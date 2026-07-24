import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMembership } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createDocumentSchema, updateDocumentSchema } from '@hive/shared';
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentBlob,
  listDocuments,
  updateDocument,
  uploadDocument,
} from '../services/documents.js';

const wsParam = z.object({ workspaceId: z.uuid() });
const wsDocParam = z.object({ workspaceId: z.uuid(), id: z.uuid() });

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------------------------- albero (indice) */
  app.get('/api/workspaces/:workspaceId/documents', async (request) => {
    const { workspaceId } = wsParam.parse(request.params);
    await requireMembership(request, workspaceId);
    return { documents: await listDocuments(workspaceId) };
  });

  /* -------------------------------------------------- un documento col contenuto */
  app.get('/api/workspaces/:workspaceId/documents/:id', async (request) => {
    const { workspaceId, id } = wsDocParam.parse(request.params);
    await requireMembership(request, workspaceId);
    const doc = await getDocument(workspaceId, id);
    if (!doc) throw notFound('Documento non trovato');
    return { document: doc };
  });

  /* -------------------------------------------------------- download del binario */
  app.get('/api/workspaces/:workspaceId/documents/:id/blob', async (request, reply) => {
    const { workspaceId, id } = wsDocParam.parse(request.params);
    await requireMembership(request, workspaceId);
    const blob = await getDocumentBlob(workspaceId, id);
    if (!blob) throw notFound('File non trovato');
    reply.header('content-type', blob.mime);
    reply.header('content-disposition', `inline; filename="${encodeURIComponent(blob.name)}"`);
    return reply.send(blob.buffer);
  });

  /* ------------------------------------------------ crea cartella o file di testo */
  app.post('/api/workspaces/:workspaceId/documents', async (request) => {
    const { workspaceId } = wsParam.parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const input = createDocumentSchema.parse(request.body);
    const doc = await createDocument(workspaceId, input, { type: 'user', id: user.id });
    return { document: doc };
  });

  /* ---------------------------------------------------------- carica un file (PDF…) */
  app.post('/api/workspaces/:workspaceId/documents/upload', async (request) => {
    const { workspaceId } = wsParam.parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const file = await request.file();
    if (!file) throw badRequest('no_file', 'Nessun file caricato.');
    const parentId = typeof file.fields.parentId === 'object' && file.fields.parentId && 'value' in file.fields.parentId
      ? String((file.fields.parentId as { value: unknown }).value) || null
      : null;
    const buffer = await file.toBuffer();
    const doc = await uploadDocument(
      workspaceId,
      {
        parentId: parentId && parentId !== 'null' ? parentId : null,
        name: file.filename,
        mime: file.mimetype || 'application/octet-stream',
        buffer,
      },
      { type: 'user', id: user.id },
    );
    return { document: doc };
  });

  /* ------------------------------------------------------------------ aggiorna */
  app.patch('/api/workspaces/:workspaceId/documents/:id', async (request) => {
    const { workspaceId, id } = wsDocParam.parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const input = updateDocumentSchema.parse(request.body);
    const doc = await updateDocument(workspaceId, id, input, { type: 'user', id: user.id });
    if (!doc) throw notFound('Documento non trovato');
    return { document: doc };
  });

  /* ------------------------------------------------------------------- cancella */
  app.delete('/api/workspaces/:workspaceId/documents/:id', async (request) => {
    const { workspaceId, id } = wsDocParam.parse(request.params);
    await requireMembership(request, workspaceId, 'member');
    const okDone = await deleteDocument(workspaceId, id);
    if (!okDone) throw notFound('Documento non trovato');
    return { ok: true };
  });
}
