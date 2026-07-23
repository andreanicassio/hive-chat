import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Loader2, TrendingUp, Info } from 'lucide-react';
import { useStore } from '../store.js';
import { api, type UsageReport } from '../lib/api.js';

/**
 * Scheda "Utilizzo": quanto sta costando il progetto, dove va il costo.
 *
 * Barre orizzontali semplici invece di una libreria di grafici: sono chiare,
 * accessibili e non aggiungono peso al bundle. I colori seguono la palette
 * del prodotto.
 */

function money(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function tokens(v: number): string {
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

const PERIODS = [
  { days: 7, label: '7 giorni' },
  { days: 30, label: '30 giorni' },
  { days: 365, label: '12 mesi' },
];

/** Barra orizzontale con etichetta e valore, lunghezza proporzionale al massimo. */
function Bar({
  label,
  sub,
  value,
  max,
  color,
  right,
}: {
  label: React.ReactNode;
  sub?: string;
  value: number;
  max: number;
  color: string;
  right: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="w-[130px] shrink-0 truncate text-[13px]">
        <span className="font-medium">{label}</span>
        {sub && <span className="ml-1 text-[11.5px] text-[var(--color-ink-faint)]">{sub}</span>}
      </div>
      <div className="h-[18px] flex-1 overflow-hidden rounded-full bg-[var(--color-sunken)]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className="w-[92px] shrink-0 text-right text-[12.5px] tabular-nums text-[var(--color-ink-soft)]">
        {right}
      </div>
    </div>
  );
}

export function Usage() {
  const workspace = useStore((s) => s.workspace);
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspace) return;
    setLoading(true);
    api
      .usage(workspace.id, days)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [workspace, days]);

  // Andamento giornaliero riempito: anche i giorni senza spesa compaiono.
  const dailySeries = useMemo(() => {
    if (!report) return [];
    const byDate = new Map(report.daily.map((d) => [d.date, d]));
    const out: Array<{ date: string; costUsd: number; runs: number }> = [];
    const span = Math.min(days, 30); // il grafico mostra al più 30 barre
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push(byDate.get(d) ?? { date: d, costUsd: 0, runs: 0 });
    }
    return out;
  }, [report, days]);

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 size={18} className="animate-spin text-[var(--color-ink-faint)]" />
      </div>
    );
  }
  if (!report) {
    return <p className="py-8 text-center text-[13.5px] text-[var(--color-ink-soft)]">Nessun dato.</p>;
  }

  const maxAgent = Math.max(...report.byAgent.map((a) => a.costUsd), 0.0001);
  const maxChannel = Math.max(...report.byChannel.map((c) => c.costUsd), 0.0001);
  const maxDay = Math.max(...dailySeries.map((d) => d.costUsd), 0.0001);
  const activeAgents = report.byAgent.filter((a) => a.runs > 0 || a.costUsd > 0);
  const activeChannels = report.byChannel.filter((c) => c.runs > 0);

  const AGENT_COLORS = ['#C8922F', '#C0663C', '#6B7F56', '#4E7C6B', '#7A5C8E', '#A65160'];

  return (
    <div className="space-y-5">
      {/* selettore periodo */}
      <div className="flex items-center gap-1">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            onClick={() => setDays(p.days)}
            className={clsx(
              'rounded-lg px-2.5 py-1 text-[13px] transition-colors',
              days === p.days
                ? 'bg-[var(--color-ink)] font-medium text-[var(--color-panel)]'
                : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-sunken)]',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* stat principali */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="rounded-[11px] bg-[var(--color-panel-alt)] px-3.5 py-3">
          <div className="text-[11.5px] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
            Costo totale
          </div>
          <div className="mt-0.5 text-[22px] font-semibold tabular-nums">
            {money(report.total.costUsd)}
          </div>
        </div>
        <div className="rounded-[11px] bg-[var(--color-panel-alt)] px-3.5 py-3">
          <div className="text-[11.5px] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
            Esecuzioni
          </div>
          <div className="mt-0.5 text-[22px] font-semibold tabular-nums">{report.total.runs}</div>
          {report.total.errorRuns > 0 && (
            <div className="text-[11.5px] text-[var(--color-error)]">
              {report.total.errorRuns} con errore
            </div>
          )}
        </div>
        <div className="rounded-[11px] bg-[var(--color-panel-alt)] px-3.5 py-3">
          <div className="text-[11.5px] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
            Token
          </div>
          <div className="mt-0.5 text-[22px] font-semibold tabular-nums">
            {tokens(report.total.inputTokens + report.total.outputTokens)}
          </div>
          <div className="text-[11.5px] text-[var(--color-ink-faint)]">
            {tokens(report.total.inputTokens)} in · {tokens(report.total.outputTokens)} out
          </div>
        </div>
      </div>

      {/* nota abbonamento vs consumo */}
      {report.subscriptionCostUsd > 0 && (
        <div className="flex items-start gap-2 rounded-[10px] bg-[color-mix(in_oklab,var(--color-honey)_9%,transparent)] px-3 py-2.5 text-[12.5px] text-[var(--color-ink-soft)]">
          <Info size={14} className="mt-px shrink-0 text-[var(--color-honey)]" />
          <div>
            <strong>{money(report.subscriptionCostUsd)}</strong> di questo costo viene dai modelli
            Claude sul tuo <strong>abbonamento</strong>: è il valore equivalente a consumo, non un
            addebito reale — l'abbonamento è a canone fisso.
            {report.payPerUseCostUsd > 0 && (
              <>
                {' '}I <strong>{money(report.payPerUseCostUsd)}</strong> via OpenRouter sono invece
                spesa reale a consumo.
              </>
            )}
          </div>
        </div>
      )}

      {/* andamento giornaliero */}
      {dailySeries.some((d) => d.costUsd > 0) && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
            <TrendingUp size={14} strokeWidth={2.1} /> Andamento
          </div>
          <div className="flex h-24 items-end gap-[3px]">
            {dailySeries.map((d) => (
              <div
                key={d.date}
                className="group relative flex-1"
                style={{ height: '100%' }}
                title={`${d.date}: ${money(d.costUsd)} · ${d.runs} run`}
              >
                <div className="absolute bottom-0 w-full rounded-t-[3px] bg-[var(--color-honey)] transition-all group-hover:bg-[var(--color-terracotta)]"
                  style={{ height: `${Math.max(2, (d.costUsd / maxDay) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-[var(--color-ink-faint)]">
            <span>{dailySeries[0]?.date.slice(5)}</span>
            <span>oggi</span>
          </div>
        </div>
      )}

      {/* per agente */}
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
          Quali agenti costano di più
        </div>
        {activeAgents.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-ink-faint)]">
            Nessuna esecuzione nel periodo.
          </p>
        ) : (
          <div>
            {activeAgents.map((a, i) => (
              <Bar
                key={a.agentId}
                label={
                  <span>
                    {a.emoji} {a.name}
                  </span>
                }
                sub={`${a.runs} run`}
                value={a.costUsd}
                max={maxAgent}
                color={AGENT_COLORS[i % AGENT_COLORS.length]!}
                right={money(a.costUsd)}
              />
            ))}
          </div>
        )}
      </div>

      {/* per canale */}
      {activeChannels.length > 0 && (
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
            Quali chat costano di più
          </div>
          <div>
            {activeChannels.map((c) => (
              <Bar
                key={c.channelId}
                label={<span>#{c.name}</span>}
                sub={`${c.runs} run`}
                value={c.costUsd}
                max={maxChannel}
                color="#4E7C6B"
                right={money(c.costUsd)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
