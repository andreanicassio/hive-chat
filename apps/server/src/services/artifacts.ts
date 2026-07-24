import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { hub } from '../realtime/hub.js';
import { loadActors, resolveActor } from './serialize.js';
import type {
  Artifact,
  ArtifactContent,
  CreateArtifactInput,
  ServerPacket,
  UpdateArtifactInput,
} from '@hive/shared';

/**
 * Artifacts: checklist e documenti che vivono accanto alla chat.
 *
 * Sia le persone (dal pannello) sia gli agenti (via tool) li creano e li
 * modificano, e ogni cambiamento viene rimbalzato in tempo reale a chi guarda
 * il canale, esattamente come un messaggio.
 */

type ArtifactRow = typeof schema.artifacts.$inferSelect;
type ActorKind = 'user' | 'agent';

/** Riporta il contenuto grezzo del DB alla forma tipizzata per il tipo. */
function normalizeContent(type: string, content: unknown): ArtifactContent {
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

export async function serializeArtifact(row: ArtifactRow): Promise<Artifact> {
  const refs: Array<{ type: string; id: string | null }> = [
    { type: row.createdByType, id: row.createdById },
  ];
  if (row.updatedByType) refs.push({ type: row.updatedByType, id: row.updatedById });
  const map = await loadActors(refs);
  return {
    id: row.id,
    channelId: row.channelId,
    type: row.type as Artifact['type'],
    title: row.title,
    content: normalizeContent(row.type, row.content),
    pinned: row.pinned,
    createdBy: resolveActor(map, row.createdByType, row.createdById),
    updatedBy: row.updatedByType ? resolveActor(map, row.updatedByType, row.updatedById) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listArtifacts(channelId: string): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.channelId, channelId), isNull(schema.artifacts.archivedAt)))
    .orderBy(desc(schema.artifacts.updatedAt));
  return Promise.all(rows.map(serializeArtifact));
}

async function broadcast(workspaceId: string, artifact: Artifact, kind: 'new' | 'updated'): Promise<void> {
  const packet: ServerPacket =
    kind === 'new'
      ? { t: 'artifact.new', artifact }
      : { t: 'artifact.updated', artifact };
  await hub.publish(workspaceId, { packet, channelId: artifact.channelId });
}

export async function createArtifact(args: {
  workspaceId: string;
  channelId: string;
  createdBy: { type: ActorKind; id: string };
  input: CreateArtifactInput;
}): Promise<Artifact> {
  const content: ArtifactContent =
    args.input.type === 'checklist'
      ? {
          items: (args.input.items ?? []).map((it) => ({
            id: randomUUID(),
            text: it.text,
            done: it.done ?? false,
          })),
        }
      : { markdown: args.input.markdown ?? '' };

  const inserted = await db
    .insert(schema.artifacts)
    .values({
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      type: args.input.type,
      title: args.input.title ?? '',
      content,
      pinned: true,
      createdByType: args.createdBy.type,
      createdById: args.createdBy.id,
      updatedByType: args.createdBy.type,
      updatedById: args.createdBy.id,
    })
    .returning();
  const artifact = await serializeArtifact(inserted[0]!);
  await broadcast(args.workspaceId, artifact, 'new');
  return artifact;
}

export async function updateArtifact(args: {
  artifactId: string;
  updatedBy: { type: ActorKind; id: string };
  patch: UpdateArtifactInput;
}): Promise<Artifact | null> {
  const rows = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, args.artifactId))
    .limit(1);
  const row = rows[0];
  if (!row || row.archivedAt) return null;

  const set: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedByType: args.updatedBy.type,
    updatedById: args.updatedBy.id,
  };
  if (args.patch.title !== undefined) set.title = args.patch.title;
  if (args.patch.pinned !== undefined) set.pinned = args.patch.pinned;
  if (args.patch.content !== undefined) {
    set.content =
      'items' in args.patch.content
        ? { items: args.patch.content.items }
        : { markdown: args.patch.content.markdown };
  }

  const updated = await db
    .update(schema.artifacts)
    .set(set)
    .where(eq(schema.artifacts.id, args.artifactId))
    .returning();
  const artifact = await serializeArtifact(updated[0]!);
  await broadcast(row.workspaceId, artifact, 'updated');
  return artifact;
}

export async function archiveArtifact(
  artifactId: string,
): Promise<{ workspaceId: string; channelId: string } | null> {
  const rows = await db
    .select({
      workspaceId: schema.artifacts.workspaceId,
      channelId: schema.artifacts.channelId,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  await db
    .update(schema.artifacts)
    .set({ archivedAt: new Date() })
    .where(eq(schema.artifacts.id, artifactId));
  await hub.publish(row.workspaceId, {
    packet: { t: 'artifact.deleted', channelId: row.channelId, artifactId },
    channelId: row.channelId,
  });
  return row;
}
