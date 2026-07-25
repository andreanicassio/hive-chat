import { and, eq, sql as raw } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';
import { redis } from './redis.js';
import { redisChannels, type AgentStatus, type RunEvent, type RunStatus, type ServerPacket } from '@hive/shared';

/**
 * Interfaccia minima che un runner/harness usa per emettere.
 * La implementano sia RunEmitter (scrive su DB+Redis, per il server) sia il
 * RemoteEmitter dei runner locali (manda gli eventi al server via HTTPS).
 */
export interface EmitterLike {
  readonly text: string;
  markStarted(): Promise<void>;
  status(status: AgentStatus, label: string | null): Promise<void>;
  runStatus(status: RunStatus, error?: string | null, queuePosition?: number): Promise<void>;
  delta(text: string): Promise<void>;
  event(event: RunEvent): Promise<void>;
  /**
   * Dimentica il testo accumulato finora.
   *
   * Serve quando un turno di ragionamento si chiude ed è già stato salvato
   * come `text.block`: da quel momento vive nella tab di lavoro, e lasciarlo
   * anche nel buffer significherebbe incollarlo al turno successivo senza
   * neanche un a capo in mezzo.
   */
  resetText(): void;
  bumpTurns(): Promise<void>;
  finish(result: {
    status: RunStatus;
    error?: string | null;
    finalText?: string;
    numTurns?: number;
    costUsd?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    usesSubscription?: boolean;
    sdkSessionId?: string | null;
  }): Promise<void>;
}

/**
 * Canale d'uscita di un run.
 *
 * Ha due compiti: mandare gli aggiornamenti ai client in tempo reale e
 * lasciare una traccia durevole su DB. Il testo viene accumulato qui e
 * salvato sul messaggio a intervalli, non a ogni token: scrivere su Postgres
 * a ogni delta metterebbe in ginocchio il database per niente.
 */
export class RunEmitter {
  private seq = 0;
  private buffer = '';
  private persisted = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly ctx: {
      runId: string;
      workspaceId: string;
      channelId: string;
      agentId: string;
      messageId: string;
    },
    /** Ogni quanto riversare il testo accumulato su DB. */
    private readonly flushIntervalMs = 700,
  ) {}

  private async publish(packet: ServerPacket): Promise<void> {
    await redis.publish(
      redisChannels.workspace(this.ctx.workspaceId),
      JSON.stringify({ packet, channelId: this.ctx.channelId }),
    );
  }

  /** Testo prodotto finora, comprensivo di quanto non ancora salvato. */
  get text(): string {
    return this.buffer;
  }

  /** Frammento di risposta: va ai client subito, su DB a intervalli. */
  async delta(text: string): Promise<void> {
    if (this.closed || !text) return;
    this.buffer += text;
    await this.publish({
      t: 'run.delta',
      runId: this.ctx.runId,
      messageId: this.ctx.messageId,
      text,
    });
    this.scheduleFlush();
  }

  /** Evento strutturato: uso di un tool, ragionamento, handoff, errore. */
  async event(event: RunEvent): Promise<void> {
    if (this.closed) return;
    this.seq++;
    const at = Date.now();
    await db
      .insert(schema.runEvents)
      .values({ runId: this.ctx.runId, seq: this.seq, type: event.type, payload: event })
      .onConflictDoNothing();
    await this.publish({
      t: 'run.event',
      runId: this.ctx.runId,
      messageId: this.ctx.messageId,
      event,
      at,
    });
  }

  /** Vedi `EmitterLike.resetText`. */
  resetText(): void {
    this.buffer = '';
  }

  /** Etichetta di stato mostrata nella barra in basso ("Honey: sto leggendo…"). */
  async status(status: AgentStatus, label: string | null): Promise<void> {
    await db
      .update(schema.agents)
      .set({ status, statusLabel: label })
      .where(eq(schema.agents.id, this.ctx.agentId));
    await redis.publish(
      redisChannels.workspace(this.ctx.workspaceId),
      JSON.stringify({
        packet: {
          t: 'agent.status',
          agentId: this.ctx.agentId,
          status,
          label,
          channelId: this.ctx.channelId,
        } satisfies ServerPacket,
      }),
    );
  }

  async runStatus(status: RunStatus, error?: string | null, queuePosition?: number): Promise<void> {
    await this.publish({
      t: 'run.status',
      runId: this.ctx.runId,
      messageId: this.ctx.messageId,
      status,
      error: error ?? null,
      ...(queuePosition !== undefined ? { queuePosition } : {}),
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
  }

  /** Riversa su DB il testo accumulato, se è cambiato. */
  async flush(): Promise<void> {
    if (this.buffer === this.persisted) return;
    const snapshot = this.buffer;
    await db
      .update(schema.messages)
      .set({ body: snapshot })
      .where(eq(schema.messages.id, this.ctx.messageId));
    this.persisted = snapshot;
  }

  /**
   * Chiude il run: salva il testo finale, aggiorna la riga di esecuzione
   * e riporta l'agente a riposo.
   */
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Il testo finale dell'SDK è più affidabile della somma dei delta:
    // se c'è, vince.
    if (result.finalText && result.finalText.trim()) {
      this.buffer = result.finalText;
    }

    // Un run finito senza output lascerebbe una bolla vuota in chat.
    if (!this.buffer.trim()) {
      this.buffer =
        result.status === 'error'
          ? `_L'esecuzione si è interrotta: ${result.error ?? 'errore sconosciuto'}_`
          : result.status === 'cancelled'
            ? '_Esecuzione annullata._'
            : '_Nessuna risposta prodotta._';
    }

    await db
      .update(schema.messages)
      .set({ body: this.buffer })
      .where(eq(schema.messages.id, this.ctx.messageId));
    this.persisted = this.buffer;

    await db
      .update(schema.agentRuns)
      .set({
        status: result.status,
        error: result.error ?? null,
        endedAt: new Date(),
        ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
        ...(result.costUsd != null ? { costUsd: result.costUsd.toFixed(6) } : {}),
        ...(result.inputTokens != null ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens != null ? { outputTokens: result.outputTokens } : {}),
        ...(result.usesSubscription !== undefined
          ? { usesSubscription: result.usesSubscription }
          : {}),
        ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId } : {}),
      })
      .where(eq(schema.agentRuns.id, this.ctx.runId));

    await this.runStatus(result.status, result.error ?? null);
    await this.status('idle', null);

    // Ripubblica il messaggio completo: chi si è collegato a metà stream
    // così vede comunque il testo intero. Carichiamo anche i dati veri
    // dell'agente per l'autore: pubblicare un autore vuoto sovrascriverebbe
    // quello corretto nel client, lasciando la bolla senza nome né avatar.
    const [rows, agentRows] = await Promise.all([
      db.select().from(schema.messages).where(eq(schema.messages.id, this.ctx.messageId)).limit(1),
      db
        .select({
          name: schema.agents.name,
          handle: schema.agents.handle,
          avatarEmoji: schema.agents.avatarEmoji,
          avatarColor: schema.agents.avatarColor,
        })
        .from(schema.agents)
        .where(eq(schema.agents.id, this.ctx.agentId))
        .limit(1),
    ]);
    const row = rows[0];
    const agent = agentRows[0];
    if (row) {
      await redis.publish(
        redisChannels.workspace(this.ctx.workspaceId),
        JSON.stringify({
          packet: {
            t: 'message.updated',
            message: {
              id: row.id,
              channelId: row.channelId,
              threadRootId: row.threadRootId,
              replyTo: null,
              author: {
                type: 'agent',
                id: this.ctx.agentId,
                name: agent?.name ?? 'Agente',
                handle: agent?.handle ?? '',
                avatarEmoji: agent?.avatarEmoji ?? '🤖',
                avatarColor: agent?.avatarColor ?? '#8A8A80',
              },
              body: row.body,
              mentions: row.mentions,
              reactions: [],
              attachments: [],
              runId: row.runId,
              replyCount: row.replyCount,
              // È la risposta di un agente, non una radice: nessun thread appeso.
              threadLastReplyAt: null,
              threadParticipants: [],
              createdAt: row.createdAt.toISOString(),
              editedAt: row.editedAt?.toISOString() ?? null,
              deletedAt: null,
            },
          },
          channelId: this.ctx.channelId,
        }),
      );
    }

    this.closed = true;

    // Segnale per la coda: se sono arrivati messaggi mentre lavoravo,
    // adesso possono partire.
    await redis
      .publish(
        redisChannels.runFinished,
        JSON.stringify({ agentId: this.ctx.agentId, channelId: this.ctx.channelId }),
      )
      .catch(() => {});
  }

  async markStarted(): Promise<void> {
    // Solo se era davvero in attesa. Senza il vincolo, un run annullato mentre
    // stava in coda tornerebbe `running` proprio qui, e l'annullamento
    // sparirebbe senza lasciare traccia.
    await db
      .update(schema.agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(schema.agentRuns.id, this.ctx.runId), eq(schema.agentRuns.status, 'queued')));
    await this.runStatus('running');
  }

  async bumpTurns(): Promise<void> {
    await db
      .update(schema.agentRuns)
      .set({ numTurns: raw`${schema.agentRuns.numTurns} + 1` })
      .where(eq(schema.agentRuns.id, this.ctx.runId));
  }
}
