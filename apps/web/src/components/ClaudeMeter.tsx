import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { SubscriptionUsage } from '@hive/shared';
import { api } from '../lib/api.js';
import { useStore } from '../store.js';

/**
 * Quanto abbonamento Claude resta, senza aprire le impostazioni.
 *
 * Le stesse due percentuali che stanno nella tab del runner, ma qui, accanto
 * alla conversazione: la domanda «faccio partire questo lavoro adesso?» nasce
 * mentre si sta scrivendo a un agente, non mentre si guardano le
 * impostazioni. E accanto ai numeri c'è il nome del conto che paga: da quando
 * ognuno può avere la sua chiave, «85%» senza dire di chi è una mezza
 * informazione.
 */

const REFRESH_MS = 60_000;

/** La più consumata fra le macchine accese: è quella che ti fermerà per prima. */
function worst(a: SubscriptionUsage | null, b: SubscriptionUsage | null | undefined) {
  if (!b) return a;
  if (!a) return b;
  const pick = (x: SubscriptionUsage) =>
    Math.max(x.fiveHour?.utilization ?? 0, x.sevenDay?.utilization ?? 0);
  return pick(b) > pick(a) ? b : a;
}

export function ClaudeMeter({ className }: { className?: string }) {
  const workspace = useStore((s) => s.workspace);
  const capabilities = useStore((s) => s.capabilities);
  const [usage, setUsage] = useState<SubscriptionUsage | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    const load = () =>
      api
        .listRunnerTokens(workspace.id)
        .then((r) => {
          if (!alive) return;
          // Solo le macchine accese: la quota di un runner spento è un numero
          // vecchio, e un numero vecchio qui vale meno di niente.
          setUsage(
            r.runnerTokens
              .filter((t) => t.online)
              .reduce<SubscriptionUsage | null>((acc, t) => worst(acc, t.usage), null),
          );
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workspace]);

  const windows = [
    { label: '5h', w: usage?.fiveHour },
    { label: '7g', w: usage?.sevenDay },
  ].filter((x) => x.w);

  if (windows.length === 0 && !capabilities.claudeAuthLabel) return null;

  return (
    <div className={clsx('px-1.5 py-1', className)}>
      {windows.length > 0 && (
        <div className="flex items-center gap-1.5">
          {windows.map(({ label, w }) => {
            const pct = Math.max(0, Math.min(100, w!.utilization));
            const hot = pct >= 80;
            return (
              <span
                key={label}
                className="flex min-w-0 flex-1 items-center gap-1"
                title={
                  w!.resetsAt
                    ? `${label}: riparte da zero ${new Date(w!.resetsAt).toLocaleString()}`
                    : label
                }
              >
                <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">{label}</span>
                <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-sunken)]">
                  <span
                    className="block h-full rounded-full transition-[width] duration-500"
                    style={{
                      width: `${pct}%`,
                      background: hot ? 'var(--color-terracotta)' : 'var(--color-ink-faint)',
                    }}
                  />
                </span>
                <span
                  className={clsx(
                    'shrink-0 text-[10px] tabular-nums',
                    hot
                      ? 'font-semibold text-[var(--color-terracotta)]'
                      : 'text-[var(--color-ink-faint)]',
                  )}
                >
                  {Math.round(pct)}%
                </span>
              </span>
            );
          })}
        </div>
      )}
      {capabilities.claudeAuthLabel && (
        <div
          className="mt-0.5 truncate text-[10.5px] text-[var(--color-ink-faint)]"
          title={`I turni Claude passano da: ${capabilities.claudeAuthLabel}`}
        >
          {capabilities.claudeAuthLabel}
        </div>
      )}
    </div>
  );
}
