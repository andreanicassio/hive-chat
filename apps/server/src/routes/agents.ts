import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireMembership } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hub } from '../realtime/hub.js';
import { agentChannelMap, serializeAgent } from '../services/serialize.js';
import { listModels, modelExists } from '../services/models.js';
import { generateSkills, NoModelKeyError } from '../services/generate.js';
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
        throw badRequest(
          'invalid_tool_config',
          `Configurazione non valida per "${def.label}": ${parsed.error.issues[0]?.message ?? 'errore'}`,
        );
      }
      grant.config = parsed.data as Record<string, unknown>;
    }
  }
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
        avatarEmoji: input.avatarEmoji,
        avatarColor: input.avatarColor ?? colorFor(handle),
        systemPrompt: input.systemPrompt ?? null,
        tools: input.tools,
        mcpServers: input.mcpServers,
        repo: input.repo ?? null,
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
          .onConflictDoNothing();
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

    const channels = await agentChannelMap(rows.map((r) => r.id));
    return {
      agents: rows.map((r) => serializeAgent(r, { channelIds: channels.get(r.id) ?? [] })),
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

    const updated = await db
      .update(schema.agents)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.model !== undefined
          ? { model, runtime: runtimeForModel(model, kind) }
          : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.avatarEmoji !== undefined ? { avatarEmoji: input.avatarEmoji } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(input.autoRespond !== undefined ? { autoRespond: input.autoRespond } : {}),
      })
      .where(eq(schema.agents.id, agentId))
      .returning();

    const row = updated[0]!;
    const channels = await agentChannelMap([agentId]);
    const agent = serializeAgent(row, { channelIds: channels.get(agentId) ?? [] });
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

    const channels = await agentChannelMap([agentId]);
    const serialized = serializeAgent(agent, { channelIds: channels.get(agentId) ?? [] });
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

    const channels = await agentChannelMap([agentId]);
    const serialized = serializeAgent(agent, { channelIds: channels.get(agentId) ?? [] });
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
      throw err;
    }
  });
}
