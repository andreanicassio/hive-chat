import { eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';
import { redis, redisBlocking, redisSub } from './redis.js';
import { env } from './env.js';
import { RunEmitter } from './emitter.js';
import { buildContext } from './context.js';
import { resolveWorkDir } from './workspace.js';
import { ClaudeCodeRunner } from './runners/claude-code.js';
import { OpenRouterRunner } from './runners/openrouter.js';
import type { Runner } from './runners/types.js';
import { MissingClaudeAuthError } from './auth.js';
import {
  MAX_HANDOFF_HOPS,
  redisChannels,
  runJobSchema,
  type RunJob,
} from '@hive/shared';

/**
 * Consumatore della coda dei run.
 *
 * Legge i job con BRPOP e ne esegue al massimo AGENT_MAX_CONCURRENCY alla
 * volta. Il limite è ciò che tiene in piedi la macchina: senza, dieci
 * persone che taggano dieci agenti insieme farebbero partire dieci processi
 * Claude Code contemporaneamente e il server andrebbe in ginocchio.
 */

const runners: Record<string, Runner> = {
  'claude-code': new ClaudeCodeRunner(),
  'openrouter-tools': new OpenRouterRunner(),
};

let active = 0;
let stopping = false;

export async function startWorker(): Promise<void> {
  console.log(
    `[worker] avviato — concorrenza max ${env.AGENT_MAX_CONCURRENCY}, ` +
      `isolamento ${env.AGENT_ISOLATION}`,
  );

  while (!stopping) {
    if (active >= env.AGENT_MAX_CONCURRENCY) {
      // Tutti gli slot occupati: aspetta che se ne liberi uno.
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    let payload: [string, string] | null = null;
    try {
      // BRPOP con timeout: permette di controllare `stopping` periodicamente.
      payload = (await redisBlocking.brpop(redisChannels.runQueue, 5)) as
        | [string, string]
        | null;
    } catch (err) {
      if (stopping) break;
      console.error('[worker] errore leggendo dalla coda:', err);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    if (!payload) continue;

    const parsed = runJobSchema.safeParse(JSON.parse(payload[1]));
    if (!parsed.success) {
      console.error('[worker] job malformato, scartato:', parsed.error.issues[0]?.message);
      continue;
    }

    active++;
    void execute(parsed.data)
      .catch((err) => console.error('[worker] errore non gestito nel run:', err))
      .finally(() => {
        active--;
      });
  }
}

export function stopWorker(): void {
  stopping = true;
}

async function execute(job: RunJob): Promise<void> {
  const emitter = new RunEmitter({
    runId: job.runId,
    workspaceId: job.workspaceId,
    channelId: job.channelId,
    agentId: job.agentId,
    messageId: job.responseMessageId,
  });

  // Annullamento: l'utente può fermare un run dalla chat.
  const abort = new AbortController();
  const cancelChannel = redisChannels.runCancel(job.runId);
  const onCancel = (ch: string) => {
    if (ch === cancelChannel) abort.abort();
  };
  redisSub.on('message', onCancel);
  await redisSub.subscribe(cancelChannel).catch(() => {});

  // Rete di sicurezza: un run che non finisce non deve occupare uno slot
  // per sempre.
  const timeout = setTimeout(() => abort.abort(), env.AGENT_RUN_TIMEOUT_MS);

  try {
    const agentRows = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, job.agentId))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) throw new Error('agente non trovato');
    if (agent.archivedAt) throw new Error('agente archiviato');

    await emitter.markStarted();

    const runner = runners[agent.runtime];
    if (!runner) {
      throw new Error(
        agent.runtime === 'opencode'
          ? 'Il runtime OpenCode non è ancora attivo. Scegli un modello Claude per questo agente.'
          : `Runtime sconosciuto: ${agent.runtime}`,
      );
    }

    const kind = agent.kind as 'assistant' | 'developer';
    const workDir = await resolveWorkDir({
      workspaceId: job.workspaceId,
      agentId: agent.id,
      kind,
    });

    const context = await buildContext({
      workspaceId: job.workspaceId,
      channelId: job.channelId,
      agentId: agent.id,
      triggerMessageId: job.triggerMessageId,
      rawPrompt: job.prompt,
      fromAgentHandle: job.fromAgentHandle,
    });

    // Continuità del filo: riprendiamo la sessione dell'ultimo run andato a
    // buon fine per questo agente in questo canale.
    const resumeSessionId = await lastSessionId(agent.id, job.channelId);

    const result = await runner.run({
      agent,
      context,
      emitter,
      runId: job.runId,
      workspaceId: job.workspaceId,
      channelId: job.channelId,
      workDir,
      resumeSessionId,
      signal: abort.signal,
    });

    await emitter.finish({
      status: abort.signal.aborted ? 'cancelled' : 'done',
      finalText: result.finalText,
      numTurns: result.numTurns,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      sdkSessionId: result.sessionId,
    });

    // Passaggi di consegne: se la risposta tagga un altro agente, lo attiviamo.
    if (!abort.signal.aborted && result.handoffs.length > 0) {
      await scheduleHandoffs(job, result.handoffs, agent.handle);
    }
  } catch (err) {
    const message =
      err instanceof MissingClaudeAuthError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    console.error(`[worker] run ${job.runId} fallito:`, message);
    await emitter.event({ type: 'error', message }).catch(() => {});
    await emitter
      .finish({
        status: abort.signal.aborted ? 'cancelled' : 'error',
        error: message,
      })
      .catch(() => {});
  } finally {
    clearTimeout(timeout);
    redisSub.off('message', onCancel);
    await redisSub.unsubscribe(cancelChannel).catch(() => {});
  }
}

/** Ultima sessione SDK riuscita di questo agente in questo canale. */
async function lastSessionId(agentId: string, channelId: string): Promise<string | null> {
  const rows = await db
    .select({ sdkSessionId: schema.agentRuns.sdkSessionId })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.agentId, agentId))
    .orderBy(schema.agentRuns.queuedAt)
    .limit(200);
  // Cerchiamo a ritroso l'ultima sessione valida.
  for (let i = rows.length - 1; i >= 0; i--) {
    const id = rows[i]?.sdkSessionId;
    if (id) return id;
  }
  return null;
}

/**
 * Accoda i run per gli agenti a cui è stata passata la palla.
 * Il contatore `hop` impedisce che due agenti si rimbalzino il lavoro
 * all'infinito.
 */
async function scheduleHandoffs(
  job: RunJob,
  handles: string[],
  fromHandle: string,
): Promise<void> {
  if (job.hop >= MAX_HANDOFF_HOPS) {
    console.warn(`[worker] catena di passaggi troppo lunga, fermata a hop ${job.hop}`);
    return;
  }

  for (const handle of handles) {
    const rows = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.handle, handle))
      .limit(1);
    const target = rows[0];
    if (!target || target.id === job.agentId) continue;

    // È membro del canale? Se no, non lo attiviamo.
    const member = await db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.memberId, target.id))
      .limit(50);
    if (!member.some((m) => m.channelId === job.channelId)) continue;

    // La creazione del run passa dal server, che sa creare la bolla del
    // messaggio: qui pubblichiamo solo la richiesta.
    await redis.lpush(
      'hive:runs:handoff',
      JSON.stringify({
        workspaceId: job.workspaceId,
        channelId: job.channelId,
        agentId: target.id,
        fromAgentHandle: fromHandle,
        hop: job.hop,
      }),
    );
  }
}
