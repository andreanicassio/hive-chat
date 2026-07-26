import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowDown, PanelRight } from 'lucide-react';
import { useStore } from '../store.js';
import type { Message } from '@hive/shared';
import { Composer, DayDivider, MessageRow } from '../components/Chat.js';
import { MobileHeader } from './Shell.js';

/* ==========================================================================
   02 — Canale

   Nessuna tab bar qui: il pollice sta sul composer, e quaranta pixel in fondo
   sono più utili alla conversazione che a una barra di navigazione.
   ======================================================================== */

/**
 * «1 nuovo messaggio», sospesa sopra il composer.
 *
 * Compare solo quando sei risalito nella conversazione e ne arriva uno
 * nuovo: se sei già in fondo non serve, e una pillola che c'è sempre diventa
 * arredamento. Il margine negativo la fa galleggiare SOPRA il vassoio invece
 * di occupare una riga sua.
 *
 * Lo scorrimento lo fa il contenitore, non `scrollIntoView`: quello sposta
 * anche gli antenati e su iOS porta con sé mezza pagina.
 */
function NewMessagePill({
  scroller,
  messages,
}: {
  scroller: React.RefObject<HTMLDivElement | null>;
  messages: Message[];
}) {
  const [pending, setPending] = useState(0);
  const lastSeen = useRef(messages.length);
  const away = useRef(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      away.current = !atBottom;
      if (atBottom) {
        setPending(0);
        lastSeen.current = messages.length;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller, messages.length]);

  useEffect(() => {
    if (!away.current) {
      lastSeen.current = messages.length;
      return;
    }
    const n = messages.length - lastSeen.current;
    if (n > 0) setPending(n);
  }, [messages.length]);

  if (pending <= 0) return null;

  return (
    <div className="pointer-events-none -mt-[34px] flex justify-center">
      <button
        onClick={() => {
          const el = scroller.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          setPending(0);
          lastSeen.current = messages.length;
        }}
        className="glass-inline pointer-events-auto flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--color-honey)]"
      >
        <ArrowDown size={13} strokeWidth={2.6} />
        {pending} {pending === 1 ? 'nuovo messaggio' : 'nuovi messaggi'}
      </button>
    </div>
  );
}

export function MobileChannel() {
  const { channelId } = useParams<{ channelId: string }>();
  const navigate = useNavigate();
  const channels = useStore((s) => s.channels);
  const messagesByChannel = useStore((s) => s.messagesByChannel);
  const runs = useStore((s) => s.runs);
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const openChannel = useStore((s) => s.openChannel);
  const loadOlder = useStore((s) => s.loadOlder);
  const activeChannelId = useStore((s) => s.activeChannelId);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Entrare da un link diretto deve funzionare come entrare da un tap.
  useEffect(() => {
    if (channelId && channelId !== activeChannelId) void openChannel(channelId);
  }, [channelId, activeChannelId, openChannel]);

  const channel = channels.find((c) => c.id === channelId);
  const messages = channelId ? (messagesByChannel.get(channelId) ?? []) : [];

  // Si resta in fondo se ci si era: se stai leggendo indietro, non ti
  // trasciniamo giù a forza.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const channelAgents = agents.filter((a) => (a.channelIds ?? []).includes(channelId ?? ''));
  const busy = channelAgents.filter((a) =>
    [...runs.values()].some(
      (r) => r.agentId === a.id && (r.status === 'running' || r.status === 'queued'),
    ),
  ).length;

  if (!channel) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title="Canale" onBack={() => navigate('/')} />
        <div className="flex flex-1 items-center justify-center text-[14px] text-[var(--color-ink-faint)]">
          Canale non trovato.
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-panel)]">
      <MobileHeader
        title={channel.name}
        /*
         * Il sottotitolo dice lo stato, non l'anagrafica: in una chat quella
         * riga serve a sapere se dall'altra parte c'è qualcuno che sta
         * facendo qualcosa. Il tema del canale viene dopo, quando non c'è
         * niente di più urgente da dire.
         */
        subtitle={
          busy > 0
            ? `${busy} ${busy === 1 ? 'agente al lavoro' : 'agenti al lavoro'}`
            : channel.topic ||
              `${channelAgents.length} ${channelAgents.length === 1 ? 'agente' : 'agenti'}`
        }
        leading={
          <div
            className={clsx(
              'flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-bold',
              busy > 0
                ? 'bg-[var(--color-honey-soft)] text-[var(--color-honey)]'
                : 'bg-[var(--color-sunken)] text-[var(--color-ink-faint)]',
            )}
          >
            #
          </div>
        }
        onTitleTap={() => navigate('/attivita')}
        onBack={() => navigate('/')}
        right={
          <button
            onClick={() => navigate('/attivita')}
            aria-label="Attività"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-[var(--color-glass-line)] bg-[var(--color-glass)]"
          >
            <PanelRight size={16} strokeWidth={2.2} />
          </button>
        }
      />

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 120 && channelId) void loadOlder(channelId);
        }}
        className="screen-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <div className="pb-3">
          {messages.map((message, i) => {
            const previous = i > 0 ? messages[i - 1]! : null;
            const prevDate = previous ? new Date(previous.createdAt) : null;
            const date = new Date(message.createdAt);
            const newDay = !prevDate || prevDate.toDateString() !== date.toDateString();
            return (
              <div key={message.id} className={i === messages.length - 1 ? 'animate-in-msg' : ''}>
                {newDay && <DayDivider date={date} />}
                <MessageRow
                  message={message}
                  previous={newDay ? null : previous}
                  run={runs.get(message.id)}
                  approvals={approvals}
                  onOpenWork={(id) => navigate(`/c/${channel.id}/m/${id}/lavoro`)}
                  onOpenThread={(id) => navigate(`/c/${channel.id}/m/${id}/thread`)}
                />
              </div>
            );
          })}
          {messages.length === 0 && (
            <p className="px-6 py-10 text-center text-[14px] text-[var(--color-ink-faint)]">
              È l’inizio di #{channel.name}. Scrivi qualcosa, o tagga un agente.
            </p>
          )}
        </div>
      </div>

      {/* `pb-[env(safe-area-inset-bottom)]`: l'ultima riga non deve finire
          sotto la barra dell'home indicator. */}
      {/* Il vassoio del composer è vetro: la luce speculare e il capello
          stanno in ALTO, perché è il bordo verso cui scorre il contenuto.
          `pb-[env(safe-area-inset-bottom)]`: l'ultima riga non finisce sotto
          l'indicatore di sistema. */}
      <div className="glass-composer shrink-0 pb-[env(safe-area-inset-bottom)]">
        <NewMessagePill scroller={scroller} messages={messages} />
        <Composer channelId={channel.id} channelName={channel.name} />
      </div>
    </div>
  );
}
