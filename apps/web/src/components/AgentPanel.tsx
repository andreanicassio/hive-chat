import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Code2,
  Hash,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  X,
  GitBranch,
  Cpu,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';
import { useStore } from '../store.js';
import { api, ApiError } from '../lib/api.js';
import { Avatar } from './Avatar.js';
import { AgentDetail } from './AgentDetail.js';
import type { AgentKind, CatalogModel } from '@hive/shared';

/* ========================================================================== */
/*  Selettore modello                                                          */
/* ========================================================================== */

function formatPrice(v: number | null): string {
  if (v == null) return '—';
  if (v === 0) return 'gratis';
  return v < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 10 ? 1 : 0)}`;
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function ModelPicker({
  kind,
  value,
  onChange,
}: {
  kind: AgentKind;
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Il catalogo cambia col tipo di agente: uno sviluppatore vede solo i Claude.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .models({ kind })
      .then(({ models }) => {
        if (!cancelled) setModels(models);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [kind]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, search]);

  const selected = models.find((m) => m.id === value);
  const featured = filtered.filter((m) => m.featured);
  const rest = filtered.filter((m) => !m.featured);

  const row = (m: CatalogModel) => (
    <button
      key={m.id}
      onClick={() => {
        onChange(m.id);
        setOpen(false);
        setSearch('');
      }}
      className={clsx(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
        m.id === value
          ? 'bg-[color-mix(in_oklab,var(--color-honey)_14%,transparent)]'
          : 'hover:bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium">{m.name}</span>
          {m.id === value && <Check size={13} strokeWidth={2.6} className="text-[var(--color-honey)]" />}
        </div>
        <div className="truncate font-mono text-[11.5px] text-[var(--color-ink-faint)]">{m.id}</div>
      </div>
      <div className="shrink-0 text-right text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
        <div>{formatContext(m.contextLength)} ctx</div>
        <div>{formatPrice(m.pricePromptPerM)}/M</div>
      </div>
    </button>
  );

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="field flex items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              <span className="font-medium">{selected.name}</span>
              <span className="ml-2 font-mono text-[12px] text-[var(--color-ink-faint)]">
                {formatContext(selected.contextLength)} ctx
              </span>
            </>
          ) : loading ? (
            'Carico i modelli…'
          ) : (
            'Scegli un modello'
          )}
        </span>
        <ChevronDown size={15} className="shrink-0 text-[var(--color-ink-faint)]" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 max-h-[340px] w-full overflow-hidden rounded-[11px] border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
            <Search size={14} className="text-[var(--color-ink-faint)]" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Cerca fra ${models.length} modelli…`}
              className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--color-ink-faint)]"
            />
          </div>
          <div className="max-h-[290px] overflow-y-auto">
            {loading ? (
              <div className="flex justify-center py-6">
                <Loader2 size={16} className="animate-spin text-[var(--color-ink-faint)]" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13.5px] text-[var(--color-ink-faint)]">
                Nessun modello trovato
              </p>
            ) : (
              <>
                {featured.length > 0 && (
                  <>
                    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
                      In evidenza
                    </div>
                    {featured.map(row)}
                  </>
                )}
                {rest.length > 0 && (
                  <>
                    <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
                      Tutti gli altri
                    </div>
                    {rest.map(row)}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/*  Pannello di creazione                                                      */
/* ========================================================================== */

interface ToolDef {
  id: string;
  label: string;
  description: string;
  group: string;
  availableFor: string[];
  dangerous: boolean;
}

const GROUP_LABELS: Record<string, string> = {
  conoscenza: 'Conoscenza',
  workspace: 'Progetto',
  integrazioni: 'Integrazioni',
  codice: 'Codice',
  sistema: 'Sistema',
};

const EMOJI_CHOICES = ['🐝', '🤖', '🍯', '🦉', '🐙', '🦊', '🌱', '⚡', '🔧', '📊', '🎯', '🧭'];

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const capabilities = useStore((s) => s.capabilities);

  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🐝');
  const [kind, setKind] = useState<AgentKind>('assistant');
  const [model, setModel] = useState('');
  const [purpose, setPurpose] = useState('');
  const [toolIds, setToolIds] = useState<Set<string>>(new Set());
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [autoRespond, setAutoRespond] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('main');
  const [execution, setExecution] = useState<'server' | 'local'>('server');
  const [permissionMode, setPermissionMode] = useState<'ask' | 'bypass'>('ask');

  const [catalog, setCatalog] = useState<ToolDef[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string[]>>({});
  const [skills, setSkills] = useState<Array<{ name: string; description: string; body: string }>>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Catalogo tool e modello di default. */
  useEffect(() => {
    void api.tools().then(({ tools, defaults }) => {
      setCatalog(tools);
      setDefaults(defaults);
      setToolIds(new Set(defaults.assistant ?? []));
    });
    void api.models({ kind: 'assistant' }).then(({ defaultModel, models }) => {
      setModel(models.some((m) => m.id === defaultModel) ? defaultModel : (models[0]?.id ?? ''));
    });
  }, []);

  /* Cambiando tipo cambiano sia i tool proponibili sia i modelli validi. */
  function switchKind(next: AgentKind) {
    setKind(next);
    setToolIds(new Set(defaults[next] ?? []));
    // Un modello non-Claude non può reggere un agente sviluppatore.
    void api.models({ kind: next }).then(({ models, defaultModel }) => {
      if (!models.some((m) => m.id === model)) {
        setModel(models.some((m) => m.id === defaultModel) ? defaultModel : (models[0]?.id ?? ''));
      }
    });
  }

  const visibleTools = catalog.filter((t) => t.availableFor.includes(kind));
  const grouped = useMemo(() => {
    const map = new Map<string, ToolDef[]>();
    for (const t of visibleTools) {
      const list = map.get(t.group) ?? [];
      list.push(t);
      map.set(t.group, list);
    }
    return [...map.entries()];
  }, [visibleTools]);

  async function generate() {
    if (purpose.trim().length < 10) {
      setError('Descrivi lo scopo dell’agente in almeno una frase per generare le skill.');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const { skills } = await api.generateSkills(workspace!.id, {
        purpose: purpose.trim(),
        kind,
        toolIds: [...toolIds],
        count: 3,
      });
      setSkills(skills);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generazione non riuscita.');
    } finally {
      setGenerating(false);
    }
  }

  async function create() {
    if (!name.trim() || !model) return;
    setSaving(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(workspace!.id, {
        name: name.trim(),
        kind,
        model,
        avatarEmoji: emoji,
        purpose: purpose.trim() || null,
        description: purpose.trim().slice(0, 200) || null,
        autoRespond,
        execution,
        permissionMode: kind === 'developer' ? permissionMode : 'ask',
        tools: [...toolIds].map((id) => ({ toolId: id, config: {}, requireApproval: false })),
        channelIds: [...channelIds],
        repo:
          kind === 'developer' && repoUrl.trim()
            ? {
                gitUrl: repoUrl.trim(),
                branch: repoBranch.trim() || 'main',
                credentialKey: 'GITHUB_TOKEN',
                setupCommand: null,
              }
            : null,
      });
      // Le skill approvate si salvano dopo: hanno bisogno dell'id dell'agente.
      for (const s of skills) {
        await api
          .saveSkill(agent.id, { ...s, enabled: true, generatedByAi: true })
          .catch(() => {});
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Creazione non riuscita.');
    } finally {
      setSaving(false);
    }
  }

  const modelUnavailable =
    (kind === 'developer' && !capabilities.anthropicConfigured) ||
    (kind === 'assistant' &&
      !model.startsWith('anthropic/') &&
      !capabilities.openrouterConfigured);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(30_26_16/0.34)] p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[92vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[16px] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
        {/* --- intestazione --- */}
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-5 py-3.5">
          <Avatar name={name || 'Nuovo agente'} emoji={emoji} color="#C8922F" size={34} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Nuovo agente</h2>
            <p className="text-[13px] text-[var(--color-ink-soft)]">
              {kind === 'developer'
                ? 'Lavora sul codice con shell e filesystem'
                : 'Risponde in chat usando i tool che gli dai'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
          >
            <X size={17} />
          </button>
        </header>

        {/* --- corpo --- */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Identità */}
          <div className="flex gap-3">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
                Icona
              </label>
              <div className="flex w-[210px] flex-wrap gap-1">
                {EMOJI_CHOICES.map((e) => (
                  <button
                    key={e}
                    onClick={() => setEmoji(e)}
                    className={clsx(
                      'flex h-7 w-7 items-center justify-center rounded-md text-[15px] transition-all',
                      e === emoji
                        ? 'bg-[color-mix(in_oklab,var(--color-honey)_22%,transparent)] ring-1 ring-[var(--color-honey)]'
                        : 'hover:bg-[var(--color-sunken)]',
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <label className="min-w-0 flex-1">
              <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
                Nome
              </span>
              <input
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Es. Fizz"
                maxLength={48}
                autoFocus
              />
              {name.trim() && (
                <span className="mt-1 block text-[12px] text-[var(--color-ink-faint)]">
                  Lo taggherai con{' '}
                  <span className="mention" data-kind="agent">
                    <Bot size={10} />@
                    {name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}
                  </span>
                </span>
              )}
            </label>
          </div>

          {/* Tipo */}
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              Tipo di agente
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  {
                    k: 'assistant' as const,
                    icon: Bot,
                    title: 'Assistente',
                    desc: 'Tool e API. Qualunque modello.',
                  },
                  {
                    k: 'developer' as const,
                    icon: Code2,
                    title: 'Sviluppatore',
                    desc: 'Codice e shell. Solo Claude.',
                  },
                ]
              ).map(({ k, icon: Icon, title, desc }) => (
                <button
                  key={k}
                  onClick={() => switchKind(k)}
                  className={clsx(
                    'rounded-[10px] border p-3 text-left transition-all',
                    kind === k
                      ? 'border-[var(--color-honey)] bg-[color-mix(in_oklab,var(--color-honey)_9%,transparent)]'
                      : 'border-[var(--color-line-strong)] hover:border-[var(--color-ink-faint)]',
                  )}
                >
                  <Icon size={17} strokeWidth={2.1} className="mb-1.5" />
                  <div className="text-[14px] font-medium">{title}</div>
                  <div className="text-[12.5px] text-[var(--color-ink-soft)]">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Modello */}
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              Modello
            </label>
            <ModelPicker kind={kind} value={model} onChange={setModel} />
            {kind === 'developer' && (
              <p className="mt-1.5 text-[12.5px] text-[var(--color-ink-faint)]">
                Gli agenti sviluppatore girano su Claude Code, che accetta solo modelli
                Claude.
              </p>
            )}
            {modelUnavailable && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-[var(--color-busy)]">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                <span>
                  Manca la credenziale per questo modello: puoi creare l'agente, ma non
                  risponderà finché non la configuri.
                </span>
              </p>
            )}
          </div>

          {/* Repository (solo agenti sviluppatore) */}
          {kind === 'developer' && (
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
                <GitBranch size={14} strokeWidth={2.1} /> Repository su cui lavorare
              </label>
              <div className="flex gap-2">
                <input
                  className="field flex-1 font-mono text-[13px]"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/tuo-utente/tuo-repo"
                />
                <input
                  className="field w-[120px] font-mono text-[13px]"
                  value={repoBranch}
                  onChange={(e) => setRepoBranch(e.target.value)}
                  placeholder="main"
                />
              </div>
              <p className="mt-1.5 text-[12.5px] text-[var(--color-ink-faint)]">
                L'agente clona questo repo in una cartella isolata e ci lavora dentro. Per
                repo privati e per il push serve un <strong>Token GitHub</strong> in
                Impostazioni → Credenziali. Ogni push passa da una tua conferma in chat.
              </p>

              {/* Dove gira: server o runner locale */}
              <label className="mt-3 mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
                <Cpu size={14} strokeWidth={2.1} /> Dove gira
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { v: 'server', t: 'Sul server', d: 'Sempre attivo, isolato in container.' },
                    { v: 'local', t: 'Sul mio computer', d: 'Runner locale: lavora sul tuo codice, con le tue credenziali.' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setExecution(o.v)}
                    className={
                      'rounded-lg border p-2.5 text-left transition-colors ' +
                      (execution === o.v
                        ? 'border-[var(--color-honey)] bg-[var(--color-honey-soft)]'
                        : 'border-[var(--color-line)] hover:bg-[var(--color-sunken)]')
                    }
                  >
                    <div className="text-[13px] font-medium">{o.t}</div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-faint)]">{o.d}</div>
                  </button>
                ))}
              </div>
              {execution === 'local' && (
                <p className="mt-1.5 text-[12.5px] text-[var(--color-ink-faint)]">
                  Questo agente risponderà solo quando il tuo <strong>runner locale</strong> è
                  acceso su questa macchina (vedi <code>deploy/RUNNER.md</code>).
                </p>
              )}

              {/* Permessi: conferma in chat o autonomia totale */}
              <label className="mt-4 mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
                <ShieldCheck size={14} strokeWidth={2.1} /> Permessi
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { v: 'ask', t: 'Chiede conferma', d: 'Le azioni delicate (shell, deploy…) passano da un tuo ok in chat.' },
                    { v: 'bypass', t: 'Autonomia totale', d: 'Non chiede mai: fa tutto da solo. Come --dangerously-skip-permissions.' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setPermissionMode(o.v)}
                    className={
                      'rounded-lg border p-2.5 text-left transition-colors ' +
                      (permissionMode === o.v
                        ? o.v === 'bypass'
                          ? 'border-[var(--color-error)] bg-[var(--color-error-soft,#fde8e8)]'
                          : 'border-[var(--color-honey)] bg-[var(--color-honey-soft)]'
                        : 'border-[var(--color-line)] hover:bg-[var(--color-sunken)]')
                    }
                  >
                    <div className="text-[13px] font-medium">{o.t}</div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-faint)]">{o.d}</div>
                  </button>
                ))}
              </div>
              {permissionMode === 'bypass' && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-[var(--color-error)]">
                  <AlertTriangle size={13} strokeWidth={2.2} className="mt-0.5 shrink-0" />
                  L'agente potrà eseguire comandi, modificare e cancellare file senza chiederti
                  nulla. Usalo solo dove ti fidi del perimetro (es. il tuo runner locale).
                </p>
              )}
            </div>
          )}

          {/* Scopo */}
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              Cosa deve fare
            </label>
            <textarea
              className="field h-auto py-2 leading-relaxed"
              rows={3}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Es. Segue il lancio del prodotto: raccoglie feedback dai canali, prepara sintesi settimanali e segnala le cose urgenti."
              maxLength={4000}
            />
            <p className="mt-1 text-[12px] text-[var(--color-ink-faint)]">
              Finisce nel suo prompt di sistema e guida la generazione delle skill.
            </p>
          </div>

          {/* Tool */}
          <div>
            <label className="mb-2 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              Cosa può fare · {toolIds.size} attivi
            </label>
            <div className="space-y-3">
              {grouped.map(([group, tools]) => (
                <div key={group}>
                  <div className="mb-1 text-[11.5px] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
                    {GROUP_LABELS[group] ?? group}
                  </div>
                  <div className="space-y-1">
                    {tools.map((t) => {
                      const on = toolIds.has(t.id);
                      return (
                        <button
                          key={t.id}
                          onClick={() =>
                            setToolIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(t.id)) next.delete(t.id);
                              else next.add(t.id);
                              return next;
                            })
                          }
                          className={clsx(
                            'flex w-full items-start gap-2.5 rounded-[9px] border px-2.5 py-2 text-left transition-all',
                            on
                              ? 'border-[color-mix(in_oklab,var(--color-honey)_45%,transparent)] bg-[color-mix(in_oklab,var(--color-honey)_7%,transparent)]'
                              : 'border-transparent hover:bg-[var(--color-sunken)]',
                          )}
                        >
                          <span
                            className={clsx(
                              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all',
                              on
                                ? 'border-[var(--color-honey)] bg-[var(--color-honey)] text-white'
                                : 'border-[var(--color-line-strong)]',
                            )}
                          >
                            {on && <Check size={11} strokeWidth={3.2} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                              {t.label}
                              {t.dangerous && (
                                <span className="flex items-center gap-1 rounded bg-[color-mix(in_oklab,var(--color-busy)_20%,transparent)] px-1.5 text-[10.5px] font-medium text-[var(--color-ink-soft)]">
                                  <AlertTriangle size={9} /> chiede conferma
                                </span>
                              )}
                            </span>
                            <span className="block text-[12.5px] leading-snug text-[var(--color-ink-soft)]">
                              {t.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Skill generate */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-[13px] font-medium text-[var(--color-ink-soft)]">
                Skill
              </label>
              <button
                onClick={() => void generate()}
                disabled={generating}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-sunken)] px-2.5 py-1 text-[12.5px] font-medium transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_9%,transparent)] disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 size={12.5} className="animate-spin" />
                ) : (
                  <Sparkles size={12.5} />
                )}
                {generating ? 'Genero…' : 'Genera con l’AI'}
              </button>
            </div>

            {skills.length === 0 ? (
              <p className="rounded-[9px] border border-dashed border-[var(--color-line-strong)] px-3 py-3 text-center text-[12.5px] text-[var(--color-ink-faint)]">
                Descrivi lo scopo qui sopra e lascia che l'AI proponga delle procedure
                operative. Le potrai rivedere prima di salvarle.
              </p>
            ) : (
              <div className="space-y-1.5">
                {skills.map((s, i) => (
                  <div
                    key={s.name}
                    className="rounded-[9px] border border-[var(--color-line)] bg-[var(--color-panel-alt)] px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[12.5px] font-medium">{s.name}</div>
                        <div className="text-[12.5px] leading-snug text-[var(--color-ink-soft)]">
                          {s.description}
                        </div>
                      </div>
                      <button
                        onClick={() => setSkills((prev) => prev.filter((_, j) => j !== i))}
                        className="shrink-0 rounded p-1 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-error)]"
                        title="Scarta"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Canali */}
          <div>
            <label className="mb-2 block text-[13px] font-medium text-[var(--color-ink-soft)]">
              In quali canali
            </label>
            <div className="flex flex-wrap gap-1.5">
              {channels
                .filter((c) => c.kind !== 'dm')
                .map((c) => {
                  const on = channelIds.has(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() =>
                        setChannelIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        })
                      }
                      className={clsx(
                        'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] transition-all',
                        on
                          ? 'border-[var(--color-honey)] bg-[color-mix(in_oklab,var(--color-honey)_12%,transparent)] font-medium'
                          : 'border-[var(--color-line-strong)] text-[var(--color-ink-soft)] hover:border-[var(--color-ink-faint)]',
                      )}
                    >
                      <Hash size={12} strokeWidth={2.4} />
                      {c.name}
                    </button>
                  );
                })}
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={autoRespond}
                onChange={(e) => setAutoRespond(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-honey)]"
              />
              <span>
                <span className="block text-[13.5px] font-medium">Risponde senza essere taggato</span>
                <span className="block text-[12.5px] text-[var(--color-ink-soft)]">
                  Interviene su ogni messaggio umano nei canali scelti. Lascialo spento se
                  non vuoi che parli sempre.
                </span>
              </span>
            </label>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-[color-mix(in_oklab,var(--color-error)_10%,transparent)] px-3 py-2 text-[13px] text-[var(--color-error)]"
            >
              {error}
            </p>
          )}
        </div>

        {/* --- piede --- */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--color-line)] px-5 py-3">
          <span className="text-[12.5px] text-[var(--color-ink-faint)]">
            {agents.length} {agents.length === 1 ? 'agente' : 'agenti'} nel progetto
          </span>
          <div className="ml-auto flex gap-2">
            <button className="btn btn-ghost" onClick={onClose}>
              Annulla
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void create()}
              disabled={saving || !name.trim() || !model}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
              {saving ? 'Creo…' : 'Crea agente'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*  Elenco agenti del progetto                                                 */
/* ========================================================================== */

export function AgentList({ onClose, onNew }: { onClose: () => void; onNew: () => void }) {
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const activity = useStore((s) => s.agentActivity);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = detailId ? (agents.find((a) => a.id === detailId) ?? null) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(30_26_16/0.34)] p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[16px] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-5 py-3.5">
          <Bot size={18} strokeWidth={2.1} />
          <h2 className="flex-1 text-[16px] font-semibold">Agenti</h2>
          <button className="btn btn-primary h-8" onClick={onNew}>
            Nuovo agente
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)]"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {agents.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <div className="mb-2 text-3xl">🐝</div>
              <p className="text-[15px] font-medium">Nessun agente, per ora</p>
              <p className="mx-auto mt-1 max-w-xs text-[13.5px] text-[var(--color-ink-soft)]">
                Creane uno, mettilo in un canale e taggalo: risponderà lì dentro insieme
                a tutti gli altri.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {agents.map((a) => {
                const state = activity.get(a.id);
                const inChannels = channels.filter((c) => (a.channelIds ?? []).includes(c.id));
                return (
                  <div
                    key={a.id}
                    onClick={() => setDetailId(a.id)}
                    className="group flex cursor-pointer items-start gap-3 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-[var(--color-sunken)]"
                    title="Vedi dettagli e impostazioni"
                  >
                    <Avatar name={a.name} emoji={a.avatarEmoji} color={a.avatarColor} size={34} isAgent />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14.5px] font-semibold">{a.name}</span>
                        <span className="text-[12.5px] text-[var(--color-ink-faint)]">
                          @{a.handle}
                        </span>
                        {a.kind === 'developer' && (
                          <span className="flex items-center gap-1 rounded bg-[var(--color-sunken)] px-1.5 text-[10.5px] font-medium text-[var(--color-ink-soft)]">
                            <Terminal size={9} /> sviluppatore
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[12px] text-[var(--color-ink-faint)]">
                        {a.model}
                      </div>
                      {inChannels.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {inChannels.map((c) => (
                            <span
                              key={c.id}
                              className="rounded bg-[var(--color-sunken)] px-1.5 py-px text-[11.5px] text-[var(--color-ink-soft)]"
                            >
                              #{c.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {state ? (
                      <span className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-ink-faint)]">
                        <Loader2 size={11} className="animate-spin" />
                        {state.status === 'waiting' ? 'in attesa' : 'al lavoro'}
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 self-center text-[12px] text-[var(--color-ink-faint)] opacity-0 transition-opacity group-hover:opacity-100">
                        Dettagli <ChevronRight size={13} strokeWidth={2.2} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {detail && <AgentDetail agent={detail} onClose={() => setDetailId(null)} />}
    </div>
  );
}
