import Redis from 'ioredis';
import { env } from './env.js';

/** Client per comandi e pubblicazioni. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Client dedicato alla lettura bloccante dalla coda (BRPOP): mentre è
 * bloccato non può servire altri comandi, quindi va tenuto separato.
 */
export const redisBlocking = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/** Client in modalità subscriber, per annullamenti e risposte alle approvazioni. */
export const redisSub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

for (const [name, client] of [
  ['cmd', redis],
  ['block', redisBlocking],
  ['sub', redisSub],
] as const) {
  client.on('error', (err) => console.error(`[redis:${name}]`, err.message));
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisBlocking.quit(), redisSub.quit()]);
}
