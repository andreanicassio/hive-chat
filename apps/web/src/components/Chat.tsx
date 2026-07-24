import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
  CornerUpLeft,
  PanelRight,
  FolderOpen,
} from 'lucide-react';
import { useStore, type RunState } from '../store.js';
import { ArtifactPanel, ArtifactPinnedStrip } from './ArtifactPanel.js';
import { DocumentsPanel } from './DocumentsPanel.js';
import { api } from '../lib/api.js';
import { realtime } from '../lib/ws.js';
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
    else parts.push({ handle: 'tutti', kind: 'all' });
    last = index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MessageBody({ body, streaming }: { body: string; streaming: boolean }) {
  const agents = useStore((s) => s.agents);
  const agentHandles = useMemo(() => new Set(agents.map((a) => a.handle)), [agents]);

  return (
    <div className={clsx('msg-body', streaming && 'streaming-caret')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Le menzioni vivono dentro il testo: le intercettiamo qui
          // invece di pre-processare il markdown, così non rompiamo
          // blocchi di codice che contengono la stessa sintassi.
          p: ({ children }) => <p>{transformChildren(children, agentHandles)}</p>,
          li: ({ children }) => <li>{transformChildren(children, agentHandles)}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function transformChildren(children: React.ReactNode, agentHandles: Set<string>): React.ReactNode {
  return (Array.isArray(children) ? children : [children]).map((child, i) => {
    if (typeof child !== 'string') return child;
    const parts = renderMentions(child, (h) => agentHandles.has(h));
    return (
      <span key={i}>
        {parts.map((part, j) =>
          typeof part === 'string' ? (
            part
          ) : (
            <span key={j} className="mention" data-kind={part.kind}>
              {part.kind === 'agent' && <Bot size={11} strokeWidth={2.4} />}
              {part.kind === 'channel' ? `#${part.handle}` : `@${part.handle}`}
            </span>
          ),
        )}
      </span>
    );
  });
}

/* ========================================================================== */
/*  Attività dell'agente: tool usati, ragionamento                            */
/* ========================================================================== */

function RunActivity({ run }: { run: RunState }) {
  const [open, setOpen] = useState(false);

  const tools = useMemo(() => {
    const started = new Map<string, { label: string; done: boolean; error: boolean }>();
    for (const e of run.events) {
      if (e.type === 'tool.start') {
        started.set(e.toolUseId, { label: e.label, done: false, error: false });
      } else if (e.type === 'tool.end') {
        const entry = started.get(e.toolUseId);
        if (entry) {
          entry.done = true;
          entry.error = e.isError;
        }
      }
    }
    return [...started.values()];
  }, [run.events]);

  const thinking = run.events.some((e) => e.type === 'thinking.start');
  if (tools.length === 0 && !thinking) return null;

  const running = tools.filter((t) => !t.done).length;

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-soft)]"
      >
        <ChevronRight
          size={12}
          strokeWidth={2.5}
          className={clsx('transition-transform', open && 'rotate-90')}
        />
        {running > 0 ? (
          <>
            <Loader2 size={11.5} className="animate-spin" />
            <span>{tools.find((t) => !t.done)?.label ?? 'Al lavoro'}</span>
          </>
        ) : (
          <span>
            {tools.length} {tools.length === 1 ? 'operazione' : 'operazioni'}
            {thinking && ' · ha ragionato'}
          </span>
        )}
      </button>

      {open && tools.length > 0 && (
        <div className="mt-1.5 flex flex-col items-start gap-1">
          {tools.map((t, i) => (
            <span key={i} className="tool-chip">
              {t.done ? (
                t.error ? (
                  <X size={11} className="text-[var(--color-error)]" strokeWidth={2.6} />
                ) : (
                  <Check size={11} className="text-[var(--color-online)]" strokeWidth={2.6} />
                )
              ) : (
                <Loader2 size={11} className="animate-spin" />
              )}
              <span className="truncate">{t.label}</span>
            </span>
          ))}
        </div>
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
            {agent?.name ?? 'Un agente'} chiede il permesso
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
          Consenti
        </button>
        <button className="btn btn-ghost h-8" onClick={() => void decide(false)} disabled={busy}>
          Rifiuta
        </button>
        <span className="ml-auto text-[12px] text-[var(--color-ink-faint)]">
          Nessuno esegue nulla finché non decidi
        </span>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Citazione del messaggio a cui si risponde                                  */
/* ========================================================================== */

function QuotedReply({ reply }: { reply: ReplyPreview }) {
  return (
    <button
      onClick={() => {
        // Salta al messaggio citato e lo evidenzia un istante.
        const el = document.getElementById(`msg-${reply.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('flash-highlight');
          setTimeout(() => el.classList.remove('flash-highlight'), 1200);
        }
      }}
      className="mb-1 flex max-w-full items-center gap-1.5 text-left text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
    >
      <CornerUpLeft size={12} strokeWidth={2.2} className="shrink-0 text-[var(--color-ink-faint)]" />
      <span className="shrink-0 font-medium">{reply.authorName}</span>
      <span className="min-w-0 truncate text-[var(--color-ink-faint)]">
        {reply.deleted ? 'messaggio eliminato' : reply.excerpt}
      </span>
    </button>
  );
}

/* ========================================================================== */
/*  Singolo messaggio                                                          */
/* ========================================================================== */

function MessageRow({
  message,
  previous,
  run,
  approvals,
}: {
  message: Message;
  previous: Message | null;
  run: RunState | undefined;
  approvals: Approval[];
}) {
  const onlineUserIds = useStore((s) => s.onlineUserIds);
  const setReplyingTo = useStore((s) => s.setReplyingTo);

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
        'group relative px-5 transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_2.5%,transparent)]',
        grouped ? 'py-0.5' : 'pt-2 pb-0.5',
      )}
    >
      {/* Azioni al passaggio del mouse: per ora, rispondi. */}
      <div className="absolute right-4 -top-2 z-10 hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-panel)] group-hover:flex">
        <button
          onClick={() => setReplyingTo(message)}
          className="flex items-center gap-1 px-2 py-1 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
          title="Rispondi a questo messaggio"
        >
          <Reply size={13} strokeWidth={2.2} /> Rispondi
        </button>
      </div>

      <div className="flex gap-2.5">
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
            <div className="mb-0.5 flex items-baseline gap-1.5">
              <span className="text-[13px] font-semibold">{message.author.name}</span>
              {isAgent && (
                <span className="rounded bg-[var(--color-sunken)] px-1 py-px text-[9.5px] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
                  agente
                </span>
              )}
              <span className="text-[11px] text-[var(--color-ink-faint)] tabular-nums">{time}</span>
            </div>
          )}

          {queued ? (
            <div className="flex items-center gap-2 py-1 text-[13.5px] text-[var(--color-ink-faint)]">
              <Loader2 size={13} className="animate-spin" />
              <span>In coda…</span>
            </div>
          ) : message.body ? (
            <MessageBody body={message.body} streaming={streaming} />
          ) : (
            <div className="flex items-center gap-1.5 py-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="typing-dot h-1.5 w-1.5 rounded-full bg-[var(--color-ink-faint)]"
                  style={{ animationDelay: `${i * 0.16}s` }}
                />
              ))}
            </div>
          )}

          {run && <RunActivity run={run} />}

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

function DayDivider({ date }: { date: Date }) {
  const label = isToday(date)
    ? 'Oggi'
    : isYesterday(date)
      ? 'Ieri'
      : format(date, "EEEE d MMMM", { locale: it });
  return (
    <div className="sticky top-0 z-10 flex justify-center py-3">
      <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-0.5 text-[12px] font-medium text-[var(--color-ink-soft)] capitalize shadow-[var(--shadow-panel)]">
        {label}
      </span>
    </div>
  );
}

/* ========================================================================== */
/*  Composer                                                                   */
/* ========================================================================== */

function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useStore((s) => s.sendMessage);
  const replyingTo = useStore((s) => s.replyingTo);
  const setReplyingTo = useStore((s) => s.setReplyingTo);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);

  // Il campo cresce col testo fino a un tetto, poi scorre.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // Quando si sceglie di rispondere, il cursore va subito nel campo.
  useEffect(() => {
    if (replyingTo) textarea.current?.focus();
  }, [replyingTo]);

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
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  async function send() {
    const body = value.trim();
    if (!body || sending) return;
    setSending(true);
    setValue('');
    try {
      await sendMessage(channelId, body);
    } catch {
      // Rimettiamo il testo nel campo: perderlo sarebbe imperdonabile.
      setValue(body);
    } finally {
      setSending(false);
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
    <div className="relative px-4 pb-4">
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
        {replyingTo && (
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
          placeholder={`Scrivi in #${channelName}`}
          rows={1}
          className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-[var(--color-ink-faint)]"
        />
        <div className="flex items-center gap-0.5 px-2.5 pb-2">
          <button
            className="rounded-md p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink-soft)]"
            title="Menziona qualcuno"
            onClick={() => {
              setValue((v) => `${v}@`);
              textarea.current?.focus();
            }}
          >
            <AtSign size={16} strokeWidth={2} />
          </button>
          <button
            className="rounded-md p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink-soft)]"
            title="Allega un file"
          >
            <Paperclip size={16} strokeWidth={2} />
          </button>
          <button
            className="rounded-md p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink-soft)]"
            title="Emoji"
          >
            <Smile size={16} strokeWidth={2} />
          </button>

          <button
            onClick={() => void send()}
            disabled={!value.trim() || sending}
            className={clsx(
              'ml-auto flex h-[30px] w-[30px] items-center justify-center rounded-full transition-all',
              value.trim()
                ? 'bg-[var(--color-ink)] text-[var(--color-panel)] hover:scale-105'
                : 'bg-[var(--color-sunken)] text-[var(--color-ink-faint)]',
            )}
            title="Invia (Invio)"
          >
            <ArrowUp size={16} strokeWidth={2.6} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Vista canale                                                               */
/* ========================================================================== */

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
    <div className="flex min-w-0 flex-1 gap-1">
    <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* --- intestazione --- */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-5 py-3">
        {channel.visibility === 'private' ? (
          <Lock size={16} strokeWidth={2.2} className="text-[var(--color-ink-soft)]" />
        ) : (
          <Hash size={17} strokeWidth={2.4} className="text-[var(--color-ink-soft)]" />
        )}
        <h1 className="text-[16.5px] font-semibold tracking-[-0.01em]">{channel.name}</h1>
        {channel.topic && (
          <>
            <span className="text-[var(--color-line-strong)]">·</span>
            <span className="truncate text-[13.5px] text-[var(--color-ink-soft)]">
              {channel.topic}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {channelAgents.length > 0 && (
            <div className="flex items-center gap-1 rounded-full bg-[var(--color-sunken)] px-2 py-1">
              {channelAgents.slice(0, 4).map((a) => (
                <span key={a.id} title={`${a.name} · ${a.model}`} className="text-[13px]">
                  {a.avatarEmoji}
                </span>
              ))}
            </div>
          )}
          <button
            className="flex items-center gap-1.5 rounded-full bg-[var(--color-sunken)] px-2.5 py-1 text-[13px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
            title="Membri del canale"
          >
            <Users size={14} strokeWidth={2.2} />
            <span className="tabular-nums">{useStore.getState().members.length}</span>
          </button>
          <button
            onClick={() => setArtifactPanelOpen(!artifactPanelOpen)}
            className={
              'hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] transition-colors lg:flex ' +
              (artifactPanelOpen
                ? 'bg-[var(--color-honey-soft)] text-[var(--color-ink)]'
                : 'bg-[var(--color-sunken)] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]')
            }
            title="Checklist e documenti"
          >
            <PanelRight size={14} strokeWidth={2.2} />
            {artifactCount > 0 && <span className="tabular-nums">{artifactCount}</span>}
          </button>
          <button
            onClick={() => setDocumentsPanelOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-[var(--color-sunken)] px-2.5 py-1 text-[13px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
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
      {artifactPanelOpen && <ArtifactPanel channelId={channel.id} />}
      {documentsPanelOpen && workspaceId && <DocumentsPanel workspaceId={workspaceId} />}
    </div>
  );
}

/* ========================================================================== */
/*  Barra di stato: cosa stanno facendo gli agenti in questo momento           */
/* ========================================================================== */

export function AgentStatusBar() {
  const activity = useStore((s) => s.agentActivity);
  const agents = useStore((s) => s.agents);

  const active = [...activity.entries()]
    .map(([id, state]) => ({ agent: agents.find((a) => a.id === id), state }))
    .filter((x) => x.agent);

  if (active.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 text-[12.5px]">
      {active.slice(0, 3).map(({ agent, state }) => (
        <span key={agent!.id} className="flex min-w-0 items-center gap-1.5">
          <span>{agent!.avatarEmoji}</span>
          <span className="font-medium">{agent!.name}:</span>
          <span className="truncate text-[var(--color-ink-soft)]">
            {state.label ??
              (state.status === 'thinking'
                ? 'sta ragionando'
                : state.status === 'waiting'
                  ? 'in attesa di conferma'
                  : 'al lavoro')}
          </span>
          <Loader2 size={11} className="animate-spin text-[var(--color-ink-faint)]" />
        </span>
      ))}
    </div>
  );
}
