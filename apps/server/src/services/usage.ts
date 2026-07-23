import { sql as raw } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * Aggregazioni di costo e consumo per un workspace.
 *
 * Ogni run salva il costo reale riportato dall'harness (l'SDK per i modelli
 * Claude, il campo usage.cost per OpenRouter) più i token. Qui li sommiamo
 * lungo tre assi — agente, canale, modello — più l'andamento giornaliero.
 *
 * Nota onesta sui costi: i modelli Claude che girano sull'abbonamento
 * riportano un costo "equivalente a consumo" (quanto costerebbero a listino),
 * non un addebito reale. I modelli via OpenRouter sono invece pay-per-use
 * effettivo. La UI lo distingue per non dare numeri fuorvianti.
 */

const n = (v: unknown): number => (v == null ? 0 : Number(v));

export interface UsageReport {
  periodDays: number;
  total: {
    costUsd: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    errorRuns: number;
  };
  /** Split fra costo su abbonamento (teorico) e a consumo reale. */
  subscriptionCostUsd: number;
  payPerUseCostUsd: number;
  byAgent: Array<{
    agentId: string;
    name: string;
    emoji: string;
    color: string;
    model: string;
    runtime: string;
    costUsd: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byChannel: Array<{
    channelId: string;
    name: string;
    costUsd: number;
    runs: number;
  }>;
  byModel: Array<{
    model: string;
    runtime: string;
    costUsd: number;
    runs: number;
    tokens: number;
  }>;
  daily: Array<{ date: string; costUsd: number; runs: number }>;
}

export async function usageReport(workspaceId: string, days: number): Promise<UsageReport> {
  // Stringa ISO invece di Date: in un template SQL grezzo postgres.js non sa
  // che tipo associare a un oggetto Date e fallisce il bind. La castiamo lato SQL.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [totalRows, agentRows, channelRows, modelRows, dailyRows] = await Promise.all([
    db.execute<{
      cost: string;
      runs: number;
      in_tok: string;
      out_tok: string;
      errors: number;
    }>(raw`
      select
        coalesce(sum(cost_usd), 0) as cost,
        count(*) filter (where status = 'done') as runs,
        coalesce(sum(input_tokens), 0) as in_tok,
        coalesce(sum(output_tokens), 0) as out_tok,
        count(*) filter (where status = 'error') as errors
      from agent_runs
      where workspace_id = ${workspaceId} and queued_at >= ${since}::timestamptz
    `),

    db.execute<{
      agent_id: string;
      name: string;
      emoji: string;
      color: string;
      model: string;
      runtime: string;
      cost: string;
      runs: number;
      in_tok: string;
      out_tok: string;
    }>(raw`
      select
        a.id as agent_id, a.name, a.avatar_emoji as emoji, a.avatar_color as color,
        a.model, a.runtime,
        coalesce(sum(r.cost_usd), 0) as cost,
        count(r.id) filter (where r.status = 'done') as runs,
        coalesce(sum(r.input_tokens), 0) as in_tok,
        coalesce(sum(r.output_tokens), 0) as out_tok
      from agent_runs r
      join agents a on a.id = r.agent_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by a.id
      order by cost desc
    `),

    db.execute<{ channel_id: string; name: string; cost: string; runs: number }>(raw`
      select
        c.id as channel_id, c.name,
        coalesce(sum(r.cost_usd), 0) as cost,
        count(r.id) filter (where r.status = 'done') as runs
      from agent_runs r
      join channels c on c.id = r.channel_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by c.id
      order by cost desc
    `),

    db.execute<{ model: string; runtime: string; cost: string; runs: number; tokens: string }>(raw`
      select
        a.model, a.runtime,
        coalesce(sum(r.cost_usd), 0) as cost,
        count(r.id) filter (where r.status = 'done') as runs,
        coalesce(sum(r.input_tokens) + sum(r.output_tokens), 0) as tokens
      from agent_runs r
      join agents a on a.id = r.agent_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by a.model, a.runtime
      order by cost desc
    `),

    db.execute<{ day: string; cost: string; runs: number }>(raw`
      select
        to_char(date_trunc('day', queued_at), 'YYYY-MM-DD') as day,
        coalesce(sum(cost_usd), 0) as cost,
        count(*) filter (where status = 'done') as runs
      from agent_runs
      where workspace_id = ${workspaceId} and queued_at >= ${since}::timestamptz
      group by day
      order by day
    `),
  ]);

  const t = totalRows[0];

  // Costo su abbonamento (claude-code) vs a consumo (tutto il resto).
  let subscriptionCost = 0;
  let payPerUse = 0;
  for (const m of modelRows) {
    if (m.runtime === 'claude-code') subscriptionCost += n(m.cost);
    else payPerUse += n(m.cost);
  }

  return {
    periodDays: days,
    total: {
      costUsd: n(t?.cost),
      runs: n(t?.runs),
      inputTokens: n(t?.in_tok),
      outputTokens: n(t?.out_tok),
      errorRuns: n(t?.errors),
    },
    subscriptionCostUsd: subscriptionCost,
    payPerUseCostUsd: payPerUse,
    byAgent: agentRows.map((r) => ({
      agentId: r.agent_id,
      name: r.name,
      emoji: r.emoji,
      color: r.color,
      model: r.model,
      runtime: r.runtime,
      costUsd: n(r.cost),
      runs: n(r.runs),
      inputTokens: n(r.in_tok),
      outputTokens: n(r.out_tok),
    })),
    byChannel: channelRows.map((r) => ({
      channelId: r.channel_id,
      name: r.name,
      costUsd: n(r.cost),
      runs: n(r.runs),
    })),
    byModel: modelRows.map((r) => ({
      model: r.model,
      runtime: r.runtime,
      costUsd: n(r.cost),
      runs: n(r.runs),
      tokens: n(r.tokens),
    })),
    daily: dailyRows.map((r) => ({ date: r.day, costUsd: n(r.cost), runs: n(r.runs) })),
  };
}
