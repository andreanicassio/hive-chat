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
  Plus,
} from 'lucide-react';
import { useStore } from '../store.js';
import { api, ApiError } from '../lib/api.js';
import { Avatar } from './Avatar.js';
import { AgentDetail } from './AgentDetail.js';
import { Modal, ModalRow, ModalSearch } from './Modal.js';
import type { Agent, AgentKind, AgentStatus, CatalogModel, RunnerToken } from '@hive/shared';

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

/**
 * Pannello di creazione E modifica di un agente.
 *
 * Passando `agent` si entra in modalità modifica: i campi partono dai suoi
 * valori e il salvataggio fa una PATCH invece di creare.
 */
export function AgentPanel({ onClose, agent }: { onClose: () => void; agent?: Agent }) {
  const workspace = useStore((s) => s.workspace);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const capabilities = useStore((s) => s.capabilities);
  const editing = Boolean(agent);

  const [name, setName] = useState(agent?.name ?? '');
  const [handle, setHandle] = useState(agent?.handle ?? '');
  const [emoji, setEmoji] = useState(agent?.avatarEmoji ?? '🐝');
  const [kind, setKind] = useState<AgentKind>(agent?.kind ?? 'assistant');
  const [model, setModel] = useState(agent?.model ?? '');
  const [purpose, setPurpose] = useState(agent?.purpose ?? '');
  const [toolIds, setToolIds] = useState<Set<string>>(
    new Set((agent?.tools ?? []).map((t) => t.toolId)),
  );
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set(agent?.channelIds ?? []));
  const [autoRespond, setAutoRespond] = useState(agent?.autoRespond ?? false);
  const [repoUrl, setRepoUrl] = useState(agent?.repo?.gitUrl ?? '');
  const [repoBranch, setRepoBranch] = useState(agent?.repo?.branch ?? 'main');
  const [execution, setExecution] = useState<'server' | 'local'>(agent?.execution ?? 'server');
  const [permissionMode, setPermissionMode] = useState<'ask' | 'bypass'>(
    agent?.permissionMode ?? 'ask',
  );
  const [toolConfigs, setToolConfigs] = useState<Record<string, Record<string, unknown>>>(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const g of agent?.tools ?? []) out[g.toolId] = (g.config ?? {}) as Record<string, unknown>;
    return out;
  });
  const [runnerTokenId, setRunnerTokenId] = useState<string | null>(agent?.runnerTokenId ?? null);
  const [runners, setRunners] = useState<RunnerToken[]>([]);

  const [catalog, setCatalog] = useState<ToolDef[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string[]>>({});
  const [skills, setSkills] = useState<Array<{ name: string; description: string; body: string }>>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Le macchine su cui l'utente ha installato un runner. */
  useEffect(() => {
    if (!workspace) return;
    void api
      .listRunnerTokens(workspace.id)
      .then(({ runnerTokens }) => setRunners(runnerTokens))
      .catch(() => setRunners([]));
  }, [workspace]);

  /* Catalogo tool e modello di default. In modifica NON tocchiamo i valori
     dell'agente: prendiamo solo il catalogo. */
  useEffect(() => {
    void api.tools().then(({ tools, defaults }) => {
      setCatalog(tools);
      setDefaults(defaults);
      if (!editing) setToolIds(new Set(defaults.assistant ?? []));
    });
    if (!editing) {
      void api.models({ kind: 'assistant' }).then(({ defaultModel, models }) => {
        setModel(models.some((m) => m.id === defaultModel) ? defaultModel : (models[0]?.id ?? ''));
      });
    }
  }, [editing]);

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

  /** Salvataggio in modifica: PATCH + allineamento dei canali. */
  async function saveEdits() {
    if (!name.trim() || !model || !agent) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateAgent(agent.id, {
        name: name.trim(),
        ...(handle.trim() && handle !== agent.handle ? { handle: handle.trim() } : {}),
        kind,
        model,
        avatarEmoji: emoji,
        purpose: purpose.trim() || null,
        autoRespond,
        execution,
        permissionMode: kind === 'developer' ? permissionMode : 'ask',
        runnerTokenId: execution === 'local' ? runnerTokenId : null,
        tools: [...toolIds].map((id) => {
          // Conserviamo config e "richiede approvazione" già impostati.
          const prev = (agent.tools ?? []).find((t) => t.toolId === id);
          return {
            toolId: id,
            config: toolConfigs[id] ?? prev?.config ?? {},
            requireApproval: prev?.requireApproval ?? false,
          };
        }),
        repo:
          kind === 'developer' && repoUrl.trim()
            ? {
                gitUrl: repoUrl.trim(),
                branch: repoBranch.trim() || 'main',
                credentialKey: agent.repo?.credentialKey ?? 'GITHUB_TOKEN',
                setupCommand: agent.repo?.setupCommand ?? null,
              }
            : null,
      });

      // Skill generate durante la modifica: si salvano sull'agente.
      for (const s of skills) {
        await api.saveSkill(agent.id, { ...s, enabled: true, generatedByAi: true }).catch(() => {});
      }

      // I canali si aggiornano a parte (aggancia/sgancia).
      const before = new Set(agent.channelIds ?? []);
      for (const id of channelIds) {
        if (!before.has(id)) await api.attachAgent(agent.id, id, autoRespond).catch(() => {});
      }
      for (const id of before) {
        if (!channelIds.has(id)) await api.detachAgent(agent.id, id).catch(() => {});
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Salvataggio non riuscito.');
    } finally {
      setSaving(false);
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
        runnerTokenId: execution === 'local' ? runnerTokenId : null,
        tools: [...toolIds].map((id) => ({
          toolId: id,
          config: toolConfigs[id] ?? {},
          requireApproval: false,
        })),
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

  const footerNode = (
    <>
      {editing ? (
        <button
          className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-error)]"
          onClick={() => {
            if (!confirm(`Archiviare ${agent!.name}? Non risponderà più, ma i suoi messaggi restano.`))
              return;
            void api.archiveAgent(agent!.id).then(onClose).catch(() => {});
          }}
        >
          <Trash2 size={13} strokeWidth={2.1} /> Archivia
        </button>
      ) : (
        <span className="text-[12.5px] text-[var(--color-ink-faint)]">
          {agents.length} {agents.length === 1 ? 'agente' : 'agenti'} nel progetto
        </span>
      )}
      <div className="ml-auto flex gap-2">
        <button className="btn btn-ghost" onClick={onClose}>
          Annulla
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void (editing ? saveEdits() : create())}
          disabled={saving || !name.trim() || !model}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
          {saving ? 'Salvo…' : editing ? 'Salva modifiche' : 'Crea agente'}
        </button>
      </div>
    </>
  );

  return (
    <Modal
      onClose={onClose}
      size="lg"
      dismissable={false}
      icon={
        <Avatar
          name={name || 'Nuovo agente'}
          emoji={emoji}
          color={agent?.avatarColor ?? '#C8922F'}
          size={34}
        />
      }
      title={editing ? `Modifica ${agent!.name}` : 'Nuovo agente'}
      subtitle={
        kind === 'developer'
          ? 'Lavora sul codice con shell e filesystem'
          : 'Risponde in chat usando i tool che gli dai'
      }
      footer={footerNode}
    >
      <div className="space-y-5">
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

          {/* In modifica l'handle è indipendente dal nome: si cambia a mano,
              perché rinominare non deve rompere le menzioni già scritte. */}
          {editing && (
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-ink-soft)]">
                Come lo tagghi
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-[15px] text-[var(--color-ink-faint)]">@</span>
                <input
                  className="field font-mono"
                  value={handle}
                  onChange={(e) =>
                    setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))
                  }
                  maxLength={32}
                  placeholder="devver"
                />
                {handle !== agent!.handle && handle.trim().length >= 2 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm shrink-0"
                    onClick={() => setHandle(agent!.handle)}
                  >
                    Annulla
                  </button>
                )}
              </div>
              {handle !== agent!.handle && (
                <span className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--color-ink-soft)]">
                  <AlertTriangle size={12} strokeWidth={2.2} className="mt-0.5 shrink-0" />
                  D'ora in poi risponderà a <strong>@{handle || '…'}</strong>. I messaggi già
                  scritti con <strong>@{agent!.handle}</strong> restano com'erano.
                </span>
              )}
            </label>
          )}

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
                    { v: 'local', t: 'Su una mia macchina', d: 'Dove hai installato il runner: il tuo Mac o un server remoto.' },
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
                <div className="mt-2">
                  <label className="mb-1 block text-[12.5px] font-medium text-[var(--color-ink-soft)]">
                    Su quale macchina
                  </label>
                  <select
                    className="field"
                    value={runnerTokenId ?? ''}
                    onChange={(e) => setRunnerTokenId(e.target.value || null)}
                  >
                    <option value="">La prima libera</option>
                    {runners.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.online ? '● ' : '○ '}
                        {r.label ?? 'Runner'}
                        {r.host ? ` — ${r.host}` : ''}
                        {r.online ? '' : ' (spenta)'}
                      </option>
                    ))}
                  </select>
                  {runnerTokenId && (
                    <p className="mt-1 text-[12px] text-[var(--color-ink-faint)]">
                      {runners.find((r) => r.id === runnerTokenId)?.workdir ?? ''}
                    </p>
                  )}
                  {runners.length === 0 && (
                    <p className="mt-1 text-[12px] text-[var(--color-ink-faint)]">
                      Nessun runner ancora: generane uno in Impostazioni → Runner.
                    </p>
                  )}
                </div>
              )}
              {execution === 'local' && (
                <p className="mt-1.5 text-[12.5px] text-[var(--color-ink-faint)]">
                  Risponde solo quando il <strong>runner</strong> è acceso. Puoi installarlo su
                  qualunque macchina (il tuo Mac o un server remoto via SSH) con il comando in
                  Impostazioni → Runner: si collega da solo in uscita, senza aprire porte.
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
                        <div key={t.id}>
                        <button
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
                                ? 'border-[var(--color-honey)] bg-[var(--color-honey)] text-[var(--color-on-accent)]'
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
                          {on && (
                            <ToolConfigForm
                              toolId={t.id}
                              value={toolConfigs[t.id] ?? {}}
                              onChange={(cfg) =>
                                setToolConfigs((prev) => ({ ...prev, [t.id]: cfg }))
                              }
                            />
                          )}
                        </div>
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

    </Modal>
  );
}


/* ========================================================================== */
/*  Configurazione dei tool che ne richiedono una                              */
/* ========================================================================== */

/**
 * Alcuni tool non funzionano senza impostazioni: il Deploy ha bisogno del
 * comando da lanciare, la Chiamata HTTP degli host autorizzati. Senza questo
 * form il salvataggio veniva rifiutato dal server con un errore incomprensibile.
 */
function ToolConfigForm({
  toolId,
  value,
  onChange,
}: {
  toolId: string;
  value: Record<string, unknown>;
  onChange: (cfg: Record<string, unknown>) => void;
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...value, ...patch });
  const field =
    'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-panel)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[color-mix(in_oklab,var(--color-honey)_55%,var(--color-line-strong))]';

  if (toolId === 'code.deploy') {
    const command = typeof value.command === 'string' ? value.command : '';
    return (
      <div className="mt-1 ml-7 space-y-2 border-l-2 border-[var(--color-line)] pl-3">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[var(--color-ink-soft)]">
            Comando di deploy <span className="text-[var(--color-error)]">*</span>
          </span>
          <input
            className={field + ' font-mono'}
            value={command}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="es. ./deploy.sh   oppure   npm run deploy"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[var(--color-ink-soft)]">
            Ambiente
          </span>
          <input
            className={field}
            value={typeof value.environment === 'string' ? value.environment : ''}
            onChange={(e) => set({ environment: e.target.value })}
            placeholder="production"
          />
        </label>
        {!command.trim() && (
          <p className="text-[11.5px] text-[var(--color-error)]">
            Senza comando questo tool non si può salvare.
          </p>
        )}
      </div>
    );
  }

  if (toolId === 'http.request') {
    const hosts = Array.isArray(value.allowedHosts) ? (value.allowedHosts as string[]) : [];
    const methods = Array.isArray(value.methods) ? (value.methods as string[]) : ['GET'];
    return (
      <div className="mt-1 ml-7 space-y-2 border-l-2 border-[var(--color-line)] pl-3">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[var(--color-ink-soft)]">
            Host consentiti <span className="text-[var(--color-error)]">*</span>
          </span>
          <input
            className={field + ' font-mono'}
            defaultValue={hosts.join(', ')}
            onBlur={(e) =>
              set({
                allowedHosts: e.target.value
                  .split(',')
                  .map((h) => h.trim())
                  .filter(Boolean),
              })
            }
            placeholder="api.stripe.com, api.github.com"
          />
          <span className="mt-1 block text-[11.5px] text-[var(--color-ink-faint)]">
            Separati da virgola. L'agente non potrà contattare altri host.
          </span>
        </label>
        <div>
          <span className="mb-1 block text-[12px] font-medium text-[var(--color-ink-soft)]">
            Metodi permessi
          </span>
          <div className="flex flex-wrap gap-1">
            {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => {
              const on = methods.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    set({ methods: on ? methods.filter((x) => x !== m) : [...methods, m] })
                  }
                  className={
                    'rounded-md px-2 py-0.5 font-mono text-[11.5px] transition-colors ' +
                    (on
                      ? 'bg-[var(--color-honey)] text-[var(--color-on-accent)]'
                      : 'bg-[var(--color-sunken)] text-[var(--color-ink-soft)]')
                  }
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-[var(--color-ink-soft)]">
            Segreto da usare (facoltativo)
          </span>
          <input
            className={field + ' font-mono'}
            value={typeof value.credentialKey === 'string' ? value.credentialKey : ''}
            onChange={(e) => set({ credentialKey: e.target.value || null })}
            placeholder="es. STRIPE_API_KEY"
          />
          <span className="mt-1 block text-[11.5px] text-[var(--color-ink-faint)]">
            Nome della chiave in Impostazioni → Credenziali. Il valore resta sul server.
          </span>
        </label>
        {hosts.length === 0 && (
          <p className="text-[11.5px] text-[var(--color-error)]">
            Indica almeno un host, altrimenti non si può salvare.
          </p>
        )}
      </div>
    );
  }

  return null;
}

/* ========================================================================== */
/*  Elenco agenti del progetto                                                 */
/* ========================================================================== */

/* ==========================================================================
   Card di un agente nell'elenco.

   Il badge dice UNO stato, e solo stati che esistono davvero: nel codice ci
   sono `idle`, `thinking`, `working`, `waiting`, `error` — nessuna «pausa».
   Un badge che mente è peggio di un badge in meno.
   ======================================================================== */

type Badge = { label: string; tint: string; pulse?: boolean };

function agentBadge(
  agent: Agent,
  live: { status: AgentStatus; label: string | null } | undefined,
  awaiting: boolean,
): Badge {
  const status = live?.status ?? agent.status;
  if (awaiting || status === 'waiting')
    return {
      label: 'attende te',
      tint: 'bg-[var(--color-honey-soft)] text-[color-mix(in_oklab,var(--color-honey)_75%,var(--color-ink))]',
    };
  if (status === 'error')
    return {
      label: 'errore',
      tint: 'bg-[color-mix(in_oklab,var(--color-error)_12%,transparent)] text-[var(--color-error)]',
    };
  if (status === 'working' || status === 'thinking')
    return {
      label: 'al lavoro',
      tint: 'bg-[color-mix(in_oklab,var(--color-online)_14%,transparent)] text-[color-mix(in_oklab,var(--color-online)_80%,var(--color-ink))]',
      pulse: true,
    };
  // Un agente locale con la macchina spenta non è «fermo»: non può partire.
  if (agent.execution === 'local' && agent.runnerOnline === false)
    return { label: 'macchina spenta', tint: 'bg-[var(--color-sunken)] text-[var(--color-ink-faint)]' };
  return { label: 'fermo', tint: 'bg-[var(--color-sunken)] text-[var(--color-ink-faint)]' };
}

function AgentCard({
  agent,
  channels,
  live,
  onOpen,
}: {
  agent: Agent;
  channels: string[];
  live: { status: AgentStatus; label: string | null } | undefined;
  onOpen: () => void;
}) {
  const approvals = useStore((s) => s.approvals);
  const pending = approvals.find((ap) => ap.agentId === agent.id);
  const badge = agentBadge(agent, live, Boolean(pending));
  const [busy, setBusy] = useState(false);

  async function decide(allowed: boolean) {
    if (!pending) return;
    setBusy(true);
    try {
      await api.decideApproval(pending.id, allowed);
    } finally {
      setBusy(false);
    }
  }

  return (
    // Un `div`, non un bottone: dentro ce ne sono altri due, e i bottoni non
    // si annidano.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen();
      }}
      className={clsx(
        'mx-3 mb-2 grid cursor-pointer grid-cols-[38px_minmax(0,1fr)_auto] items-start gap-3 rounded-[10px] border px-3.5 py-3 transition-colors',
        pending
          ? 'border-[color-mix(in_oklab,var(--color-honey)_35%,transparent)] bg-[var(--color-honey-soft)]'
          : 'border-[var(--color-line)] hover:border-[var(--color-line-strong)]',
      )}
    >
      <Avatar name={agent.name} emoji={agent.avatarEmoji} color={agent.avatarColor} size={38} isAgent />

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold">{agent.name}</span>
          <span className="shrink-0 text-[12px] font-normal text-[var(--color-ink-faint)]">
            @{agent.handle}
          </span>
          {agent.kind === 'developer' && (
            <span className="flex shrink-0 items-center gap-1 rounded bg-[var(--color-sunken)] px-1.5 text-[10.5px] font-medium text-[var(--color-ink-soft)]">
              <Terminal size={9} /> sviluppatore
            </span>
          )}
        </div>

        <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-ink-faint)]">
          <span className="font-mono">{agent.model.replace(/^.*\//, '')}</span>
          {' · '}
          {agent.execution === 'local' ? 'sulla tua macchina' : 'sul server'}
          {' · '}
          {channels.length > 0 ? channels.map((c) => `#${c}`).join(' ') : 'in nessun canale'}
        </div>

        {(live?.label ?? agent.statusLabel) && (
          <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--color-ink-soft)]">
            {live?.label ?? agent.statusLabel}
          </div>
        )}

        {pending && (
          <div className="mt-2">
            <p className="text-[12.5px] text-[var(--color-ink-soft)]">{pending.title}</p>
            <div className="mt-2 flex gap-2">
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void decide(true);
                }}
              >
                Concedi
              </button>
              <button
                className="btn btn-sm border border-[var(--color-line-strong)]"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void decide(false);
                }}
              >
                Rifiuta
              </button>
            </div>
          </div>
        )}
      </div>

      <span
        className={clsx(
          'flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
          badge.tint,
        )}
      >
        {badge.pulse && (
          <span className="h-[6px] w-[6px] animate-pulse rounded-full bg-[var(--color-online)]" />
        )}
        {badge.label}
      </span>
    </div>
  );
}

export function AgentList({ onClose, onNew }: { onClose: () => void; onNew: () => void }) {
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const activity = useStore((s) => s.agentActivity);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const detail = detailId ? (agents.find((a) => a.id === detailId) ?? null) : null;
  const editTarget = editId ? (agents.find((a) => a.id === editId) ?? null) : null;
  const approvals = useStore((s) => s.approvals);
  // «Richiede attenzione» vuol dire: sta aspettando una tua decisione, o è
  // finito in errore. Non un agente semplicemente fermo.
  const attention = agents.filter(
    (a) =>
      approvals.some((ap) => ap.agentId === a.id) ||
      (activity.get(a.id)?.status ?? a.status) === 'waiting' ||
      (activity.get(a.id)?.status ?? a.status) === 'error',
  ).length;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(needle) ||
        a.handle.toLowerCase().includes(needle) ||
        (a.description ?? '').toLowerCase().includes(needle),
    );
  }, [agents, q]);

  return (
    <>
      <Modal
        onClose={onClose}
        size="md"
        tall
        flush
        icon={<Bot size={18} strokeWidth={2.1} />}
        title="Agenti"
        subtitle={
          agents.length === 0
            ? undefined
            : `${agents.length} ${agents.length === 1 ? 'configurato' : 'configurati'}${
                attention > 0
                  ? ` · ${attention} ${attention === 1 ? 'richiede' : 'richiedono'} attenzione`
                  : ''
              }`
        }
        headerRight={
          <button className="btn btn-primary btn-sm" onClick={onNew}>
            <Plus size={13} strokeWidth={2.4} /> Nuovo agente
          </button>
        }
      >
        {agents.length > 0 && (
          <ModalSearch value={q} onChange={setQ} placeholder="Cerca un agente…" />
        )}

        {agents.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mb-2 text-3xl">🐝</div>
            <p className="text-[15px] font-medium">Nessun agente, per ora</p>
            <p className="mx-auto mt-1 max-w-xs text-[13.5px] text-[var(--color-ink-soft)]">
              Creane uno, mettilo in un canale e taggalo: risponderà lì dentro insieme a tutti
              gli altri.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-6 py-10 text-center text-[13.5px] text-[var(--color-ink-faint)]">
            Nessun agente per «{q}».
          </p>
        ) : (
          <div className="pb-2">
            {filtered.map((a) => {
              const state = activity.get(a.id);
              const inChannels = channels.filter((c) => (a.channelIds ?? []).includes(c.id));
              return (
                <AgentCard
                  key={a.id}
                  agent={a}
                  channels={inChannels.map((c) => c.name)}
                  live={state}
                  onOpen={() => setDetailId(a.id)}
                />
              );
            })}
          </div>
        )}
      </Modal>

      {detail && !editTarget && (
        <AgentDetail
          agent={detail}
          onClose={() => setDetailId(null)}
          onEdit={(a) => setEditId(a.id)}
        />
      )}
      {editTarget && (
        <AgentPanel
          agent={editTarget}
          onClose={() => {
            setEditId(null);
            setDetailId(null);
          }}
        />
      )}
    </>
  );
}
