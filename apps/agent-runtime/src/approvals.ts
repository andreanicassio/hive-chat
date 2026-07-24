import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';
import { redis, redisSub } from './redis.js';
import { env } from './env.js';
import {
  approvalReplySchema,
  redisChannels,
  type Approval,
  type ServerPacket,
} from '@hive/shared';
import type { EmitterLike } from './emitter.js';

/**
 * Chiede a un umano il permesso di eseguire un'azione irreversibile.
 *
 * Il flusso: creiamo la richiesta su DB, la pubblichiamo in chat come card,
 * poi ci mettiamo in ascolto su un canale Redis dedicato finché qualcuno
 * decide o finché scade il tempo. Il run resta fermo nel frattempo — è
 * esattamente il comportamento che vogliamo per un `git push`.
 */

export interface ApprovalRequest {
  runId: string;
  workspaceId: string;
  channelId: string;
  agentId: string;
  toolName: string;
  /** Riga di intestazione della card, es. "Vuole fare push su main". */
  title: string;
  /** Il comando o il diff esatto, mostrato in monospace. */
  detail: string;
  input: unknown;
}

export interface ApprovalOutcome {
  allowed: boolean;
  reason: string | null;
  /** Vero se nessuno ha risposto in tempo. */
  timedOut: boolean;
}

export async function requestApproval(
  req: ApprovalRequest,
  emitter: EmitterLike,
): Promise<ApprovalOutcome> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + env.APPROVAL_TIMEOUT_MS);

  const inserted = await db
    .insert(schema.approvals)
    .values({
      id,
      runId: req.runId,
      workspaceId: req.workspaceId,
      channelId: req.channelId,
      agentId: req.agentId,
      toolName: req.toolName,
      title: req.title.slice(0, 280),
      detail: req.detail.slice(0, 20_000),
      input: req.input as object,
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

  await redis.publish(
    redisChannels.workspace(req.workspaceId),
    JSON.stringify({
      packet: { t: 'approval.requested', approval } satisfies ServerPacket,
      channelId: req.channelId,
    }),
  );

  await emitter.event({ type: 'approval.requested', approvalId: id });
  await emitter.status('waiting', `In attesa di conferma: ${req.title}`);

  await db
    .update(schema.agentRuns)
    .set({ status: 'awaiting_approval' })
    .where(eq(schema.agentRuns.id, req.runId));
  await emitter.runStatus('awaiting_approval');

  const outcome = await waitForDecision(id);

  if (outcome.timedOut) {
    await db
      .update(schema.approvals)
      .set({ status: 'expired' })
      .where(eq(schema.approvals.id, id));
  }

  await db
    .update(schema.agentRuns)
    .set({ status: 'running' })
    .where(eq(schema.agentRuns.id, req.runId));
  await emitter.runStatus('running');
  await emitter.event({
    type: 'approval.resolved',
    approvalId: id,
    allowed: outcome.allowed,
  });

  return outcome;
}

/**
 * Attende la decisione su un canale Redis dedicato.
 *
 * Usiamo una connessione subscriber separata per ogni attesa: sono eventi
 * rari (un push, un deploy) e così non c'è da smistare messaggi fra attese
 * concorrenti sulla stessa connessione.
 */
function waitForDecision(approvalId: string): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const channel = redisChannels.approvalReply(approvalId);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      redisSub.off('message', onMessage);
      void redisSub.unsubscribe(channel).catch(() => {});
    };

    const finish = (outcome: ApprovalOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const onMessage = (ch: string, raw: string) => {
      if (ch !== channel) return;
      try {
        const parsed = approvalReplySchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        finish({ allowed: parsed.data.allowed, reason: parsed.data.reason, timedOut: false });
      } catch {
        /* payload malformato: continuiamo ad aspettare */
      }
    };

    const timer = setTimeout(
      () =>
        finish({
          allowed: false,
          reason: 'Nessuno ha risposto entro il tempo previsto',
          timedOut: true,
        }),
      env.APPROVAL_TIMEOUT_MS,
    );

    redisSub.on('message', onMessage);
    void redisSub.subscribe(channel).catch(() => {
      finish({
        allowed: false,
        reason: 'Impossibile mettersi in ascolto della risposta',
        timedOut: false,
      });
    });

    // Se la decisione è arrivata prima che ci iscrivessimo (corsa possibile
    // se l'utente è velocissimo), leggiamola direttamente da DB.
    void (async () => {
      const rows = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.id, approvalId))
        .limit(1);
      const row = rows[0];
      if (row && row.status !== 'pending') {
        finish({
          allowed: row.status === 'allowed',
          reason: row.reason,
          timedOut: row.status === 'expired',
        });
      }
    })().catch(() => {});
  });
}
