import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ArtifactContent } from '@hive/shared';
import * as schema from './schema.js';
import type { Database } from './index.js';

/**
 * Checklist e documenti del pannello, in un posto solo.
 *
 * Stanno qui e non nei tool dell'agente perché i tool sono DUE: quelli del
 * worker sul server, che parla col database, e quelli del runner sul computer
 * di una persona, che il database non lo vede e passa dagli endpoint HTTPS.
 * Finché la logica è vissuta solo nel primo, un agente `local` si sentiva
 * promettere nel prompt strumenti che nessuno gli passava — e non poteva
 * nemmeno LEGGERE la to-do del canale in cui stava lavorando.
 *
 * Ogni funzione fa solo il lavoro sul database e restituisce la riga toccata:
 * l'annuncio in tempo reale lo fa chi chiama, perché i due percorsi hanno due
 * strade diverse per arrivare alla chat (Redis di là, l'hub di qua).
 */

export type ArtifactRow = typeof schema.artifacts.$inferSelect;

/** Esito uniforme: un testo per l'agente, e la riga da annunciare se cambiata. */
export interface ArtifactResult {
  ok: boolean;
  text: string;
  row: ArtifactRow | null;
  kind: 'new' | 'updated' | null;
}

const fail = (text: string): ArtifactResult => ({ ok: false, text, row: null, kind: null });

/**
 * Il contenuto salvato non è mai dato per buono.
 *
 * È una colonna jsonb: ci può finire dentro una forma vecchia, o una voce
 * senza id scritta a mano. Normalizzare qui evita che ogni chiamante inventi
 * la sua idea di «checklist vuota».
 */
export function normalizeArtifactContent(type: string, content: unknown): ArtifactContent {
  const c = (content ?? {}) as Record<string, unknown>;
  if (type === 'checklist') {
    const items = Array.isArray(c.items) ? c.items : [];
    return {
      items: items.map((raw) => {
        const it = (raw ?? {}) as Record<string, unknown>;
        return {
          id: typeof it.id === 'string' ? it.id : randomUUID(),
          text: typeof it.text === 'string' ? it.text : '',
          done: Boolean(it.done),
        };
      }),
    };
  }
  return { markdown: typeof c.markdown === 'string' ? c.markdown : '' };
}

/** Un artifact vivo di QUESTO canale: l'id da solo non basta come permesso. */
async function loadArtifact(
  db: Database,
  channelId: string,
  id: string,
): Promise<ArtifactRow | null> {
  const rows = await db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, id),
        eq(schema.artifacts.channelId, channelId),
        isNull(schema.artifacts.archivedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Elenco leggibile, con gli id: servono per aggiornare quello giusto. */
export async function listArtifactsText(db: Database, channelId: string): Promise<string> {
  const rows = await db
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.channelId, channelId), isNull(schema.artifacts.archivedAt)))
    .orderBy(desc(schema.artifacts.updatedAt));
  if (rows.length === 0) return 'Nessun artifact in questo canale. Puoi crearne uno.';
  return rows
    .map((r) => {
      const content = normalizeArtifactContent(r.type, r.content);
      if (r.type === 'checklist' && 'items' in content) {
        const items = content.items
          .map((it) => `    - [${it.done ? 'x' : ' '}] (${it.id}) ${it.text}`)
          .join('\n');
        return `• checklist «${r.title || 'senza titolo'}» — id ${r.id}\n${items || '    (vuota)'}`;
      }
      const md = 'markdown' in content ? content.markdown : '';
      return `• documento «${r.title || 'senza titolo'}» — id ${r.id} (${md.length} caratteri)`;
    })
    .join('\n');
}

export async function createArtifact(
  db: Database,
  args: {
    workspaceId: string;
    channelId: string;
    agentId: string;
    type: 'checklist' | 'doc';
    title: string;
    items?: string[];
    markdown?: string;
  },
): Promise<ArtifactResult> {
  const content =
    args.type === 'checklist'
      ? { items: (args.items ?? []).map((text) => ({ id: randomUUID(), text, done: false })) }
      : { markdown: args.markdown ?? '' };
  const inserted = await db
    .insert(schema.artifacts)
    .values({
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      type: args.type,
      title: args.title,
      content,
      pinned: true,
      createdByType: 'agent',
      createdById: args.agentId,
      updatedByType: 'agent',
      updatedById: args.agentId,
    })
    .returning();
  const row = inserted[0]!;
  return { ok: true, text: `Creato «${args.title}» (id ${row.id}).`, row, kind: 'new' };
}

/** Le colonne di firma, identiche a ogni scrittura. */
const stamp = (agentId: string) => ({
  updatedAt: new Date(),
  updatedByType: 'agent' as const,
  updatedById: agentId,
});

export async function addChecklistItem(
  db: Database,
  args: { channelId: string; agentId: string; artifactId: string; text: string },
): Promise<ArtifactResult> {
  const row = await loadArtifact(db, args.channelId, args.artifactId);
  if (!row) return fail('Checklist non trovata in questo canale.');
  if (row.type !== 'checklist') return fail('Questo artifact non è una checklist.');
  const content = normalizeArtifactContent(row.type, row.content);
  const items = 'items' in content ? content.items : [];
  items.push({ id: randomUUID(), text: args.text, done: false });
  const updated = await db
    .update(schema.artifacts)
    .set({ content: { items }, ...stamp(args.agentId) })
    .where(eq(schema.artifacts.id, args.artifactId))
    .returning();
  return { ok: true, text: `Aggiunta la voce «${args.text}».`, row: updated[0]!, kind: 'updated' };
}

export async function checkChecklistItem(
  db: Database,
  args: {
    channelId: string;
    agentId: string;
    artifactId: string;
    itemId?: string;
    itemText?: string;
    done: boolean;
  },
): Promise<ArtifactResult> {
  const row = await loadArtifact(db, args.channelId, args.artifactId);
  if (!row) return fail('Checklist non trovata in questo canale.');
  if (row.type !== 'checklist') return fail('Questo artifact non è una checklist.');
  const content = normalizeArtifactContent(row.type, row.content);
  const items = 'items' in content ? content.items : [];
  const needle = args.itemText?.toLowerCase().trim();
  const target = items.find(
    (it) =>
      (args.itemId && it.id === args.itemId) || (needle && it.text.toLowerCase().includes(needle)),
  );
  if (!target) return fail('Voce non trovata: controlla id o testo con list_artifacts.');
  target.done = args.done;
  const updated = await db
    .update(schema.artifacts)
    .set({ content: { items }, ...stamp(args.agentId) })
    .where(eq(schema.artifacts.id, args.artifactId))
    .returning();
  return {
    ok: true,
    text: `«${target.text}» segnata come ${args.done ? 'fatta' : 'da fare'}.`,
    row: updated[0]!,
    kind: 'updated',
  };
}

export async function updateArtifact(
  db: Database,
  args: {
    channelId: string;
    agentId: string;
    artifactId: string;
    title?: string;
    markdown?: string;
  },
): Promise<ArtifactResult> {
  const row = await loadArtifact(db, args.channelId, args.artifactId);
  if (!row) return fail('Artifact non trovato in questo canale.');
  const set: Record<string, unknown> = stamp(args.agentId);
  if (args.title !== undefined) set.title = args.title;
  if (args.markdown !== undefined) {
    if (row.type !== 'doc') return fail('Solo i documenti hanno un contenuto markdown.');
    set.content = { markdown: args.markdown };
  }
  const updated = await db
    .update(schema.artifacts)
    .set(set)
    .where(eq(schema.artifacts.id, args.artifactId))
    .returning();
  return { ok: true, text: 'Artifact aggiornato.', row: updated[0]!, kind: 'updated' };
}
