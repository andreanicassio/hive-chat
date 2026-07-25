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
    ? `cd ~/my-project && curl -fsSL ${origin}/runner | bash -s -- ${fresh}`
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
      const { token } = await api.createRunnerToken(workspaceId, { label: 'My computer' });
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
          <Cpu size={16} strokeWidth={2.1} className="text-[var(--color-honey)]" /> Local runner
        </h3>
        <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--color-ink-soft)]">
          Run a developer agent <strong>on your own computer</strong>, on your live code: generate
          a token, run one line in the terminal and you're connected. Claude Code installs and
          updates itself. Then set an agent to “On my computer”.
        </p>
      </div>

      {fresh ? (
        <div className="rounded-xl border border-[var(--color-honey)] bg-[var(--color-honey-soft)] p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-ink)]">
            <TriangleAlert size={14} strokeWidth={2.2} /> Copy the command now: you won't see the
            token again.
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
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-[var(--color-ink-soft)]">
            Replace <code>~/my-project</code> with your code folder.
          </p>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={() => void generate()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Generate runner token
        </button>
      )}

      {/* Token attivi */}
      <div>
        <div className="mb-1.5 text-[12.5px] font-medium text-[var(--color-ink-soft)]">
          Active tokens
        </div>
        {tokens === null ? (
          <Loader2 size={16} className="animate-spin text-[var(--color-ink-faint)]" />
        ) : tokens.length === 0 ? (
          <p className="text-[13px] text-[var(--color-ink-faint)]">No tokens yet.</p>
        ) : (
          <div className="space-y-1">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded-[9px] bg-[var(--color-panel-alt)] px-3 py-2"
              >
                <span
                  className={
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full ' +
                    (t.online ? 'bg-[var(--color-success,#2e9e5b)]' : 'bg-[var(--color-ink-faint)]')
                  }
                  title={t.online ? 'on' : 'off'}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    {t.label ?? 'Runner'}
                    {t.host && (
                      <span className="ml-1.5 font-normal text-[var(--color-ink-faint)]">
                        on {t.host}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11.5px] text-[var(--color-ink-faint)]">
                    {t.online ? 'on now' : t.lastSeenAt
                      ? `off · last seen ${new Date(t.lastSeenAt).toLocaleString('en')}`
                      : 'never connected'}
                    {t.workdir ? ` · ${t.workdir}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => void revoke(t.id)}
                  className="shrink-0 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-error)]"
                  title="Revoke"
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
