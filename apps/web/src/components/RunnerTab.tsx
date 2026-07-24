import { useEffect, useState } from 'react';
import { Loader2, Plus, Copy, Check, Trash2, Cpu, TriangleAlert } from 'lucide-react';
import type { RunnerToken } from '@hive/shared';
import { api } from '../lib/api.js';

/**
 * Runner locale: qui l'utente genera il token e copia il comando di
 * installazione. Il token in chiaro si vede una volta sola.
 */
export function RunnerTab({ workspaceId }: { workspaceId: string }) {
  const [tokens, setTokens] = useState<RunnerToken[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const origin = window.location.origin.replace(/\/+$/, '');
  const command = fresh
    ? `cd ~/il-mio-progetto && curl -fsSL ${origin}/runner | bash -s -- ${fresh}`
    : '';

  async function load() {
    try {
      const { runnerTokens } = await api.listRunnerTokens(workspaceId);
      setTokens(runnerTokens);
    } catch {
      setTokens([]);
    }
  }
  useEffect(() => {
    void load();
  }, [workspaceId]);

  async function generate() {
    setBusy(true);
    try {
      const { token } = await api.createRunnerToken(workspaceId, { label: 'Il mio computer' });
      setFresh(token);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api.revokeRunnerToken(id).catch(() => {});
    setTokens((t) => (t ?? []).filter((x) => x.id !== id));
  }

  const copy = () => {
    void navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="flex items-center gap-1.5 text-[15px] font-semibold">
          <Cpu size={16} strokeWidth={2.1} className="text-[var(--color-honey)]" /> Runner locale
        </h3>
        <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
          Fai girare un agente sviluppatore <strong>sul tuo computer</strong>, sul tuo codice
          live: genera un token, lancia una riga nel terminale e sei collegato. Claude Code si
          installa e si aggiorna da solo. Poi imposta un agente su «Sul mio computer».
        </p>
      </div>

      {fresh ? (
        <div className="rounded-xl border border-[var(--color-honey)] bg-[var(--color-honey-soft)] p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-ink)]">
            <TriangleAlert size={14} strokeWidth={2.2} /> Copia il comando adesso: il token non si
            rivede più.
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-[var(--color-ink)] px-3 py-2.5">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12.5px] whitespace-nowrap text-[#f0ece1]">
              {command}
            </code>
            <button
              onClick={copy}
              className="flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[12px] text-white transition-colors hover:bg-white/20"
            >
              {copied ? <Check size={12} strokeWidth={2.6} /> : <Copy size={12} />}
              {copied ? 'Copiato' : 'Copia'}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-[var(--color-ink-soft)]">
            Sostituisci <code>~/il-mio-progetto</code> con la cartella del tuo codice.
          </p>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={() => void generate()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Genera token del runner
        </button>
      )}

      {/* Token attivi */}
      <div>
        <div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-ink-soft)]">
          Token attivi
        </div>
        {tokens === null ? (
          <Loader2 size={16} className="animate-spin text-[var(--color-ink-faint)]" />
        ) : tokens.length === 0 ? (
          <p className="text-[13px] text-[var(--color-ink-faint)]">Nessun token ancora.</p>
        ) : (
          <div className="space-y-1">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded-[9px] bg-[var(--color-panel-alt)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{t.label ?? 'Runner'}</div>
                  <div className="text-[11.5px] text-[var(--color-ink-faint)]">
                    {t.lastSeenAt
                      ? `attivo · visto ${new Date(t.lastSeenAt).toLocaleString('it')}`
                      : 'mai collegato'}
                  </div>
                </div>
                <button
                  onClick={() => void revoke(t.id)}
                  className="shrink-0 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-error)]"
                  title="Revoca"
                >
                  <Trash2 size={14} strokeWidth={2.1} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
