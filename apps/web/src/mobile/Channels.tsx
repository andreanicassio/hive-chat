import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import { useStore } from '../store.js';
import { SearchPanel } from '../components/Search.js';
import { MobileHeader, WithTabs } from './Shell.js';

/* ==========================================================================
   01 — Conversazioni

   Un elenco solo, a tutta larghezza, come in ogni app di messaggi: riga per
   riga, l'ultima cosa detta e quando. Prima erano tre blocchi in schede
   arrotondate — «Al lavoro», «Canali», una nota sugli agenti in fondo — e
   l'occhio doveva scegliere dove guardare per una domanda che è una sola:
   cosa è successo mentre non c'ero.

   Chi sta lavorando non ha più una sezione sua: appare al posto
   dell'anteprima, nella riga del suo canale, come «sta scrivendo…» altrove.
   ======================================================================== */

/** «14:32» se è di oggi, «ieri», poi la data: come si legge un orario in chat. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'ieri';
  if (now.getTime() - d.getTime() < 7 * 86_400_000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

export function MobileChannels() {
  const navigate = useNavigate();
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const openChannel = useStore((s) => s.openChannel);
  const [searching, setSearching] = useState(false);

  /** Per ogni canale, l'agente che ci sta lavorando adesso (se c'è). */
  const busyByChannel = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of runs.values()) {
      if (r.status !== 'running' && r.status !== 'queued') continue;
      const agent = agents.find((a) => a.id === r.agentId);
      if (r.channelId) out.set(r.channelId, agent?.name ?? 'Un agente');
    }
    return out;
  }, [runs, agents]);

  /*
   * In cima chi ha parlato per ultimo, non chi è stato creato per primo.
   * Un elenco di conversazioni ordinato per data di creazione invecchia male:
   * dopo un mese il canale più vivo sta in fondo.
   */
  const ordered = useMemo(
    () =>
      [...channels].sort((a, b) => {
        const at = a.lastMessage?.createdAt ?? '';
        const bt = b.lastMessage?.createdAt ?? '';
        if (at && bt) return bt.localeCompare(at);
        if (at) return -1;
        if (bt) return 1;
        return a.position - b.position;
      }),
    [channels],
  );

  return (
    <WithTabs>
      <MobileHeader title="Conversazioni" large />

      <div data-tabs className="screen-scroll h-full overflow-y-auto">
        {/* La ricerca sta nell'elenco e scorre con lui: in cima ruba una riga
            a ogni apertura, e quasi sempre non serve. */}
        <div className="px-4 pb-1">
          <button
            onClick={() => setSearching(true)}
            className="flex h-[36px] w-full items-center gap-2 rounded-[10px] bg-[var(--color-sunken)] px-3 text-left"
          >
            <Search size={15} strokeWidth={2} className="shrink-0 text-[var(--color-ink-faint)]" />
            <span className="text-[14.5px] text-[var(--color-ink-faint)]">Cerca</span>
          </button>
        </div>

        {ordered.map((c) => {
          const unread = c.unreadCount ?? 0;
          const busy = busyByChannel.get(c.id);
          const last = c.lastMessage;
          return (
            <button
              key={c.id}
              onClick={() => {
                void openChannel(c.id);
                navigate(`/c/${c.id}`);
              }}
              className="flex w-full items-center gap-3 py-2 pr-4 pl-4 text-left active:bg-[var(--color-sunken)]"
            >
              <span
                className={clsx(
                  'flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full text-[17px] font-bold',
                  busy
                    ? 'bg-[var(--color-honey-soft)] text-[var(--color-honey)]'
                    : 'bg-[var(--color-sunken)] text-[var(--color-ink-faint)]',
                )}
              >
                #
              </span>

              {/* La riga sotto l'avatar corre fino al bordo, come in ogni
                  elenco di conversazioni: separa le righe senza disegnare una
                  griglia. */}
              <span className="flex min-w-0 flex-1 flex-col border-b border-[var(--color-line)] py-1.5">
                <span className="flex items-baseline gap-2">
                  <span
                    className={clsx(
                      'min-w-0 flex-1 truncate text-[16.5px] tracking-[-0.01em]',
                      unread > 0 ? 'font-bold' : 'font-semibold',
                    )}
                  >
                    {c.name}
                  </span>
                  {last && (
                    <span className="shrink-0 text-[12px] text-[var(--color-ink-faint)]">
                      {shortTime(last.createdAt)}
                    </span>
                  )}
                </span>

                <span className="mt-0.5 flex items-center gap-2">
                  <span
                    className={clsx(
                      'min-w-0 flex-1 truncate text-[14px]',
                      busy
                        ? 'text-[var(--color-honey)]'
                        : unread > 0
                          ? 'text-[var(--color-ink-soft)]'
                          : 'text-[var(--color-ink-faint)]',
                    )}
                  >
                    {busy ? (
                      `${busy} sta lavorando…`
                    ) : last ? (
                      <>
                        {last.isAgent && `${last.authorEmoji ?? '🤖'} `}
                        <span className="text-[var(--color-ink-faint)]">
                          {last.authorName.split(' ')[0]}:
                        </span>{' '}
                        {last.excerpt}
                      </>
                    ) : (
                      c.topic || 'Nessun messaggio'
                    )}
                  </span>
                  {unread > 0 && (
                    <span className="flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[var(--color-honey)] px-1.5 text-[11.5px] font-semibold text-[var(--color-on-accent)] tabular-nums">
                      {unread}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}

        {channels.length === 0 && (
          <p className="px-4 py-10 text-center text-[13.5px] text-[var(--color-ink-faint)]">
            Nessuna conversazione ancora.
          </p>
        )}
      </div>

      {searching && <SearchPanel onClose={() => setSearching(false)} />}
    </WithTabs>
  );
}
