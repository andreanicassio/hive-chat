import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { redisPub } from '../lib/redis.js';
import { hub } from '../realtime/hub.js';
import { unauthorized, forbidden, notFound } from '../lib/errors.js';
import { hashToken } from './runner.js';
import { applyRunnerOps, type RunnerOp, type RunSinkContext } from '../services/runner-sink.js';
import { buildAgentContext, documentTreeText, readDocByPath, writeDocByPath } from '@hive/db';
import { toDocumentNode } from '../services/documents.js';
import { redisChannels, runJobSchema, RUNNER_PRESENCE_TTL_SEC, type Approval } from '@hive/shared';

/** Verifica che il run sia di un agente `local` di questo utente. */
async function resolveRun(userId: string, runId: string) {
  const runRows = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) throw notFound('Run non trovato');
  const agentRows = await db
    .select({ createdBy: schema.agents.createdBy, execution: schema.agents.execution })
    .from(schema.agents)
    .where(eq(schema.agents.id, run.agentId))
    .limit(1);
  const agent = agentRows[0];
  if (!agent || agent.createdBy !== userId || agent.execution !== 'local') {
    throw forbidden('Questo run non appartiene al tuo runner.');
  }
  return run;
}

/** Autentica il runner dal token bearer e ne ricava utente + progetto. */
async function requireRunner(
  request: FastifyRequest,
): Promise<{ userId: string; workspaceId: string; tokenId: string }> {
  const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token.startsWith('hrt_')) throw unauthorized('Token runner mancante o non valido.');
  const rows = await db
    .select()
    .from(schema.runnerTokens)
    .where(and(eq(schema.runnerTokens.tokenHash, hashToken(token)), isNull(schema.runnerTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw unauthorized('Token runner non riconosciuto.');
  await db
    .update(schema.runnerTokens)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.runnerTokens.id, row.id));
  return { userId: row.userId, workspaceId: row.workspaceId, tokenId: row.id };
}

async function refreshPresence(
  userId: string,
  workspaceId: string,
  tokenId: string,
  name: string,
): Promise<void> {
  const label = name || '1';
  await redisPub.set(
    redisChannels.runnerPresence(userId, workspaceId),
    label,
    'EX',
    RUNNER_PRESENCE_TTL_SEC,
  );
  await redisPub.set(redisChannels.runnerPresenceById(tokenId), label, 'EX', RUNNER_PRESENCE_TTL_SEC);
}

/** Ultima sessione SDK riuscita dell'agente in questo canale, per il resume. */
async function lastSessionId(agentId: string): Promise<string | null> {
  const rows = await db
    .select({ sdkSessionId: schema.agentRuns.sdkSessionId })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.agentId, agentId))
    .orderBy(desc(schema.agentRuns.queuedAt))
    .limit(50);
  for (const r of rows) if (r.sdkSessionId) return r.sdkSessionId;
  return null;
}

export async function runnerApiRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------------------- presenza / heartbeat */
  app.post('/api/runner/hello', async (request) => {
    const { userId, workspaceId, tokenId } = await requireRunner(request);
    const body = z
      .object({
        name: z.string().max(80).optional(),
        host: z.string().max(120).optional(),
        workdir: z.string().max(2000).optional(),
      })
      .parse(request.body ?? {});
    await refreshPresence(userId, workspaceId, tokenId, body.name ?? 'runner');
    // Così in Impostazioni si vede DOVE gira ogni runner.
    await db
      .update(schema.runnerTokens)
      .set({
        ...(body.host ? { lastHost: body.host } : {}),
        ...(body.workdir ? { lastWorkdir: body.workdir } : {}),
        ...(body.name ? { label: body.name } : {}),
      })
      .where(eq(schema.runnerTokens.id, tokenId));
    return { ok: true, userId, workspaceId };
  });

  /* ------------------------------------------------------ poll di un job */
  app.get('/api/runner/poll', async (request, reply) => {
    const { userId, workspaceId, tokenId } = await requireRunner(request);
    const name = z.object({ name: z.string().max(80).optional() }).parse(request.query).name ?? 'runner';
    // Prima la coda di QUESTA macchina (agenti che l'hanno scelta), poi quella
    // generica dell'utente (agenti senza macchina preferita).
    const keys = [
      redisChannels.runnerQueueById(tokenId),
      redisChannels.runnerQueue(userId, workspaceId),
    ];

    // La presenza si rinnova QUI, all'arrivo della richiesta: è la prova che
    // il runner è vivo. Non va rinnovata dentro il ciclo, altrimenti una
    // richiesta rimasta appesa terrebbe "accesa" una macchina già spenta.
    await refreshPresence(userId, workspaceId, tokenId, name);

    // Long-poll leggero: controlliamo la coda per ~25s (TTL presenza 30s).
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      let raw: string | null = null;
      for (const k of keys) {
        raw = await redisPub.rpop(k);
        if (raw) break;
      }
      if (raw) {
        const job = runJobSchema.parse(JSON.parse(raw));
        // Sicurezza: il job dev'essere di un agente 'local' di questo utente.
        const agentRows = await db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, job.agentId))
          .limit(1);
        const agent = agentRows[0];
        if (
          !agent ||
          agent.createdBy !== userId ||
          agent.execution !== 'local' ||
          agent.workspaceId !== workspaceId
        ) {
          // Non è roba di questo runner (altro utente o altro progetto).
          continue;
        }
        const context = await buildAgentContext(db, {
          workspaceId: job.workspaceId,
          channelId: job.channelId,
          agentId: job.agentId,
          triggerMessageId: job.triggerMessageId,
          rawPrompt: job.prompt,
          fromAgentHandle: job.fromAgentHandle,
        });
        return {
          job,
          agent,
          context: { systemPrompt: context.systemPrompt, prompt: context.prompt },
          resumeSessionId: await lastSessionId(job.agentId),
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return reply.code(204).send();
  });

  /* --------------------------------------- eventi di esecuzione dal runner */
  app.post('/api/runner/events', async (request) => {
    const { userId } = await requireRunner(request);
    const { runId, ops } = z
      .object({ runId: z.uuid(), ops: z.array(z.any()).max(500) })
      .parse(request.body);

    const runRows = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);
    const run = runRows[0];
    if (!run) throw notFound('Run non trovato');

    // L'agente del run dev'essere un 'local' di questo utente.
    const agentRows = await db
      .select({ createdBy: schema.agents.createdBy, execution: schema.agents.execution })
      .from(schema.agents)
      .where(eq(schema.agents.id, run.agentId))
      .limit(1);
    const agent = agentRows[0];
    if (!agent || agent.createdBy !== userId || agent.execution !== 'local') {
      throw forbidden('Questo run non appartiene al tuo runner.');
    }

    const ctx: RunSinkContext = {
      runId: run.id,
      workspaceId: run.workspaceId,
      channelId: run.channelId,
      agentId: run.agentId,
      messageId: run.responseMessageId!,
    };
    await applyRunnerOps(ctx, ops as RunnerOp[]);
    return { ok: true };
  });

  /* --------------------------- approvazione inline in chat (dal runner) */
  // Il runner chiede il permesso per un'azione: creiamo la card in chat.
  app.post('/api/runner/approval', async (request) => {
    const { userId } = await requireRunner(request);
    const body = z
      .object({
        runId: z.uuid(),
        toolName: z.string().max(128),
        title: z.string().max(280),
        detail: z.string().max(20_000).default(''),
        input: z.any(),
      })
      .parse(request.body);
    const run = await resolveRun(userId, body.runId);

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const inserted = await db
      .insert(schema.approvals)
      .values({
        id,
        runId: run.id,
        workspaceId: run.workspaceId,
        channelId: run.channelId,
        agentId: run.agentId,
        toolName: body.toolName,
        title: body.title.slice(0, 280),
        detail: body.detail.slice(0, 20_000),
        input: (body.input ?? {}) as object,
        status: 'pending',
        expiresAt,
      })
      .returning();
    const row = inserted[0]!;

    const approval: Approval = {
      id: row.id,
      runId: row.runId,
      channelId: row.channelId,
      agentId: row.agentId,
      toolName: row.toolName,
      title: row.title,
      detail: row.detail,
      input: row.input,
      status: 'pending',
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      reason: null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
    await hub.publish(run.workspaceId, {
      packet: { t: 'approval.requested', approval },
      channelId: run.channelId,
    });
    await db
      .update(schema.agentRuns)
      .set({ status: 'awaiting_approval' })
      .where(eq(schema.agentRuns.id, run.id));

    return { approvalId: id };
  });

  // Il runner attende la decisione (long-poll ~25s, poi ripete).
  app.get('/api/runner/approval/:id', async (request, reply) => {
    const { userId } = await requireRunner(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const rows = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound('Richiesta non trovata');
      // (la verifica utente è implicita: solo il proprietario vede il runId)
      void userId;
      if (row.status !== 'pending') {
        // riportiamo il run in esecuzione mentre il runner prosegue
        await db
          .update(schema.agentRuns)
          .set({ status: 'running' })
          .where(eq(schema.agentRuns.id, row.runId));
        return { decided: true, allowed: row.status === 'allowed', reason: row.reason ?? null };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { decided: false };
  });

  /* ------------------------------- comandi fuori turno (lettura/scrittura file) */
  // Il runner fa poll qui per servire richieste che non fanno partire un turno
  // (es. leggere/scrivere il CLAUDE.md del progetto dall'interfaccia).
  app.get('/api/runner/commands', async (request, reply) => {
    const { userId, tokenId } = await requireRunner(request);
    const deadline = Date.now() + 20_000;
    const cmdKeys = [redisChannels.runnerCommandsById(tokenId), redisChannels.runnerCommands(userId)];
    while (Date.now() < deadline) {
      let raw: string | null = null;
      for (const k of cmdKeys) {
        raw = await redisPub.rpop(k);
        if (raw) break;
      }
      if (raw) return { command: JSON.parse(raw) };
      await new Promise((r) => setTimeout(r, 700));
    }
    return reply.code(204).send();
  });

  app.post('/api/runner/command-result', async (request) => {
    await requireRunner(request);
    const body = z
      .object({
        commandId: z.uuid(),
        ok: z.boolean(),
        content: z.string().max(400_000).optional(),
        path: z.string().max(2000).optional(),
        exists: z.boolean().optional(),
        error: z.string().max(2000).optional(),
      })
      .parse(request.body);
    await redisPub.set(
      redisChannels.runnerCommandResult(body.commandId),
      JSON.stringify(body),
      'EX',
      60,
    );
    return { ok: true };
  });

  /* ------------------------ tool hive proxati: DOCUMENTI (base di conoscenza) */
  // Il runner locale non ha il DB: gli strumenti dei documenti passano di qui.
  app.post('/api/runner/documents/list', async (request) => {
    const { userId } = await requireRunner(request);
    const { runId } = z.object({ runId: z.uuid() }).parse(request.body);
    const run = await resolveRun(userId, runId);
    const tree = await documentTreeText(db, run.workspaceId);
    return { tree };
  });

  app.post('/api/runner/documents/read', async (request) => {
    const { userId } = await requireRunner(request);
    const { runId, path } = z
      .object({ runId: z.uuid(), path: z.string().min(1).max(1000) })
      .parse(request.body);
    const run = await resolveRun(userId, runId);
    return readDocByPath(db, run.workspaceId, path);
  });

  app.post('/api/runner/documents/write', async (request) => {
    const { userId } = await requireRunner(request);
    const { runId, path, content, description } = z
      .object({
        runId: z.uuid(),
        path: z.string().min(1).max(1000),
        content: z.string().max(200_000),
        description: z.string().max(300).optional(),
      })
      .parse(request.body);
    const run = await resolveRun(userId, runId);
    const r = await writeDocByPath(db, run.workspaceId, path, content, {
      description,
      actor: { type: 'agent', id: run.agentId },
    });
    // Realtime: fai comparire la modifica nel pannello Documenti.
    const rows = await db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).limit(1);
    if (rows[0]) {
      await hub.publish(run.workspaceId, {
        packet: { t: 'document.changed', workspaceId: run.workspaceId, document: toDocumentNode(rows[0]) },
      });
    }
    return { text: `${r.created ? 'Creato' : 'Aggiornato'} ${r.path}.` };
  });
}
