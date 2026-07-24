import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireChannelAccess } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import {
  archiveArtifact,
  createArtifact,
  listArtifacts,
  updateArtifact,
} from '../services/artifacts.js';
import { createArtifactSchema, updateArtifactSchema } from '@hive/shared';

/** Risolve il canale di un artifact, per riusare la guardia sul canale. */
async function channelOf(artifactId: string): Promise<string> {
  const rows = await db
    .select({ channelId: schema.artifacts.channelId, archivedAt: schema.artifacts.archivedAt })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row || row.archivedAt) throw notFound('Artifact non trovato');
  return row.channelId;
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------------------- elenco di un canale */
  app.get('/api/channels/:channelId/artifacts', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    await requireChannelAccess(request, channelId);
    return { artifacts: await listArtifacts(channelId) };
  });

  /* ------------------------------------------------------------- creazione */
  app.post('/api/channels/:channelId/artifacts', async (request, reply) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { user, workspaceId } = await requireChannelAccess(request, channelId, 'member');
    const input = createArtifactSchema.parse(request.body);
    const artifact = await createArtifact({
      workspaceId,
      channelId,
      createdBy: { type: 'user', id: user.id },
      input,
    });
    return reply.code(201).send({ artifact });
  });

  /* -------------------------------------------------------------- modifica */
  app.patch('/api/artifacts/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const channelId = await channelOf(id);
    const { user } = await requireChannelAccess(request, channelId, 'member');
    const patch = updateArtifactSchema.parse(request.body);
    const artifact = await updateArtifact({
      artifactId: id,
      updatedBy: { type: 'user', id: user.id },
      patch,
    });
    if (!artifact) throw notFound('Artifact non trovato');
    return { artifact };
  });

  /* ------------------------------------------------------------ rimozione */
  app.delete('/api/artifacts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const channelId = await channelOf(id);
    await requireChannelAccess(request, channelId, 'member');
    await archiveArtifact(id);
    return reply.code(204).send();
  });
}
