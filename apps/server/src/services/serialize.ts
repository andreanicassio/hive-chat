import { and, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type {
  ActorRef,
  Agent,
  Approval,
  Channel,
  Message,
  Reaction,
  MentionRef,
  ReplyPreview,
} from '@hive/shared';

/* ---------------------------------------------------------------------------
 * Attori
 * ------------------------------------------------------------------------ */

const SYSTEM_ACTOR: ActorRef = {
  type: 'system',
  id: '00000000-0000-0000-0000-000000000000',
  name: 'Hive',
  handle: 'hive',
  avatarEmoji: '🐝',
  avatarColor: '#B8873B',
};

/**
 * Carica in blocco gli attori (utenti e agenti) citati da un insieme di
 * messaggi. Una sola query per tipo, così niente N+1 sullo scroll.
 */
export async function loadActors(
  refs: Array<{ type: string; id: string | null }>,
): Promise<Map<string, ActorRef>> {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const r of refs) {
    if (!r.id) continue;
    if (r.type === 'user') userIds.add(r.id);
    else if (r.type === 'agent') agentIds.add(r.id);
  }

  const map = new Map<string, ActorRef>();

  if (userIds.size > 0) {
    const rows = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        handle: schema.users.handle,
        avatarEmoji: schema.users.avatarEmoji,
        avatarColor: schema.users.avatarColor,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, [...userIds]));
    for (const r of rows) {
      map.set(`user:${r.id}`, {
        type: 'user',
        id: r.id,
        name: r.name,
        handle: r.handle,
        avatarEmoji: r.avatarEmoji,
        avatarColor: r.avatarColor,
      });
    }
  }

  if (agentIds.size > 0) {
    const rows = await db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        handle: schema.agents.handle,
        avatarEmoji: schema.agents.avatarEmoji,
        avatarColor: schema.agents.avatarColor,
      })
      .from(schema.agents)
      .where(inArray(schema.agents.id, [...agentIds]));
    for (const r of rows) {
      map.set(`agent:${r.id}`, {
        type: 'agent',
        id: r.id,
        name: r.name,
        handle: r.handle,
        avatarEmoji: r.avatarEmoji,
        avatarColor: r.avatarColor,
      });
    }
  }

  return map;
}

export function resolveActor(
  map: Map<string, ActorRef>,
  type: string,
  id: string | null,
): ActorRef {
  if (type === 'system' || !id) return SYSTEM_ACTOR;
  return (
    map.get(`${type}:${id}`) ?? {
      type: type === 'agent' ? 'agent' : 'user',
      id,
      // L'attore è stato cancellato: mostriamo un segnaposto invece di rompere.
      name: type === 'agent' ? 'Agente rimosso' : 'Utente rimosso',
      handle: 'sconosciuto',
      avatarEmoji: null,
      avatarColor: '#8A8A80',
    }
  );
}

/* ---------------------------------------------------------------------------
 * Messaggi
 * ------------------------------------------------------------------------ */

type MessageRow = typeof schema.messages.$inferSelect;

/**
 * Quanti volti mostrare nella barra «N risposte». Il conteggio resta
 * `replyCount`: questi servono solo alla pila di avatar, che oltre i 4
 * diventa illeggibile.
 */
const THREAD_FACES = 4;

/**
 * Trasforma le righe messaggio in DTO completi, caricando in blocco
 * autori, reazioni e allegati.
 *
 * `viewer` serve per marcare le reazioni proprie.
 */
export async function serializeMessages(
  rows: MessageRow[],
  viewer: { type: 'user' | 'agent'; id: string } | null,
): Promise<Message[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const actors = await loadActors(
    rows.map((r) => ({ type: r.authorType, id: r.authorId })),
  );

  // Reazioni, raggruppate per messaggio ed emoji.
  const reactionRows = await db
    .select({
      messageId: schema.reactions.messageId,
      actorType: schema.reactions.actorType,
      actorId: schema.reactions.actorId,
      emoji: schema.reactions.emoji,
    })
    .from(schema.reactions)
    .where(inArray(schema.reactions.messageId, ids));

  const reactionActors = await loadActors(
    reactionRows.map((r) => ({ type: r.actorType, id: r.actorId })),
  );

  const reactionsByMessage = new Map<string, Map<string, Reaction>>();
  for (const r of reactionRows) {
    let byEmoji = reactionsByMessage.get(r.messageId);
    if (!byEmoji) {
      byEmoji = new Map();
      reactionsByMessage.set(r.messageId, byEmoji);
    }
    let entry = byEmoji.get(r.emoji);
    if (!entry) {
      entry = { emoji: r.emoji, count: 0, mine: false, actors: [] };
      byEmoji.set(r.emoji, entry);
    }
    entry.count++;
    if (viewer && viewer.type === r.actorType && viewer.id === r.actorId) {
      entry.mine = true;
    }
    const actor = resolveActor(reactionActors, r.actorType, r.actorId);
    entry.actors.push({ type: actor.type, id: actor.id, name: actor.name });
  }

  // Allegati.
  const attachmentRows = await db
    .select()
    .from(schema.attachments)
    .where(inArray(schema.attachments.messageId, ids));

  const attachmentsByMessage = new Map<string, Message['attachments']>();
  for (const a of attachmentRows) {
    if (!a.messageId) continue;
    const list = attachmentsByMessage.get(a.messageId) ?? [];
    list.push({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      url: `/api/files/${a.id}`,
    });
    attachmentsByMessage.set(a.messageId, list);
  }

  // Anteprime dei messaggi citati: una query per tutti quelli con replyTo.
  const replyIds = rows.map((r) => r.replyToId).filter((id): id is string => Boolean(id));
  const replyPreviews = new Map<string, ReplyPreview>();
  if (replyIds.length > 0) {
    const quoted = await db
      .select({
        id: schema.messages.id,
        authorType: schema.messages.authorType,
        authorId: schema.messages.authorId,
        body: schema.messages.body,
        deletedAt: schema.messages.deletedAt,
      })
      .from(schema.messages)
      .where(inArray(schema.messages.id, replyIds));
    const quotedActors = await loadActors(
      quoted.map((q) => ({ type: q.authorType, id: q.authorId })),
    );
    for (const q of quoted) {
      const actor = resolveActor(quotedActors, q.authorType, q.authorId);
      // L'anteprima è testo semplice: togliamo il markup delle menzioni.
      const plain = q.body.replace(/<@([a-z0-9._-]+)>/g, '@$1').replace(/<#([a-z0-9-]+)>/g, '#$1');
      replyPreviews.set(q.id, {
        id: q.id,
        authorName: actor.name,
        authorType: actor.type,
        excerpt: q.deletedAt ? '' : plain.slice(0, 140),
        deleted: Boolean(q.deletedAt),
      });
    }
  }

  // Riepilogo dei thread. Una query sola per tutte le radici del set: il
  // raggruppamento per (radice, autore) fa uscire poche righe anche da thread
  // lunghissimi, e la finestra sulla partizione porta con sé l'ora dell'ultima
  // risposta senza una seconda passata.
  const rootIds = rows.filter((r) => r.replyCount > 0).map((r) => r.id);
  const lastReplyAt = new Map<string, string>();
  const participantsByRoot = new Map<string, ActorRef[]>();
  if (rootIds.length > 0) {
    const summary = await db
      .select({
        rootId: schema.messages.threadRootId,
        authorType: schema.messages.authorType,
        authorId: schema.messages.authorId,
        // Le date calcolate in SQL tornano come testo grezzo (il driver
        // applica i suoi parser solo alle colonne vere), quindi le facciamo
        // già formattare in ISO da Postgres: niente parsing a indovinare.
        firstAt: raw<string>`to_char(min(${schema.messages.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        lastAt: raw<string>`to_char((max(max(${schema.messages.createdAt})) over (partition by ${schema.messages.threadRootId})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.threadRootId, rootIds),
          isNull(schema.messages.deletedAt),
        ),
      )
      .groupBy(
        schema.messages.threadRootId,
        schema.messages.authorType,
        schema.messages.authorId,
      );

    const threadActors = await loadActors(
      summary.map((s) => ({ type: s.authorType, id: s.authorId })),
    );

    const byRoot = new Map<string, typeof summary>();
    for (const s of summary) {
      if (!s.rootId) continue;
      const list = byRoot.get(s.rootId) ?? [];
      list.push(s);
      byRoot.set(s.rootId, list);
    }
    for (const [rootId, list] of byRoot) {
      // Ordine di prima comparsa: su date ISO in UTC il confronto testuale
      // è già l'ordine cronologico.
      list.sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0));
      lastReplyAt.set(rootId, list[0]!.lastAt);
      participantsByRoot.set(
        rootId,
        list
          .slice(0, THREAD_FACES)
          .map((s) => resolveActor(threadActors, s.authorType, s.authorId)),
      );
    }
  }

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    threadRootId: r.threadRootId,
    replyTo: r.replyToId ? (replyPreviews.get(r.replyToId) ?? null) : null,
    author: resolveActor(actors, r.authorType, r.authorId),
    // Un messaggio cancellato non deve trapelare il testo originale.
    body: r.deletedAt ? '' : r.body,
    mentions: (r.mentions as MentionRef[]) ?? [],
    reactions: [...(reactionsByMessage.get(r.id)?.values() ?? [])],
    attachments: attachmentsByMessage.get(r.id) ?? [],
    runId: r.runId,
    replyCount: r.replyCount,
    threadLastReplyAt: lastReplyAt.get(r.id) ?? null,
    threadParticipants: participantsByRoot.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    deletedAt: r.deletedAt?.toISOString() ?? null,
  }));
}

export async function serializeMessage(
  row: MessageRow,
  viewer: { type: 'user' | 'agent'; id: string } | null,
): Promise<Message> {
  const [msg] = await serializeMessages([row], viewer);
  return msg!;
}

/* ---------------------------------------------------------------------------
 * Canali
 * ------------------------------------------------------------------------ */

type ChannelRow = typeof schema.channels.$inferSelect;

export function serializeChannel(row: ChannelRow, extra?: Partial<Channel>): Channel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    groupId: row.groupId,
    name: row.name,
    topic: row.topic,
    purpose: row.purpose,
    visibility: row.visibility as Channel['visibility'],
    kind: row.kind as Channel['kind'],
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    ...extra,
  };
}

/**
 * Conteggio dei non letti per l'utente, canale per canale.
 * Una sola query aggregata invece di una per canale.
 */
export async function unreadCounts(
  workspaceId: string,
  userId: string,
): Promise<Map<string, { unread: number; mention: boolean }>> {
  const rows = await db.execute<{
    channel_id: string;
    unread: number;
    mention: boolean;
  }>(raw`
    select
      c.id as channel_id,
      count(m.id) filter (
        where m.deleted_at is null
          and not (m.author_type = 'user' and m.author_id = ${userId})
      )::int as unread,
      coalesce(bool_or(
        m.mentions @> ${JSON.stringify([{ type: 'user', id: userId }])}::jsonb
      ), false) as mention
    from channels c
    join channel_members cm
      on cm.channel_id = c.id
     and cm.member_type = 'user'
     and cm.member_id = ${userId}
    left join messages m
      on m.channel_id = c.id
     and m.created_at > coalesce(cm.last_read_at, '-infinity'::timestamptz)
    where c.workspace_id = ${workspaceId}
      and c.archived_at is null
    group by c.id
  `);

  const map = new Map<string, { unread: number; mention: boolean }>();
  for (const r of rows) {
    map.set(r.channel_id, { unread: Number(r.unread) || 0, mention: Boolean(r.mention) });
  }
  return map;
}

/* ---------------------------------------------------------------------------
 * Agenti
 * ------------------------------------------------------------------------ */

type AgentRow = typeof schema.agents.$inferSelect;

export function serializeAgent(row: AgentRow, extra?: Partial<Agent>): Agent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    handle: row.handle,
    name: row.name,
    description: row.description,
    purpose: row.purpose,
    kind: row.kind as Agent['kind'],
    model: row.model,
    runtime: row.runtime as Agent['runtime'],
    effort: row.effort as Agent['effort'],
    avatarEmoji: row.avatarEmoji,
    avatarColor: row.avatarColor,
    systemPrompt: row.systemPrompt,
    tools: (row.tools as Agent['tools']) ?? [],
    mcpServers: (row.mcpServers as Agent['mcpServers']) ?? [],
    repo: (row.repo as Agent['repo']) ?? null,
    execution: (row.execution as Agent['execution']) ?? 'server',
    permissionMode: (row.permissionMode as Agent['permissionMode']) ?? 'ask',
    runnerTokenId: row.runnerTokenId ?? null,
    autoRespond: row.autoRespond,
    status: row.status as Agent['status'],
    statusLabel: row.statusLabel,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    ...extra,
  };
}

/** Canali a cui è agganciato ciascun agente del workspace. */
export async function agentChannelMap(
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (agentIds.length === 0) return map;
  const rows = await db
    .select({
      agentId: schema.channelMembers.memberId,
      channelId: schema.channelMembers.channelId,
    })
    .from(schema.channelMembers)
    .where(
      and(
        eq(schema.channelMembers.memberType, 'agent'),
        inArray(schema.channelMembers.memberId, agentIds),
      ),
    );
  for (const r of rows) {
    const list = map.get(r.agentId) ?? [];
    list.push(r.channelId);
    map.set(r.agentId, list);
  }
  return map;
}

/* ---------------------------------------------------------------------------
 * Approvazioni
 * ------------------------------------------------------------------------ */

type ApprovalRow = typeof schema.approvals.$inferSelect;

export async function serializeApproval(row: ApprovalRow): Promise<Approval> {
  let decidedByName: string | null = null;
  if (row.decidedBy) {
    const rows = await db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, row.decidedBy))
      .limit(1);
    decidedByName = rows[0]?.name ?? null;
  }
  return {
    id: row.id,
    runId: row.runId,
    channelId: row.channelId,
    agentId: row.agentId,
    toolName: row.toolName,
    title: row.title,
    detail: row.detail,
    input: row.input,
    status: row.status as Approval['status'],
    decidedBy: row.decidedBy,
    decidedByName,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
