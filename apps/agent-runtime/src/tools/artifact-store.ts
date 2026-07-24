import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from '../db.js';
import { redis } from '../redis.js';
import {
  redisChannels,
  type ActorRef,
  type Artifact,
  type ArtifactContent,
  type ServerPacket,
} from '@hive/shared';

/**
 * Lato runtime degli artifacts: gli agenti li creano e li aggiornano dai
 * tool, scrivono direttamente sul DB e pubblicano su Redis lo stesso pacchetto
 * che la chat riceve per i messaggi. Così una spunta messa dall'agente compare
 * subito nel pannello di chi sta guardando.
 */

export type ArtifactRow = typeof schema.artifacts.$inferSelect;

async function actorRef(type: string | null, id: string | null): Promise<ActorRef> {
  const fallback: ActorRef = {
    type: type === 'agent' ? 'agent' : 'user',
    id: id ?? 'unknown',
    name: type === 'agent' ? 'Agente' : 'Utente',
    handle: 'sconosciuto',
    avatarEmoji: null,
    avatarColor: '#8A8A80',
  };
  if (!type || !id) return fallback;
  if (type === 'agent') {
    const r = (
      await db
        .select({
          name: schema.agents.name,
          handle: schema.agents.handle,
          avatarEmoji: schema.agents.avatarEmoji,
          avatarColor: schema.agents.avatarColor,
        })
        .from(schema.agents)
        .where(eq(schema.agents.id, id))
        .limit(1)
    )[0];
    return r
      ? { type: 'agent', id, name: r.name, handle: r.handle, avatarEmoji: r.avatarEmoji, avatarColor: r.avatarColor }
      : fallback;
  }
  const r = (
    await db
      .select({
        name: schema.users.name,
        handle: schema.users.handle,
        avatarEmoji: schema.users.avatarEmoji,
        avatarColor: schema.users.avatarColor,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
  )[0];
  return r
    ? { type: 'user', id, name: r.name, handle: r.handle, avatarEmoji: r.avatarEmoji, avatarColor: r.avatarColor }
    : fallback;
}

export function normalizeContent(type: string, content: unknown): ArtifactContent {
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
  return {
    id: row.id,
    channelId: row.channelId,
    type: row.type as Artifact['type'],
    title: row.title,
    content: normalizeContent(row.type, row.content),
    pinned: row.pinned,
    createdBy: await actorRef(row.createdByType, row.createdById),
    updatedBy: row.updatedByType ? await actorRef(row.updatedByType, row.updatedById) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Scrive il pacchetto realtime su Redis, come fa l'emitter per i messaggi. */
export async function publishArtifact(
  workspaceId: string,
  row: ArtifactRow,
  kind: 'new' | 'updated',
): Promise<Artifact> {
  const artifact = await serializeArtifact(row);
  const packet: ServerPacket =
    kind === 'new' ? { t: 'artifact.new', artifact } : { t: 'artifact.updated', artifact };
  await redis.publish(
    redisChannels.workspace(workspaceId),
    JSON.stringify({ packet, channelId: artifact.channelId }),
  );
  return artifact;
}
