import { useEffect, useState } from 'react';
import {
  X,
  Terminal,
  Cpu,
  ShieldCheck,
  AlertTriangle,
  FileCode2,
  Loader2,
  Save,
  Hash,
} from 'lucide-react';
import type { Agent } from '@hive/shared';
import { useStore } from '../store.js';
import { api, ApiError } from '../lib/api.js';
import { Avatar } from './Avatar.js';

/**
 * Dettagli di un agente: cosa è, dove gira, che permessi ha — e soprattutto
 * il CLAUDE.md del progetto su cui lavora, leggibile e modificabile da qui.
 * Il file è quello VERO sul disco (sul server o sulla macchina di chi ha il
 * runner acceso), non una copia.
 */
export function AgentDetail({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const channels = useStore((s) => s.channels);
  const inChannels = channels.filter((c) => (agent.channelIds ?? []).includes(c.id));

  const [execution, setExecution] = useState(agent.execution);
  const [permissionMode, setPermissionMode] = useState(agent.permissionMode ?? 'ask');
  const [savingCfg, setSavingCfg] = useState(false);

  async function saveConfig(next: Partial<Agent>) {
    setSavingCfg(true);
    try {
      await api.updateAgent(agent.id, next as Record<string, unknown>);
    } catch {
      /* il websocket riporta comunque lo stato vero */
    } finally {
      setSavingCfg(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgb(30_26_16/0.34)] p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[16px] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
        {/* intestazione */}
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-line)] px-5 py-4">
          <Avatar name={agent.name} emoji={agent.avatarEmoji} color={agent.avatarColor} size={40} isAgent />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[16px] font-semibold">{agent.name}</h2>
              <span className="text-[13px] text-[var(--color-ink-faint)]">@{agent.handle}</span>
              {agent.kind === 'developer' && (
                <span className="flex items-center gap-1 rounded bg-[var(--color-sunken)] px-1.5 text-[10.5px] font-medium text-[var(--color-ink-soft)]">
                  <Terminal size={9} /> sviluppatore
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--color-ink-faint)]">
              {agent.model}
            </div>
            {inChannels.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {inChannels.map((c) => (
                  <span
                    key={c.id}
                    className="flex items-center gap-0.5 rounded bg-[var(--color-sunken)] px-1.5 py-px text-[11.5px] text-[var(--color-ink-soft)]"
                  >
                    <Hash size={9} />
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)]"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {agent.description && (
            <p className="text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
              {agent.description}
            </p>
          )}

          {agent.kind === 'developer' && (
            <>
              {/* dove gira */}
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
                  <Cpu size={14} strokeWidth={2.1} /> Dove gira
                  {savingCfg && <Loader2 size={11} className="animate-spin" />}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { v: 'server', t: 'Sul server', d: 'Sempre attivo, isolato in container.' },
                      { v: 'local', t: 'Sul mio computer', d: 'Runner locale, sul tuo codice.' },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => {
                        setExecution(o.v);
                        void saveConfig({ execution: o.v });
                      }}
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
              </div>

              {/* permessi */}
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
                  <ShieldCheck size={14} strokeWidth={2.1} /> Permessi
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { v: 'ask', t: 'Chiede conferma', d: 'Le azioni delicate passano da te.' },
                      { v: 'bypass', t: 'Autonomia totale', d: 'Non chiede mai: fa tutto da solo.' },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => {
                        setPermissionMode(o.v);
                        void saveConfig({ permissionMode: o.v });
                      }}
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
              </div>

              <ClaudeMdEditor agent={agent} execution={execution} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Editor del CLAUDE.md reale nella cartella di lavoro dell'agente. */
function ClaudeMdEditor({ agent, execution }: { agent: Agent; execution: string }) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [path, setPath] = useState('');
  const [source, setSource] = useState<'server' | 'runner' | null>(null);
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getAgentClaudeMd(agent.id);
      setContent(r.content);
      setOriginal(r.content);
      setPath(r.path);
      setSource(r.source);
      setExists(r.exists);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Non riesco a leggere il file.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // ricarica se cambia dove gira: cambia anche il file di riferimento
  }, [agent.id, execution]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.saveAgentClaudeMd(agent.id, content);
      setOriginal(r.content);
      setExists(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Salvataggio fallito.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
        <FileCode2 size={14} strokeWidth={2.1} /> CLAUDE.md del progetto
      </label>
      <p className="mb-2 text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
        Le istruzioni che l'agente legge a ogni turno, come Claude Code da terminale.
        {path && (
          <>
            {' '}
            File reale:{' '}
            <code className="rounded bg-[var(--color-sunken)] px-1 py-px font-mono text-[11px]">
              {path}
            </code>
            {source === 'runner' && ' (sul tuo computer)'}
          </>
        )}
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-[13px] text-[var(--color-ink-faint)]">
          <Loader2 size={14} className="animate-spin" /> Leggo il file…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-sunken)] p-3">
          <div className="flex items-start gap-1.5 text-[12.5px] text-[var(--color-ink-soft)]">
            <AlertTriangle size={13} strokeWidth={2.2} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
          <button className="btn btn-ghost btn-sm mt-2" onClick={() => void load()}>
            Riprova
          </button>
        </div>
      ) : (
        <>
          {!exists && (
            <p className="mb-1.5 text-[12px] text-[var(--color-ink-faint)]">
              Non esiste ancora: salvando lo crei.
            </p>
          )}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            spellCheck={false}
            className="field h-auto w-full resize-y py-2 font-mono text-[12.5px] leading-relaxed"
            placeholder={'# Progetto\n\nComportati così…'}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              className="btn btn-primary btn-sm"
              disabled={saving || content === original}
              onClick={() => void save()}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Salva sul disco
            </button>
            {content !== original && !saving && (
              <button className="btn btn-ghost btn-sm" onClick={() => setContent(original)}>
                Annulla
              </button>
            )}
            {saved && <span className="text-[12px] text-[var(--color-ink-faint)]">Salvato ✓</span>}
          </div>
        </>
      )}
    </div>
  );
}
