import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ChevronRight, Hash, Plus, Search } from 'lucide-react';
import { useStore, type RunState } from '../store.js';
import { Avatar } from '../components/Avatar.js';
import { useTicker } from '../components/Chat.js';
import { MobileHeader, STATUS_BAR, WithTabs } from './Shell.js';

/* ==========================================================================
   01 — Canali

   La prima domanda che ci si fa aprendo l'app dal telefono non è «cosa c'è di
   nuovo», è «cosa sta facendo l'agente». Per questo «Al lavoro» sta sopra
   l'elenco dei canali, e non dentro un pannello da aprire.
   ======================================================================== */

/** Riga di un agente al lavoro: cosa sta facendo e da quanto. */
function WorkingRow({ messageId, run }: { messageId: string; run: RunState }) {
  const navigate = useNavigate();
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const agent = agents.find((a) => a.id === run.agentId);
  const channel = channels.find((c) => c.id === run.channelId);
  const now = useTicker(true);
  const seconds = run.startedAt ? Math.floor((now - run.startedAt) / 1000) : 0;

  let current = 'sta ragionando…';
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i]!.event;
    if (e.type === 'tool.start') {
      current = e.label;
      break;
    }
  }

  return (
    <button
      onClick={() => navigate(run.channelId ? `/c/${run.channelId}#msg-${messageId}` : '/attivita')}
      className="flex w-full min-h-[62px] items-center gap-3 px-3.5 py-2.5 text-left"
    >
      <Avatar name={agent?.name ?? 'Agente'} emoji={agent?.avatarEmoji} color={agent?.avatarColor} size={38} isAgent />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[16px] font-semibold">{agent?.name ?? 'Agente'}</span>
          <span className="shrink-0 text-[12px] text-[var(--color-ink-faint)]">
            {run.numTurns > 0 ? `passaggio ${run.numTurns}` : channel ? `#${channel.name}` : ''}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[12px] text-[var(--color-ink-faint)] tabular-nums">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--color-ink-soft)]">
          {current}
        </p>
        {/* Avanzamento senza percentuale: non sappiamo quanto manca, e fingerlo
            sarebbe peggio. La luce che scorre dice «vivo», non «a metà». */}
        <div className="sweep mt-2 h-[3px] overflow-hidden rounded-full bg-[var(--color-sunken)]" />
      </div>
    </button>
  );
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-1.5">
      <span className="text-[11.5px] font-semibold tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
        {children}
      </span>
      <span className="flex-1" />
      {right}
    </div>
  );
}

export function MobileChannels() {
  const navigate = useNavigate();
  const workspace = useStore((s) => s.workspace);
  const user = useStore((s) => s.user);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const messagesByChannel = useStore((s) => s.messagesByChannel);
  const openChannel = useStore((s) => s.openChannel);

  const working = [...runs.entries()].filter(
    ([, r]) => r.status === 'running' || r.status === 'queued',
  );

  return (
    <WithTabs>
      <header className={clsx('shrink-0 bg-gradient-to-b from-[#d9dee2] to-[#cfd6db] px-4 pb-2.5', STATUS_BAR)}>
        <div className="flex items-center gap-2">
          <h1 className="text-[26px] font-bold tracking-[-0.03em]">Hive</h1>
          {workspace && (
            <span className="flex h-6 items-center gap-1 rounded-full border border-[rgba(28,34,40,.12)] bg-[rgba(255,255,255,.55)] px-2 text-[12.5px]">
              <span>{workspace.iconEmoji || '🐝'}</span>
              <span className="max-w-[120px] truncate">{workspace.name}</span>
            </span>
          )}
          <span className="flex-1" />
          {user && (
            <Avatar name={user.name} emoji={user.avatarEmoji} color={user.avatarColor} size={34} />
          )}
        </div>

        <div className="mt-2.5 flex h-[38px] items-center gap-2 rounded-[11px] border border-[rgba(28,34,40,.12)] bg-[rgba(255,255,255,.6)] px-3">
          <Search size={16} strokeWidth={2} className="shrink-0 text-[var(--color-ink-faint)]" />
          <input
            placeholder="Cerca ovunque"
            className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-[var(--color-ink-faint)]"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        {working.length > 0 && (
          <>
            <SectionLabel
              right={
                <button
                  onClick={() => navigate('/attivita')}
                  className="text-[13px] font-semibold text-[var(--color-honey)]"
                >
                  Attività
                </button>
              }
            >
              <span className="mr-1.5 inline-block h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--color-online)] align-middle" />
              Al lavoro
            </SectionLabel>
            <div className="mx-3 divide-y divide-[var(--color-line)] overflow-hidden rounded-[14px] bg-white">
              {working.map(([messageId, run]) => (
                <WorkingRow key={run.runId} messageId={messageId} run={run} />
              ))}
            </div>
          </>
        )}

        <SectionLabel
          right={
            <button className="text-[var(--color-honey)]" aria-label="Nuovo canale">
              <Plus size={18} strokeWidth={2.2} />
            </button>
          }
        >
          Canali
        </SectionLabel>
        <div className="mx-3 divide-y divide-[var(--color-line)] overflow-hidden rounded-[14px] bg-white">
          {channels.map((c) => {
            const last = messagesByChannel.get(c.id)?.at(-1);
            const author = last?.author;
            const unread = c.unreadCount ?? 0;
            return (
              <button
                key={c.id}
                onClick={() => {
                  void openChannel(c.id);
                  navigate(`/c/${c.id}`);
                }}
                className="flex min-h-[60px] w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
              >
                <Hash size={16} strokeWidth={2.2} className="shrink-0 text-[var(--color-ink-faint)]" />
                <div className="min-w-0 flex-1">
                  <div
                    className={clsx(
                      'truncate text-[16px] tracking-[-0.01em]',
                      unread > 0 ? 'font-bold' : 'font-medium',
                    )}
                  >
                    {c.name}
                  </div>
                  {last && (
                    <p
                      className={clsx(
                        'mt-0.5 truncate text-[13.5px]',
                        unread > 0
                          ? 'text-[var(--color-ink-soft)]'
                          : 'text-[var(--color-ink-faint)]',
                      )}
                    >
                      {author?.type === 'agent' && `${author.avatarEmoji ?? '🤖'} `}
                      {last.body.replace(/<@([a-z0-9._-]+)>/g, '@$1').slice(0, 80) ||
                        (last.attachments.length > 0 ? 'ha inviato un file' : '')}
                    </p>
                  )}
                </div>
                {unread > 0 ? (
                  <span className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--color-honey)] px-1.5 text-[12px] font-semibold text-white tabular-nums">
                    {unread}
                  </span>
                ) : (
                  <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-[var(--color-line-strong)]" />
                )}
              </button>
            );
          })}
          {channels.length === 0 && (
            <p className="px-3.5 py-5 text-center text-[13.5px] text-[var(--color-ink-faint)]">
              Nessun canale ancora.
            </p>
          )}
        </div>

        {agents.length > 0 && (
          <p className="px-4 pt-5 text-[12px] text-[var(--color-ink-faint)]">
            {agents.length} {agents.length === 1 ? 'agente' : 'agenti'} in questo progetto.
          </p>
        )}
      </div>
    </WithTabs>
  );
}
