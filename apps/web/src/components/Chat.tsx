import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { format, isToday, isYesterday } from 'date-fns';
import { it } from 'date-fns/locale';
import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  ChevronRight,
  Hash,
  Loader2,
  Lock,
  Paperclip,
  Smile,
  Users,
  X,
  Reply,
  ArrowRight,
  CornerUpLeft,
  PanelRight,
  FolderOpen,
  MessagesSquare,
  ListChecks,
  Trash2,
  Square,
} from 'lucide-react';
import { useStore, type RunState } from '../store.js';
import { ArtifactPanel, ArtifactPinnedStrip } from './ArtifactPanel.js';
import { DocumentsPanel } from './DocumentsPanel.js';
import { ChannelMembers } from './ChannelMembers.js';
import { ChannelAside } from './ChannelAside.js';
import { Modal } from './Modal.js';
import { api } from '../lib/api.js';
import { realtime } from '../lib/ws.js';
import { draftKey, readDraft, writeDraft } from '../lib/drafts.js';
import { Avatar } from './Avatar.js';
import type { Approval, Message, ReplyPreview, RunEvent } from '@hive/shared';

/* ========================================================================== */
/*  Corpo del messaggio: markdown + menzioni rese come pillole                 */
/* ========================================================================== */

const MENTION_RE = /<@([a-z0-9][a-z0-9._-]*)>|<#([a-z0-9][a-z0-9-]*)>|<!(everyone)>/g;

function renderMentions(text: string, isAgentHandle: (h: string) => boolean) {
  const parts: Array<string | { handle: string; kind: 'user' | 'agent' | 'channel' | 'all' }> = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const index = m.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    if (m[1]) parts.push({ handle: m[1], kind: isAgentHandle(m[1]) ? 'agent' : 'user' });
    else if (m[2]) parts.push({ handle: m[2], kind: 'channel' });
    else parts.push({ handle: 'everyone', kind: 'all' });
    last = index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Allegati di un messaggio: le immagini si vedono, il resto si scarica. */
function Attachments({ items }: { items: Message['attachments'] }) {
  if (items.length === 0) return null;
  return (
    // `min-w-0` sui figli: senza, un elemento flex non scende sotto la
    // larghezza del suo contenuto, e un'immagine larga spingeva la pagina
    // oltre il 100% facendo comparire uno scorrimento orizzontale su tutto.
    <div className="mt-1.5 flex max-w-full flex-wrap gap-2">
      {items.map((a) =>
        a.mime.startsWith('image/') ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            title={a.filename}
            className="min-w-0 max-w-full"
          >
            <img
              src={a.url}
              alt={a.filename}
              loading="lazy"
              // 420px è il tetto su schermo largo, non una misura fissa: sotto
              // quella soglia comanda la larghezza disponibile.
              className="max-h-[300px] w-auto max-w-full rounded-[10px] border border-[var(--color-line)] object-contain"
              style={{ maxWidth: 'min(420px, 100%)' }}
            />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            download={a.filename}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-[var(--color-line)] px-2.5 py-1.5 text-[13px] transition-colors hover:bg-[var(--color-sunken)]"
          >
            <Paperclip size={13} className="shrink-0" />
            <span className="truncate">{a.filename}</span>
          </a>
        ),
      )}
    </div>
  );
}

/* --- L'onda ---------------------------------------------------------------

   Il testo che arriva sta SUBITO tutto nel DOM: le parole non ancora rivelate
   ci sono già, a `opacity: 0`. Così gli a capo sono definitivi fin dal primo
   istante e non c'è mai reflow — è il requisito esplicito del documento.
   Poi il fronte dell'onda avanza per conto suo e le accende in sequenza.

   Il primo tentativo animava ogni parola quando *entrava* nel DOM. Non
   funzionava: i token dal server arrivano a blocchi, venti parole entrano
   nello stesso frame e sfumano insieme. Un blocco che appare, non un'onda.
   Il fronte va quindi disaccoppiato dall'arrivo, ed è quello che fa qui.
------------------------------------------------------------------------- */

/** Passo pieno, in ms. La dissolvenza dura 600ms: a ~60ms si sovrappongono. */
const WAVE_MIN = 52;
const WAVE_JITTER = 34;

/**
 * Chi ha chiesto meno movimento non vede l'onda: il testo compare e basta.
 *
 * Va deciso QUI e non dentro il ticker: è questo valore a mettere `data-wave`
 * sul contenitore, e senza il ticker che le accende le parole resterebbero
 * invisibili per sempre. Un'animazione in meno è una preferenza; un messaggio
 * che non si legge è un guasto.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

/**
 * Quanto aspettare prima della prossima parola.
 *
 * Le pause dopo la punteggiatura vengono dal documento di design. Il ramo del
 * recupero no, e serve: il modello scrive circa 70 parole al secondo, cioè
 * quattro o cinque volte più in fretta dell'onda. A cadenza fissa, su una
 * risposta lunga il fronte resterebbe indietro di mezzo minuto. Quando la coda
 * si allunga il passo si accorcia, e l'onda si vede quando c'è il tempo di
 * vederla.
 */
function waveDelay(word: string, backlog: number): number {
  if (backlog > 24) return 12;
  const step = WAVE_MIN + Math.random() * WAVE_JITTER;
  const last = word.slice(-1);
  if ('.!?'.includes(last)) return step + 260;
  if (',;:'.includes(last)) return step + 120;
  return step;
}

/**
 * Fa avanzare il fronte dell'onda.
 *
 * Accende le parole scrivendo direttamente sul DOM, senza passare da React.
 * Non è pigrizia: il fronte avanza anche ottanta volte al secondo quando
 * recupera, e ogni passo che passasse dallo stato farebbe ri-analizzare tutto
 * il markdown del messaggio. Così invece il componente si ri-rende solo
 * quando arriva del testo nuovo, come prima, e l'onda costa un attributo.
 *
 * Le parole nuove nascono spente (è il CSS a deciderlo, finché il contenitore
 * ha `data-wave`), quindi non c'è niente da sincronizzare: il fronte le trova
 * e le accende quando arriva il loro turno.
 */
function useWave(host: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    let scheduledAt = performance.now();
    let scheduledFor = 0;

    /** Accende tutto fino alla fine, in ordine. Nessuno viene scavalcato. */
    const catchUp = () => {
      const nodes = host.current?.querySelectorAll<HTMLElement>('.word');
      if (!nodes) return;
      for (; cursor < nodes.length; cursor++) nodes[cursor]!.dataset.in = 'true';
    };

    const tick = () => {
      /*
       * Quanto siamo stati fermi davvero.
       *
       * I timer di una scheda in secondo piano vengono strozzati dal browser,
       * e su telefono succede appena metti via lo schermo. Al ritorno il
       * fronte si ritrova centinaia di parole indietro: invece di riprendere
       * il passo con calma — che vorrebbe dire testo che si accende a
       * chiazze mentre lo stai leggendo — recupera tutto in un colpo.
       */
      const late = performance.now() - scheduledAt - scheduledFor;
      const nodes = host.current?.querySelectorAll<HTMLElement>('.word');
      const total = nodes?.length ?? 0;
      // Il testo è stato sostituito, non allungato: succede quando un turno di
      // ragionamento si chiude e la bolla riparte da capo.
      if (cursor > total) cursor = 0;
      let delay = 40;
      if (nodes && cursor < total) {
        if (late > 800) {
          catchUp();
        } else {
          const backlog = total - cursor;
          const jump = backlog > 80 ? Math.ceil(backlog / 24) : 1;
          const until = Math.min(total, cursor + jump);
          for (; cursor < until; cursor++) nodes[cursor]!.dataset.in = 'true';
          delay = waveDelay(nodes[cursor - 1]?.textContent ?? '', backlog);
        }
      }
      scheduledAt = performance.now();
      scheduledFor = delay;
      timer = setTimeout(tick, delay);
    };

    // Tornando in primo piano si recupera subito, senza aspettare il tick:
    // è il momento in cui uno guarda lo schermo.
    const onVisible = () => {
      if (!document.hidden) catchUp();
    };
    document.addEventListener('visibilitychange', onVisible);

    scheduledAt = performance.now();
    scheduledFor = WAVE_MIN;
    timer = setTimeout(tick, WAVE_MIN);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, host]);
}

export function MessageBody({
  body,
  streaming,
  className,
}: {
  body: string;
  streaming?: boolean;
  className?: string;
}) {
  const agents = useStore((s) => s.agents);
  const agentHandles = useMemo(() => new Set(agents.map((a) => a.handle)), [agents]);
  const host = useRef<HTMLDivElement>(null);
  const waving = streaming === true && !prefersReducedMotion();
  useWave(host, waving);

  /*
   * Le sostituzioni DEVONO essere memoizzate.
   *
   * Scritte in linea, queste funzioni sono nuove a ogni render: React le vede
   * come componenti di tipo diverso e rismonta l'intero sottoalbero a ogni
   * token che arriva. Ogni parola diventa un nodo nuovo — e i nodi nuovi non
   * hanno l'attributo che l'onda ha appena scritto sui vecchi, quindi il
   * messaggio restava invisibile fino a fine streaming.
   *
   * Le menzioni le intercettiamo qui invece di pre-processare il markdown,
   * così non rompiamo blocchi di codice che contengono la stessa sintassi.
   */
  const components = useMemo(() => {
    const ctx: WordCtx = { agentHandles, splitting: waving };
    return {
      p: ({ children }: { children?: React.ReactNode }) => (
        <p>{transformChildren(children, ctx)}</p>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <li>{transformChildren(children, ctx)}</li>
      ),
      h1: ({ children }: { children?: React.ReactNode }) => (
        <h1>{transformChildren(children, ctx)}</h1>
      ),
      h2: ({ children }: { children?: React.ReactNode }) => (
        <h2>{transformChildren(children, ctx)}</h2>
      ),
      h3: ({ children }: { children?: React.ReactNode }) => (
        <h3>{transformChildren(children, ctx)}</h3>
      ),
      td: ({ children }: { children?: React.ReactNode }) => (
        <td>{transformChildren(children, ctx)}</td>
      ),
      th: ({ children }: { children?: React.ReactNode }) => (
        <th>{transformChildren(children, ctx)}</th>
      ),
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {transformChildren(children, ctx)}
        </a>
      ),
    };
  }, [agentHandles, waving]);

  return (
    <div ref={host} className={clsx('msg-body', className)} data-wave={waving ? 'true' : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

interface WordCtx {
  agentHandles: Set<string>;
  /** Falso a turno fermo: niente span, il testo va nel DOM così com'è. */
  splitting: boolean;
}

/**
 * Divide un pezzo di testo in parole, una per span.
 *
 * Gli spazi restano testo nudo: la riga va a capo esattamente dove andrebbe
 * senza gli span. Le parole nascono spente — lo dice il CSS finché il
 * contenitore è in streaming — e le accende il fronte dell'onda.
 */
function revealWords(text: string, keyPrefix: string): React.ReactNode {
  return text.split(/(\s+)/).map((chunk, i) =>
    chunk === '' || /^\s+$/.test(chunk) ? (
      chunk
    ) : (
      <span key={`${keyPrefix}-${i}`} className="word">
        {chunk}
      </span>
    ),
  );
}

/** Dentro questi il testo non si tocca: spezzarlo romperebbe la formattazione. */
const INSTANT_TAGS = new Set(['code', 'pre', 'kbd', 'samp']);

function transformChildren(children: React.ReactNode, ctx: WordCtx): React.ReactNode {
  return (Array.isArray(children) ? children : [children]).map((child, i) => {
    if (typeof child === 'string') {
      const parts = renderMentions(child, (h) => ctx.agentHandles.has(h));
      return (
        <span key={i}>
          {parts.map((part, j) =>
            typeof part === 'string' ? (
              ctx.splitting ? (
                revealWords(part, `${i}-${j}`)
              ) : (
                part
              )
            ) : (
              <span key={j} className="mention" data-kind={part.kind}>
                {part.kind === 'agent' && <Bot size={11} strokeWidth={2.4} />}
                {part.kind === 'channel' ? `#${part.handle}` : `@${part.handle}`}
              </span>
            ),
          )}
        </span>
      );
    }

    // Grassetto, corsivo e simili: il testo lì dentro deve entrare nell'onda
    // come il resto, altrimenti una parola in grassetto comparirebbe di colpo
    // in mezzo alla frase. Solo i tag nativi: i componenti nostri (`a`)
    // chiamano già questa funzione da sé, e trattarli qui li conterebbe due
    // volte.
    if (isValidElement(child) && typeof child.type === 'string' && !INSTANT_TAGS.has(child.type)) {
      const inner = (child.props as { children?: React.ReactNode }).children;
      if (inner !== undefined && inner !== null) {
        return cloneElement(child, undefined, transformChildren(inner, ctx));
      }
    }
    return child;
  });
}

/* ========================================================================== */
/*  Tab di lavoro: dove finisce tutto quello che non è la risposta             */
/* ========================================================================== */

/**
 * Un passaggio del lavoro dell'agente: o un pezzo di ragionamento, o
 * un'operazione con uno strumento.
 */
export type WorkStep =
  | { kind: 'text'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      name: string;
      label: string;
      done: boolean;
      error: boolean;
      startedAt: number;
      endedAt: number | null;
    };

/** Orologio che scorre: si aggiorna solo mentre serve davvero. */
export function useTicker(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

/** "0,31 s" per le operazioni: sotto il minuto il decimo conta. */
export function shortDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "2m 14s" per il totale del turno: qui i decimi non servono. */
export function totalDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function buildSteps(run: RunState): WorkStep[] {
  const steps: WorkStep[] = [];
  const byToolUse = new Map<string, Extract<WorkStep, { kind: 'tool' }>>();
  for (const [i, timed] of run.events.entries()) {
    const e = timed.event;
    if (e.type === 'text.block') {
      steps.push({ kind: 'text', key: `t${i}`, text: e.text });
    } else if (e.type === 'tool.start') {
      const step = {
        kind: 'tool' as const,
        key: e.toolUseId,
        name: e.name,
        label: e.label,
        done: false,
        error: false,
        startedAt: timed.at,
        endedAt: null as number | null,
      };
      byToolUse.set(e.toolUseId, step);
      steps.push(step);
    } else if (e.type === 'tool.end') {
      const step = byToolUse.get(e.toolUseId);
      if (step) {
        step.done = true;
        step.error = e.isError;
        step.endedAt = timed.at;
      }
    }
  }
  return steps;
}

/** Nome corto dello strumento per i chip: `mcp__hive__read_document` → `read_document`. */
export function toolChipName(name: string): string {
  const parts = name.split('__');
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

/** Una riga del registro operazioni. */
function OpRow({
  step,
  now,
  alt,
}: {
  step: Extract<WorkStep, { kind: 'tool' }>;
  /** Ora corrente se il turno è in corso, ora di fine se è già concluso: senza
      questo, un'operazione rimasta senza `tool.end` (un turno interrotto)
      mostrerebbe una durata che continua a crescere per sempre. */
  now: number;
  alt: boolean;
}) {
  const elapsed = Math.max(0, (step.endedAt ?? now) - step.startedAt);
  return (
    <div
      className={clsx(
        'grid grid-cols-[16px_46px_minmax(0,1fr)_52px] items-center gap-2.5 px-[11px] py-[7px]',
        alt && 'bg-[var(--color-panel-alt)]',
      )}
    >
      {step.done ? (
        step.error ? (
          <X size={10} strokeWidth={3} className="mx-auto text-[var(--color-error)]" />
        ) : (
          <Check size={10} strokeWidth={3} className="mx-auto text-[var(--color-online)]" />
        )
      ) : (
        <span className="mx-auto h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-online)]" />
      )}
      <span className="truncate font-mono text-[10.5px] text-[var(--color-ink-soft)]">
        {toolChipName(step.name)}
      </span>
      <span className="truncate font-mono text-[11px] text-[var(--color-ink-soft)]">
        {step.label}
      </span>
      <span className="text-right font-mono text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
        {shortDuration(elapsed)}
      </span>
    </div>
  );
}

/**
 * Il lavoro dell'agente, chiuso in una tab.
 *
 * La regola è che, chiusa, occupi due righe: un agente verboso non deve poter
 * rendere illeggibile un canale. Fuori dalla tab resta solo la risposta.
 *
 * Il ragionamento arriva come eventi `text.block` — senza quelli sarebbe
 * perso, perché a fine turno il corpo del messaggio viene sovrascritto con il
 * testo conclusivo. Per un turno già finito la traccia non è in memoria: la
 * chiediamo al server solo quando qualcuno apre la tab.
 */
export function WorkTab({ run, messageId }: { run: RunState; messageId: string }) {
  const live = run.status === 'running' || run.status === 'queued';
  // Chiusa sempre, anche mentre lavora: l'intestazione dice già che sta
  // lavorando, a che passaggio è e da quanto. Aprirla da sola farebbe crescere
  // il canale sotto agli occhi di chi sta leggendo altro. Se la apri tu,
  // resta aperta: non te la richiudiamo a fine turno.
  const [open, setOpen] = useState(false);
  const loadRunEvents = useStore((s) => s.loadRunEvents);

  const now = useTicker(live);
  const steps = useMemo(() => buildSteps(run), [run.events]);
  const tools = steps.filter((s): s is Extract<WorkStep, { kind: 'tool' }> => s.kind === 'tool');
  const thinking = run.events.some((e) => e.event.type === 'thinking.start');

  // Una risposta secca non ha "lavoro svolto": un solo passaggio e nessuno
  // strumento vuol dire che l'agente ha semplicemente risposto, e mettergli
  // sopra una tab vuota sarebbe rumore su ogni singolo messaggio. Dopo un
  // ricaricamento la traccia non è in memoria, ma `numTurns` basta a
  // distinguere i due casi.
  const stepCount = Math.max(run.numTurns, tools.length);
  if (stepCount < 2 && tools.length === 0 && steps.length === 0 && !thinking) return null;

  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : null;
  const chips = [...new Set(tools.map((t) => toolChipName(t.name)))].slice(-3);

  function toggle() {
    if (!open) void loadRunEvents(messageId);
    setOpen(!open);
  }

  return (
    <div
      className={clsx(
        'mt-2 max-w-[620px] overflow-hidden rounded-[9px] border bg-[var(--color-panel-alt)]',
        live ? 'border-[var(--color-line-strong)]' : 'border-[var(--color-line)]',
      )}
    >
      <button
        onClick={toggle}
        className="flex h-[34px] w-full items-center gap-[9px] px-[11px] text-left transition-colors hover:bg-[var(--color-sunken)]"
      >
        <ChevronRight
          size={11}
          strokeWidth={2.6}
          className={clsx(
            'shrink-0 text-[var(--color-ink-faint)] transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-[12.5px] font-semibold tracking-[-0.005em] text-[var(--color-ink-soft)]">
          {live ? 'Working' : 'Work'}
        </span>
        <span className="shrink-0 text-[11.5px] text-[var(--color-ink-faint)]">
          {live
            ? `step ${stepCount || 1}`
            : `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`}
        </span>
        <span className="flex-1" />
        {!live && chips.length > 0 && (
          <span className="hidden shrink-0 gap-1 sm:flex">
            {chips.map((c) => (
              <span
                key={c}
                className="rounded-[4px] bg-[var(--color-sunken)] px-[5px] py-px font-mono text-[10px] text-[var(--color-ink-soft)]"
              >
                {c}
              </span>
            ))}
          </span>
        )}
        {live && (
          <span className="h-[9px] w-[9px] shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--color-line-strong)] border-t-[var(--color-ink-faint)]" />
        )}
        {elapsed !== null && (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-ink-faint)] tabular-nums">
            {totalDuration(elapsed)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-panel)]">
          {steps.length === 0 ? (
            <div className="px-[14px] py-3 text-[13px] text-[var(--color-ink-faint)]">
              {thinking ? 'It thought this through, without using tools.' : 'No trace available.'}
            </div>
          ) : (
            <WorkSteps steps={steps} now={run.endedAt ?? now} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * La stessa tab, ridotta a una riga che naviga.
 *
 * È la versione da telefono: espandere otto passaggi dentro lo scroll del
 * canale lo renderebbe illeggibile, quindi il lavoro diventa una schermata a
 * parte e qui resta solo la porta — alta 44px, che è la misura minima sotto
 * la quale un dito sbaglia bersaglio.
 */
export function WorkRow({ run, onOpen }: { run: RunState; onOpen: () => void }) {
  const live = run.status === 'running' || run.status === 'queued';
  const now = useTicker(live);
  const steps = useMemo(() => buildSteps(run), [run.events]);
  const tools = steps.filter((s): s is Extract<WorkStep, { kind: 'tool' }> => s.kind === 'tool');
  const stepCount = Math.max(run.numTurns, tools.length);
  if (stepCount < 2 && tools.length === 0 && steps.length === 0) return null;

  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : null;
  const running = tools.find((t) => !t.done);
  const seconds = elapsed !== null ? Math.floor(elapsed / 1000) : null;

  return (
    // Due bottoni affiancati, non annidati: quello grande naviga, quello
    // piccolo ferma il turno. In un solo `button` non ci potrebbero stare.
    <div className="mt-2 flex items-stretch gap-1.5">
      <button
        onClick={onOpen}
        className={clsx(
          'flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border px-3 text-left',
          live
            ? 'sweep-slow border-[var(--color-line-strong)] bg-[var(--color-panel-alt)]'
            : 'border-[var(--color-line)] bg-[var(--color-panel-alt)]',
        )}
      >
        {live ? (
          <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-[var(--color-online)]" />
        ) : (
          <PanelRight
            size={15}
            strokeWidth={2.2}
            className="shrink-0 text-[var(--color-ink-faint)]"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[13.5px] font-semibold text-[var(--color-ink-soft)]">
              {live ? 'Working' : 'Work'}
            </span>
            {live && seconds !== null && (
              <span className="text-[12px] text-[var(--color-ink-faint)] tabular-nums">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
              </span>
            )}
          </span>
          <span className="block truncate text-[12px] text-[var(--color-ink-faint)]">
            {live
              ? (running?.label ?? 'thinking…')
              : `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}${
                  elapsed !== null ? ` · ${totalDuration(elapsed)}` : ''
                }`}
          </span>
        </span>
        <ChevronRight
          size={17}
          strokeWidth={2}
          className="shrink-0 text-[var(--color-line-strong)]"
        />
      </button>

      {live && (
        <button
          onClick={() => void api.cancelRun(run.runId).catch(() => {})}
          aria-label="Stop this turn"
          className="flex w-11 shrink-0 items-center justify-center rounded-[10px] border border-[var(--color-line)] bg-[var(--color-panel-alt)] text-[var(--color-ink-faint)] transition-colors active:text-[var(--color-error)]"
        >
          <Square size={13} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

/**
 * Ragionamento e operazioni in ordine.
 *
 * La tipografia qui è più piccola del messaggio finale (13,5px contro 15px):
 * la gerarchia fra "lavoro" e "risposta" è il punto della tab, e darle lo
 * stesso corpo la annullerebbe.
 */
function WorkSteps({ steps, now }: { steps: WorkStep[]; now: number }) {
  // Le operazioni consecutive stanno in un unico registro, con le righe
  // alternate: una tabella si legge, una sequenza di card no.
  const groups: Array<WorkStep | Extract<WorkStep, { kind: 'tool' }>[]> = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (step.kind === 'tool' && Array.isArray(last)) last.push(step);
    else if (step.kind === 'tool') groups.push([step]);
    else groups.push(step);
  }

  return (
    <div className="flex flex-col gap-3 py-[13px]">
      {groups.map((group, i) =>
        Array.isArray(group) ? (
          <div key={`ops-${i}`} className="overflow-hidden">
            {group.map((step, j) => (
              <OpRow key={step.key} step={step} now={now} alt={j % 2 === 1} />
            ))}
          </div>
        ) : group.kind === 'text' ? (
          <MessageBody
            key={group.key}
            body={group.text}
            className="msg-body-work px-[14px]"
          />
        ) : null,
      )}
    </div>
  );
}

/* ========================================================================== */
/*  Card di approvazione: il gate umano prima di un'azione irreversibile       */
/* ========================================================================== */

function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === approval.agentId);

  async function decide(allowed: boolean) {
    setBusy(true);
    try {
      await api.decideApproval(approval.id, allowed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-[11px] border border-[color-mix(in_oklab,var(--color-busy)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-busy)_7%,var(--color-panel))]">
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <span className="mt-0.5 text-[15px]">{agent?.avatarEmoji ?? '🤖'}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">
            {agent?.name ?? 'An agent'} needs your approval
          </div>
          <div className="mt-0.5 text-[13.5px] text-[var(--color-ink-soft)]">{approval.title}</div>
        </div>
      </div>

      {approval.detail && (
        <pre className="mx-3.5 mt-2.5 max-h-44 overflow-auto rounded-lg bg-[var(--color-panel-alt)] px-3 py-2 font-mono text-[12.5px] leading-relaxed">
          {approval.detail}
        </pre>
      )}

      <div className="flex items-center gap-2 px-3.5 py-3">
        <button className="btn btn-primary h-8" onClick={() => void decide(true)} disabled={busy}>
          Allow
        </button>
        <button className="btn btn-ghost h-8" onClick={() => void decide(false)} disabled={busy}>
          Deny
        </button>
        <span className="ml-auto text-[12px] text-[var(--color-ink-faint)]">
          Nothing runs until you decide
        </span>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Intestazione di un turno in corso: puntini, cronometro, stop               */
/* ========================================================================== */

function LiveHint({ run, compact }: { run: RunState; compact?: boolean }) {
  const now = useTicker(true);
  const seconds = run.startedAt ? Math.floor((now - run.startedAt) / 1000) : 0;

  // Su schermo stretto nell'intestazione restano solo i puntini. Il resto —
  // cronometro e «Ferma» — non sparisce: scende nella riga del lavoro, che sta
  // subito sotto. Sei elementi su una riga da 390px si accavallano, e il
  // documento dice che lo stato «sta scrivendo» lo dicono i puntini.
  if (compact) {
    return (
      <span className="flex items-center gap-[3px]">
        {[0, 0.18, 0.36].map((delay) => (
          <span
            key={delay}
            className="typing-dot h-1 w-1 rounded-full bg-[var(--color-ink-faint)]"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 text-[11.5px] text-[var(--color-ink-faint)]">
      <span className="flex items-center gap-[3px]">
        {[0, 0.18, 0.36].map((delay) => (
          <span
            key={delay}
            className="typing-dot h-1 w-1 rounded-full bg-[var(--color-ink-faint)]"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </span>
      <span className="tabular-nums">
        is typing · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </span>
      <button
        onClick={() => void api.cancelRun(run.runId).catch(() => {})}
        className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel-alt)] px-2 py-px transition-colors hover:border-[color-mix(in_oklab,var(--color-error)_35%,var(--color-line))] hover:text-[var(--color-error)]"
        title="Stop this turn"
      >
        Stop
      </button>
    </span>
  );
}

/* ========================================================================== */
/*  Barra "N risposte": nel canale, un thread è solo questo                    */
/* ========================================================================== */

function ThreadBar({ message, onOpen }: { message: Message; onOpen?: () => void }) {
  const openThread = useStore((s) => s.openThread);
  const last = message.threadLastReplyAt ? new Date(message.threadLastReplyAt) : null;

  return (
    <button
      onClick={() => (onOpen ? onOpen() : openThread(message.id))}
      className="-ml-[5px] mt-[9px] inline-flex items-center gap-2 rounded-lg border border-transparent py-1 pr-[9px] pl-[5px] transition-colors hover:border-[var(--color-line)] hover:bg-[var(--color-panel-alt)]"
    >
      {message.threadParticipants.length > 0 && (
        <span className="flex">
          {message.threadParticipants.slice(0, 3).map((p, i) => (
            <span
              key={`${p.type}-${p.id}`}
              className="rounded-full border-[1.5px] border-[var(--color-panel)]"
              style={{ marginLeft: i === 0 ? 0 : -6 }}
            >
              <Avatar
                name={p.name}
                emoji={p.avatarEmoji}
                color={p.avatarColor}
                size={20}
                isAgent={p.type === 'agent'}
              />
            </span>
          ))}
        </span>
      )}
      <span className="text-[12.5px] font-semibold tracking-[-0.005em] text-[var(--color-honey)]">
        {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {last && (
        <span className="text-[11.5px] text-[var(--color-ink-faint)]">
          last at {format(last, 'HH:mm')}
        </span>
      )}
    </button>
  );
}

/* ========================================================================== */
/*  Eliminare un proprio messaggio                                             */
/* ========================================================================== */

/**
 * Conferma prima di eliminare.
 *
 * Il punto non è chiedere «sei sicuro?» — è dire **cosa** succede. Se quel
 * messaggio ha fatto partire un agente, cancellarlo lo ferma: chi clicca deve
 * saperlo prima, non scoprirlo dopo vedendo un turno interrotto.
 */
function DeleteMessageDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const agents = useStore((s) => s.agents);
  // I turni che questo messaggio ha innescato e che non sono ancora finiti.
  /*
   * Il selettore prende la mappa, il filtro sta fuori.
   *
   * Filtrare DENTRO il selettore restituiva un array nuovo a ogni chiamata, e
   * React interroga lo store più volte per render: vedendo sempre un valore
   * diverso concludeva che stesse cambiando di continuo e ri-renderizzava
   * all'infinito. È il «Maximum update depth exceeded» che si vedeva aprendo
   * questa conferma.
   */
  const runs = useStore((s) => s.runs);
  const affected = useMemo(
    () =>
      [...runs.values()].filter(
        (r) =>
          r.triggerMessageId === message.id &&
          (r.status === 'queued' || r.status === 'running' || r.status === 'awaiting_approval'),
      ),
    [runs, message.id],
  );

  async function remove() {
    setBusy(true);
    setFailed(false);
    try {
      await api.deleteMessage(message.id);
      onClose();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  const names = affected
    .map((r) => agents.find((a) => a.id === r.agentId)?.name)
    .filter((n): n is string => Boolean(n));

  return (
    <Modal
      onClose={onClose}
      title="Delete this message?"
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn bg-[var(--color-error)] text-[var(--color-on-accent)] hover:brightness-110"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      }
    >
      <p className="text-[14px] text-[var(--color-ink-soft)]">
        The text disappears for everyone and can't be recovered. In its place stays a line saying
        there was a message here.
      </p>

      {names.length > 0 && (
        <div className="mt-3 flex items-start gap-2.5 rounded-[10px] border border-[color-mix(in_oklab,var(--color-honey)_35%,transparent)] bg-[var(--color-honey-soft)] px-3 py-2.5">
          <Bot size={15} strokeWidth={2.2} className="mt-0.5 shrink-0" />
          <p className="text-[13.5px]">
            {names.length === 1 ? (
              <>
                <strong className="font-semibold">{names[0]}</strong> is replying to this message:
                deleting it <strong className="font-semibold">stops it too</strong>.
              </>
            ) : (
              <>
                <strong className="font-semibold">{names.join(', ')}</strong> are replying to this
                message: deleting it{' '}
                <strong className="font-semibold">stops them too</strong>.
              </>
            )}
          </p>
        </div>
      )}

      {failed && (
        <p className="mt-3 text-[13.5px] text-[var(--color-error)]">
          Couldn't delete it. Try again.
        </p>
      )}
    </Modal>
  );
}

/* ========================================================================== */
/*  Citazione del messaggio a cui si risponde                                  */
/* ========================================================================== */

/** Testo di anteprima per le pillole: niente markup delle menzioni. */
function plainExcerpt(body: string): string {
  return body
    .replace(/<@([a-z0-9._-]+)>/g, '@$1')
    .replace(/<#([a-z0-9-]+)>/g, '#$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Salta a un messaggio e lo evidenzia un istante. */
function jumpToMessage(id: string): void {
  const el = document.getElementById(`msg-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash-highlight');
  setTimeout(() => el.classList.remove('flash-highlight'), 1200);
}

function QuotedReply({ reply }: { reply: ReplyPreview }) {
  return (
    <button
      onClick={() => jumpToMessage(reply.id)}
      className="mb-1 flex max-w-full items-center gap-1.5 text-left text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
    >
      <CornerUpLeft size={12} strokeWidth={2.2} className="shrink-0 text-[var(--color-ink-faint)]" />
      <span className="shrink-0 font-medium">{reply.authorName}</span>
      <span className="min-w-0 truncate text-[var(--color-ink-faint)]">
        {reply.deleted ? 'deleted message' : reply.excerpt}
      </span>
    </button>
  );
}

/* ========================================================================== */
/*  Singolo messaggio                                                          */
/* ========================================================================== */

export function MessageRow({
  message,
  previous,
  run,
  approvals,
  onOpenWork,
  onOpenThread,
}: {
  message: Message;
  previous: Message | null;
  run: RunState | undefined;
  approvals: Approval[];
  /**
   * Su telefono il lavoro dell'agente non si espande in linea: espandere otto
   * passaggi dentro lo scroll del canale lo rende inservibile. Se questo
   * gestore c'è, la tab diventa una riga che NAVIGA a una schermata sua.
   */
  onOpenWork?: (messageId: string) => void;
  /** Idem per il thread: su telefono è una schermata, non un pannello. */
  onOpenThread?: (messageId: string) => void;
}) {
  const onlineUserIds = useStore((s) => s.onlineUserIds);
  const setReplyingTo = useStore((s) => s.setReplyingTo);
  const openThread = useStore((s) => s.openThread);
  const myUserId = useStore((s) => s.user?.id);
  const allRuns = useStore((s) => s.runs);
  const allAgents = useStore((s) => s.agents);
  const steerMark = useStore((s) => s.steered.get(message.id));
  const allMessages = useStore((s) => s.messagesByChannel.get(message.channelId));

  /*
   * I due capi del filo.
   *
   * `steerAnswerId`: se questo messaggio è stato infilato in un turno, qual è
   * la bolla dell'agente che quel turno ha prodotto.
   * `steeredIn`: se questa È la bolla dell'agente, quali messaggi gli sono
   * arrivati mentre lavorava.
   */
  /*
   * Entrambi i capi si cercano FRA I MESSAGGI, non nell'elenco dei turni.
   *
   * Prima la destinazione la chiedevo a quell'elenco, che dopo un
   * ricaricamento contiene solo i turni ancora vivi: di uno finito non resta
   * niente, quindi il marchio sopravviveva e il collegamento non si
   * disegnava più. I messaggi invece ci sono sempre, e si portano già dietro
   * tutto — la bolla dell'agente ha l'id del turno che l'ha prodotta, il tuo
   * messaggio ha quello del turno in cui è entrato.
   */
  const steerAnswerId = useMemo(() => {
    if (!message.steeredIntoRunId || !allMessages) return null;
    return allMessages.find((m) => m.runId === message.steeredIntoRunId)?.id ?? null;
  }, [message.steeredIntoRunId, allMessages]);

  const steeredIn = useMemo(() => {
    if (!message.runId || !allMessages) return [];
    return allMessages.filter((m) => m.steeredIntoRunId === message.runId && !m.deletedAt);
  }, [message.runId, allMessages]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Chi è in coda per rispondere PROPRIO a questo messaggio. La mappa dei run
  // è stabile: il filtro sta qui fuori dal selettore, altrimenti ogni render
  // vedrebbe un array nuovo e il ciclo non finirebbe più.
  const queuedHere = useMemo(() => {
    const names: string[] = [];
    for (const r of allRuns.values()) {
      if (r.status !== 'queued' || r.triggerMessageId !== message.id) continue;
      names.push(allAgents.find((a) => a.id === r.agentId)?.name ?? 'An agent');
    }
    return names;
  }, [allRuns, allAgents, message.id]);
  // Si cancella solo la propria roba. Il server lo ripete comunque: questo
  // serve a non mostrare un bottone che poi risponderebbe «non puoi».
  const mine = message.author.type === 'user' && message.author.id === myUserId;

  // Messaggi consecutivi dello stesso autore entro 5 minuti si raggruppano:
  // meno rumore visivo, si legge come una conversazione.
  const grouped =
    previous !== null &&
    previous.author.type === message.author.type &&
    previous.author.id === message.author.id &&
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000 &&
    !previous.runId;

  const time = format(new Date(message.createdAt), 'HH:mm');
  const isAgent = message.author.type === 'agent';
  const streaming = run?.streaming === true;
  const queued = run?.status === 'queued';
  const waiting = run?.status === 'awaiting_approval';

  // Finché il turno è in coda l'agente non ha ancora aperto bocca: una bolla
  // vuota coi puntini annuncerebbe una risposta che non è nemmeno partita.
  // L'attesa si vede sotto il messaggio che l'ha innescata.
  if (queued && !message.body) return null;

  if (message.deletedAt) {
    return (
      <div className="px-5 py-0.5 pl-[62px] text-[13px] italic text-[var(--color-ink-faint)]">
        Messaggio eliminato
      </div>
    );
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={clsx(
        'group relative px-5 transition-colors hover:bg-[var(--color-panel-alt)]',
        grouped ? 'py-0.5' : 'pt-2 pb-[9px]',
      )}
    >
      {/* Azioni al passaggio del mouse: citare nel canale, o aprire un thread. */}
      <div className="absolute right-4 -top-2 z-10 hidden divide-x divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-panel)] group-hover:flex">
        <button
          onClick={() => setReplyingTo(message)}
          className="flex items-center gap-1 px-2 py-1 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
          title="Cita questo messaggio nel canale"
        >
          <Reply size={13} strokeWidth={2.2} /> Rispondi
        </button>
        <button
          onClick={() => openThread(message.id)}
          className="flex items-center gap-1 px-2 py-1 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
          title="Apri un thread: le risposte restano a parte, fuori dal canale"
        >
          <MessagesSquare size={13} strokeWidth={2.2} /> Nel thread
        </button>
        {mine && (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 px-2 py-1 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-error)]"
            title="Elimina questo messaggio"
          >
            <Trash2 size={13} strokeWidth={2.2} /> Elimina
          </button>
        )}
      </div>

      {confirmDelete && (
        <DeleteMessageDialog message={message} onClose={() => setConfirmDelete(false)} />
      )}

      <div className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3">
        <div className="w-8 shrink-0">
          {grouped ? (
            <span className="mt-0.5 hidden text-[10.5px] text-[var(--color-ink-faint)] tabular-nums group-hover:block">
              {time}
            </span>
          ) : (
            <Avatar
              name={message.author.name}
              emoji={message.author.avatarEmoji}
              color={message.author.avatarColor}
              size={32}
              isAgent={isAgent}
              online={
                message.author.type === 'user' ? onlineUserIds.has(message.author.id) : undefined
              }
            />
          )}
        </div>

        <div className="min-w-0 flex-1 pb-1">
          {/* Citazione: se questo messaggio risponde a un altro. */}
          {message.replyTo && <QuotedReply reply={message.replyTo} />}

          {!grouped && (
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="text-[14px] font-semibold tracking-[-0.01em]">
                {message.author.name}
              </span>
              {isAgent && (
                <span className="rounded-[5px] border border-[var(--color-line)] bg-[var(--color-sunken)] px-[5px] py-px text-[10px] font-semibold tracking-[0.07em] text-[var(--color-ink-soft)] uppercase">
                  agente
                </span>
              )}
              <span className="text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
                {time}
              </span>
              {streaming && run && <LiveHint run={run} compact={Boolean(onOpenWork)} />}
            </div>
          )}

          {steeredIn.length > 0 && (
            /* Entrati mentre l'agente già lavorava: senza dirlo qui, la
               risposta sembrerebbe uscita dal nulla. Non fingo di sapere
               QUALE paragrafo risponde a cosa — quello non lo so — ma il
               filo fra le due bolle si vede e si percorre. */
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-[var(--color-ink-faint)]">
                letti mentre lavorava:
              </span>
              {steeredIn.map((m) => (
                <button
                  key={m.id}
                  onClick={() => jumpToMessage(m.id)}
                  className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-sunken)] px-2 py-[2px] text-[11.5px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
                >
                  <CornerUpLeft size={10} strokeWidth={2.4} className="shrink-0" />
                  <span className="truncate">{plainExcerpt(m.body)}</span>
                </button>
              ))}
            </div>
          )}

          {/* Il lavoro sta sopra la risposta e dentro la sua tab: quello che
              resta qui fuori è ciò che l'agente ha da dire. */}
          {run &&
            !queued &&
            (onOpenWork ? (
              <WorkRow run={run} onOpen={() => onOpenWork(message.id)} />
            ) : (
              <WorkTab run={run} messageId={message.id} />
            ))}

          {message.body ? (
            <div className={clsx(run && 'mt-3')}>
              <MessageBody body={message.body} streaming={streaming} />
            </div>
          ) : streaming ? null : (
            <div className="flex items-center gap-1.5 py-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="typing-dot h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)]"
                  style={{ animationDelay: `${i * 0.18}s` }}
                />
              ))}
            </div>
          )}

          {!steerMark && message.steeredIntoRunId && steerAnswerId && (
            /* Turno finito: la pillola diventa il filo verso la risposta in
               cui questo messaggio è stato letto. Prima spariva e basta, e
               del collegamento non restava traccia. */
            <button
              onClick={() => jumpToMessage(steerAnswerId)}
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-sunken)] px-2 py-[3px] text-[11.5px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
            >
              letto in questo turno
              <ArrowRight size={11} strokeWidth={2.4} />
            </button>
          )}

          {steerMark && (
            /* Consegnato a un turno già in corso: non nascerà nessuna bolla
               nuova, quindi senza questa riga sembrerebbe caduto nel vuoto.
               Due stati, perché fra il «consegnato» e il «letto» sul runner
               locale possono passare secondi, e dire subito «sta leggendo»
               era una promessa che non potevamo mantenere. */
            <div
              className={clsx(
                'mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11.5px] text-[var(--color-ink-soft)]',
                steerMark.reading
                  ? 'border-[color-mix(in_oklab,var(--color-online)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-online)_10%,transparent)]'
                  : 'border-[var(--color-line)] bg-[var(--color-sunken)]',
              )}
            >
              <span
                className={clsx(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  steerMark.reading
                    ? 'animate-pulse bg-[var(--color-online)]'
                    : 'queued-pulse bg-[var(--color-ink-faint)]',
                )}
              />
              {steerMark.reading
                ? `${allAgents.find((a) => a.id === steerMark.agentId)?.name ?? 'L’agente'} lo sta leggendo mentre lavora`
                : 'in consegna al turno in corso'}
            </div>
          )}

          {queuedHere.length > 0 && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-sunken)] px-2 py-[3px] text-[11.5px] text-[var(--color-ink-soft)]">
              <span className="queued-pulse h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)]" />
              {queuedHere.join(', ')} {queuedHere.length === 1 ? 'è' : 'sono'} in coda
            </div>
          )}

          <Attachments items={message.attachments} />

          {message.replyCount > 0 && (
            <ThreadBar
              message={message}
              onOpen={onOpenThread ? () => onOpenThread(message.id) : undefined}
            />
          )}

          {waiting &&
            approvals
              .filter((a) => a.runId === run?.runId)
              .map((a) => <ApprovalCard key={a.id} approval={a} />)}

          {run?.status === 'error' && run.error && (
            <div className="mt-1.5 rounded-lg bg-[color-mix(in_oklab,var(--color-error)_8%,transparent)] px-2.5 py-1.5 text-[13px] text-[var(--color-error)]">
              {run.error}
            </div>
          )}

          {message.reactions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  className="reaction"
                  data-mine={r.mine}
                  onClick={() => void api.toggleReaction(message.id, r.emoji)}
                  title={r.actors.map((a) => a.name).join(', ')}
                >
                  <span>{r.emoji}</span>
                  <span className="tabular-nums">{r.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Separatore di data                                                         */
/* ========================================================================== */

export function DayDivider({ date }: { date: Date }) {
  const label = isToday(date)
    ? 'Oggi'
    : isYesterday(date)
      ? 'Ieri'
      : format(date, "EEEE d MMMM", { locale: it });
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <span className="h-px flex-1 bg-[var(--color-line)]" />
      <span className="text-[11.5px] font-semibold text-[var(--color-ink-faint)] lowercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-[var(--color-line)]" />
    </div>
  );
}

/* ========================================================================== */
/*  Composer                                                                   */
/* ========================================================================== */

/** Allegato in attesa: mostrato subito, caricato in sottofondo. */
interface PendingAttachment {
  key: string;
  file: File;
  preview: string | null;
  /** Id assegnato dal server quando il caricamento finisce. */
  id: string | null;
}

export function Composer({
  channelId,
  channelName,
  threadRootId,
  compact,
}: {
  channelId: string;
  channelName: string;
  /** Se valorizzato, quello che si scrive resta nel thread. */
  threadRootId?: string;
  compact?: boolean;
}) {
  // La bozza appartiene alla conversazione, non al composer: il composer è
  // uno solo e non si smonta cambiando canale.
  const key = draftKey(channelId, threadRootId);
  const [value, setValue] = useState(() => readDraft(key));
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /* Allegati trascinati o incollati, in attesa di partire col messaggio. */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const workspaceId = useStore((s) => s.workspace?.id ?? null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Il trascinamento non basta: da telefono o tablet non esiste, e sul desktop
  // non lo scopri se non ci provi. La graffetta apre il selettore di sistema.
  const filePicker = useRef<HTMLInputElement>(null);
  const sendMessage = useStore((s) => s.sendMessage);
  const replyingTo = useStore((s) => s.replyingTo);
  const setReplyingTo = useStore((s) => s.setReplyingTo);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);

  /*
   * Cambio di conversazione: si rimette in campo la bozza di quella nuova.
   * Gli allegati già caricati seguono la stessa regola — appartengono al
   * messaggio che stavi scrivendo lì, non a quello che scriverai altrove.
   */
  const stashed = useRef(new Map<string, PendingAttachment[]>());
  const prevKey = useRef(key);
  useEffect(() => {
    const from = prevKey.current;
    if (from === key) return;
    prevKey.current = key;
    setValue(readDraft(key));
    setPending((current) => {
      stashed.current.set(from, current);
      return stashed.current.get(key) ?? [];
    });
  }, [key]);

  // Il campo cresce col testo fino a un tetto, poi scorre.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // Quando si sceglie di rispondere, il cursore va subito nel campo. Ma solo
  // nel composer del canale: citare un messaggio lì non deve spostare il fuoco
  // dentro il thread, che è un'altra conversazione.
  useEffect(() => {
    if (replyingTo && !threadRootId) textarea.current?.focus();
  }, [replyingTo, threadRootId]);

  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const channelAgents = agents.filter((a) => (a.channelIds ?? []).includes(channelId));
    return [
      ...channelAgents.map((a) => ({
        handle: a.handle,
        name: a.name,
        emoji: a.avatarEmoji,
        color: a.avatarColor,
        isAgent: true,
      })),
      ...members.map((m) => ({
        handle: m.handle,
        name: m.name,
        emoji: m.avatarEmoji,
        color: m.avatarColor,
        isAgent: false,
      })),
    ]
      .filter((s) => s.handle.includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, agents, members, channelId]);

  function onChange(next: string) {
    setValue(next);
    writeDraft(key, next);
    realtime.send({ t: 'typing', channelId });
    // Rilevamento della menzione in corso: l'ultima @ non ancora chiusa.
    const upToCaret = next.slice(0, textarea.current?.selectionStart ?? next.length);
    const match = /(?:^|\s)@([a-zA-Z0-9._-]*)$/.exec(upToCaret);
    setMentionQuery(match ? (match[1] ?? '') : null);
  }

  function pick(handle: string) {
    const el = textarea.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@[a-zA-Z0-9._-]*$/, `<@${handle}> `);
    const next = before + value.slice(caret);
    setValue(next);
    writeDraft(key, next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  async function send() {
    const body = value.trim();
    const ready = pending.filter((p) => p.id);
    // Con un'immagine ha senso inviare anche senza testo.
    if ((!body && ready.length === 0) || sending) return;
    setSending(true);
    setValue('');
    writeDraft(key, '');
    setPending([]);
    try {
      await sendMessage(
        channelId,
        body || '(immagine)',
        ready.map((p) => p.id!),
        threadRootId ?? null,
      );
    } catch {
      // Rimettiamo tutto nel campo: perderlo sarebbe imperdonabile.
      setValue(body);
      writeDraft(key, body);
      setPending(ready);
    } finally {
      setSending(false);
    }
  }

  /** Carica subito i file scelti: quando premi invio sono già pronti. */
  async function addFiles(files: File[]) {
    if (!workspaceId || files.length === 0) return;
    const accepted = files.slice(0, 10);
    const locals: PendingAttachment[] = accepted.map((f) => ({
      key: `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`,
      file: f,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      id: null,
    }));
    setPending((prev) => [...prev, ...locals]);
    for (const local of locals) {
      try {
        const { attachment } = await api.uploadFile(workspaceId, local.file);
        setPending((prev) =>
          prev.map((p) => (p.key === local.key ? { ...p, id: attachment.id } : p)),
        );
      } catch {
        setPending((prev) => prev.filter((p) => p.key !== local.key));
      }
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && suggestions.length > 0) {
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pick(suggestions[0]!.handle);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div
      className={compact ? 'relative px-3.5 pt-2 pb-3.5' : 'relative px-5 pt-1 pb-4'}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {/* Riquadro di rilascio: compare mentre trascini un file sulla chat. */}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-honey)] bg-[var(--color-honey-soft)]/85 text-[14px] font-medium">
          Lascia qui: immagini e file finiscono nel messaggio
        </div>
      )}

      {/* Anteprime di ciò che sta per partire. */}
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div
              key={p.key}
              className="group relative overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)]"
            >
              {p.preview ? (
                <img src={p.preview} alt={p.file.name} className="h-16 w-16 object-cover" />
              ) : (
                <div className="flex h-16 w-28 items-center gap-1.5 px-2 text-[12px]">
                  <Paperclip size={12} />
                  <span className="truncate">{p.file.name}</span>
                </div>
              )}
              {!p.id && (
                <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-panel)]/70">
                  <Loader2 size={14} className="animate-spin" />
                </div>
              )}
              <button
                onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
                className="absolute top-0.5 right-0.5 rounded bg-[var(--color-ink)]/70 p-0.5 text-[var(--color-panel)] opacity-0 transition-opacity group-hover:opacity-100"
                title="Togli"
              >
                <X size={11} strokeWidth={2.6} />
              </button>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-2 overflow-hidden rounded-[11px] border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
          {suggestions.map((s, i) => (
            <button
              key={`${s.isAgent}-${s.handle}`}
              onClick={() => pick(s.handle)}
              className={clsx(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                i === 0
                  ? 'bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]'
                  : 'hover:bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)]',
              )}
            >
              <Avatar name={s.name} emoji={s.emoji} color={s.color} size={22} />
              <span className="text-[14px] font-medium">{s.name}</span>
              <span className="text-[13px] text-[var(--color-ink-faint)]">@{s.handle}</span>
              {s.isAgent && (
                <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-ink-faint)]">
                  <Bot size={11} /> agente
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="composer">
        {/* La citazione appartiene al canale: nel thread il contesto è già il
            thread, e mostrarla lì direbbe una cosa che non succede. */}
        {replyingTo && !threadRootId && (
          <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3.5 pt-2 pb-1.5 text-[12.5px]">
            <CornerUpLeft size={13} strokeWidth={2.2} className="shrink-0 text-[var(--color-ink-faint)]" />
            <span className="text-[var(--color-ink-soft)]">
              In risposta a{' '}
              <span className="font-medium text-[var(--color-ink)]">
                {replyingTo.author.name}
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-ink-faint)]">
              {replyingTo.body.replace(/<@([a-z0-9._-]+)>/g, '@$1').slice(0, 80)}
            </span>
            <button
              onClick={() => setReplyingTo(null)}
              className="shrink-0 rounded p-0.5 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
              title="Annulla risposta"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <textarea
          ref={textarea}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={threadRootId ? 'Rispondi nel thread…' : `Scrivi in #${channelName}`}
          rows={compact ? 2 : 1}
          className={clsx(
            'w-full resize-none bg-transparent leading-[1.55] tracking-[-0.005em] outline-none placeholder:text-[var(--color-ink-faint)]',
            compact ? 'px-3 pt-2.5 pb-0.5 text-[14px]' : 'px-3.5 pt-3 pb-1 text-[14.5px]',
          )}
        />
        <div className="flex items-center gap-0.5 pt-1 pr-2 pb-2 pl-2.5">
          <button
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            title="Menziona qualcuno"
            onClick={() => {
              setValue((v) => `${v}@`);
              textarea.current?.focus();
            }}
          >
            <AtSign size={15} strokeWidth={2} />
          </button>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            title="Allega un file"
            onClick={() => filePicker.current?.click()}
          >
            <Paperclip size={15} strokeWidth={2} />
          </button>
          {/* Nessun `accept`: qualsiasi tipo di file è benvenuto. */}
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              // Azzeriamo il campo, altrimenti riscegliere lo stesso file non
              // fa scattare un altro change e sembra che il bottone sia rotto.
              e.target.value = '';
              void addFiles(chosen);
            }}
          />
          <button
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
            title="Emoji"
          >
            <Smile size={15} strokeWidth={2} />
          </button>

          <span className="ml-auto mr-2 font-mono text-[10.5px] text-[var(--color-ink-faint)]">
            ⌘↵
          </span>
          <button
            onClick={() => void send()}
            disabled={!value.trim() || sending}
            className={clsx(
              'flex items-center justify-center rounded-full border transition-colors',
              compact ? 'h-[26px] w-[26px]' : 'h-[30px] w-[30px]',
              value.trim()
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-panel)]'
                : 'border-[var(--color-line)] bg-[var(--color-sunken)] text-[var(--color-ink-faint)] hover:border-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-[var(--color-panel)]',
            )}
            title="Invia (Invio)"
          >
            <ArrowUp size={compact ? 14 : 16} strokeWidth={2.6} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Vista canale                                                               */
/* ========================================================================== */

/** I controlli dell'intestazione sono tutti uguali: una forma sola, qui. */
const HEADER_BTN =
  'flex h-[27px] items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-2.5 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]';
const HEADER_BTN_ON =
  'border-[color-mix(in_oklab,var(--color-honey)_45%,transparent)] bg-[var(--color-honey-soft)] text-[var(--color-ink)]';

export function Chat() {
  const activeChannelId = useStore((s) => s.activeChannelId);
  const channels = useStore((s) => s.channels);
  const messagesByChannel = useStore((s) => s.messagesByChannel);
  const runs = useStore((s) => s.runs);
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const loading = useStore((s) => s.loadingChannel);
  const typingByChannel = useStore((s) => s.typingByChannel);
  const loadOlder = useStore((s) => s.loadOlder);
  const artifactPanelOpen = useStore((s) => s.artifactPanelOpen);
  const setArtifactPanelOpen = useStore((s) => s.setArtifactPanelOpen);
  const artifactCount = useStore((s) =>
    activeChannelId ? (s.artifactsByChannel.get(activeChannelId)?.length ?? 0) : 0,
  );
  const asideOpen = useStore((s) => s.asideOpen);
  const setAsideOpen = useStore((s) => s.setAsideOpen);
  const [membersOpen, setMembersOpen] = useState(false);
  const channelMemberCount = useStore((s) =>
    activeChannelId
      ? s.agents.filter((a) => (a.channelIds ?? []).includes(activeChannelId)).length +
        s.members.length
      : s.members.length,
  );
  const documentsPanelOpen = useStore((s) => s.documentsPanelOpen);
  const setDocumentsPanelOpen = useStore((s) => s.setDocumentsPanelOpen);
  const workspaceId = useStore((s) => s.workspace?.id ?? null);
  const docCount = useStore((s) => {
    const wid = s.workspace?.id;
    return wid ? (s.documentsByWorkspace.get(wid)?.filter((d) => d.kind === 'file').length ?? 0) : 0;
  });

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const channel = channels.find((c) => c.id === activeChannelId);
  const messages = activeChannelId ? (messagesByChannel.get(activeChannelId) ?? []) : [];

  // Resta in fondo mentre arrivano messaggi, ma solo se ci eri già:
  // se stai leggendo indietro non ti strappiamo la pagina da sotto.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    atBottom.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeChannelId]);

  const typing = activeChannelId
    ? [...(typingByChannel.get(activeChannelId)?.values() ?? [])].filter(
        (t) => Date.now() - t.at < 6000,
      )
    : [];

  if (!channel) {
    return (
      <div className="panel flex flex-1 items-center justify-center text-[var(--color-ink-faint)]">
        <div className="text-center">
          <div className="mb-2 text-3xl">🐝</div>
          <p className="text-[14.5px]">Scegli un canale per iniziare</p>
        </div>
      </div>
    );
  }

  const channelAgents = agents.filter((a) => (a.channelIds ?? []).includes(channel.id));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-1">
    {/* Il pannello laterale sta DENTRO il foglio della conversazione, diviso
        da una sola riga: è un'altra vista della stessa conversazione, non un
        secondo foglio che ci galleggia accanto. */}
    <div className="panel flex min-w-0 flex-1 overflow-hidden">
    <div className="flex min-w-0 flex-1 flex-col">
      {/* --- intestazione --- */}
      <header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-[18px]">
        {channel.visibility === 'private' ? (
          <Lock size={17} strokeWidth={2.2} className="text-[var(--color-ink-faint)]" />
        ) : (
          <Hash size={20} strokeWidth={2.2} className="text-[var(--color-ink-faint)]" />
        )}
        <h1 className="text-[17px] font-semibold tracking-[-0.02em]">{channel.name}</h1>
        {channel.topic && (
          <>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span className="truncate text-[13px] text-[var(--color-ink-faint)]">
              {channel.topic}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {channelAgents.length > 0 && (
            <div className="flex h-[27px] items-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] px-2">
              {channelAgents.slice(0, 4).map((a) => (
                <span key={a.id} title={`${a.name} · ${a.model}`} className="text-[13px]">
                  {a.avatarEmoji}
                </span>
              ))}
            </div>
          )}
          <button
            onClick={() => setMembersOpen(true)}
            className={HEADER_BTN}
            title="Chi c'è in questo canale e quali agenti rispondono qui"
          >
            <Users size={14} strokeWidth={2.2} />
            <span className="tabular-nums">{channelMemberCount}</span>
          </button>
          <button
            onClick={() => setAsideOpen(!asideOpen)}
            className={clsx(HEADER_BTN, 'hidden lg:flex', asideOpen && HEADER_BTN_ON)}
            title="Attività degli agenti e thread"
          >
            <PanelRight size={14} strokeWidth={2.2} />
          </button>
          <button
            onClick={() => setArtifactPanelOpen(!artifactPanelOpen)}
            className={clsx(HEADER_BTN, 'hidden lg:flex', artifactPanelOpen && HEADER_BTN_ON)}
            title="Checklist e documenti condivisi"
          >
            <ListChecks size={14} strokeWidth={2.2} />
            {artifactCount > 0 && <span className="tabular-nums">{artifactCount}</span>}
          </button>
          <button
            onClick={() => setDocumentsPanelOpen(true)}
            className={HEADER_BTN}
            title="Documenti del progetto"
          >
            <FolderOpen size={14} strokeWidth={2.2} />
            {docCount > 0 && <span className="tabular-nums">{docCount}</span>}
          </button>
        </div>
      </header>

      <ArtifactPinnedStrip channelId={channel.id} />

      {/* --- messaggi --- */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 120 && activeChannelId) void loadOlder(activeChannelId);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {loading && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--color-ink-faint)]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-sunken)] text-2xl">
              <Hash size={24} strokeWidth={2} className="text-[var(--color-ink-faint)]" />
            </div>
            <h2 className="text-[17px] font-semibold">Benvenuto in #{channel.name}</h2>
            <p className="mt-1 max-w-sm text-[14px] text-[var(--color-ink-soft)]">
              È l'inizio del canale. Scrivi qualcosa, oppure tagga un agente con{' '}
              <span className="mention">@</span> per farlo lavorare.
            </p>
          </div>
        ) : (
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
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* --- sta scrivendo --- */}
      <div className="h-5 shrink-0 px-5 text-[12.5px] text-[var(--color-ink-faint)]">
        {typing.length > 0 && (
          <span>
            {typing.map((t) => t.name).join(', ')}{' '}
            {typing.length === 1 ? 'sta scrivendo' : 'stanno scrivendo'}…
          </span>
        )}
      </div>

      <Composer channelId={channel.id} channelName={channel.name} />
    </div>
      {asideOpen && <ChannelAside channelId={channel.id} channelName={channel.name} />}
    </div>
      {artifactPanelOpen && <ArtifactPanel channelId={channel.id} />}
      {documentsPanelOpen && workspaceId && <DocumentsPanel workspaceId={workspaceId} />}
      {membersOpen && (
        <ChannelMembers channelId={channel.id} onClose={() => setMembersOpen(false)} />
      )}
    </div>
  );
}

/* ========================================================================== */
/*  Barra di stato: cosa stanno facendo gli agenti in questo momento           */
/* ========================================================================== */

export function AgentStatusBar() {
  const activity = useStore((s) => s.agentActivity);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  // Il cronometro serve solo se c'è qualcuno al lavoro.
  const now = useTicker(activity.size > 0);

  const active = [...activity.entries()]
    .map(([id, state]) => {
      const run = [...runs.values()].find(
        (r) => r.agentId === id && (r.status === 'running' || r.status === 'queued'),
      );
      return {
        agent: agents.find((a) => a.id === id),
        state,
        // Un turno in coda non ha un cronometro: non è partito niente da
        // misurare, e la rotella che gira direbbe che sta lavorando.
        queued: run?.status === 'queued',
        startedAt: run?.startedAt,
      };
    })
    .filter((x) => x.agent);

  if (active.length === 0) return null;

  return (
    <div className="flex h-10 items-center gap-4 px-4 text-[12.5px]">
      {active.slice(0, 3).map(({ agent, state, startedAt, queued }) => {
        const seconds = startedAt ? Math.floor((now - startedAt) / 1000) : null;
        return (
          <span key={agent!.id} className="flex min-w-0 items-center gap-2">
            <span>{agent!.avatarEmoji}</span>
            <span className="font-semibold">{agent!.name}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-ink-soft)]">
              {queued
                ? 'in coda'
                : (state.label ??
                  (state.status === 'thinking'
                    ? 'sta ragionando'
                    : state.status === 'waiting'
                      ? 'in attesa di conferma'
                      : 'al lavoro'))}
            </span>
            {queued ? (
              <span className="queued-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-ink-faint)]" />
            ) : (
              <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--color-line-strong)] border-t-[var(--color-ink-faint)]" />
            )}
            {!queued && seconds !== null && (
              <span className="shrink-0 text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
