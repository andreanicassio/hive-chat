import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireChannelAccess, requireMembership } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { hub } from '../realtime/hub.js';
import { bumpReplyCount, postMessage } from '../services/messages.js';
import { serializeChannel, serializeMessages } from '../services/serialize.js';
import { channelNameSchema, createChannelSchema, postMessageSchema } from '@hive/shared';

/** Gli utenti che fanno parte di un canale: per non annunciare i privati a tutti. */
async function channelUserIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: schema.channelMembers.memberId })
    .from(schema.channelMembers)
    .where(
      and(
        eq(schema.channelMembers.channelId, channelId),
        eq(schema.channelMembers.memberType, 'user'),
      ),
    );
  return rows.map((r) => r.memberId);
}

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------------------------------- crea canale */
  app.post('/api/workspaces/:workspaceId/channels', async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const input = createChannelSchema.parse(request.body);

    const existing = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(eq(schema.channels.workspaceId, workspaceId), eq(schema.channels.name, input.name)),
      )
      .limit(1);
    if (existing.length > 0) {
      throw conflict('channel_exists', `Esiste già un canale #${input.name}`);
    }

    const created = await db
      .insert(schema.channels)
      .values({
        workspaceId,
        groupId: input.groupId ?? null,
        name: input.name,
        topic: input.topic ?? null,
        purpose: input.purpose ?? null,
        visibility: input.visibility,
        createdBy: user.id,
      })
      .returning();
    const row = created[0]!;

    await db.insert(schema.channelMembers).values({
      channelId: row.id,
      memberType: 'user',
      memberId: user.id,
    });

    // Su un canale pubblico entrano tutti i membri del progetto.
    if (input.visibility === 'public') {
      const members = await db
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
      if (members.length > 0) {
        await db
          .insert(schema.channelMembers)
          .values(
            members.map((m) => ({
              channelId: row.id,
              memberType: 'user' as const,
              memberId: m.userId,
            })),
          )
          .onConflictDoNothing();
      }
    }

    const channel = serializeChannel(row, { unreadCount: 0, hasMention: false, agentIds: [] });
    // Un canale privato non va annunciato a tutto il progetto: nome, scopo e
    // id finirebbero a chi non ne fa parte (e il client si iscriverebbe pure).
    await hub.publish(workspaceId, {
      packet: { t: 'channel.created', channel },
      ...(row.visibility === 'private' ? { userIds: await channelUserIds(row.id) } : {}),
    });

    return reply.code(201).send({ channel });
  });

  /* ------------------------------------------------------ modifica canale */
  app.patch('/api/channels/:channelId', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { workspaceId } = await requireChannelAccess(request, channelId, 'member');
    const input = z
      .object({
        name: channelNameSchema.optional(),
        topic: z.string().max(280).nullable().optional(),
        purpose: z.string().max(1000).nullable().optional(),
        groupId: z.uuid().nullable().optional(),
      })
      .parse(request.body);

    // Il nome è unico nel progetto: se è già preso lo diciamo chiaramente
    // invece di far esplodere il vincolo del database.
    if (input.name) {
      const clash = await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.workspaceId, workspaceId),
            eq(schema.channels.name, input.name),
            isNull(schema.channels.archivedAt),
          ),
        )
        .limit(1);
      if (clash[0] && clash[0].id !== channelId) {
        throw conflict('channel_exists', `Esiste già un canale #${input.name}.`);
      }
    }

    const updated = await db
      .update(schema.channels)
      .set(input)
      .where(eq(schema.channels.id, channelId))
      .returning();
    const row = updated[0];
    if (!row) throw notFound('Canale non trovato');

    const channel = serializeChannel(row);
    await hub.publish(workspaceId, {
      packet: { t: 'channel.updated', channel },
      ...(row.visibility === 'private' ? { userIds: await channelUserIds(row.id) } : {}),
    });
    return { channel };
  });

  /* ------------------------------------------------------ archivia canale */
  // Archiviamo invece di cancellare: i messaggi restano, il canale sparisce
  // dalle liste. Serve il ruolo admin, come per gli agenti.
  app.delete('/api/channels/:channelId', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { workspaceId } = await requireChannelAccess(request, channelId, 'admin');

    const updated = await db
      .update(schema.channels)
      .set({ archivedAt: new Date() })
      .where(eq(schema.channels.id, channelId))
      .returning();
    if (!updated[0]) throw notFound('Canale non trovato');

    await hub.publish(workspaceId, { packet: { t: 'channel.deleted', channelId } });
    return { ok: true };
  });

  /* -------------------------------------------------------- entra/esci */
  app.post('/api/channels/:channelId/join', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { user } = await requireChannelAccess(request, channelId);
    await db
      .insert(schema.channelMembers)
      .values({ channelId, memberType: 'user', memberId: user.id })
      .onConflictDoNothing();
    return { ok: true };
  });

  app.post('/api/channels/:channelId/leave', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { user } = await requireChannelAccess(request, channelId);
    await db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, 'user'),
          eq(schema.channelMembers.memberId, user.id),
        ),
      );
    return { ok: true };
  });

  /* ----------------------------------------------- cronologia messaggi */
  app.get('/api/channels/:channelId/messages', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { user } = await requireChannelAccess(request, channelId);
    const query = z
      .object({
        /** Cursore: restituisce i messaggi precedenti a questo istante. */
        before: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        /** Se presente, restituisce le risposte di quel thread. */
        threadRootId: z.uuid().optional(),
      })
      .parse(request.query);

    const conditions = [eq(schema.messages.channelId, channelId)];
    if (query.threadRootId) {
      conditions.push(eq(schema.messages.threadRootId, query.threadRootId));
    } else {
      // In vista canale mostriamo solo i messaggi radice.
      conditions.push(isNull(schema.messages.threadRootId));
    }
    if (query.before) {
      conditions.push(lt(schema.messages.createdAt, new Date(query.before)));
    }

    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(...conditions))
      .orderBy(desc(schema.messages.createdAt))
      .limit(query.limit);

    // Query in ordine decrescente per prendere i più recenti, poi invertiamo
    // così il client li riceve già in ordine cronologico.
    rows.reverse();

    const messages = await serializeMessages(rows, { type: 'user', id: user.id });
    return {
      messages,
      hasMore: rows.length === query.limit,
      nextCursor: rows[0]?.createdAt.toISOString() ?? null,
    };
  });

  /* ------------------------------------------------------ invia messaggio */
  app.post('/api/channels/:channelId/messages', async (request, reply) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { user, workspaceId } = await requireChannelAccess(request, channelId);
    const input = postMessageSchema.parse(request.body);

    const { message, triggeredRuns } = await postMessage({
      workspaceId,
      channelId,
      author: { type: 'user', id: user.id },
      body: input.body,
      threadRootId: input.threadRootId ?? null,
      replyToId: input.replyToId ?? null,
      attachmentIds: input.attachmentIds,
      clientNonce: input.clientNonce ?? null,
    });

    // Chi scrive ha implicitamente letto tutto fino a qui.
    await db
      .update(schema.channelMembers)
      .set({ lastReadAt: new Date(), lastReadMessageId: message.id })
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, 'user'),
          eq(schema.channelMembers.memberId, user.id),
        ),
      );

    return reply.code(201).send({ message, triggeredRuns });
  });

  /* ---------------------------------------------- modifica ed elimina */
  app.patch('/api/messages/:messageId', async (request) => {
    const { messageId } = z.object({ messageId: z.uuid() }).parse(request.params);
    const { body } = z.object({ body: z.string().min(1).max(16000) }).parse(request.body);

    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Messaggio non trovato');

    const { user, workspaceId } = await requireChannelAccess(request, existing.channelId);
    if (existing.authorType !== 'user' || existing.authorId !== user.id) {
      throw notFound('Messaggio non trovato');
    }

    const updated = await db
      .update(schema.messages)
      .set({ body, editedAt: new Date() })
      .where(eq(schema.messages.id, messageId))
      .returning();

    const [message] = await serializeMessages(updated, { type: 'user', id: user.id });
    await hub.publish(workspaceId, {
      packet: { t: 'message.updated', message: message! },
      channelId: existing.channelId,
    });
    return { message };
  });

  app.delete('/api/messages/:messageId', async (request) => {
    const { messageId } = z.object({ messageId: z.uuid() }).parse(request.params);
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Messaggio non trovato');

    const { user, role, workspaceId } = await requireChannelAccess(request, existing.channelId);
    const isAuthor = existing.authorType === 'user' && existing.authorId === user.id;
    const isModerator = role === 'admin' || role === 'owner';
    if (!isAuthor && !isModerator) throw notFound('Messaggio non trovato');

    await db
      .update(schema.messages)
      .set({ deletedAt: new Date(), body: '' })
      .where(eq(schema.messages.id, messageId));

    // Una risposta cancellata non conta più nel thread: senza questo il numero
    // sulla radice cresce e non torna mai indietro.
    if (existing.threadRootId && !existing.deletedAt) {
      await bumpReplyCount(workspaceId, existing.threadRootId, -1);
    }

    await hub.publish(workspaceId, {
      packet: { t: 'message.deleted', channelId: existing.channelId, messageId },
      channelId: existing.channelId,
    });
    return { ok: true };
  });

  /* ------------------------------------------------------------ reazioni */
  app.put('/api/messages/:messageId/reactions/:emoji', async (request) => {
    const { messageId, emoji } = z
      .object({ messageId: z.uuid(), emoji: z.string().min(1).max(32) })
      .parse(request.params);

    const rows = await db
      .select({ channelId: schema.messages.channelId })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    const msg = rows[0];
    if (!msg) throw notFound('Messaggio non trovato');

    const { user, workspaceId } = await requireChannelAccess(request, msg.channelId);

    // Toggle: se c'è già la togliamo, altrimenti la mettiamo.
    const existing = await db
      .select({ emoji: schema.reactions.emoji })
      .from(schema.reactions)
      .where(
        and(
          eq(schema.reactions.messageId, messageId),
          eq(schema.reactions.actorType, 'user'),
          eq(schema.reactions.actorId, user.id),
          eq(schema.reactions.emoji, emoji),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .delete(schema.reactions)
        .where(
          and(
            eq(schema.reactions.messageId, messageId),
            eq(schema.reactions.actorType, 'user'),
            eq(schema.reactions.actorId, user.id),
            eq(schema.reactions.emoji, emoji),
          ),
        );
    } else {
      await db
        .insert(schema.reactions)
        .values({ messageId, actorType: 'user', actorId: user.id, emoji })
        .onConflictDoNothing();
    }

    const refreshed = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    const [message] = await serializeMessages(refreshed, { type: 'user', id: user.id });

    await hub.publish(workspaceId, {
      packet: {
        t: 'reaction.changed',
        channelId: msg.channelId,
        messageId,
        reactions: message!.reactions,
      },
      channelId: msg.channelId,
    });
    return { reactions: message!.reactions };
  });

  /* -------------------------------------------------------- segna letto */
  app.post('/api/channels/:channelId/read', async (request) => {
    const { channelId } = z.object({ channelId: z.uuid() }).parse(request.params);
    const { user } = await requireChannelAccess(request, channelId);
    const { messageId } = z.object({ messageId: z.uuid().optional() }).parse(request.body ?? {});

    await db
      .update(schema.channelMembers)
      .set({ lastReadAt: new Date(), lastReadMessageId: messageId ?? null })
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, 'user'),
          eq(schema.channelMembers.memberId, user.id),
        ),
      );
    return { ok: true };
  });
}
