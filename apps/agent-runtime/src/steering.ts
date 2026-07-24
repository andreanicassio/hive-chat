import Redis from 'ioredis';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { redisChannels } from '@hive/shared';
import { env } from './env.js';

/**
 * Input "a caldo" per un turno in corso.
 *
 * Nel terminale, mentre Claude Code lavora, puoi scrivere e lui lo legge
 * subito. Qui facciamo lo stesso: la chat pubblica il messaggio su un canale
 * Redis legato al turno, e questo generatore lo consegna all'SDK senza
 * interrompere il lavoro in corso.
 */

const STEERABLE_TTL_SEC = 60;

export interface Steering {
  /** Da passare a `query({ prompt })`. */
  prompt: AsyncGenerator<SDKUserMessage>;
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

export function createSteering(runId: string, firstPrompt: string): Steering {
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const waiting: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const nudge = () => {
    wake?.();
    wake = null;
  };

  sub.on('error', () => {});
  void sub.subscribe(redisChannels.steer(runId));
  sub.on('message', (_ch, text) => {
    if (!closed && text.trim()) {
      waiting.push(text);
      nudge();
    }
  });

  // Finché questo marcatore esiste, la chat sa che può iniettare a caldo.
  const markAlive = () =>
    void pub.set(redisChannels.steerable(runId), '1', 'EX', STEERABLE_TTL_SEC).catch(() => {});
  markAlive();
  const keepAlive = setInterval(markAlive, (STEERABLE_TTL_SEC / 2) * 1000);
  keepAlive.unref();

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
    turnFinished: () => {
      // Se nel frattempo è arrivato altro, il generatore lo consegna e il
      // turno prosegue; altrimenti chiude.
      if (waiting.length === 0) {
        closed = true;
        nudge();
      }
    },
    stop: async () => {
      closed = true;
      nudge();
      clearInterval(keepAlive);
      await pub.del(redisChannels.steerable(runId)).catch(() => {});
      sub.disconnect();
      pub.disconnect();
    },
  };
}
