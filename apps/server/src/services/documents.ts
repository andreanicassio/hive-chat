import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import type { DocumentNode, DocumentFull } from '@hive/shared';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { hub } from '../realtime/hub.js';

const execFileP = promisify(execFile);

type DocRow = typeof schema.documents.$inferSelect;
type Actor = { type: 'user' | 'agent'; id: string };

const uploadDir = () => join(env.HIVE_UPLOAD_ROOT, 'documents');

/** Riga DB → nodo dell'albero (senza contenuto). */
export function toDocumentNode(row: DocRow): DocumentNode {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind as DocumentNode['kind'],
    name: row.name,
    description: row.description,
    mime: row.mime,
    size: row.size,
    hasBlob: Boolean(row.storageKey),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function publishChanged(workspaceId: string, row: DocRow): Promise<void> {
  await hub.publish(workspaceId, {
    packet: { t: 'document.changed', workspaceId, document: toDocumentNode(row) },
  });
}

/** Tutti i nodi del workspace (l'indice). */
export async function listDocuments(workspaceId: string): Promise<DocumentNode[]> {
  const rows = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.workspaceId, workspaceId))
    .limit(2000);
  return rows.map(toDocumentNode);
}

/** Un documento col contenuto testuale (per l'editor / la lettura). */
export async function getDocument(workspaceId: string, id: string): Promise<DocumentFull | null> {
  const rows = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), eq(schema.documents.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...toDocumentNode(row), content: row.content ?? row.extractedText ?? null };
}

/** Bytes grezzi di un binario caricato (per il download / viewer PDF). */
export async function getDocumentBlob(
  workspaceId: string,
  id: string,
): Promise<{ buffer: Buffer; mime: string; name: string } | null> {
  const rows = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, id), eq(schema.documents.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.storageKey) return null;
  try {
    const buffer = await readFile(join(uploadDir(), row.storageKey));
    return { buffer, mime: row.mime ?? 'application/octet-stream', name: row.name };
  } catch {
    return null;
  }
}

export async function createDocument(
  workspaceId: string,
  input: { parentId: string | null; kind: 'folder' | 'file'; name: string; description?: string | null; content?: string },
  actor: Actor,
): Promise<DocumentNode> {
  const size = input.content != null ? Buffer.byteLength(input.content, 'utf8') : null;
  const inserted = await db
    .insert(schema.documents)
    .values({
      workspaceId,
      parentId: input.parentId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      mime: input.kind === 'file' ? 'text/markdown' : null,
      content: input.kind === 'file' ? (input.content ?? '') : null,
      size,
      createdByType: actor.type,
      createdById: actor.id,
    })
    .returning();
  const row = inserted[0]!;
  await publishChanged(workspaceId, row);
  return toDocumentNode(row);
}

export async function updateDocument(
  workspaceId: string,
  id: string,
  input: { name?: string; description?: string | null; content?: string; parentId?: string | null },
  actor: Actor,
): Promise<DocumentNode | null> {
  const set: Partial<DocRow> = {
    updatedByType: actor.type,
    updatedById: actor.id,
    updatedAt: new Date(),
  };
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.parentId !== undefined) set.parentId = input.parentId;
  if (input.content !== undefined) {
    set.content = input.content;
    set.size = Buffer.byteLength(input.content, 'utf8');
  }
  const updated = await db
    .update(schema.documents)
    .set(set)
    .where(and(eq(schema.documents.id, id), eq(schema.documents.workspaceId, workspaceId)))
    .returning();
  const row = updated[0];
  if (!row) return null;
  await publishChanged(workspaceId, row);
  return toDocumentNode(row);
}

/** Cancella un nodo e tutta la sua discendenza (cartelle → figli), coi binari. */
export async function deleteDocument(workspaceId: string, id: string): Promise<boolean> {
  const all = await db
    .select({ id: schema.documents.id, parentId: schema.documents.parentId, storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(eq(schema.documents.workspaceId, workspaceId))
    .limit(2000);
  if (!all.some((n) => n.id === id)) return false;

  // BFS della discendenza.
  const toDelete = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
        toDelete.add(n.id);
        grew = true;
      }
    }
  }

  // Rimuovi i binari dal disco.
  for (const n of all) {
    if (toDelete.has(n.id) && n.storageKey) {
      await rm(join(uploadDir(), n.storageKey)).catch(() => {});
    }
  }
  for (const docId of toDelete) {
    await db
      .delete(schema.documents)
      .where(and(eq(schema.documents.id, docId), eq(schema.documents.workspaceId, workspaceId)));
    await hub.publish(workspaceId, { packet: { t: 'document.deleted', workspaceId, documentId: docId } });
  }
  return true;
}

/** Estrae testo da un binario per renderlo leggibile agli agenti. */
async function extractText(path: string, mime: string): Promise<string | null> {
  try {
    if (mime === 'application/pdf') {
      const { stdout } = await execFileP('pdftotext', ['-q', '-enc', 'UTF-8', path, '-'], {
        maxBuffer: 20 * 1024 * 1024,
      });
      return stdout.trim() || null;
    }
    if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/markdown') {
      const buf = await readFile(path, 'utf8');
      return buf.slice(0, 400_000);
    }
  } catch {
    /* estrazione fallita: il file resta comunque scaricabile */
  }
  return null;
}

/** Salva un file caricato: binario su disco + testo estratto per gli agenti. */
export async function uploadDocument(
  workspaceId: string,
  args: { parentId: string | null; name: string; mime: string; buffer: Buffer },
  actor: Actor,
): Promise<DocumentNode> {
  await mkdir(uploadDir(), { recursive: true });
  // Inserisci prima per avere l'id (che è anche la storageKey).
  const inserted = await db
    .insert(schema.documents)
    .values({
      workspaceId,
      parentId: args.parentId,
      kind: 'file',
      name: args.name,
      mime: args.mime,
      size: args.buffer.byteLength,
      createdByType: actor.type,
      createdById: actor.id,
    })
    .returning();
  const row = inserted[0]!;
  const storageKey = row.id;
  const diskPath = join(uploadDir(), storageKey);
  await writeFile(diskPath, args.buffer);
  const extracted = await extractText(diskPath, args.mime);
  const updated = await db
    .update(schema.documents)
    .set({ storageKey, extractedText: extracted })
    .where(eq(schema.documents.id, row.id))
    .returning();
  const finalRow = updated[0]!;
  await publishChanged(workspaceId, finalRow);
  return toDocumentNode(finalRow);
}
