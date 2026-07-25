import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireChannelAccess, requireMembership } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { redisPub } from '../lib/redis.js';
import { hub } from '../realtime/hub.js';
import { serializeApproval } from '../services/serialize.js';
import { cancelRun } from '../services/messages.js';
import {
  decideApprovalSchema,
  redisChannels,
  type ApprovalReply,
} from '@hive/shared';

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------- approvazioni ancora in attesa */
  app.get('/api/workspaces/:workspaceId/approvals', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId);

    const rows = await db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.workspaceId, workspaceId),
          eq(schema.approvals.status, 'pending'),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(50);

    return { approvals: await Promise.all(rows.map(serializeApproval)) };
  });

  /* ------------------------------------------------- decidi (consenti/nega) */
  app.post('/api/approvals/:approvalId/decide', async (request) => {
    const { approvalId } = z.object({ approvalId: z.uuid() }).parse(request.params);
    const input = decideApprovalSchema.parse(request.body);

    const rows = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approvalId))
      .limit(1);
    const approval = rows[0];
    if (!approval) throw notFound('Richiesta non trovata');

    // Chi decide deve avere accesso al canale in cui l'agente sta lavorando.
    const { user } = await requireChannelAccess(request, approval.channelId, 'member');

    if (approval.status !== 'pending') {
      throw badRequest(
        'already_decided',
        `Questa richiesta è già stata ${approval.status === 'allowed' ? 'approvata' : 'rifiutata'}`,
      );
    }
    if (approval.expiresAt <= new Date()) {
      await db
        .update(schema.approvals)
        .set({ status: 'expired' })
        .where(eq(schema.approvals.id, approvalId));
      throw badRequest('expired', 'La richiesta è scaduta: chiedi all’agente di riprovare');
    }

    const updated = await db
      .update(schema.approvals)
      .set({
        status: input.allowed ? 'allowed' : 'denied',
        decidedBy: user.id,
        decidedAt: new Date(),
        reason: input.reason ?? null,
      })
      .where(
        // Doppio controllo sullo stato: se due persone cliccano insieme,
        // solo la prima scrive e la seconda riceve "già deciso".
        and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, 'pending')),
      )
      .returning();

    const row = updated[0];
    if (!row) throw badRequest('already_decided', 'Qualcun altro ha già deciso');

    const serialized = await serializeApproval(row);

    // Sveglia il worker che sta aspettando la risposta.
    const reply: ApprovalReply = {
      approvalId,
      allowed: input.allowed,
      reason: input.reason ?? null,
      decidedBy: user.id,
    };
    await redisPub.publish(redisChannels.approvalReply(approvalId), JSON.stringify(reply));

    await hub.publish(approval.workspaceId, {
      packet: { t: 'approval.resolved', approval: serialized },
      channelId: approval.channelId,
    });

    return { approval: serialized };
  });

  /* --------------------------------------------- storico run di un canale */
  app.get('/api/channels/:channelId/runs', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    await requireChannelAccess(request, channelId);

    const rows = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.channelId, channelId))
      .orderBy(desc(schema.agentRuns.queuedAt))
      .limit(50);

    return {
      runs: rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        channelId: r.channelId,
        triggerMessageId: r.triggerMessageId,
        responseMessageId: r.responseMessageId,
        sdkSessionId: r.sdkSessionId,
        status: r.status,
        error: r.error,
        numTurns: r.numTurns,
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        queuedAt: r.queuedAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        endedAt: r.endedAt?.toISOString() ?? null,
      })),
    };
  });

  /** Traccia completa di un run: tool usati, output, errori. */
  app.get('/api/runs/:runId/events', async (request) => {
    const { runId } = z.object({ runId: z.uuid() }).parse(request.params);
    const rows = await db
      .select({ channelId: schema.agentRuns.channelId })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);
    const run = rows[0];
    if (!run) throw notFound('Esecuzione non trovata');
    await requireChannelAccess(request, run.channelId);

    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.seq);

    return {
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  /** Interrompe un run in corso. */
  app.post('/api/runs/:runId/cancel', async (request) => {
    const { runId } = z.object({ runId: z.uuid() }).parse(request.params);
    const rows = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);
    const run = rows[0];
    if (!run) throw notFound('Esecuzione non trovata');
    await requireChannelAccess(request, run.channelId, 'member');

    const { alreadyFinished } = await cancelRun(runId);
    return { ok: true, ...(alreadyFinished ? { alreadyFinished } : {}) };
  });
}
