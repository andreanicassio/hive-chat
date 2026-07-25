import Redis from 'ioredis';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { redisChannels } from '@hive/shared';
import { env } from './env.js';

/**
 * Input "a caldo" per un turno in corso.
 *
 * Nel terminale, mentre Claude Code lavora, puoi scrivere e lui lo legge
 * subito. Qui facciamo lo stesso: il prompt non è una stringa ma un flusso
 * che resta aperto per tutta la durata del turno, e i messaggi che arrivano
 * nel frattempo ci entrano dentro senza interrompere il lavoro.
 *
 * Ci sono due modi di consegnarli, perché ci sono due posti in cui un turno
 * può girare:
 *
 * - **sul worker del server**, che Redis ce l'ha in casa: il testo arriva su
 *   una lista, con un campanello sul canale pub/sub;
 * - **sul runner locale**, che gira sulla macchina di chi lo ha installato e
 *   Redis non lo vede nemmeno: lì il testo se lo porta indietro il viaggio
 *   che il runner fa già ogni pochi secondi per sapere se l'hai fermato.
 *
 * Il nucleo (`createInbox`) è lo stesso per entrambi. Cambia solo chi lo
 * riempie.
 */

const STEERABLE_TTL_SEC = 60;

export interface Steering {
  /** Da passare a `query({ prompt })`. */
  prompt: AsyncGenerator<SDKUserMessage>;
  /** Consegna un testo al turno in corso. */
  inject: (text: string) => void;
  /** Il modello ha finito un giro: chiude tutto se non è arrivato altro. */
  turnFinished: () => void;
  /** Chiude e libera le risorse. */
  stop: () => Promise<void>;
}

function userMessage(text: string, priority: 'now' | 'next'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    priority,
  } as SDKUserMessage;
}

/**
 * Il nucleo: una casella di posta che diventa un flusso di messaggi utente.
 *
 * Non sa niente di Redis né di HTTP. Chi la usa ci infila dentro i testi con
 * `inject`, da dove vuole.
 */
function createInbox(firstPrompt: string) {
  const waiting: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const nudge = () => {
    wake?.();
    wake = null;
  };

  const inject = (text: string) => {
    if (closed || !text.trim()) return;
    waiting.push(text);
    nudge();
  };

  async function* generate(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(firstPrompt, 'now');
    for (;;) {
      if (closed && waiting.length === 0) return;
      const next = waiting.shift();
      if (next !== undefined) {
        // `next`: non spezza l'operazione in corso, entra appena può.
        yield userMessage(next, 'next');
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (closed || waiting.length > 0) nudge();
      });
    }
  }

  return {
    prompt: generate(),
    inject,
    pending: () => waiting.length,
    turnFinished: () => {
      // Se nel frattempo è arrivato altro, il generatore lo consegna e il
      // turno prosegue; altrimenti chiude.
      if (waiting.length === 0) {
        closed = true;
        nudge();
      }
    },
    close: () => {
      closed = true;
      nudge();
    },
  };
}

/**
 * Steering per un turno che gira **senza** Redis a portata di mano.
 *
 * È il caso del runner locale: chi riceve i testi dal server li passa qui con
 * `inject`. Nessuna chiave, nessuna sottoscrizione, nessuna risorsa da
 * chiudere.
 */
export function createLocalSteering(firstPrompt: string): Steering {
  const inbox = createInbox(firstPrompt);
  return {
    prompt: inbox.prompt,
    inject: inbox.inject,
    turnFinished: inbox.turnFinished,
    stop: async () => {
      inbox.close();
    },
  };
}

/**
 * Steering per un turno che gira sul server, dove Redis c'è.
 *
 * Il marcatore `steerable` dice alla chat che può iniettare invece di
 * accodare; scade da solo, così un turno morto male non resta a raccogliere
 * messaggi che nessuno leggerà.
 */
export function createSteering(runId: string, firstPrompt: string): Steering {
  const inbox = createInbox(firstPrompt);
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  sub.on('error', () => {});
  pub.on('error', () => {});

  /** Svuota la lista: è lì che stanno i testi, il canale è solo il campanello. */
  const drain = async () => {
    for (;;) {
      const text = await pub.rpop(redisChannels.steerQueue(runId)).catch(() => null);
      if (!text) return;
      inbox.inject(text);
    }
  };

  void sub.subscribe(redisChannels.steer(runId));
  sub.on('message', () => void drain());
  // Un giro subito: qualcosa può essere arrivato fra la creazione della lista
  // e la sottoscrizione.
  void drain();

  // Finché questo marcatore esiste, la chat sa che può iniettare a caldo.
  const markAlive = () =>
    void pub.set(redisChannels.steerable(runId), '1', 'EX', STEERABLE_TTL_SEC).catch(() => {});
  markAlive();
  const keepAlive = setInterval(markAlive, (STEERABLE_TTL_SEC / 2) * 1000);
  keepAlive.unref();

  return {
    prompt: inbox.prompt,
    inject: inbox.inject,
    turnFinished: inbox.turnFinished,
    stop: async () => {
      inbox.close();
      clearInterval(keepAlive);
      // Il marcatore va via per primo: da questo istante la chat torna ad
      // accodare, e non può più infilare niente in una lista che nessuno
      // svuoterà.
      await pub.del(redisChannels.steerable(runId)).catch(() => {});
      await pub.del(redisChannels.steerQueue(runId)).catch(() => {});
      sub.disconnect();
      pub.disconnect();
    },
  };
}
