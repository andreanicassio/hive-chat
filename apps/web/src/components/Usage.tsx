import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Loader2, TrendingUp, Info } from 'lucide-react';
import { useStore } from '../store.js';
import { api, type UsageReport } from '../lib/api.js';

/**
 * Scheda "Utilizzo": quanto stai spendendo davvero, e dove va la spesa.
 *
 * La regola della pagina: **in dollari compare solo quello che è fatturato a
 * token.** I run coperti dall'abbonamento si misurano in token, e il loro
 * equivalente a listino resta un'informazione di contorno — sommarlo alla
 * spesa vera darebbe una cifra che non paghi.
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

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
        {title}
        {hint && <span className="ml-1.5 font-normal text-[11.5px] text-[var(--color-ink-faint)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Tetto di spesa mensile: il freno che evita bollette a sorpresa. */
function BudgetCard({
  workspaceId,
  budget,
  onChange,
}: {
  workspaceId: string;
  budget: { limitUsd: number | null; spentUsd: number; exceeded: boolean };
  onChange: (b: { limitUsd: number | null; spentUsd: number; exceeded: boolean }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(budget.limitUsd?.toString() ?? '');
  const [saving, setSaving] = useState(false);

  async function save(limit: number | null) {
    setSaving(true);
    try {
      const { budget: next } = await api.setBudget(workspaceId, limit);
      onChange(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const pct =
    budget.limitUsd && budget.limitUsd > 0
      ? Math.min(100, (budget.spentUsd / budget.limitUsd) * 100)
      : 0;

  return (
    <div
      className={
        'rounded-xl border p-3.5 ' +
        (budget.exceeded
          ? 'border-[var(--color-error)] bg-[color-mix(in_oklab,var(--color-error)_7%,transparent)]'
          : 'border-[var(--color-line)]')
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-[var(--color-ink-soft)]">
          Tetto di spesa mensile
        </span>
        {!editing && (
          <button
            className="ml-auto text-[12.5px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            onClick={() => {
              setValue(budget.limitUsd?.toString() ?? '');
              setEditing(true);
            }}
          >
            {budget.limitUsd === null ? 'Imposta' : 'Modifica'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[15px] text-[var(--color-ink-faint)]">$</span>
          <input
            autoFocus
            type="number"
            min={0}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="es. 50"
            className="field h-8 w-28"
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={() => void save(value.trim() === '' ? null : Number(value))}
          >
            Salva
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Annulla
          </button>
          {budget.limitUsd !== null && (
            <button
              className="ml-auto text-[12.5px] text-[var(--color-ink-faint)] hover:text-[var(--color-error)]"
              onClick={() => void save(null)}
            >
              Togli il limite
            </button>
          )}
        </div>
      ) : budget.limitUsd === null ? (
        <p className="mt-1 text-[12.5px] text-[var(--color-ink-faint)]">
          Nessun limite: gli agenti possono spendere quanto serve. Impostane uno per
          evitare sorprese.
        </p>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-[19px] font-semibold tabular-nums">
              ${budget.spentUsd.toFixed(2)}
            </span>
            <span className="text-[13px] text-[var(--color-ink-faint)]">
              di ${budget.limitUsd.toFixed(2)} questo mese
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-sunken)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct}%`,
                background: budget.exceeded ? 'var(--color-error)' : 'var(--color-honey)',
              }}
            />
          </div>
          {budget.exceeded && (
            <p className="mt-1.5 text-[12.5px] text-[var(--color-error)]">
              Tetto raggiunto: gli agenti non partono più finché non lo alzi.
            </p>
          )}
        </>
      )}
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

  // Andamento giornaliero riempito: anche i giorni senza attività compaiono.
  const dailySeries = useMemo(() => {
    if (!report) return [];
    const byDate = new Map(report.daily.map((d) => [d.date, d]));
    const out: UsageReport['daily'] = [];
    const span = Math.min(days, 30); // il grafico mostra al più 30 barre
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push(
        byDate.get(d) ?? { date: d, billedCostUsd: 0, subscriptionEquivalentUsd: 0, runs: 0 },
      );
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

  const { total } = report;

  // Gli agenti a consumo si classificano in dollari, quelli in abbonamento in
  // token: due valute diverse, due liste diverse. Un agente che ha entrambi i
  // tipi di run (l'auth è cambiata nel periodo) compare in tutte e due.
  const paidAgents = report.byAgent.filter((a) => a.billedCostUsd > 0);
  const subAgents = report.byAgent.filter(
    (a) => a.billedCostUsd === 0 && (a.runs > 0 || a.inputTokens + a.outputTokens > 0),
  );
  const paidChannels = report.byChannel.filter((c) => c.billedCostUsd > 0);

  const maxPaidAgent = Math.max(...paidAgents.map((a) => a.billedCostUsd), 0.0001);
  const maxSubAgent = Math.max(...subAgents.map((a) => a.inputTokens + a.outputTokens), 1);
  const maxChannel = Math.max(...paidChannels.map((c) => c.billedCostUsd), 0.0001);

  /*
   * Il grafico segue la serie che nel periodo pesa davvero.
   *
   * Prima bastava un centesimo di spesa reale per farci disegnare quella, e
   * gli 800 dollari equivalenti dell'abbonamento sparivano: restavano due
   * barre in fondo e sembrava che prima di ieri non fosse successo niente.
   * Le due valute non si sommano — una la paghi, l'altra no — quindi si
   * sceglie la maggiore e la si dichiara nel titolo.
   */
  const chartMode: 'billed' | 'subscription' | 'runs' =
    total.billedCostUsd >= total.subscriptionEquivalentUsd && total.billedCostUsd > 0
      ? 'billed'
      : total.subscriptionEquivalentUsd > 0
        ? 'subscription'
        : 'runs';
  const chartValue = (d: UsageReport['daily'][number]) =>
    chartMode === 'billed'
      ? d.billedCostUsd
      : chartMode === 'subscription'
        ? d.subscriptionEquivalentUsd
        : d.runs;
  const maxDay = Math.max(...dailySeries.map(chartValue), chartMode === 'runs' ? 1 : 0.0001);

  const AGENT_COLORS = ['#C8922F', '#C0663C', '#6B7F56', '#4E7C6B', '#7A5C8E', '#A65160'];

  return (
    <div className="space-y-5">
      <BudgetCard
        workspaceId={workspace!.id}
        budget={report.budget}
        onChange={(b) => setReport((r) => (r ? { ...r, budget: b } : r))}
      />

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
            Spesa reale
          </div>
          <div className="mt-0.5 text-[22px] font-semibold tabular-nums">
            {money(total.billedCostUsd)}
          </div>
          <div className="text-[11.5px] text-[var(--color-ink-faint)]">
            {tokens(total.billedTokens)} token fatturati
          </div>
        </div>
        <div className="rounded-[11px] bg-[var(--color-panel-alt)] px-3.5 py-3">
          <div className="text-[11.5px] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
            Esecuzioni
          </div>
          <div className="mt-0.5 text-[22px] font-semibold tabular-nums">{total.runs}</div>
          {total.errorRuns > 0 && (
            <div className="text-[11.5px] text-[var(--color-error)]">
              {total.errorRuns} con errore
            </div>
          )}
        </div>
        <div className="rounded-[11px] bg-[var(--color-panel-alt)] px-3.5 py-3">
          <div className="text-[11.5px] font-medium tracking-wide text-[var(--color-ink-faint)] uppercase">
            Token
          </div>
          <div className="mt-0.5 text-[22px] font-semibold tabular-nums">
            {tokens(total.inputTokens + total.outputTokens)}
          </div>
          <div className="text-[11.5px] text-[var(--color-ink-faint)]">
            {tokens(total.inputTokens)} in · {tokens(total.outputTokens)} out
          </div>
        </div>
      </div>

      {/* quello che l'abbonamento copre: token veri, dollari solo come metro */}
      {total.subscriptionTokens > 0 && (
        <div className="flex items-start gap-2 rounded-[10px] bg-[color-mix(in_oklab,var(--color-honey)_9%,transparent)] px-3 py-2.5 text-[12.5px] text-[var(--color-ink-soft)]">
          <Info size={14} className="mt-px shrink-0 text-[var(--color-honey)]" />
          <div>
            Altri <strong>{tokens(total.subscriptionTokens)} token</strong> sono coperti
            dall'<strong>abbonamento</strong> e non compaiono qui sopra: il canone è fisso, quei
            token non li paghi a consumo.
            <span className="text-[var(--color-ink-faint)]">
              {' '}
              Se fossero fatturati a token costerebbero circa{' '}
              {money(total.subscriptionEquivalentUsd)}.
            </span>
          </div>
        </div>
      )}

      {/* andamento */}
      {dailySeries.some((d) => chartValue(d) > 0) && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink-soft)]">
            <TrendingUp size={14} strokeWidth={2.1} />{' '}
            {chartMode === 'billed'
              ? 'Trend of what you actually paid'
              : chartMode === 'subscription'
                ? 'Trend of subscription use, at list price'
                : 'Trend of runs'}
          </div>
          <div className="flex h-24 items-end gap-[3px]">
            {dailySeries.map((d) => (
              <div
                key={d.date}
                className="group relative flex-1"
                style={{ height: '100%' }}
                // Nel suggerimento ci sono entrambe le valute: la barra ne
                // mostra una sola, e senza l'altra il giorno sembra vuoto.
                title={`${d.date}: ${money(d.billedCostUsd)} paid · ${money(
                  d.subscriptionEquivalentUsd,
                )} on subscription · ${d.runs} runs`}
              >
                <div
                  className="absolute bottom-0 w-full rounded-t-[3px] bg-[var(--color-honey)] transition-all group-hover:bg-[var(--color-terracotta)]"
                  style={{ height: `${Math.max(2, (chartValue(d) / maxDay) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-[var(--color-ink-faint)]">
            <span>{dailySeries[0]?.date.slice(5)}</span>
            <span>today</span>
          </div>
        </div>
      )}

      {/* agenti che costano davvero */}
      {paidAgents.length > 0 && (
        <Section title="Quali agenti costano davvero" hint="fatturati a token">
          {paidAgents.map((a, i) => (
            <Bar
              key={a.agentId}
              label={
                <span>
                  {a.emoji} {a.name}
                </span>
              }
              sub={`${a.runs} run`}
              value={a.billedCostUsd}
              max={maxPaidAgent}
              color={AGENT_COLORS[i % AGENT_COLORS.length]!}
              right={money(a.billedCostUsd)}
            />
          ))}
        </Section>
      )}

      {/* agenti in abbonamento: si misurano in token */}
      {subAgents.length > 0 && (
        <Section title="Quali agenti consumano l'abbonamento" hint="nessun addebito">
          {subAgents.map((a) => (
            <Bar
              key={a.agentId}
              label={
                <span>
                  {a.emoji} {a.name}
                </span>
              }
              sub={`${a.runs} run`}
              value={a.inputTokens + a.outputTokens}
              max={maxSubAgent}
              color="#B9A88A"
              right={`${tokens(a.inputTokens + a.outputTokens)} tok`}
            />
          ))}
        </Section>
      )}

      {/* canali, solo dove c'è spesa vera */}
      {paidChannels.length > 0 && (
        <Section title="Quali chat costano davvero" hint="fatturate a token">
          {paidChannels.map((c) => (
            <Bar
              key={c.channelId}
              label={<span>#{c.name}</span>}
              sub={`${c.runs} run`}
              value={c.billedCostUsd}
              max={maxChannel}
              color="#4E7C6B"
              right={money(c.billedCostUsd)}
            />
          ))}
        </Section>
      )}

      {/* ripartizione per modello */}
      {report.byModel.length > 0 && (
        <Section title="Per modello">
          <div className="overflow-hidden rounded-[10px] border border-[var(--color-border)]">
            <table className="w-full text-[12.5px]">
              <thead className="bg-[var(--color-panel-alt)] text-[11.5px] text-[var(--color-ink-faint)]">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Modello</th>
                  <th className="px-3 py-1.5 text-right font-medium">Run</th>
                  <th className="px-3 py-1.5 text-right font-medium">Token</th>
                  <th className="px-3 py-1.5 text-right font-medium">Spesa</th>
                </tr>
              </thead>
              <tbody>
                {report.byModel.map((m) => (
                  <tr key={`${m.runtime}:${m.model}`} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-1.5">
                      <span className="truncate">{m.model}</span>
                      {m.subscription && (
                        <span className="ml-1.5 text-[11px] text-[var(--color-ink-faint)]">
                          abbonamento
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-ink-soft)]">
                      {m.runs}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-ink-soft)]">
                      {tokens(m.tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {m.subscription ? (
                        <span className="text-[var(--color-ink-faint)]">—</span>
                      ) : (
                        money(m.billedCostUsd)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
