import Redis from 'ioredis';
import { env } from '../env.js';
import { redisChannels } from '@hive/shared';
import { flushPendingPrompts } from './messages.js';
import { notifyRunFinishedById } from './notify.js';

/**
 * Ascolta la fine dei turni e fa partire i messaggi rimasti in coda.
 *
 * Usa una connessione propria e un canale dedicato: il fanout verso i client
 * è sottoscritto solo quando qualcuno è collegato, quindi non è affidabile
 * per una cosa che deve funzionare sempre.
 */
export function startPendingFlusher(): void {
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  sub.on('error', (err) => console.error('[coda] redis:', err.message));

  void sub.subscribe(redisChannels.runFinished);
  sub.on('message', (_channel, raw) => {
    try {
      const { runId, agentId, channelId } = JSON.parse(raw) as {
        runId?: string;
        agentId: string;
        channelId: string;
      };
      if (agentId && channelId) void flushPendingPrompts(agentId, channelId).catch(() => {});
      // Stesso segnale, secondo lettore: qui è l'unico punto che vede finire
      // TUTTI i turni, quelli sul server e quelli sui runner locali.
      if (runId) void notifyRunFinishedById(runId).catch(() => {});
    } catch {
      /* messaggio malformato: ignorato */
    }
  });
}
