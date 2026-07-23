import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { hub } from './hub.js';
import { loadSession } from '../lib/auth.js';
import { clientPacketSchema, type ServerPacket } from '@hive/shared';

/** Finestra minima fra due eventi "sta scrivendo" dello stesso utente. */
const TYPING_THROTTLE_MS = 2500;

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, async (socket, request) => {
    // La socket eredita il cookie di sessione dell'handshake HTTP.
    await loadSession(request);
    const user = request.user;

    const send = (packet: ServerPacket) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(packet));
      }
    };

    if (!user) {
      send({ t: 'error', code: 'unauthorized', message: 'Sessione non valida' });
      socket.close(4401, 'unauthorized');
      return;
    }

    let conn: Awaited<ReturnType<typeof hub.add>> | null = null;
    const lastTyping = new Map<string, number>();

    socket.on('message', (raw: Buffer) => {
      void (async () => {
        let parsed;
        try {
          parsed = clientPacketSchema.safeParse(JSON.parse(raw.toString()));
        } catch {
          return;
        }
        if (!parsed.success) return;
        const packet = parsed.data;

        switch (packet.t) {
          case 'hello': {
            // Verifichiamo l'appartenenza prima di agganciare la socket.
            const member = await db
              .select({ role: schema.workspaceMembers.role })
              .from(schema.workspaceMembers)
              .where(
                and(
                  eq(schema.workspaceMembers.workspaceId, packet.workspaceId),
                  eq(schema.workspaceMembers.userId, user.id),
                ),
              )
              .limit(1);

            if (member.length === 0) {
              send({ t: 'error', code: 'forbidden', message: 'Non fai parte di questo progetto' });
              socket.close(4403, 'forbidden');
              return;
            }

            if (conn) await hub.remove(conn);
            conn = await hub.add(socket, user.id, packet.workspaceId);
            send({
              t: 'ready',
              userId: user.id,
              workspaceId: packet.workspaceId,
              serverTime: new Date().toISOString(),
            });
            await hub.publish(packet.workspaceId, {
              packet: { t: 'presence', userId: user.id, online: true },
              exceptUserId: user.id,
            });
            return;
          }

          case 'subscribe': {
            if (!conn) return;
            for (const id of packet.channelIds) conn.channels.add(id);
            return;
          }

          case 'unsubscribe': {
            if (!conn) return;
            for (const id of packet.channelIds) conn.channels.delete(id);
            return;
          }

          case 'typing': {
            if (!conn) return;
            // Senza throttle un utente che digita veloce inonderebbe il canale.
            const now = Date.now();
            const prev = lastTyping.get(packet.channelId) ?? 0;
            if (now - prev < TYPING_THROTTLE_MS) return;
            lastTyping.set(packet.channelId, now);

            await hub.publish(conn.workspaceId, {
              packet: {
                t: 'typing',
                channelId: packet.channelId,
                actorId: user.id,
                name: user.name,
              },
              channelId: packet.channelId,
              exceptUserId: user.id,
            });
            return;
          }

          case 'read': {
            if (!conn) return;
            await db
              .update(schema.channelMembers)
              .set({ lastReadAt: new Date(), lastReadMessageId: packet.messageId })
              .where(
                and(
                  eq(schema.channelMembers.channelId, packet.channelId),
                  eq(schema.channelMembers.memberType, 'user'),
                  eq(schema.channelMembers.memberId, user.id),
                ),
              );
            return;
          }

          case 'ping': {
            send({ t: 'pong' });
            return;
          }
        }
      })().catch((err) => {
        app.log.error({ err }, 'errore gestendo un pacchetto websocket');
      });
    });

    socket.on('close', () => {
      void (async () => {
        if (!conn) return;
        const workspaceId = conn.workspaceId;
        await hub.remove(conn);
        conn = null;
        // Annuncia offline solo se non restano altre schede aperte.
        if (!hub.isOnlineLocally(workspaceId, user.id)) {
          await hub.publish(workspaceId, {
            packet: { t: 'presence', userId: user.id, online: false },
            exceptUserId: user.id,
          });
        }
        await db
          .update(schema.users)
          .set({ lastSeenAt: new Date() })
          .where(eq(schema.users.id, user.id))
          .catch(() => {});
      })().catch(() => {});
    });

    socket.on('error', () => {
      /* la chiusura fa la pulizia */
    });
  });
}
