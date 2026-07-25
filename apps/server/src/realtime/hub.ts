import { WebSocket } from 'ws';
import { redisPub, redisSub } from '../lib/redis.js';
import { redisChannels, type ServerPacket } from '@hive/shared';

/**
 * Stato "socket aperto".
 *
 * Non usiamo `conn.socket.OPEN` come riferimento: a seconda di come
 * `@fastify/websocket` espone il socket, quella costante d'istanza può
 * essere `undefined`, e `readyState !== undefined` sarebbe sempre vero —
 * scartando in silenzio ogni messaggio. Usiamo la costante statica della
 * classe, che vale sempre 1.
 */
const OPEN = WebSocket.OPEN;

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
  /**
   * Canale che questa scheda ha davvero davanti, se il client lo dichiara.
   * `undefined` = client che non manda `focus` (vedi `isWatching`).
   */
  activeChannelId?: string | null;
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

  /** Il canale che una scheda ha davanti. `null` quando la finestra è nascosta. */
  setFocus(conn: Connection, channelId: string | null): void {
    conn.activeChannelId = channelId;
  }

  /**
   * Questa persona sta guardando quel canale proprio adesso?
   *
   * Serve alle notifiche push: chi ha già la conversazione sotto gli occhi non
   * va avvisato una seconda volta sul telefono.
   *
   * Il segnale buono è `focus`, che dice il canale davvero aperto. I client
   * che non lo mandano ancora ricadono sull'iscrizione: è più grossolana —
   * il client si iscrive a tutta la sidebar — ma sbaglia in difesa, tacendo
   * invece di disturbare.
   */
  isWatching(userId: string, channelId: string): boolean {
    for (const set of this.byWorkspace.values()) {
      for (const conn of set) {
        if (conn.userId !== userId) continue;
        if (conn.socket.readyState !== OPEN) continue;
        if (conn.activeChannelId !== undefined) {
          if (conn.activeChannelId === channelId) return true;
        } else if (conn.channels.has(channelId)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Manda un pacchetto a tutte le socket di una persona, ovunque sia.
   *
   * Non passa da Redis: il fanout fra nodi è per workspace, e una notifica
   * non ne ha sempre uno (il runner spento non appartiene a un canale).
   * Finché l'API gira su un processo solo è esatto; il giorno che diventano
   * due, questo va rifatto sopra un canale Redis per utente.
   */
  sendToUser(userId: string, packet: ServerPacket): void {
    const payload = JSON.stringify(packet);
    for (const set of this.byWorkspace.values()) {
      for (const conn of set) {
        if (conn.userId !== userId) continue;
        if (conn.socket.readyState !== OPEN) continue;
        try {
          conn.socket.send(payload);
        } catch {
          /* socket morente: se ne occupa il gestore di close */
        }
      }
    }
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
    if (conn.socket.readyState !== OPEN) return;
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
      if (conn.socket.readyState !== OPEN) continue;
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
