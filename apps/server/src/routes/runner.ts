import type { FastifyInstance } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireMembership, requireUser } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { createRunnerTokenSchema, redisChannels, type RunnerToken } from '@hive/shared';
import { redisPub } from '../lib/redis.js';

/** SHA-256 esadecimale del token: sul DB salviamo solo questo. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function serialize(
  row: typeof schema.runnerTokens.$inferSelect,
  online = false,
): RunnerToken {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revoked: row.revokedAt != null,
    online,
    host: row.lastHost ?? null,
    workdir: row.lastWorkdir ?? null,
  };
}

/** Quali di questi runner stanno rispondendo adesso. */
async function onlineIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      if (await redisPub.exists(redisChannels.runnerPresenceById(id))) out.add(id);
    }),
  );
  return out;
}

/**
 * Gestione dei token dei runner locali (lato utente, autenticato a sessione).
 * L'API vera e propria che il runner usa col token vive altrove.
 */
export async function runnerTokenRoutes(app: FastifyInstance): Promise<void> {
  /* ----------------------------------------------------------- genera token */
  app.post('/api/workspaces/:workspaceId/runner-tokens', async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const input = createRunnerTokenSchema.parse(request.body ?? {});

    // Token in chiaro mostrato UNA volta; sul DB solo l'hash.
    const token = `hrt_${randomBytes(24).toString('hex')}`;
    const inserted = await db
      .insert(schema.runnerTokens)
      .values({
        workspaceId,
        userId: user.id,
        tokenHash: hashToken(token),
        label: input.label ?? null,
      })
      .returning();

    return reply.code(201).send({ token, runnerToken: serialize(inserted[0]!) });
  });

  /* ------------------------------------------------------------ elenca token */
  app.get('/api/workspaces/:workspaceId/runner-tokens', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const rows = await db
      .select()
      .from(schema.runnerTokens)
      .where(
        and(
          eq(schema.runnerTokens.workspaceId, workspaceId),
          eq(schema.runnerTokens.userId, user.id),
          isNull(schema.runnerTokens.revokedAt),
        ),
      )
      .orderBy(desc(schema.runnerTokens.createdAt));
    const live = await onlineIds(rows.map((r) => r.id));
    return { runnerTokens: rows.map((r) => serialize(r, live.has(r.id))) };
  });

  /* ------------------------------------------------------------ revoca token */
  app.delete('/api/runner-tokens/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const user = await requireUser(request);
    const rows = await db
      .select()
      .from(schema.runnerTokens)
      .where(eq(schema.runnerTokens.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.userId !== user.id) throw notFound('Token non trovato');
    await db
      .update(schema.runnerTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.runnerTokens.id, id));
    return reply.code(204).send();
  });
}
