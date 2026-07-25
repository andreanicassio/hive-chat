/**
 * Bozze del composer, una per conversazione.
 *
 * Quello che si scrive senza inviare appartiene al posto in cui lo si sta
 * scrivendo. Prima il testo viveva nello stato del composer, che è uno solo e
 * non si smonta cambiando canale: scrivevi in #annunci, passavi a #generale e
 * te lo ritrovavi lì — pronto a partire nel canale sbagliato.
 *
 * Stanno in `localStorage` e non in memoria perché una bozza deve sopravvivere
 * anche a una ricarica: è il momento in cui serve di più.
 */

const KEY = 'hive:drafts';

type Drafts = Record<string, string>;

function readAll(): Drafts {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Drafts) : {};
  } catch {
    return {};
  }
}

function writeAll(drafts: Drafts): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* archiviazione piena o bloccata: la bozza resta comunque a schermo */
  }
}

/** Un thread è una conversazione a sé: ha la sua bozza, non quella del canale. */
export function draftKey(channelId: string, threadRootId?: string | null): string {
  return threadRootId ? `${channelId}:${threadRootId}` : channelId;
}

export function readDraft(key: string): string {
  return readAll()[key] ?? '';
}

export function writeDraft(key: string, value: string): void {
  const all = readAll();
  // La bozza vuota si cancella invece di restare come stringa vuota: così
  // l'elenco non cresce con un residuo per ogni canale mai visitato.
  if (value.trim()) all[key] = value;
  else delete all[key];
  writeAll(all);
}
