import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireMembership } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hub } from '../realtime/hub.js';
import { agentChannels, serializeAgent } from '../services/serialize.js';
import { listModels, modelExists } from '../services/models.js';
import { generateSkills, NoModelKeyError } from '../services/generate.js';
import { readClaudeMd, writeClaudeMd } from '../services/agent-files.js';
import {
  colorFor,
  createAgentSchema,
  defaultToolIds,
  generateSkillsSchema,
  isRunnableConfig,
  runtimeForModel,
  slugifyHandle,
  toolCatalog,
  updateAgentSchema,
  upsertSkillSchema,
  type AgentKind,
} from '@hive/shared';
import { env } from '../env.js';
import { computeCapabilities } from '../services/capabilities.js';

/** Handle libero nel workspace: non deve collidere né con agenti né con utenti. */
async function uniqueAgentHandle(workspaceId: string, base: string): Promise<string> {
  const root = slugifyHandle(base);
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? root : `${root}${i + 1}`;
    const [agentTaken, userTaken] = await Promise.all([
      db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(
          and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.handle, candidate)),
        )
        .limit(1),
      db
        .select({ id: schema.users.id })
        .from(schema.users)
        .innerJoin(
          schema.workspaceMembers,
          and(
            eq(schema.workspaceMembers.userId, schema.users.id),
            eq(schema.workspaceMembers.workspaceId, workspaceId),
          ),
        )
        .where(eq(schema.users.handle, candidate))
        .limit(1),
    ]);
    if (agentTaken.length === 0 && userTaken.length === 0) return candidate;
  }
  return `${root}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Valida i tool concessi contro il catalogo e il tipo di agente. */
function validateTools(
  tools: Array<{ toolId: string; config: Record<string, unknown>; requireApproval: boolean }>,
  kind: AgentKind,
) {
  for (const grant of tools) {
    const def = toolCatalog.find((t) => t.id === grant.toolId);
    if (!def) throw badRequest('unknown_tool', `Tool sconosciuto: ${grant.toolId}`);
    if (!def.availableFor.includes(kind)) {
      throw badRequest(
        'tool_not_available',
        `Il tool "${def.label}" non è disponibile per un agente ${kind === 'developer' ? 'sviluppatore' : 'assistente'}`,
      );
    }
    if (def.configSchema) {
      const parsed = def.configSchema.safeParse(grant.config);
      if (!parsed.success) {
        // Messaggio leggibile: dice QUALE campo manca, non il gergo di zod.
        const issue = parsed.error.issues[0];
        const field = issue?.path?.join('.') ?? '';
        const detail =
          issue?.code === 'invalid_type' && issue.input === undefined
            ? `manca il campo "${field}"`
            : field
              ? `${field}: ${issue?.message ?? 'valore non valido'}`
              : (issue?.message ?? 'valore non valido');
        throw badRequest(
          'invalid_tool_config',
          `Per usare "${def.label}" devi completarne la configurazione — ${detail}.`,
        );
      }
      grant.config = parsed.data as Record<string, unknown>;
    }
  }
}

/**
 * Un agente che gira su una macchina dell'utente deve dire QUALE.
 *
 * Si poteva lasciare in bianco («la prima libera») e il turno finiva su una
 * coda condivisa: lo prendeva la prima macchina accesa. Ma ogni runner ha la
 * sua cartella di lavoro — checkout diversi, spesso repo diversi — quindi non
 * era bilanciamento del carico: era sorteggiare su quale codice si lavora.
 */
function requireRunner(execution: string, runnerTokenId: string | null): void {
  if (execution !== 'local') return;
  if (runnerTokenId) return;
  throw badRequest(
    'runner_required',
    'Scegli su quale macchina lavora questo agente: ognuna ha la sua cartella di lavoro.',
  );
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------ catalogo tool */
  app.get('/api/tools', async () => ({
    tools: toolCatalog.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      group: t.group,
      icon: t.icon,
      availableFor: t.availableFor,
      dangerous: t.dangerous,
      hasConfig: Boolean(t.configSchema),
    })),
    defaults: defaultToolIds,
  }));

  /* --------------------------------------------------- catalogo modelli */
  app.get('/api/models', async (request) => {
    const query = z
      .object({
        kind: z.enum(['assistant', 'developer']).optional(),
        search: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(400).default(400),
      })
      .parse(request.query);

    const models = await listModels({
      devOnly: query.kind === 'developer',
      search: query.search,
      limit: query.limit,
    });

    return {
      models,
      capabilities: computeCapabilities(),
      defaultModel: env.HIVE_DEFAULT_MODEL,
    };
  });

  /* ------------------------------------------------------- crea agente */
  app.post('/api/workspaces/:workspaceId/agents', async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const input = createAgentSchema.parse(request.body);

    const model = input.model ?? env.HIVE_DEFAULT_MODEL;

    // Un agente sviluppatore su un modello non-Claude oggi non è eseguibile.
    const runnable = isRunnableConfig(model, input.kind);
    if (!runnable.ok) throw badRequest('model_not_runnable', runnable.reason);

    if (!(await modelExists(model, input.kind === 'developer'))) {
      throw badRequest(
        'unknown_model',
        `Modello non disponibile nel catalogo: ${model}`,
      );
    }

    validateTools(input.tools, input.kind);
    requireRunner(input.execution, input.runnerTokenId ?? null);

    const handle = input.handle
      ? await uniqueAgentHandle(workspaceId, input.handle)
      : await uniqueAgentHandle(workspaceId, input.name);

    const created = await db
      .insert(schema.agents)
      .values({
        workspaceId,
        handle,
        name: input.name.trim(),
        description: input.description ?? null,
        purpose: input.purpose ?? null,
        kind: input.kind,
        model,
        runtime: runtimeForModel(model, input.kind),
        effort: input.effort,
        replyStyle: input.replyStyle,
        replyStyleCustom: input.replyStyleCustom ?? null,
        avatarEmoji: input.avatarEmoji,
        avatarColor: input.avatarColor ?? colorFor(handle),
        systemPrompt: input.systemPrompt ?? null,
        tools: input.tools,
        mcpServers: input.mcpServers,
        repo: input.repo ?? null,
        execution: input.execution,
        permissionMode: input.permissionMode,
        runnerTokenId: input.runnerTokenId ?? null,
        autoRespond: input.autoRespond,
        createdBy: user.id,
      })
      .returning();
    const row = created[0]!;

    // Aggancia l'agente ai canali richiesti.
    if (input.channelIds.length > 0) {
      const valid = await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.workspaceId, workspaceId),
            isNull(schema.channels.archivedAt),
          ),
        );
      const validIds = new Set(valid.map((c) => c.id));
      const toAttach = input.channelIds.filter((id) => validIds.has(id));
      if (toAttach.length > 0) {
        await db
          .insert(schema.channelMembers)
          .values(
            toAttach.map((channelId) => ({
              channelId,
              memberType: 'agent' as const,
              memberId: row.id,
              autoRespond: input.autoRespond,
            })),
          )
          // Non `doNothing`: se il legame col canale esisteva già, l'impostazione
          // di auto-risposta verrebbe buttata via in silenzio — ed è proprio la
          // cosa che l'utente ha appena scelto.
          .onConflictDoUpdate({
            target: [
              schema.channelMembers.channelId,
              schema.channelMembers.memberType,
              schema.channelMembers.memberId,
            ],
            set: { autoRespond: input.autoRespond },
          });
      }
    }

    const agent = serializeAgent(row, { channelIds: input.channelIds, skillCount: 0 });
    await hub.publish(workspaceId, { packet: { t: 'agent.upserted', agent } });
    return reply.code(201).send({ agent });
  });

  /* ------------------------------------------------------ elenco agenti */
  app.get('/api/workspaces/:workspaceId/agents', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId);

    const rows = await db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.archivedAt)))
      .orderBy(asc(schema.agents.name));

    const channels = await agentChannels(rows.map((r) => r.id));
    return {
      agents: rows.map((r) =>
        serializeAgent(r, {
          channelIds: channels.all.get(r.id) ?? [],
          autoRespondChannelIds: channels.auto.get(r.id) ?? [],
        }),
      ),
    };
  });

  /* ---------------------------------------------------- modifica agente */
  app.patch('/api/agents/:agentId', async (request) => {
    const { agentId } = z.object({ agentId: z.uuid() }).parse(request.params);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Agente non trovato');

    await requireMembership(request, existing.workspaceId, 'member');
    const input = updateAgentSchema.parse(request.body);

    const kind = (input.kind ?? existing.kind) as AgentKind;
    const model = input.model ?? existing.model;

    const runnable = isRunnableConfig(model, kind);
    if (!runnable.ok) throw badRequest('model_not_runnable', runnable.reason);
    if (input.model && !(await modelExists(model, kind === 'developer'))) {
      throw badRequest('unknown_model', `Modello non disponibile: ${model}`);
    }
    if (input.tools) validateTools(input.tools, kind);
    requireRunner(
      input.execution ?? existing.execution,
      input.runnerTokenId !== undefined ? input.runnerTokenId : existing.runnerTokenId,
    );

    // L'handle si può cambiare, ma deve restare unico nel progetto: se è già
    // preso ne ricaviamo una variante libera (es. devver2).
    let nextHandle: string | undefined;
    if (input.handle !== undefined && slugifyHandle(input.handle) !== existing.handle) {
      nextHandle = await uniqueAgentHandle(existing.workspaceId, input.handle);
    }

    const updated = await db
      .update(schema.agents)
      .set({
        ...(nextHandle ? { handle: nextHandle } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.model !== undefined
          ? { model, runtime: runtimeForModel(model, kind) }
          : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.replyStyle !== undefined ? { replyStyle: input.replyStyle } : {}),
        ...(input.replyStyleCustom !== undefined ? { replyStyleCustom: input.replyStyleCustom } : {}),
        ...(input.avatarEmoji !== undefined ? { avatarEmoji: input.avatarEmoji } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(input.execution !== undefined ? { execution: input.execution } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.runnerTokenId !== undefined ? { runnerTokenId: input.runnerTokenId } : {}),
        ...(input.autoRespond !== undefined ? { autoRespond: input.autoRespond } : {}),
      })
      .where(eq(schema.agents.id, agentId))
      .returning();

    const row = updated[0]!;

    /*
     * L'auto-risposta vive sul legame agente-canale, non sull'agente: è lì che
     * il server la legge quando decide chi deve rispondere. Aggiornare solo la
     * riga dell'agente non produceva NESSUN effetto — la spunta risultava
     * accesa e l'agente restava muto. Quando cambia, si riallineano tutti i
     * canali in cui l'agente sta; poi la si può cambiare canale per canale.
     */
    if (input.autoRespond !== undefined) {
      await db
        .update(schema.channelMembers)
        .set({ autoRespond: input.autoRespond })
        .where(
          and(
            eq(schema.channelMembers.memberType, 'agent'),
            eq(schema.channelMembers.memberId, agentId),
          ),
        );
    }

    // Se cambiano tool, tipo o modello, la sessione SDK ripresa avrebbe un
    // contesto ormai sbagliato (es. "questo tool non ce l'ho"): la
    // invalidiamo, così il prossimo turno riparte pulito con la nuova config.
    if (input.tools !== undefined || input.kind !== undefined || input.model !== undefined) {
      await db
        .update(schema.agentRuns)
        .set({ sdkSessionId: null })
        .where(eq(schema.agentRuns.agentId, agentId));
    }

    const channels = await agentChannels([agentId]);
    const agent = serializeAgent(row, {
      channelIds: channels.all.get(agentId) ?? [],
      autoRespondChannelIds: channels.auto.get(agentId) ?? [],
    });
    await hub.publish(existing.workspaceId, { packet: { t: 'agent.upserted', agent } });
    return { agent };
  });

  /* ------------------------------------------------------ archivia agente */
  app.delete('/api/agents/:agentId', async (request) => {
    const { agentId } = z.object({ agentId: z.uuid() }).parse(request.params);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Agente non trovato');
    await requireMembership(request, existing.workspaceId, 'admin');

    // Archiviamo invece di cancellare: i messaggi già scritti restano attribuiti.
    await db
      .update(schema.agents)
      .set({ archivedAt: new Date() })
      .where(eq(schema.agents.id, agentId));
    await db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.memberType, 'agent'),
          eq(schema.channelMembers.memberId, agentId),
        ),
      );
    return { ok: true };
  });

  /* ------------------- CLAUDE.md del progetto su cui lavora l'agente */
  // È il file VERO sul disco: sul server per gli agenti `server`, sulla
  // macchina della persona (via runner) per quelli `local`.
  app.get('/api/agents/:agentId/claude-md', async (request) => {
    const { agentId } = z.object({ agentId: z.uuid() }).parse(request.params);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Agente non trovato');
    await requireMembership(request, existing.workspaceId);
    return readClaudeMd(existing);
  });

  app.put('/api/agents/:agentId/claude-md', async (request) => {
    const { agentId } = z.object({ agentId: z.uuid() }).parse(request.params);
    const { content } = z.object({ content: z.string().max(200_000) }).parse(request.body);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Agente non trovato');
    await requireMembership(request, existing.workspaceId, 'member');
    return writeClaudeMd(existing, content);
  });

  /* --------------------------------------- aggancia/sgancia dai canali */
  app.put('/api/agents/:agentId/channels/:channelId', async (request) => {
    const { agentId, channelId } = z
      .object({ agentId: z.uuid(), channelId: z.uuid() })
      .parse(request.params);
    const { autoRespond } = z
      .object({ autoRespond: z.boolean().default(false) })
      .parse(request.body ?? {});

    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const agent = rows[0];
    if (!agent) throw notFound('Agente non trovato');
    await requireMembership(request, agent.workspaceId, 'member');

    const channelRows = await db
      .select({ workspaceId: schema.channels.workspaceId })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1);
    if (channelRows[0]?.workspaceId !== agent.workspaceId) {
      throw badRequest('cross_workspace', 'Il canale appartiene a un altro progetto');
    }

    await db
      .insert(schema.channelMembers)
      .values({ channelId, memberType: 'agent', memberId: agentId, autoRespond })
      .onConflictDoUpdate({
        target: [
          schema.channelMembers.channelId,
          schema.channelMembers.memberType,
          schema.channelMembers.memberId,
        ],
        set: { autoRespond },
      });

    const channels = await agentChannels([agentId]);
    const serialized = serializeAgent(agent, {
      channelIds: channels.all.get(agentId) ?? [],
      autoRespondChannelIds: channels.auto.get(agentId) ?? [],
    });
    await hub.publish(agent.workspaceId, { packet: { t: 'agent.upserted', agent: serialized } });
    return { ok: true };
  });

  app.delete('/api/agents/:agentId/channels/:channelId', async (request) => {
    const { agentId, channelId } = z
      .object({ agentId: z.uuid(), channelId: z.uuid() })
      .parse(request.params);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const agent = rows[0];
    if (!agent) throw notFound('Agente non trovato');
    await requireMembership(request, agent.workspaceId, 'member');

    await db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, 'agent'),
          eq(schema.channelMembers.memberId, agentId),
        ),
      );

    const channels = await agentChannels([agentId]);
    const serialized = serializeAgent(agent, {
      channelIds: channels.all.get(agentId) ?? [],
      autoRespondChannelIds: channels.auto.get(agentId) ?? [],
    });
    await hub.publish(agent.workspaceId, { packet: { t: 'agent.upserted', agent: serialized } });
    return { ok: true };
  });

  /* ---------------------------------------------------------- skill */
  app.get('/api/agents/:agentId/skills', async (request) => {
    const { agentId } = z.object({ agentId: z.uuid() }).parse(request.params);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const agent = rows[0];
    if (!agent) throw notFound('Agente non trovato');
    await requireMembership(request, agent.workspaceId);

    const skills = await db
      .select()
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.agentId, agentId))
      .orderBy(asc(schema.agentSkills.name));

    return {
      skills: skills.map((s) => ({
        id: s.id,
        agentId: s.agentId,
        name: s.name,
        description: s.description,
        body: s.body,
        enabled: s.enabled,
        generatedByAi: s.generatedByAi,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  });

  app.post('/api/agents/:agentId/skills', async (request, reply) => {
    const { agentId } = z.object({ agentId: z.uuid() }).parse(request.params);
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
    const agent = rows[0];
    if (!agent) throw notFound('Agente non trovato');
    await requireMembership(request, agent.workspaceId, 'member');

    const input = upsertSkillSchema
      .extend({ generatedByAi: z.boolean().default(false) })
      .parse(request.body);

    const created = await db
      .insert(schema.agentSkills)
      .values({
        agentId,
        name: input.name,
        description: input.description,
        body: input.body,
        enabled: input.enabled,
        generatedByAi: input.generatedByAi,
      })
      .onConflictDoUpdate({
        target: [schema.agentSkills.agentId, schema.agentSkills.name],
        set: {
          description: input.description,
          body: input.body,
          enabled: input.enabled,
          updatedAt: new Date(),
        },
      })
      .returning();

    return reply.code(201).send({ skill: created[0] });
  });

  app.delete('/api/skills/:skillId', async (request) => {
    const { skillId } = z.object({ skillId: z.uuid() }).parse(request.params);
    const rows = await db
      .select({ workspaceId: schema.agents.workspaceId })
      .from(schema.agentSkills)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.agentSkills.agentId))
      .where(eq(schema.agentSkills.id, skillId))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('Skill non trovata');
    await requireMembership(request, row.workspaceId, 'member');

    await db.delete(schema.agentSkills).where(eq(schema.agentSkills.id, skillId));
    return { ok: true };
  });

  /* --------------------------------------------- generazione skill via AI */
  app.post('/api/workspaces/:workspaceId/skills/generate', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'member');
    const input = generateSkillsSchema.parse(request.body);

    try {
      const skills = await generateSkills({
        workspaceId,
        purpose: input.purpose,
        kind: input.kind,
        toolIds: input.toolIds,
        count: input.count,
      });
      // Sono proposte: l'utente le rivede e le modifica prima di salvarle.
      return { skills };
    } catch (err) {
      if (err instanceof NoModelKeyError) {
        throw badRequest('no_model_key', err.message);
      }
      // Un errore del provider (chiave sbagliata, rate limit, modello giù) non
      // deve diventare un 500 opaco: lo giriamo come messaggio leggibile.
      const detail = err instanceof Error ? err.message : String(err);
      throw badRequest(
        'generation_failed',
        `La generazione non è riuscita: ${detail}. ` +
          'Controlla che la chiave in Impostazioni sia valida.',
      );
    }
  });
}
