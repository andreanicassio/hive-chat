import type { EmitterLike } from './emitter.js';
import type { AgentStatus, RunEvent, RunStatus } from '@hive/shared';

/**
 * Emitter dei runner LOCALI: invece di scrivere su DB/Redis (che il runner non
 * ha), accumula gli eventi e li manda al server via HTTPS col token. Il server
 * fa le scritture vere (vedi services/runner-sink.ts). Stessa interfaccia
 * dell'emitter del runtime, così i runner (ClaudeCodeRunner) non cambiano.
 */

type Op =
  | { op: 'started' }
  | { op: 'status'; status: AgentStatus; label: string | null }
  | { op: 'delta'; text: string }
  | { op: 'body'; text: string }
  | { op: 'event'; seq: number; event: RunEvent; at: number }
  | Record<string, unknown>;

export class RemoteEmitter implements EmitterLike {
  private buffer = '';
  private lastBody = '';
  private seq = 0;
  private pending: Op[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Il segnale di stop si consegna una volta sola. */
  private cancelSeen = false;

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly runId: string,
    /** Chiamata quando il server dice che il turno è stato annullato. */
    private readonly onCancel?: () => void,
  ) {
    // Battito lento. Il flush normale scatta quando c'è qualcosa da mandare,
    // ma durante un comando lungo può non esserci niente per minuti — e la
    // risposta a questo invio è l'unico modo che il server ha di dirci di
    // fermarci. Ogni 5s la richiesta parte comunque, anche a vuoto.
    this.keepalive = setInterval(() => void this.flush(true).catch(() => {}), 5000);
    this.keepalive.unref?.();
  }

  get text(): string {
    return this.buffer;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, 500);
  }

  private async flush(force = false): Promise<void> {
    // Nessuna guardia su `closed`: l'ultimo flush è proprio quello che parte
    // dopo la chiusura, ed è quello che porta al server l'esito del turno.
    const ops = this.pending;
    if (!force && ops.length === 0 && this.buffer === this.lastBody) return;
    this.pending = [];
    if (this.buffer !== this.lastBody) {
      ops.push({ op: 'body', text: this.buffer });
      this.lastBody = this.buffer;
    }
    try {
      const res = await fetch(`${this.serverUrl}/api/runner/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ runId: this.runId, ops }),
      });
      const body = (await res.json().catch(() => ({}))) as { cancel?: boolean };
      if (body.cancel && !this.cancelSeen) {
        this.cancelSeen = true;
        this.onCancel?.();
      }
    } catch (err) {
      // Rete ballerina: non facciamo cadere il turno per un batch perso.
      console.error('[runner] invio eventi fallito:', (err as Error).message);
    }
  }

  async markStarted(): Promise<void> {
    this.pending.push({ op: 'started' });
    await this.flush();
  }

  async status(status: AgentStatus, label: string | null): Promise<void> {
    this.pending.push({ op: 'status', status, label });
    this.schedule();
  }

  // Sui runner locali non serve: run.status lo gestisce il server su started/finish.
  async runStatus(_status: RunStatus): Promise<void> {}

  async delta(text: string): Promise<void> {
    if (!text) return;
    this.buffer += text;
    this.pending.push({ op: 'delta', text });
    this.schedule();
  }

  async event(event: RunEvent): Promise<void> {
    this.seq++;
    // L'ora la prendiamo QUI, non quando il lotto parte: fra i due momenti
    // possono passare 500ms, e sarebbero tutti attribuiti all'ultima
    // operazione del lotto.
    this.pending.push({ op: 'event', seq: this.seq, event, at: Date.now() });
    this.schedule();
  }

  /** Vedi `EmitterLike.resetText`. */
  resetText(): void {
    this.buffer = '';
  }

  async bumpTurns(): Promise<void> {
    // Il numero di turni arriva nel finish.
  }

  async finish(result: {
    status: RunStatus;
    error?: string | null;
    finalText?: string;
    numTurns?: number;
    costUsd?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    usesSubscription?: boolean;
    sdkSessionId?: string | null;
  }): Promise<void> {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (result.finalText && result.finalText.trim()) this.buffer = result.finalText;
    this.pending.push({ op: 'finish', ...result });
    this.closed = true;
    await this.flush();
  }
}
