import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PanelRight } from 'lucide-react';
import { useStore } from '../store.js';
import { Composer, DayDivider, MessageRow } from '../components/Chat.js';
import { MobileHeader } from './Shell.js';

/* ==========================================================================
   02 — Canale

   Nessuna tab bar qui: il pollice sta sul composer, e quaranta pixel in fondo
   sono più utili alla conversazione che a una barra di navigazione.
   ======================================================================== */

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
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-panel)]">
      <MobileHeader
        title={`# ${channel.name}`}
        subtitle={
          busy > 0
            ? `${channelAgents.length} ${channelAgents.length === 1 ? 'agente' : 'agenti'} · ${busy} al lavoro`
            : channel.topic || `${channelAgents.length} agenti`
        }
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
        className="min-h-0 flex-1 overflow-y-auto"
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
      <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
        <Composer channelId={channel.id} channelName={channel.name} />
      </div>
    </div>
  );
}
