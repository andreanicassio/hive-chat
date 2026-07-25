import Redis from 'ioredis';
import { redisChannels } from '@hive/shared';
import { env } from './env.js';
import { createInbox, type Steering } from './steering-core.js';

/**
 * Steering lato server, dove Redis c'è. Il nucleo comune sta in
 * `steering-core.ts`: quel file lo usa anche il runner, e non deve
 * trascinarsi dietro Redis.
 */

const STEERABLE_TTL_SEC = 60;

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
