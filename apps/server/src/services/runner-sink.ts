import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { hub } from '../realtime/hub.js';
import { flushPendingPrompts } from './messages.js';
import type { AgentStatus, RunEvent, RunStatus, ServerPacket } from '@hive/shared';

/**
 * Applica sul server gli "eventi" che un runner locale produce mentre esegue
 * un turno. Il runner non tocca il database: manda qui una lista di operazioni
 * e il server fa le stesse scritture + pubblicazioni che farebbe l'emitter del
 * runtime. È lo speculare, lato server, dell'emitter di agent-runtime.
 */

export interface RunSinkContext {
  runId: string;
  workspaceId: string;
  channelId: string;
  agentId: string;
  messageId: string;
}

/** Una singola operazione nello stream del runner. */
export type RunnerOp =
  | { op: 'started' }
  | { op: 'status'; status: AgentStatus; label: string | null }
  | { op: 'delta'; text: string }
  | { op: 'body'; text: string }
  /** `at` è in millisecondi epoch. Manca sui runner più vecchi del campo. */
  | { op: 'event'; seq: number; event: RunEvent; at?: number }
  | {
      op: 'finish';
      status: RunStatus;
      error?: string | null;
      finalText?: string;
      numTurns?: number;
      costUsd?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      usesSubscription?: boolean;
      sdkSessionId?: string | null;
    };

async function publish(ctx: RunSinkContext, packet: ServerPacket): Promise<void> {
  await hub.publish(ctx.workspaceId, { packet, channelId: ctx.channelId });
}

async function applyStatus(
  ctx: RunSinkContext,
  status: AgentStatus,
  label: string | null,
): Promise<void> {
  await db
    .update(schema.agents)
    .set({ status, statusLabel: label })
    .where(eq(schema.agents.id, ctx.agentId));
  await hub.publish(ctx.workspaceId, {
    packet: { t: 'agent.status', agentId: ctx.agentId, status, label, channelId: ctx.channelId },
  });
}

async function applyFinish(ctx: RunSinkContext, op: Extract<RunnerOp, { op: 'finish' }>): Promise<void> {
  let body = op.finalText?.trim() ? op.finalText : '';
  if (!body.trim()) {
    // fallback dal testo già persistito (i delta), o una nota.
    const cur = await db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(eq(schema.messages.id, ctx.messageId))
      .limit(1);
    body = cur[0]?.body?.trim() ?? '';
  }

  /*
   * Fermato prima che dicesse una parola: la bolla sparisce.
   *
   * Un cartello «esecuzione annullata» al suo posto è peggio del silenzio —
   * occupa una riga della conversazione per dire che non è successo niente.
   * Se invece aveva già cominciato a rispondere, quel testo resta: è roba
   * vera, e cancellarla sarebbe buttare via lavoro fatto.
   */
  const purge = !body.trim() && op.status === 'cancelled';
  if (purge) {
    await db.delete(schema.messages).where(eq(schema.messages.id, ctx.messageId));
  } else {
    if (!body.trim()) {
      body =
        op.status === 'error'
          ? `_L'esecuzione si è interrotta: ${op.error ?? 'errore sconosciuto'}_`
          : '_Nessuna risposta prodotta._';
    }
    await db.update(schema.messages).set({ body }).where(eq(schema.messages.id, ctx.messageId));
  }
  await db
    .update(schema.agentRuns)
    .set({
      status: op.status,
      error: op.error ?? null,
      endedAt: new Date(),
      ...(op.numTurns !== undefined ? { numTurns: op.numTurns } : {}),
      ...(op.costUsd != null ? { costUsd: op.costUsd.toFixed(6) } : {}),
      ...(op.inputTokens != null ? { inputTokens: op.inputTokens } : {}),
      ...(op.outputTokens != null ? { outputTokens: op.outputTokens } : {}),
      ...(op.usesSubscription !== undefined ? { usesSubscription: op.usesSubscription } : {}),
      ...(op.sdkSessionId ? { sdkSessionId: op.sdkSessionId } : {}),
    })
    .where(eq(schema.agentRuns.id, ctx.runId));

  await publish(ctx, {
    t: 'run.status',
    runId: ctx.runId,
    messageId: ctx.messageId,
    status: op.status,
    error: op.error ?? null,
  });
  await applyStatus(ctx, 'idle', null);

  if (purge) {
    await publish(ctx, {
      t: 'message.deleted',
      channelId: ctx.channelId,
      messageId: ctx.messageId,
      purged: true,
    });
    return;
  }

  // Ripubblica il messaggio completo con l'autore reale (nome/avatar).
  const [rows, agentRows] = await Promise.all([
    db.select().from(schema.messages).where(eq(schema.messages.id, ctx.messageId)).limit(1),
    db
      .select({
        name: schema.agents.name,
        handle: schema.agents.handle,
        avatarEmoji: schema.agents.avatarEmoji,
        avatarColor: schema.agents.avatarColor,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, ctx.agentId))
      .limit(1),
  ]);
  const row = rows[0];
  const agent = agentRows[0];
  if (row) {
    await publish(ctx, {
      t: 'message.updated',
      message: {
        id: row.id,
        channelId: row.channelId,
        threadRootId: row.threadRootId,
        steeredIntoRunId: row.steeredIntoRunId ?? null,
        replyTo: null,
        author: {
          type: 'agent',
          id: ctx.agentId,
          name: agent?.name ?? 'Agente',
          handle: agent?.handle ?? '',
          avatarEmoji: agent?.avatarEmoji ?? '🤖',
          avatarColor: agent?.avatarColor ?? '#8A8A80',
        },
        body: row.body,
        mentions: row.mentions as never,
        reactions: [],
        attachments: [],
        runId: row.runId,
        replyCount: row.replyCount,
        // È la risposta di un agente, non una radice: nessun thread appeso.
        threadLastReplyAt: null,
        threadParticipants: [],
        createdAt: row.createdAt.toISOString(),
        editedAt: row.editedAt?.toISOString() ?? null,
        deletedAt: null,
      },
    });
  }

  // Se nel frattempo sono arrivati altri messaggi, adesso tocca a loro.
  await flushPendingPrompts(ctx.agentId, ctx.channelId).catch(() => {});
}

export async function applyRunnerOps(ctx: RunSinkContext, ops: RunnerOp[]): Promise<void> {
  for (const op of ops) {
    switch (op.op) {
      case 'started':
        await db
          .update(schema.agentRuns)
          .set({ status: 'running', startedAt: new Date() })
          .where(eq(schema.agentRuns.id, ctx.runId));
        await publish(ctx, {
          t: 'run.status',
          runId: ctx.runId,
          messageId: ctx.messageId,
          status: 'running',
        });
        break;
      case 'status':
        await applyStatus(ctx, op.status, op.label);
        break;
      case 'delta':
        await publish(ctx, {
          t: 'run.delta',
          runId: ctx.runId,
          messageId: ctx.messageId,
          text: op.text,
        });
        break;
      case 'body':
        await db
          .update(schema.messages)
          .set({ body: op.text })
          .where(eq(schema.messages.id, ctx.messageId));
        break;
      case 'event': {
        // L'ora la decide il runner: gli eventi arrivano a lotti, e usare
        // quella del server appiattirebbe tutte le durate del lotto a zero.
        // Un `at` mancante è un runner più vecchio del campo.
        const at = typeof op.at === 'number' ? op.at : Date.now();
        await db
          .insert(schema.runEvents)
          .values({
            runId: ctx.runId,
            seq: op.seq,
            type: op.event.type,
            payload: op.event,
            createdAt: new Date(at),
          })
          .onConflictDoNothing();
        await publish(ctx, {
          t: 'run.event',
          runId: ctx.runId,
          messageId: ctx.messageId,
          event: op.event,
          at,
        });
        break;
      }
      case 'finish':
        await applyFinish(ctx, op);
        break;
    }
  }
}
