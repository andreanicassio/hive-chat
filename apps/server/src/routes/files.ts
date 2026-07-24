import type { FastifyInstance } from 'fastify';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { requireMembership, requireChannelAccess, requireUser } from '../lib/auth.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';

/**
 * Allegati dei messaggi (immagini e file trascinati in chat).
 *
 * Il binario sta su disco, il record sul database. L'allegato nasce senza
 * messaggio (si carica mentre si sta ancora scrivendo) e viene agganciato
 * quando il messaggio parte davvero.
 */

const attachmentDir = () => join(env.HIVE_UPLOAD_ROOT, 'attachments');

/** Estensione plausibile dal tipo, per dare un nome utile agli agenti. */
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

export function isViewableImage(mime: string): boolean {
  // Quelli che Claude sa guardare davvero.
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------- carica */
  app.post('/api/workspaces/:workspaceId/files', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');

    const file = await request.file();
    if (!file) throw badRequest('no_file', 'Nessun file caricato.');
    const buffer = await file.toBuffer();
    const mime = file.mimetype || 'application/octet-stream';

    await mkdir(attachmentDir(), { recursive: true });
    const inserted = await db
      .insert(schema.attachments)
      .values({
        workspaceId,
        filename: file.filename || `allegato.${EXT[mime] ?? 'bin'}`,
        mime,
        size: buffer.byteLength,
        // Il percorso definitivo lo scriviamo subito dopo, con l'id.
        storagePath: '',
        uploadedBy: user.id,
      })
      .returning();
    const row = inserted[0]!;
    const path = join(attachmentDir(), row.id);
    await writeFile(path, buffer);
    await db
      .update(schema.attachments)
      .set({ storagePath: path })
      .where(eq(schema.attachments.id, row.id));

    return {
      attachment: {
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        url: `/api/files/${row.id}`,
      },
    };
  });

  /* -------------------------------------------------------------- scarica */
  app.get('/api/files/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, id))
      .limit(1);
    const att = rows[0];
    if (!att) throw notFound('File non trovato');

    if (att.messageId) {
      // Agganciato a un messaggio: vale l'accesso al canale di quel messaggio.
      const msg = await db
        .select({ channelId: schema.messages.channelId })
        .from(schema.messages)
        .where(eq(schema.messages.id, att.messageId))
        .limit(1);
      if (!msg[0]) throw notFound('File non trovato');
      await requireChannelAccess(request, msg[0].channelId);
    } else {
      // Non ancora inviato: lo vede solo chi l'ha caricato.
      const user = requireUser(request);
      if (att.uploadedBy !== user.id) throw forbidden('Questo file non è tuo.');
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(att.storagePath);
    } catch {
      throw notFound('File non più disponibile');
    }
    reply.header('content-type', att.mime);
    reply.header('cache-control', 'private, max-age=86400');
    reply.header(
      'content-disposition',
      `inline; filename="${encodeURIComponent(att.filename)}"`,
    );
    return reply.send(buffer);
  });
}
