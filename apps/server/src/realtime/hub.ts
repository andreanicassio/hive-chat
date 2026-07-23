import type { WebSocket } from 'ws';
import { redisPub, redisSub } from '../lib/redis.js';
import { redisChannels, type ServerPacket } from '@hive/shared';

/**
 * Hub delle connessioni WebSocket.
 *
 * Ogni nodo API tiene le proprie socket in memoria e si iscrive su Redis al
 * canale del workspace. Chiunque pubblichi lì (API o worker agenti) raggiunge
 * tutti i client, anche quelli connessi a un altro processo.
 *
 * Il filtro per canale è fatto qui, non su Redis: un solo canale Redis per
 * workspace tiene basso il numero di sottoscrizioni.
 */

interface Connection {
  id: number;
  socket: WebSocket;
  userId: string;
  workspaceId: string;
  /** Canali di cui il client vuole gli eventi. */
  channels: Set<string>;
  alive: boolean;
}

/** Busta pubblicata su Redis: il pacchetto più le regole di consegna. */
interface Envelope {
  packet: ServerPacket;
  /** Consegna solo a chi è sottoscritto a questo canale. */
  channelId?: string;
  /** Consegna solo a questi utenti (es. notifiche personali). */
  userIds?: string[];
  /** Non rimandare al mittente. */
  exceptUserId?: string;
}

let nextId = 1;

class Hub {
  private byWorkspace = new Map<string, Set<Connection>>();
  private subscribed = new Set<string>();

  constructor() {
    redisSub.on('message', (redisChannel, raw) => {
      const workspaceId = redisChannel.slice('hive:ws:'.length);
      let envelope: Envelope;
      try {
        envelope = JSON.parse(raw) as Envelope;
      } catch {
        return;
      }
      this.deliverLocal(workspaceId, envelope);
    });
  }

  async add(socket: WebSocket, userId: string, workspaceId: string): Promise<Connection> {
    const conn: Connection = {
      id: nextId++,
      socket,
      userId,
      workspaceId,
      channels: new Set(),
      alive: true,
    };

    let set = this.byWorkspace.get(workspaceId);
    if (!set) {
      set = new Set();
      this.byWorkspace.set(workspaceId, set);
    }
    set.add(conn);

    // Prima connessione per questo workspace su questo nodo: iscriviti.
    if (!this.subscribed.has(workspaceId)) {
      this.subscribed.add(workspaceId);
      await redisSub.subscribe(redisChannels.workspace(workspaceId));
    }

    return conn;
  }

  async remove(conn: Connection): Promise<void> {
    const set = this.byWorkspace.get(conn.workspaceId);
    if (!set) return;
    set.delete(conn);
    if (set.size > 0) return;

    this.byWorkspace.delete(conn.workspaceId);
    this.subscribed.delete(conn.workspaceId);
    await redisSub.unsubscribe(redisChannels.workspace(conn.workspaceId)).catch(() => {});
  }

  /** Numero di connessioni locali, per health check e diagnostica. */
  get size(): number {
    let n = 0;
    for (const set of this.byWorkspace.values()) n += set.size;
    return n;
  }

  /** L'utente ha almeno una socket aperta su questo nodo. */
  isOnlineLocally(workspaceId: string, userId: string): boolean {
    const set = this.byWorkspace.get(workspaceId);
    if (!set) return false;
    for (const c of set) if (c.userId === userId) return true;
    return false;
  }

  /** Pubblica su Redis: raggiunge tutti i nodi, incluso questo. */
  async publish(workspaceId: string, envelope: Envelope): Promise<void> {
    await redisPub.publish(
      redisChannels.workspace(workspaceId),
      JSON.stringify(envelope),
    );
  }

  /** Invia direttamente a una socket già in mano al chiamante. */
  send(conn: Connection, packet: ServerPacket): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    try {
      conn.socket.send(JSON.stringify(packet));
    } catch {
      /* socket morente: se ne occupa il gestore di close */
    }
  }

  private deliverLocal(workspaceId: string, envelope: Envelope): void {
    const set = this.byWorkspace.get(workspaceId);
    if (!set || set.size === 0) return;

    const payload = JSON.stringify(envelope.packet);

    for (const conn of set) {
      if (envelope.exceptUserId && conn.userId === envelope.exceptUserId) continue;
      if (envelope.userIds && !envelope.userIds.includes(conn.userId)) continue;
      if (envelope.channelId && !conn.channels.has(envelope.channelId)) continue;
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      try {
        conn.socket.send(payload);
      } catch {
        /* ignorata: la chiusura ripulisce */
      }
    }
  }
}

export const hub = new Hub();
export type { Connection, Envelope };
