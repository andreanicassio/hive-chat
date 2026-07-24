import { sql as raw } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * Aggregazioni di consumo per un workspace.
 *
 * Ogni run salva i token più il costo che l'harness gli attribuisce, e se è
 * passato da un abbonamento o da una chiave a consumo.
 *
 * **I due numeri non si sommano.** Un run in abbonamento riporta un costo
 * "equivalente a listino": quanto sarebbe costato pagandolo a token. Non è un
 * addebito — l'abbonamento è a canone fisso. Un run a consumo (OpenRouter, o
 * Claude con una API key) riporta invece spesa vera. Qui li teniamo in due
 * colonne separate per tutta la lunghezza del report, così la UI non deve
 * ricostruire la distinzione e nessuno somma dollari veri con dollari finti.
 *
 * Per i run precedenti alla colonna `uses_subscription` ripieghiamo sul
 * criterio vecchio (runtime `claude-code` = abbonamento): è ciò che era vero
 * quando sono stati registrati.
 */

const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** Predicato "questo run è andato sull'abbonamento", con fallback storico. */
const IS_SUB = raw`coalesce(r.uses_subscription, a.runtime = 'claude-code')`;

export interface UsageReport {
  periodDays: number;
  total: {
    /** Spesa reale: solo i run fatturati a token. È il numero che paghi. */
    billedCostUsd: number;
    /** Quanto costerebbero a listino i run in abbonamento. Non lo paghi. */
    subscriptionEquivalentUsd: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    /** Token dei run a consumo e di quelli in abbonamento, separati. */
    billedTokens: number;
    subscriptionTokens: number;
    errorRuns: number;
  };
  byAgent: Array<{
    agentId: string;
    name: string;
    emoji: string;
    color: string;
    model: string;
    runtime: string;
    billedCostUsd: number;
    subscriptionEquivalentUsd: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byChannel: Array<{
    channelId: string;
    name: string;
    billedCostUsd: number;
    subscriptionEquivalentUsd: number;
    tokens: number;
    runs: number;
  }>;
  byModel: Array<{
    model: string;
    runtime: string;
    /** Tutti i run del periodo su questo modello sono passati da abbonamento. */
    subscription: boolean;
    billedCostUsd: number;
    subscriptionEquivalentUsd: number;
    runs: number;
    tokens: number;
  }>;
  daily: Array<{
    date: string;
    billedCostUsd: number;
    subscriptionEquivalentUsd: number;
    runs: number;
  }>;
}

export async function usageReport(workspaceId: string, days: number): Promise<UsageReport> {
  // Stringa ISO invece di Date: in un template SQL grezzo postgres.js non sa
  // che tipo associare a un oggetto Date e fallisce il bind. La castiamo lato SQL.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Le somme separate per valuta si scrivono sempre uguale: il costo va nella
  // colonna "abbonamento" o in quella "a consumo" a seconda del predicato.
  const billed = raw`coalesce(sum(r.cost_usd) filter (where not ${IS_SUB}), 0)`;
  const subEquiv = raw`coalesce(sum(r.cost_usd) filter (where ${IS_SUB}), 0)`;
  const tokens = raw`coalesce(sum(r.input_tokens), 0) + coalesce(sum(r.output_tokens), 0)`;

  const [totalRows, agentRows, channelRows, modelRows, dailyRows] = await Promise.all([
    db.execute<{
      billed: string;
      sub_equiv: string;
      runs: number;
      in_tok: string;
      out_tok: string;
      billed_tok: string;
      sub_tok: string;
      errors: number;
    }>(raw`
      select
        ${billed} as billed,
        ${subEquiv} as sub_equiv,
        count(*) filter (where r.status = 'done') as runs,
        coalesce(sum(r.input_tokens), 0) as in_tok,
        coalesce(sum(r.output_tokens), 0) as out_tok,
        coalesce(sum(coalesce(r.input_tokens, 0) + coalesce(r.output_tokens, 0))
          filter (where not ${IS_SUB}), 0) as billed_tok,
        coalesce(sum(coalesce(r.input_tokens, 0) + coalesce(r.output_tokens, 0))
          filter (where ${IS_SUB}), 0) as sub_tok,
        count(*) filter (where r.status = 'error') as errors
      from agent_runs r
      join agents a on a.id = r.agent_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
    `),

    db.execute<{
      agent_id: string;
      name: string;
      emoji: string;
      color: string;
      model: string;
      runtime: string;
      billed: string;
      sub_equiv: string;
      runs: number;
      in_tok: string;
      out_tok: string;
    }>(raw`
      select
        a.id as agent_id, a.name, a.avatar_emoji as emoji, a.avatar_color as color,
        a.model, a.runtime,
        ${billed} as billed,
        ${subEquiv} as sub_equiv,
        count(r.id) filter (where r.status = 'done') as runs,
        coalesce(sum(r.input_tokens), 0) as in_tok,
        coalesce(sum(r.output_tokens), 0) as out_tok
      from agent_runs r
      join agents a on a.id = r.agent_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by a.id
      order by billed desc, sub_equiv desc
    `),

    db.execute<{
      channel_id: string;
      name: string;
      billed: string;
      sub_equiv: string;
      tokens: string;
      runs: number;
    }>(raw`
      select
        c.id as channel_id, c.name,
        ${billed} as billed,
        ${subEquiv} as sub_equiv,
        ${tokens} as tokens,
        count(r.id) filter (where r.status = 'done') as runs
      from agent_runs r
      join agents a on a.id = r.agent_id
      join channels c on c.id = r.channel_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by c.id
      order by billed desc, sub_equiv desc
    `),

    db.execute<{
      model: string;
      runtime: string;
      subscription: boolean;
      billed: string;
      sub_equiv: string;
      runs: number;
      tokens: string;
    }>(raw`
      select
        a.model, a.runtime,
        bool_and(${IS_SUB}) as subscription,
        ${billed} as billed,
        ${subEquiv} as sub_equiv,
        count(r.id) filter (where r.status = 'done') as runs,
        ${tokens} as tokens
      from agent_runs r
      join agents a on a.id = r.agent_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by a.model, a.runtime
      order by billed desc, tokens desc
    `),

    db.execute<{ day: string; billed: string; sub_equiv: string; runs: number }>(raw`
      select
        to_char(date_trunc('day', r.queued_at), 'YYYY-MM-DD') as day,
        ${billed} as billed,
        ${subEquiv} as sub_equiv,
        count(*) filter (where r.status = 'done') as runs
      from agent_runs r
      join agents a on a.id = r.agent_id
      where r.workspace_id = ${workspaceId} and r.queued_at >= ${since}::timestamptz
      group by day
      order by day
    `),
  ]);

  const t = totalRows[0];

  return {
    periodDays: days,
    total: {
      billedCostUsd: n(t?.billed),
      subscriptionEquivalentUsd: n(t?.sub_equiv),
      runs: n(t?.runs),
      inputTokens: n(t?.in_tok),
      outputTokens: n(t?.out_tok),
      billedTokens: n(t?.billed_tok),
      subscriptionTokens: n(t?.sub_tok),
      errorRuns: n(t?.errors),
    },
    byAgent: agentRows.map((r) => ({
      agentId: r.agent_id,
      name: r.name,
      emoji: r.emoji,
      color: r.color,
      model: r.model,
      runtime: r.runtime,
      billedCostUsd: n(r.billed),
      subscriptionEquivalentUsd: n(r.sub_equiv),
      runs: n(r.runs),
      inputTokens: n(r.in_tok),
      outputTokens: n(r.out_tok),
    })),
    byChannel: channelRows.map((r) => ({
      channelId: r.channel_id,
      name: r.name,
      billedCostUsd: n(r.billed),
      subscriptionEquivalentUsd: n(r.sub_equiv),
      tokens: n(r.tokens),
      runs: n(r.runs),
    })),
    byModel: modelRows.map((r) => ({
      model: r.model,
      runtime: r.runtime,
      subscription: Boolean(r.subscription),
      billedCostUsd: n(r.billed),
      subscriptionEquivalentUsd: n(r.sub_equiv),
      runs: n(r.runs),
      tokens: n(r.tokens),
    })),
    daily: dailyRows.map((r) => ({
      date: r.day,
      billedCostUsd: n(r.billed),
      subscriptionEquivalentUsd: n(r.sub_equiv),
      runs: n(r.runs),
    })),
  };
}
