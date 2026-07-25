import { useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { format } from 'date-fns';
import { Square, X } from 'lucide-react';
import { useStore, type RunState } from '../store.js';
import { api } from '../lib/api.js';
import { Avatar } from './Avatar.js';
import { Composer, MessageBody, WorkTab, useTicker, toolChipName } from './Chat.js';
import type { Message } from '@hive/shared';

/* ========================================================================== */
/*  Pannello laterale del canale: cosa stanno facendo gli agenti, e i thread   */
/* ========================================================================== */

/** Ultima operazione avviata in un run, quella che l'agente sta facendo ora. */
function currentTool(run: RunState): { name: string; label: string } | null {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i]!.event;
    if (e.type === 'tool.start') return { name: e.name, label: e.label };
  }
  return null;
}

/** Card di un agente al lavoro: cronometro, comando in corso, e come fermarlo. */
function ActiveRunCard({ run }: { run: RunState }) {
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === run.agentId);
  const now = useTicker(true);
  const seconds = run.startedAt ? Math.floor((now - run.startedAt) / 1000) : 0;
  const tool = currentTool(run);

  return (
    <div className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel)] p-[11px]">
      <div className="flex items-center gap-2">
        <span className="text-[14px]">{agent?.avatarEmoji ?? '🤖'}</span>
        <span className="text-[12.5px] font-semibold">{agent?.name ?? 'Agente'}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </div>

      <div className="mt-2 truncate rounded-md bg-[var(--color-panel-alt)] px-2 py-1.5 font-mono text-[10.5px] text-[var(--color-ink-soft)]">
        {tool?.label ?? (run.status === 'queued' ? 'in coda…' : 'sta ragionando…')}
      </div>

      <div className="mt-2.5 flex gap-1.5">
        <button
          onClick={() => void api.cancelRun(run.runId).catch(() => {})}
          className="flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] bg-[color-mix(in_oklab,var(--color-error)_10%,transparent)] text-[12px] font-medium text-[var(--color-error)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-error)_18%,transparent)]"
        >
          <Square size={10} strokeWidth={3} /> Interrompi
        </button>
      </div>
    </div>
  );
}

/** Registro: le ultime operazioni degli agenti in questo canale. */
function ActivityLog({ runs }: { runs: RunState[] }) {
  const agents = useStore((s) => s.agents);

  const rows = useMemo(() => {
    const out: Array<{
      key: string;
      agentName: string;
      tool: string;
      label: string;
      at: number;
      running: boolean;
    }> = [];
    for (const run of runs) {
      const agentName = agents.find((a) => a.id === run.agentId)?.name ?? 'Agente';
      const ended = new Set<string>();
      for (const t of run.events) {
        if (t.event.type === 'tool.end') ended.add(t.event.toolUseId);
      }
      for (const t of run.events) {
        if (t.event.type !== 'tool.start') continue;
        out.push({
          key: t.event.toolUseId,
          agentName,
          tool: toolChipName(t.event.name),
          label: t.event.label,
          at: t.at,
          running: !ended.has(t.event.toolUseId),
        });
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 30);
  }, [runs, agents]);

  if (rows.length === 0) {
    return (
      <p className="px-1 text-[12px] text-[var(--color-ink-faint)]">
        Qui compare quello che gli agenti fanno in questo canale, operazione per operazione.
      </p>
    );
  }

  return (
    <div>
      {rows.map((r) => (
        <div
          key={r.key}
          className="grid grid-cols-[14px_minmax(0,1fr)] gap-[9px] border-b border-[var(--color-line)] px-[3px] py-[7px] last:border-b-0"
        >
          <span
            className={clsx(
              'mt-[5px] h-[7px] w-[7px] rounded-full',
              r.running
                ? 'animate-pulse bg-[var(--color-online)]'
                : 'bg-[var(--color-ink-faint)]',
            )}
          />
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-semibold">{r.agentName}</span>
              <span className="font-mono text-[10px] text-[var(--color-ink-faint)]">{r.tool}</span>
              <span className="flex-1" />
              <span className="text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
                {format(new Date(r.at), 'HH:mm')}
              </span>
            </div>
            <div className="mt-0.5 font-mono text-[10.5px] break-all text-[var(--color-ink-soft)]">
              {r.label}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Quante tracce concluse tirare giù per riempire il registro. */
const LOG_DEPTH = 5;

function ActivityTab({ channelId }: { channelId: string }) {
  const runs = useStore((s) => s.runs);
  const loadRunEvents = useStore((s) => s.loadRunEvents);
  const mine = useMemo(
    () => [...runs.values()].filter((r) => r.channelId === channelId),
    [runs, channelId],
  );
  const active = mine.filter((r) => r.status === 'running' || r.status === 'queued');

  // All'apertura del canale le tracce dei run già conclusi non sono in memoria:
  // senza questo, dopo un ricaricamento il registro resta vuoto e sembra rotto.
  // Ne chiediamo poche, e solo qui: è un pannello che si apre apposta, non
  // qualcosa che pesa su ogni canale.
  const recent = useMemo(() => {
    const byId = new Map(mine.map((r) => [r.runId, r] as const));
    return [...byId.values()]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, LOG_DEPTH)
      .map((r) => r.runId);
  }, [mine]);

  useEffect(() => {
    for (const runId of recent) {
      const entry = [...runs.entries()].find(([, r]) => r.runId === runId);
      if (entry && !entry[1].eventsLoaded) void loadRunEvents(entry[0]);
    }
    // `recent` cambia solo quando cambia l'insieme dei run: `loadRunEvents`
    // segna subito la voce come caricata, quindi non si ripete.
  }, [recent, runs, loadRunEvents]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
      {active.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {active.map((r) => (
            <ActiveRunCard key={r.runId} run={r} />
          ))}
        </div>
      )}

      <div className="mb-2 text-[11.5px] font-semibold tracking-[0.04em] text-[var(--color-ink-faint)] uppercase">
        Registro
      </div>
      <ActivityLog runs={mine} />
    </div>
  );
}

/* ========================================================================== */
/*  Thread                                                                     */
/* ========================================================================== */

/** Una risposta dentro il thread: più stretta della riga di canale. */
function ThreadReply({ message }: { message: Message }) {
  const run = useStore((s) => s.runs.get(message.id));
  const isAgent = message.author.type === 'agent';

  return (
    <div className="grid grid-cols-[26px_minmax(0,1fr)] gap-2.5 py-2.5">
      <Avatar
        name={message.author.name}
        emoji={message.author.avatarEmoji}
        color={message.author.avatarColor}
        size={26}
        isAgent={isAgent}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold">{message.author.name}</span>
          {isAgent && (
            <span className="rounded-[4px] bg-[var(--color-sunken)] px-1 py-px text-[9.5px] font-semibold tracking-[0.07em] text-[var(--color-ink-soft)] uppercase">
              agente
            </span>
          )}
          <span className="text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
            {format(new Date(message.createdAt), 'HH:mm')}
          </span>
        </div>
        {run && <WorkTab run={run} messageId={message.id} />}
        {message.body && (
          <div className={clsx('mt-1', run && 'mt-2')}>
            <MessageBody body={message.body} streaming={run?.streaming === true} />
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadTab({ channelId, channelName }: { channelId: string; channelName: string }) {
  const rootId = useStore((s) => s.openThreadRootId);
  const replies = useStore((s) => (rootId ? s.threadsByRoot.get(rootId) : undefined));
  const root = useStore((s) =>
    rootId ? s.messagesByChannel.get(channelId)?.find((m) => m.id === rootId) : undefined,
  );
  const scroller = useRef<HTMLDivElement>(null);

  // Le risposte nuove arrivano in fondo: restiamoci.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies]);

  if (!rootId || !root) {
    return (
      <div className="flex min-h-0 flex-1 items-center px-5 text-center text-[12.5px] text-[var(--color-ink-faint)]">
        Apri un thread da un messaggio: le risposte restano qui, fuori dal canale.
      </div>
    );
  }

  const list = replies ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {/* Il messaggio radice è un riferimento, non il fuoco: sta in una card
            e con un corpo più piccolo delle risposte. */}
        <div className="rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel-alt)] px-[11px] py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Avatar
              name={root.author.name}
              emoji={root.author.avatarEmoji}
              color={root.author.avatarColor}
              size={18}
              isAgent={root.author.type === 'agent'}
            />
            <span className="text-[12.5px] font-semibold">{root.author.name}</span>
            <span className="text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
              {format(new Date(root.createdAt), 'HH:mm')}
            </span>
          </div>
          <MessageBody body={root.body} className="msg-body-work" />
        </div>

        <div className="mt-3.5 mb-1 flex items-center gap-2.5">
          <span className="text-[11px] font-semibold tracking-[0.04em] text-[var(--color-ink-faint)] uppercase">
            {root.replyCount} {root.replyCount === 1 ? 'risposta' : 'risposte'}
          </span>
          <span className="h-px flex-1 bg-[var(--color-line)]" />
        </div>

        {list.map((m) => (
          <ThreadReply key={m.id} message={m} />
        ))}
      </div>

      <Composer channelId={channelId} channelName={channelName} threadRootId={rootId} compact />
    </div>
  );
}

/* ========================================================================== */

export function ChannelAside({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: string;
}) {
  const tab = useStore((s) => s.asideTab);
  const setTab = useStore((s) => s.setAsideTab);
  const setOpen = useStore((s) => s.setAsideOpen);
  const replyCount = useStore((s) => {
    const rootId = s.openThreadRootId;
    if (!rootId) return 0;
    return s.messagesByChannel.get(channelId)?.find((m) => m.id === rootId)?.replyCount ?? 0;
  });

  return (
    <aside className="hidden w-[268px] shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-panel-alt)] lg:flex">
      <div className="flex h-[54px] shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        {(['activity', 'thread'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              'flex h-6 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-semibold tracking-[-0.005em] transition-colors',
              tab === t
                ? 'bg-[var(--color-sunken)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-faint)] hover:bg-[var(--color-sunken)]',
            )}
          >
            {t === 'activity' ? 'Attività' : 'Thread'}
            {t === 'thread' && replyCount > 0 && (
              <span className="text-[10.5px] font-medium text-[var(--color-ink-faint)] tabular-nums">
                {replyCount}
              </span>
            )}
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => setOpen(false)}
          className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          title="Chiudi il pannello"
        >
          <X size={14} strokeWidth={2.2} />
        </button>
      </div>

      {tab === 'activity' ? (
        <ActivityTab channelId={channelId} />
      ) : (
        <ThreadTab channelId={channelId} channelName={channelName} />
      )}
    </aside>
  );
}
