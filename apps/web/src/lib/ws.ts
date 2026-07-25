import type { ClientPacket, ServerPacket } from '@hive/shared';

/**
 * Connessione realtime.
 *
 * Si riconnette da sola con backoff esponenziale e rimanda `hello` più le
 * sottoscrizioni ai canali: dopo un blackout di rete il client torna allo
 * stato giusto senza che l'utente debba ricaricare.
 */

type Listener = (packet: ServerPacket) => void;

const MAX_BACKOFF_MS = 20_000;

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private workspaceId: string | null = null;
  private subscribed = new Set<string>();
  /** L'ultimo `focus` mandato: serve a non ripeterlo e a rimandarlo al riavvio. */
  private focused: string | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  /** Stato mostrato in UI quando la connessione cade. */
  onStatusChange: ((connected: boolean) => void) | null = null;

  connect(workspaceId: string): void {
    this.workspaceId = workspaceId;
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.onStatusChange?.(true);
      if (this.workspaceId) {
        this.send({ t: 'hello', workspaceId: this.workspaceId });
      }
      // Ripristina le sottoscrizioni perse con la vecchia connessione.
      if (this.subscribed.size > 0) {
        this.send({ t: 'subscribe', channelIds: [...this.subscribed] });
      }
      // E anche il canale a fuoco: il server ha appena perso quello stato, e
      // senza rimandarlo arriverebbero notifiche di ciò che stai leggendo.
      if (this.focused !== null) this.send({ t: 'focus', channelId: this.focused });
      this.heartbeat = setInterval(() => this.send({ t: 'ping' }), 25_000);
    };

    socket.onmessage = (event) => {
      let packet: ServerPacket;
      try {
        packet = JSON.parse(event.data as string) as ServerPacket;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(packet);
    };

    socket.onclose = () => {
      this.cleanupSocket();
      this.onStatusChange?.(false);
      if (!this.closedByUs) this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` arriva comunque subito dopo: la riconnessione è gestita lì.
    };
  }

  private cleanupSocket(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Backoff con jitter: se il server riparte, i client non tornano tutti
    // nello stesso istante.
    const base = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = base * (0.7 + Math.random() * 0.6);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  send(packet: ClientPacket): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(packet));
    }
  }

  subscribe(channelIds: string[]): void {
    const fresh = channelIds.filter((id) => !this.subscribed.has(id));
    for (const id of channelIds) this.subscribed.add(id);
    if (fresh.length > 0) this.send({ t: 'subscribe', channelIds: fresh });
  }

  unsubscribe(channelIds: string[]): void {
    for (const id of channelIds) this.subscribed.delete(id);
    this.send({ t: 'unsubscribe', channelIds });
  }

  /**
   * Il canale che questa scheda ha davvero davanti agli occhi.
   *
   * Non coincide con le sottoscrizioni: il client si iscrive a tutti i canali
   * della barra laterale per tenere aggiornati i contatori dei non letti. Se
   * il server usasse quelle per decidere se sei presente, risulteresti a
   * guardare ovunque e le notifiche non partirebbero mai.
   *
   * `null` quando la finestra è nascosta: se il telefono è in tasca, non stai
   * guardando niente.
   */
  focus(channelId: string | null): void {
    if (this.focused === channelId) return;
    this.focused = channelId;
    this.send({ t: 'focus', channelId });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.subscribed.clear();
    this.socket?.close();
    this.cleanupSocket();
  }
}

export const realtime = new RealtimeClient();
