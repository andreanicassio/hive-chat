import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { format } from 'date-fns';
import { Square, X } from 'lucide-react';
import { useStore, type RunState } from '../store.js';
import { api } from '../lib/api.js';
import { Avatar } from './Avatar.js';
import { Composer, MessageBody, WorkTab, useTicker } from './Chat.js';
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

/**
 * L'ultima cosa che l'agente ha detto di stare facendo, con parole sue.
 *
 * È il riassunto migliore che esista: lo scrive lui fra uno strumento e
 * l'altro. Meglio di qualsiasi etichetta che potremmo dedurre dal nome del
 * comando — «Legge auth.ts» dice cosa, non perché.
 */
function currentNote(run: RunState): string | null {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i]!.event;
    if (e.type !== 'text.block') continue;
    const text = e.text.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    // La prima frase basta: qui serve il capo del discorso, non il discorso.
    const stop = text.search(/[.!?](\s|$)/);
    const first = stop > 30 ? text.slice(0, stop + 1) : text;
    return first.length > 180 ? `${first.slice(0, 179)}…` : first;
  }
  return null;
}

/** Famiglie di strumenti, per contarli invece di elencarli. */
const TOOL_FAMILY: Array<[RegExp, [string, string]]> = [
  [/^(Read|Glob|Grep|NotebookRead)$/, ['lettura', 'letture']],
  [/^(Edit|MultiEdit|Write|NotebookEdit)$/, ['modifica', 'modifiche']],
  [/^(Bash|BashOutput|KillShell)$/, ['comando', 'comandi']],
  [/^(WebFetch|WebSearch)$/, ['ricerca', 'ricerche']],
  [/^(Task|Agent)$/, ['sotto-agente', 'sotto-agenti']],
];

/**
 * Cosa ha fatto finora, in famiglie: «12 letture · 4 modifiche · 3 comandi».
 *
 * Un elenco di ogni singolo comando è rumore — dice tantissimo e non fa
 * capire niente. Il conteggio per famiglia dice la forma del lavoro in una
 * riga: se sta leggendo o se sta scrivendo.
 */
function toolTally(run: RunState): string {
  const counts = new Map<string, { one: string; many: string; n: number }>();
  for (const t of run.events) {
    const e = t.event;
    if (e.type !== 'tool.start') continue;
    const family = TOOL_FAMILY.find(([re]) => re.test(e.name))?.[1] ?? ['strumento', 'strumenti'];
    const key = family[1];
    const entry = counts.get(key) ?? { one: family[0], many: family[1], n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map((c) => `${c.n} ${c.n === 1 ? c.one : c.many}`)
    .join(' · ');
}

/** Il testo di un messaggio senza il markup delle menzioni. */
function plainText(body: string, max: number): string {
  const text = body
    .replace(/<@([a-z0-9._-]+)>/g, '@$1')
    .replace(/<#([a-z0-9-]+)>/g, '#$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Cosa sta facendo un agente, riassunto.
 *
 * Tre righe che rispondono a tre domande: cosa gli è stato chiesto, a che
 * punto è con parole sue, e che forma ha avuto il lavoro finora. Il comando
 * esatto in esecuzione sta in fondo, piccolo: serve solo a capire se è vivo.
 */
function ActiveRunCard({ run, channelId }: { run: RunState; channelId: string }) {
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === run.agentId);
  const asked = useStore((s) =>
    run.triggerMessageId
      ? s.messagesByChannel.get(channelId)?.find((m) => m.id === run.triggerMessageId)
      : undefined,
  );
  const now = useTicker(true);
  const seconds = run.startedAt ? Math.floor((now - run.startedAt) / 1000) : 0;
  const tool = currentTool(run);
  const note = currentNote(run);
  const tally = toolTally(run);

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

      {asked && (
        <p className="mt-2 border-l-2 border-[var(--color-line-strong)] pl-2 text-[12px] leading-[1.45] text-[var(--color-ink-faint)]">
          {plainText(asked.body, 120)}
        </p>
      )}

      <p className="mt-2 text-[13px] leading-[1.45] text-[var(--color-ink)]">
        {note ??
          (run.status === 'queued'
            ? 'In coda: parte appena si libera.'
            : tool
              ? tool.label
              : 'Sta ragionando…')}
      </p>

      {tally && (
        <p className="mt-1.5 text-[11.5px] text-[var(--color-ink-faint)]">
          {tally}
          {run.numTurns > 1 && ` · passaggio ${run.numTurns}`}
        </p>
      )}

      {note && tool && (
        <p className="mt-1.5 truncate font-mono text-[10.5px] text-[var(--color-ink-faint)]">
          {tool.label}
        </p>
      )}

      <button
        onClick={() => void api.cancelRun(run.runId).catch(() => {})}
        className="mt-2.5 flex h-[26px] w-full items-center justify-center gap-1.5 rounded-[7px] bg-[color-mix(in_oklab,var(--color-error)_10%,transparent)] text-[12px] font-medium text-[var(--color-error)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-error)_18%,transparent)]"
      >
        <Square size={10} strokeWidth={3} /> Interrompi
      </button>
    </div>
  );
}

/**
 * I turni già chiusi, una riga ciascuno.
 *
 * Non è un registro: di un turno finito interessa cosa gli era stato chiesto e
 * quanto ci ha messo, non la sequenza dei comandi. Quella, se serve, sta nella
 * tab di lavoro del messaggio — che è dove ha senso cercarla.
 */
function RecentTurns({
  runs,
  channelId,
}: {
  runs: Array<{ messageId: string; run: RunState }>;
  channelId: string;
}) {
  const agents = useStore((s) => s.agents);
  const messages = useStore((s) => s.messagesByChannel.get(channelId));

  const rows = useMemo(
    () =>
      runs
        .filter(({ run }) => run.status !== 'running' && run.status !== 'queued')
        .sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0))
        .slice(0, 8)
        .map(({ messageId, run }) => ({
          messageId,
          run,
          agentName: agents.find((a) => a.id === run.agentId)?.name ?? 'Agente',
          asked: run.triggerMessageId
            ? messages?.find((m) => m.id === run.triggerMessageId)?.body
            : undefined,
        })),
    [runs, agents, messages],
  );

  if (rows.length === 0) {
    return (
      <p className="px-1 text-[12px] leading-[1.5] text-[var(--color-ink-faint)]">
        Qui finiscono i turni già chiusi, con quello che era stato chiesto e quanto è durato.
      </p>
    );
  }

  return (
    <div>
      {rows.map(({ messageId, run, agentName, asked }) => {
        const secs =
          run.startedAt && run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : null;
        return (
          <button
            key={run.runId}
            title="Vai alla risposta"
            onClick={() => {
              const el = document.getElementById(`msg-${messageId}`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el?.classList.add('flash-highlight');
              setTimeout(() => el?.classList.remove('flash-highlight'), 1200);
            }}
            className="w-full border-b border-[var(--color-line)] py-2 text-left last:border-b-0"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-semibold">{agentName}</span>
              <span className="flex-1" />
              {secs !== null && (
                <span className="text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
                  {secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] leading-[1.45] text-[var(--color-ink-soft)]">
              {asked ? plainText(asked, 100) : 'Turno senza messaggio d’innesco'}
            </p>
            {run.status === 'cancelled' && (
              <span className="mt-1 inline-block text-[10.5px] text-[var(--color-ink-faint)]">
                interrotto
              </span>
            )}
            {run.status === 'error' && (
              <span className="mt-1 inline-block text-[10.5px] text-[var(--color-error)]">
                errore
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Quante tracce concluse tirare giù per riempire il registro. */
const LOG_DEPTH = 5;

function ActivityTab({ channelId }: { channelId: string }) {
  const runs = useStore((s) => s.runs);
  const loadRunEvents = useStore((s) => s.loadRunEvents);
  // Teniamo anche la chiave della mappa: è l'id della bolla dell'agente, e
  // serve per saltare al messaggio da «Turni recenti».
  const mine = useMemo(
    () =>
      [...runs.entries()]
        .filter(([, r]) => r.channelId === channelId)
        .map(([messageId, run]) => ({ messageId, run })),
    [runs, channelId],
  );
  const active = mine.filter(
    ({ run }) => run.status === 'running' || run.status === 'queued',
  );

  // Il riassunto di un turno in corso si regge sui suoi eventi, e dopo un
  // ricaricamento non sono in memoria. Ne chiediamo pochi, e solo qui: è un
  // pannello che si apre apposta, non qualcosa che pesa su ogni canale.
  const toLoad = useMemo(
    () =>
      [...mine]
        .sort((a, b) => (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0))
        .slice(0, LOG_DEPTH)
        .filter(({ run }) => !run.eventsLoaded)
        .map(({ messageId }) => messageId),
    [mine],
  );

  useEffect(() => {
    // `loadRunEvents` segna subito la voce come caricata, quindi non si ripete.
    for (const messageId of toLoad) void loadRunEvents(messageId);
  }, [toLoad, loadRunEvents]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
      {active.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {active.map(({ run }) => (
            <ActiveRunCard key={run.runId} run={run} channelId={channelId} />
          ))}
        </div>
      )}

      <div className="mb-1 text-[11.5px] font-semibold tracking-[0.04em] text-[var(--color-ink-faint)] uppercase">
        Turni recenti
      </div>
      <RecentTurns runs={mine} channelId={channelId} />
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

/* --- Larghezza del pannello ----------------------------------------------- */

const ASIDE_MIN = 260;
const ASIDE_MAX = 620;
const ASIDE_DEFAULT = 340;
const ASIDE_KEY = 'hive.aside.width';

/**
 * Larghezza del pannello, trascinabile e ricordata.
 *
 * Il trascinamento non passa dal React state a ogni pixel — scrive direttamente
 * la larghezza sull'elemento — ma qui basta lo state: il pannello è un solo
 * nodo e i suoi figli non si rimisurano a ogni frame. Su `pointerup` la
 * misura finisce in localStorage, non prima: salvare a ogni movimento
 * vorrebbe dire scrivere su disco cinquanta volte al secondo.
 */
function useAsideWidth() {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(ASIDE_KEY));
    return Number.isFinite(saved) && saved >= ASIDE_MIN && saved <= ASIDE_MAX
      ? saved
      : ASIDE_DEFAULT;
  });
  const [resizing, setResizing] = useState(false);
  const latest = useRef(width);
  latest.current = width;

  const startResize = (e: React.PointerEvent | null) => {
    // Doppio clic: torna alla larghezza di partenza.
    if (!e) {
      setWidth(ASIDE_DEFAULT);
      localStorage.setItem(ASIDE_KEY, String(ASIDE_DEFAULT));
      return;
    }
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = latest.current;
    setResizing(true);
    // Senza questo, trascinando si seleziona mezza chat.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: PointerEvent) => {
      // Il pannello sta a destra: trascinare verso sinistra lo allarga.
      const next = Math.min(ASIDE_MAX, Math.max(ASIDE_MIN, startWidth + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setResizing(false);
      localStorage.setItem(ASIDE_KEY, String(latest.current));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return { width, startResize, resizing };
}

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
  const { width, startResize, resizing } = useAsideWidth();

  return (
    <aside
      style={{ width }}
      className="relative hidden shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-panel-alt)] lg:flex"
    >
      {/* Presa per il ridimensionamento: larga 5px a cavallo del bordo, così
          si becca senza mirare. La riga che si vede resta quella del bordo. */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => startResize(null)}
        title="Trascina per ridimensionare, doppio clic per rimettere la larghezza di partenza"
        className={clsx(
          'absolute top-0 -left-[3px] z-20 h-full w-[6px] cursor-col-resize',
          'after:absolute after:inset-y-0 after:left-[2px] after:w-[2px] after:transition-colors',
          resizing
            ? 'after:bg-[var(--color-honey)]'
            : 'after:bg-transparent hover:after:bg-[var(--color-line-strong)]',
        )}
      />
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
