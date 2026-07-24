import { and, eq } from 'drizzle-orm';
import * as schema from './schema.js';
import type { Database } from './index.js';
import { renderDocumentTree, type DocNode } from './documents-index.js';

/**
 * Operazioni sull'albero Documenti guidate dai PERCORSI (es. "specs/auth.md").
 * Una sola implementazione, condivisa fra i tool degli agenti (worker) e gli
 * endpoint del runner a token — così la semantica è identica ovunque.
 */

export interface DocActor {
  type: 'user' | 'agent';
  id: string;
}

type FullNode = DocNode & {
  content: string | null;
  extractedText: string | null;
  storageKey: string | null;
};

export function splitDocPath(p: string): string[] {
  return p
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function listDocNodes(db: Database, workspaceId: string): Promise<FullNode[]> {
  return db
    .select({
      id: schema.documents.id,
      parentId: schema.documents.parentId,
      kind: schema.documents.kind,
      name: schema.documents.name,
      description: schema.documents.description,
      mime: schema.documents.mime,
      content: schema.documents.content,
      extractedText: schema.documents.extractedText,
      storageKey: schema.documents.storageKey,
    })
    .from(schema.documents)
    .where(eq(schema.documents.workspaceId, workspaceId))
    .limit(2000);
}

export async function documentTreeText(db: Database, workspaceId: string): Promise<string> {
  return renderDocumentTree(await listDocNodes(db, workspaceId));
}

function resolvePath(nodes: DocNode[], parts: string[]): DocNode | null {
  let parentId: string | null = null;
  let node: DocNode | null = null;
  for (const part of parts) {
    node =
      nodes.find(
        (n) => (n.parentId ?? null) === parentId && n.name.toLowerCase() === part.toLowerCase(),
      ) ?? null;
    if (!node) return null;
    parentId = node.id;
  }
  return node;
}

/** Legge un documento per percorso. Ritorna testo o l'elenco se è una cartella. */
export async function readDocByPath(
  db: Database,
  workspaceId: string,
  path: string,
): Promise<{ ok: boolean; text: string }> {
  const nodes = await listDocNodes(db, workspaceId);
  const parts = splitDocPath(path);
  if (parts.length === 0) return { ok: false, text: 'Percorso vuoto.' };
  const node = resolvePath(nodes, parts);
  if (!node) {
    const tree = renderDocumentTree(nodes);
    return {
      ok: false,
      text: `Non trovo "${path}".` + (tree ? ` Documenti disponibili:\n\n${tree}` : ' La base è vuota.'),
    };
  }
  if (node.kind === 'folder') {
    const sub = nodes.filter((n) => n.id === node.id || n.parentId === node.id);
    const tree = renderDocumentTree(sub);
    const kids = nodes.filter((n) => n.parentId === node.id);
    return {
      ok: true,
      text: kids.length ? `"${path}" è una cartella. Contenuto:\n\n${tree}` : `"${path}" è una cartella vuota.`,
    };
  }
  const full = nodes.find((n) => n.id === node.id)!;
  const body = full.content ?? full.extractedText ?? '';
  if (!body.trim() && full.storageKey) {
    return { ok: true, text: `(${path} è un file caricato ma non ne è ancora stato estratto il testo.)` };
  }
  return { ok: true, text: body || `(${path} è vuoto.)` };
}

/** Crea/aggiorna una nota markdown per percorso, creando le cartelle mancanti. */
export async function writeDocByPath(
  db: Database,
  workspaceId: string,
  path: string,
  content: string,
  opts: { description?: string; actor: DocActor },
): Promise<{ created: boolean; id: string; path: string }> {
  const parts = splitDocPath(path);
  if (parts.length === 0) throw new Error('Percorso vuoto.');
  const fileName = parts[parts.length - 1]!;
  const folderParts = parts.slice(0, -1);

  let nodes = await listDocNodes(db, workspaceId);
  let parentId: string | null = null;
  for (const folder of folderParts) {
    const existing = nodes.find(
      (n) =>
        (n.parentId ?? null) === parentId &&
        n.kind === 'folder' &&
        n.name.toLowerCase() === folder.toLowerCase(),
    );
    if (existing) {
      parentId = existing.id;
    } else {
      const ins: Array<{ id: string }> = await db
        .insert(schema.documents)
        .values({
          workspaceId,
          parentId,
          kind: 'folder',
          name: folder,
          createdByType: opts.actor.type,
          createdById: opts.actor.id,
        })
        .returning({ id: schema.documents.id });
      parentId = ins[0]!.id;
      nodes = await listDocNodes(db, workspaceId);
    }
  }

  const size = Buffer.byteLength(content, 'utf8');
  const existingFile = nodes.find(
    (n) =>
      (n.parentId ?? null) === parentId &&
      n.kind === 'file' &&
      n.name.toLowerCase() === fileName.toLowerCase(),
  );
  if (existingFile) {
    await db
      .update(schema.documents)
      .set({
        content,
        size,
        mime: 'text/markdown',
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        updatedByType: opts.actor.type,
        updatedById: opts.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, existingFile.id));
    return { created: false, id: existingFile.id, path };
  }
  const ins: Array<{ id: string }> = await db
    .insert(schema.documents)
    .values({
      workspaceId,
      parentId,
      kind: 'file',
      name: fileName,
      mime: 'text/markdown',
      content,
      size,
      description: opts.description ?? null,
      createdByType: opts.actor.type,
      createdById: opts.actor.id,
    })
    .returning({ id: schema.documents.id });
  return { created: true, id: ins[0]!.id, path };
}
