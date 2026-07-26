import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { redisPub } from '../lib/redis.js';
import { hub } from '../realtime/hub.js';
import { scheduleTurn } from '../services/scheduled-turns.js';
import { channelMemberIds, notifyApproval } from '../services/notify.js';
import { unauthorized, forbidden, notFound } from '../lib/errors.js';
import { hashToken } from './runner.js';
import { applyRunnerOps, type RunnerOp, type RunSinkContext } from '../services/runner-sink.js';
import {
  buildAgentContext,
  channelAttachments,
  documentTreeText,
  readDocByPath,
  writeDocByPath,
} from '@hive/db';
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
        /** Quanto abbonamento Claude Code ha già consumato questa macchina. */
        usage: z
          .object({
            fiveHour: z
              .object({ utilization: z.number(), resetsAt: z.string().nullable() })
              .nullable()
              .optional(),
            sevenDay: z
              .object({ utilization: z.number(), resetsAt: z.string().nullable() })
              .nullable()
              .optional(),
            at: z.string(),
          })
          .optional(),
      })
      .parse(request.body ?? {});
    await refreshPresence(userId, workspaceId, tokenId, body.name ?? 'runner');

    // Sta in Redis con la stessa scadenza della presenza: un numero di una
    // macchina spenta è un numero che invecchia in silenzio, e su questo si
    // decide se far partire un lavoro adesso o aspettare.
    if (body.usage) {
      await redisPub.set(
        redisChannels.runnerUsage(tokenId),
        JSON.stringify(body.usage),
        'EX',
        RUNNER_PRESENCE_TTL_SEC * 3,
      );
    }
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
        // Annullato mentre aspettava in coda: non c'era nessuno a cui mandare
        // il segnale di stop, quindi il controllo tocca a chi lo preleva.
        if (await redisPub.exists(redisChannels.runCancelled(job.runId))) continue;
        const context = await buildAgentContext(db, {
          workspaceId: job.workspaceId,
          channelId: job.channelId,
          agentId: job.agentId,
          triggerMessageId: job.triggerMessageId,
          threadRootId: job.threadRootId,
          rawPrompt: job.prompt,
          fromAgentHandle: job.fromAgentHandle,
        });
        // Gli allegati del canale: il runner sta su un'altra macchina e il
        // disco del server non ce l'ha, quindi qui gli diciamo solo COSA
        // scaricare e dove metterlo. I byte se li prende dalla rotta apposita.
        // `storagePath` (percorso sul server) resta fuori: a lui non serve.
        const attachments = (await channelAttachments(db, job.channelId)).map((a) => ({
          id: a.id,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
          relPath: a.relPath,
        }));

        return {
          job,
          agent,
          context: { systemPrompt: context.systemPrompt, prompt: context.prompt },
          attachments,
          resumeSessionId: await lastSessionId(job.agentId),
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return reply.code(204).send();
  });

  /* ------------------------------------------- allegati del turno in corso */
  /**
   * Scarica il binario di un allegato per il runner.
   *
   * Perimetro stretto, di proposito: il token del runner sta sul computer di
   * una persona, quindi questa rotta non permette di pescare un allegato
   * qualsiasi per id. Si passa dal `runId`, `resolveRun` verifica che quel run
   * sia di un agente `local` di questo utente, e l'allegato deve comparire fra
   * quelli che quel canale mostrerebbe comunque all'agente. In pratica: puoi
   * scaricare solo ciò che il turno che stai eseguendo vedrebbe lo stesso.
   */
  app.get('/api/runner/files/:id', async (request, reply) => {
    const { userId } = await requireRunner(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { runId } = z.object({ runId: z.uuid() }).parse(request.query);

    const run = await resolveRun(userId, runId);
    const allowed = await channelAttachments(db, run.channelId);
    const att = allowed.find((a) => a.id === id);
    if (!att || !att.storagePath) throw notFound('Allegato non disponibile');

    let buffer: Buffer;
    try {
      buffer = await readFile(att.storagePath);
    } catch {
      throw notFound('Allegato non più disponibile');
    }
    reply.header('content-type', att.mime);
    return reply.send(buffer);
  });

  /* --------------------------------------- eventi di esecuzione dal runner */
  app.post('/api/runner/events', async (request) => {
    const { userId } = await requireRunner(request);
    const { runId, ops, steerable } = z
      .object({
        runId: z.uuid(),
        ops: z.array(z.any()).max(500),
        // I runner vecchi non lo mandano: per loro niente steering, e i
        // messaggi continuano ad accodarsi come prima.
        steerable: z.boolean().optional(),
      })
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
    // L'unico canale di ritorno verso un runner che sta lavorando. Il runner
    // sta su un'altra macchina, non vede Redis, e mentre esegue un turno non
    // fa poll: l'invio degli eventi è l'unica cosa che continua a passare di
    // qui, quindi è da qui che gli si dice di fermarsi.
    const cancelled = await redisPub.exists(redisChannels.runCancelled(run.id));

    /*
     * Steering a caldo per un turno che gira su un'altra macchina.
     *
     * Il marcatore vive quanto due battiti di questo invio: se il runner
     * smette di farsi vivo, la chat torna ad accodare invece di infilare
     * messaggi in una lista che nessuno svuoterà più.
     */
    let steer: string[] | undefined;
    if (steerable && !cancelled) {
      await redisPub.set(redisChannels.steerable(run.id), '1', 'EX', 15);
      const key = redisChannels.steerQueue(run.id);
      const texts: string[] = [];
      for (;;) {
        const raw = await redisPub.rpop(key);
        if (!raw) break;
        let rec: { text?: string; messageId?: string | null } = {};
        try {
          rec = JSON.parse(raw) as typeof rec;
        } catch {
          // Record scritto da una versione precedente: era il testo nudo.
          rec = { text: raw };
        }
        if (!rec.text) continue;
        texts.push(rec.text);
        // Da adesso il turno ce l'ha davvero in mano: la chat può smettere di
        // dire «in consegna» e dire «lo sta leggendo».
        if (rec.messageId) {
          await hub.publish(run.workspaceId, {
            packet: {
              t: 'steer.delivered',
              channelId: run.channelId,
              messageId: rec.messageId,
              runId: run.id,
              agentId: run.agentId,
              state: 'reading',
            },
            channelId: run.channelId,
          });
        }
      }
      if (texts.length > 0) steer = texts;
    }

    return {
      ok: true,
      ...(cancelled ? { cancel: true } : {}),
      ...(steer ? { steer } : {}),
    };
  });

  /* ------------------------------------- prenotare un turno futuro (runner) */
  //
  // Il runner gira su un'altra macchina e il database non lo vede: passa da
  // qui. Le regole (quanto in là, quanti pendenti, quanti risvegli di fila)
  // stanno in `@hive/db`, quindi sono le stesse dei turni sul server.
  app.post('/api/runner/schedule', async (request) => {
    const { userId } = await requireRunner(request);
    const { runId, inMinutes, note } = z
      .object({
        runId: z.uuid(),
        inMinutes: z.number().int().min(1).max(10080),
        note: z.string().min(1).max(4000),
      })
      .parse(request.body);

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

    const { runAt } = await scheduleTurn({
      workspaceId: run.workspaceId,
      channelId: run.channelId,
      agentId: run.agentId,
      inMinutes,
      note,
      fromRunId: run.id,
    });
    return { ok: true, runAt: runAt.toISOString() };
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

    // Un agente in attesa resta fermo finché qualcuno non decide: è il caso
    // in cui una notifica serve davvero, e va anche a chi sta guardando il
    // canale — la card si perde facilmente nello scorrimento.
    void (async () => {
      const [agentRow] = await db
        .select({ name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, run.agentId))
        .limit(1);
      const [channelRow] = await db
        .select({ name: schema.channels.name })
        .from(schema.channels)
        .where(eq(schema.channels.id, run.channelId))
        .limit(1);
      await notifyApproval({
        userIds: await channelMemberIds(run.channelId),
        agentName: agentRow?.name ?? 'Un agente',
        channelId: run.channelId,
        channelName: channelRow?.name ?? 'canale',
        title: row.title,
      });
    })().catch((err: unknown) => console.error('[push] permesso:', err));

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
