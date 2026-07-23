import Redis from 'ioredis';
import { env } from '../env.js';

/**
 * Servono due connessioni distinte: una in modalità subscriber non può
 * eseguire comandi normali, quindi teniamo separati pub e sub.
 */
export const redisPub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

export const redisSub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

for (const [name, client] of [
  ['pub', redisPub],
  ['sub', redisSub],
] as const) {
  client.on('error', (err) => {
    console.error(`[redis:${name}]`, err.message);
  });
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redisPub.quit(), redisSub.quit()]);
}
