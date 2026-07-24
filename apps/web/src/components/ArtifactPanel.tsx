import { useEffect, useRef, useState } from 'react';
import {
  CheckSquare,
  FileText,
  ListChecks,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { Artifact, ChecklistItem } from '@hive/shared';
import { useStore } from '../store.js';

// Riferimento stabile: se il selettore Zustand restituisse un `[]` nuovo a ogni
// render, lo store crederebbe che lo stato sia cambiato e ci manderebbe in loop.
const NO_ARTIFACTS: Artifact[] = [];

/** Id casuale per le voci nuove create dal client (contesto non-sicuro incluso). */
function rid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function items(a: Artifact): ChecklistItem[] {
  return a.type === 'checklist' && 'items' in a.content ? a.content.items : [];
}
function markdown(a: Artifact): string {
  return a.type === 'doc' && 'markdown' in a.content ? a.content.markdown : '';
}

/* ==========================================================================
   Checklist
   ======================================================================== */
function ChecklistCard({ artifact }: { artifact: Artifact }) {
  const update = useStore((s) => s.updateArtifactRemote);
  const remove = useStore((s) => s.deleteArtifact);
  const [draft, setDraft] = useState('');
  const list = items(artifact);
  const done = list.filter((i) => i.done).length;

  const commit = (next: ChecklistItem[]) =>
    void update(artifact.id, { content: { items: next } });

  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3">
      <div className="flex items-center gap-2">
        <ListChecks size={15} className="shrink-0 text-[var(--color-sage)]" strokeWidth={2.2} />
        <input
          defaultValue={artifact.title}
          onBlur={(e) => {
            if (e.target.value !== artifact.title) void update(artifact.id, { title: e.target.value });
          }}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] font-semibold outline-none"
          placeholder="Senza titolo"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-ink-faint)]">
          {done}/{list.length}
        </span>
        <button
          onClick={() => void remove(artifact.id, artifact.channelId)}
          className="shrink-0 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-error)]"
          title="Elimina"
        >
          <Trash2 size={13} strokeWidth={2.2} />
        </button>
      </div>

      <ul className="mt-2 space-y-0.5">
        {list.map((it) => (
          <li key={it.id} className="group/it flex items-start gap-2">
            <button
              onClick={() =>
                commit(list.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))
              }
              className="mt-0.5 shrink-0 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-sage)]"
            >
              {it.done ? (
                <CheckSquare size={15} className="text-[var(--color-sage)]" strokeWidth={2.2} />
              ) : (
                <Square size={15} strokeWidth={2.2} />
              )}
            </button>
            <span
              className={
                'min-w-0 flex-1 text-[13px] leading-snug ' +
                (it.done ? 'text-[var(--color-ink-faint)] line-through' : 'text-[var(--color-ink)]')
              }
            >
              {it.text}
            </span>
            <button
              onClick={() => commit(list.filter((x) => x.id !== it.id))}
              className="mt-0.5 shrink-0 text-transparent transition-colors group-hover/it:text-[var(--color-ink-faint)] hover:!text-[var(--color-error)]"
            >
              <X size={13} strokeWidth={2.4} />
            </button>
          </li>
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          commit([...list, { id: rid(), text, done: false }]);
          setDraft('');
        }}
        className="mt-2 flex items-center gap-1.5"
      >
        <Plus size={14} className="shrink-0 text-[var(--color-ink-faint)]" strokeWidth={2.4} />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Aggiungi una voce…"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
      </form>
    </section>
  );
}

/* ==========================================================================
   Documento (foglio markdown editabile)
   ======================================================================== */
function DocCard({ artifact }: { artifact: Artifact }) {
  const update = useStore((s) => s.updateArtifactRemote);
  const remove = useStore((s) => s.deleteArtifact);
  const [text, setText] = useState(markdown(artifact));
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Se qualcun altro (o un agente) modifica il doc mentre non lo stiamo
  // toccando, riallineiamo il nostro testo.
  useEffect(() => {
    if (!focused.current) setText(markdown(artifact));
  }, [artifact.updatedAt, artifact]);

  const save = (value: string) => void update(artifact.id, { content: { markdown: value } });

  const onChange = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(value), 700);
  };

  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3">
      <div className="flex items-center gap-2">
        <FileText size={15} className="shrink-0 text-[var(--color-honey)]" strokeWidth={2.2} />
        <input
          defaultValue={artifact.title}
          onBlur={(e) => {
            if (e.target.value !== artifact.title) void update(artifact.id, { title: e.target.value });
          }}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] font-semibold outline-none"
          placeholder="Senza titolo"
        />
        <button
          onClick={() => void remove(artifact.id, artifact.channelId)}
          className="shrink-0 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-error)]"
          title="Elimina"
        >
          <Trash2 size={13} strokeWidth={2.2} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (timer.current) clearTimeout(timer.current);
          save(text);
        }}
        placeholder="Scrivi qui… (markdown)"
        className="mt-2 min-h-[120px] w-full resize-y bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-[var(--color-ink-faint)]"
      />
    </section>
  );
}

/* ==========================================================================
   Pannello
   ======================================================================== */
export function ArtifactPanel({ channelId }: { channelId: string }) {
  const artifacts = useStore((s) => s.artifactsByChannel.get(channelId) ?? NO_ARTIFACTS);
  const create = useStore((s) => s.createArtifact);
  const setOpen = useStore((s) => s.setArtifactPanelOpen);

  return (
    <aside className="panel hidden w-[340px] shrink-0 flex-col overflow-hidden lg:flex">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-4 py-3">
        <ListChecks size={16} strokeWidth={2.2} className="text-[var(--color-ink-soft)]" />
        <h2 className="text-[14px] font-semibold">Artifacts</h2>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
          title="Chiudi il pannello"
        >
          <X size={16} strokeWidth={2.2} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {artifacts.length === 0 && (
          <p className="px-1 pt-2 text-[13px] leading-relaxed text-[var(--color-ink-faint)]">
            Qui vivono checklist e documenti del canale. Creali tu, o chiedi a un agente
            di tenere una to-do e spuntarla mentre lavora.
          </p>
        )}
        {artifacts.map((a) =>
          a.type === 'checklist' ? (
            <ChecklistCard key={a.id} artifact={a} />
          ) : (
            <DocCard key={a.id} artifact={a} />
          ),
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => void create(channelId, { type: 'checklist', title: 'Checklist' })}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--color-line-strong)] py-2 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-sunken)]"
          >
            <ListChecks size={14} strokeWidth={2.2} /> Checklist
          </button>
          <button
            onClick={() => void create(channelId, { type: 'doc', title: 'Documento' })}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--color-line-strong)] py-2 text-[12.5px] text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-sunken)]"
          >
            <FileText size={14} strokeWidth={2.2} /> Documento
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ==========================================================================
   Striscia degli artifact appuntati, in cima alla chat
   ======================================================================== */
export function ArtifactPinnedStrip({ channelId }: { channelId: string }) {
  const artifacts = useStore((s) => s.artifactsByChannel.get(channelId) ?? NO_ARTIFACTS);
  const setOpen = useStore((s) => s.setArtifactPanelOpen);
  const pinned = artifacts.filter((a) => a.pinned);
  if (pinned.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--color-line)] px-4 py-1.5">
      {pinned.map((a) => {
        const label =
          a.type === 'checklist'
            ? `${items(a).filter((i) => i.done).length}/${items(a).length}`
            : null;
        return (
          <button
            key={a.id}
            onClick={() => setOpen(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-sunken)] px-2.5 py-1 text-[12px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
            title="Apri nel pannello"
          >
            {a.type === 'checklist' ? (
              <ListChecks size={12.5} strokeWidth={2.2} className="text-[var(--color-sage)]" />
            ) : (
              <FileText size={12.5} strokeWidth={2.2} className="text-[var(--color-honey)]" />
            )}
            <span className="max-w-[160px] truncate font-medium">{a.title || 'Senza titolo'}</span>
            {label && <span className="tabular-nums text-[var(--color-ink-faint)]">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
