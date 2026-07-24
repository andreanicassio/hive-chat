import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { channelAttachments, type AgentAttachment } from '@hive/db';
import { db } from './db.js';

/**
 * Copia nella cartella di lavoro dell'agente le immagini e i file condivisi
 * nel canale, così può aprirli con Read (le immagini le vede davvero).
 * Gira sul server, dove i binari degli allegati stanno già su disco.
 */
export async function materializeAttachments(
  channelId: string,
  workDir: string,
): Promise<AgentAttachment[]> {
  const items = await channelAttachments(db, channelId);
  const done: AgentAttachment[] = [];
  for (const item of items) {
    if (!item.storagePath) continue;
    const dest = join(workDir, item.relPath);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(item.storagePath, dest);
      done.push(item);
    } catch {
      // Allegato sparito dal disco: meglio saltarlo che far fallire il turno.
    }
  }
  return done;
}
