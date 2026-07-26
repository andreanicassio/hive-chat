import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search as SearchIcon } from 'lucide-react';
import type { Message } from '@hive/shared';
import { Modal } from './Modal.js';
import { Avatar } from './Avatar.js';
import { api } from '../lib/api.js';
import { useStore } from '../store.js';

/**
 * Ricerca nei messaggi del progetto.
 *
 * Il bottone c'era da sempre, con la sua lente e la sua scorciatoia scritta
 * accanto, e sotto non c'era niente: né questo pannello né un endpoint. Da
 * qui si cerca solo nei canali di cui si è membri — il filtro sta sul
 * server, perché un filtro sul client non è un permesso.
 */

/** Il pezzo di testo attorno alla parola trovata, con la parola in evidenza. */
function Excerpt({ body, q }: { body: string; q: string }) {
  const plain = body.replace(/<@([a-z0-9._-]+)>/g, '@$1').replace(/<#([a-z0-9-]+)>/g, '#$1');
  const at = plain.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{plain.slice(0, 160)}</>;
  // Un po' di respiro prima della parola: un estratto che comincia esattamente
  // sul termine cercato non fa capire di cosa si stesse parlando.
  const from = Math.max(0, at - 50);
  return (
    <>
      {from > 0 && '…'}
      {plain.slice(from, at)}
      <mark className="rounded-[3px] bg-[var(--color-honey-soft)] px-0.5 text-[var(--color-ink)]">
        {plain.slice(at, at + q.length)}
      </mark>
      {plain.slice(at + q.length, at + q.length + 110)}
      {plain.length > at + q.length + 110 && '…'}
    </>
  );
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const channels = useStore((s) => s.channels);
  const openChannel = useStore((s) => s.openChannel);

  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const channelName = useMemo(
    () => new Map(channels.map((c) => [c.id, c.name])),
    [channels],
  );

  /*
   * Si cerca mentre scrivi, ma non a ogni tasto: 220ms di pausa. E ogni
   * risposta porta il numero della richiesta che l'ha chiesta — senza, una
   * ricerca lenta partita prima può atterrare dopo una veloce e rimettere in
   * pagina i risultati della parola precedente.
   */
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || !workspace) {
      setResults(null);
      setBusy(false);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .search(workspace.id, term)
        .then((r) => {
          if (seq.current === mine) setResults(r.results);
        })
        .catch(() => {
          if (seq.current === mine) setResults([]);
        })
        .finally(() => {
          if (seq.current === mine) setBusy(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [q, workspace]);

  async function go(message: Message) {
    await openChannel(message.channelId);
    onClose();
    // Il messaggio può essere fuori dalla finestra caricata: se non c'è, si
    // resta in cima al canale invece di far finta di averlo trovato.
    setTimeout(() => {
      const el = document.getElementById(`msg-${message.id}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-highlight');
      setTimeout(() => el.classList.remove('flash-highlight'), 1200);
    }, 250);
  }

  return (
    <Modal onClose={onClose} size="lg" tall flush>
      {/* Il campo resta in cima mentre i risultati scorrono: il modale ha già
          il suo scroller, e mettercene un altro dentro ne farebbe due. */}
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3">
        <SearchIcon size={16} strokeWidth={2.2} className="shrink-0 text-[var(--color-ink-faint)]" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the project's messages"
          className="w-full bg-transparent text-[15px] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        {busy && <Loader2 size={14} className="shrink-0 animate-spin text-[var(--color-ink-faint)]" />}
      </div>

      <div>
        {q.trim().length < 2 && (
          <p className="px-4 py-10 text-center text-[13.5px] text-[var(--color-ink-faint)]">
            Type at least two letters. Only the channels you belong to are searched.
          </p>
        )}
        {q.trim().length >= 2 && results?.length === 0 && !busy && (
          <p className="px-4 py-10 text-center text-[13.5px] text-[var(--color-ink-faint)]">
            Nothing for «{q.trim()}».
          </p>
        )}
        {results?.map((m) => (
          <button
            key={m.id}
            onClick={() => void go(m)}
            className="flex w-full items-start gap-2.5 border-b border-[var(--color-line)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-sunken)]"
          >
            <Avatar
              name={m.author.name}
              emoji={m.author.avatarEmoji}
              color={m.author.avatarColor}
              size={26}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5 text-[12.5px]">
                <span className="font-semibold">{m.author.name}</span>
                <span className="text-[var(--color-ink-faint)]">
                  #{channelName.get(m.channelId) ?? 'canale'} ·{' '}
                  {new Date(m.createdAt).toLocaleDateString()}
                </span>
              </span>
              <span className="mt-0.5 block text-[13.5px] leading-[1.5] text-[var(--color-ink-soft)]">
                <Excerpt body={m.body} q={q.trim()} />
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
