import { desc, eq, inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import type { Database } from './index.js';

/**
 * Allegati (immagini e file) resi disponibili agli agenti.
 *
 * Claude sa guardare le immagini con il tool Read: basta che il file esista
 * dove l'agente lavora. Qui decidiamo QUALI allegati contano per il turno e
 * come raccontarglieli; a copiarli ci pensa chi ha il disco sottomano —
 * il worker sul server o il runner sulla macchina della persona.
 */

/** Sottocartella dedicata, per non mescolarli al codice del progetto. */
export const ATTACH_DIR = '.hive/allegati';

/** Formati che il modello sa davvero guardare. */
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface AgentAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** Percorso relativo alla cartella di lavoro dell'agente. */
  relPath: string;
  viewable: boolean;
  /** Percorso sul disco del server: assente per i runner locali. */
  storagePath?: string;
}

/** Nome file sicuro: niente percorsi, niente sorprese. */
function safeName(id: string, filename: string): string {
  const base = filename.replace(/[^\w.\- ]+/g, '_').slice(-60) || 'allegato';
  return `${id.slice(0, 8)}-${base}`;
}

/**
 * Gli allegati dei messaggi recenti del canale: sono quelli di cui si sta
 * parlando adesso. Pochi, per non riempire il disco a ogni turno.
 */
export async function channelAttachments(
  db: Database,
  channelId: string,
  limit = 8,
): Promise<AgentAttachment[]> {
  const recent = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.channelId, channelId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(40);
  if (recent.length === 0) return [];

  const rows = await db
    .select()
    .from(schema.attachments)
    .where(
      inArray(
        schema.attachments.messageId,
        recent.map((m) => m.id),
      ),
    )
    .orderBy(desc(schema.attachments.createdAt))
    .limit(limit);

  return rows.map((a) => ({
    id: a.id,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    relPath: `${ATTACH_DIR}/${safeName(a.id, a.filename)}`,
    viewable: VIEWABLE.has(a.mime),
    storagePath: a.storagePath,
  }));
}

/** Le righe da mettere nel contesto dell'agente. */
export function describeAttachments(items: AgentAttachment[]): string {
  if (items.length === 0) return '';
  const lines = items.map((i) => {
    const kb = Math.max(1, Math.round(i.size / 1024));
    return i.viewable
      ? `- \`${i.relPath}\` — immagine «${i.filename}» (${kb} KB)`
      : `- \`${i.relPath}\` — ${i.filename} (${kb} KB)`;
  });
  return (
    `\n## File condivisi in questo canale\n` +
    `Sono già nella tua cartella di lavoro, con qualsiasi estensione abbiano. ` +
    `**Aprili con Read** invece di tirare a indovinare dal nome: le immagini le ` +
    `vedi davvero, e testo, codice e PDF li leggi. Per i formati che Read non ` +
    `apre (archivi, fogli di calcolo, binari) usa la shell.\n${lines.join('\n')}`
  );
}
