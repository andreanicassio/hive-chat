import { eq, sql as raw } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/**
 * Tetto di spesa mensile per progetto.
 *
 * Ogni turno di un agente costa: senza un limite, una persona può avviarne
 * centinaia in un minuto e la bolletta se ne accorge dopo. Qui controlliamo
 * PRIMA di far partire un turno, non dopo.
 *
 * **Conta solo i run fatturati a token.** Un run in abbonamento riporta comunque
 * un `cost_usd`, ma è un equivalente a listino: non lo paghi. Sommarlo qui
 * bloccherebbe gli agenti al raggiungimento di una cifra mai spesa — che è
 * esattamente il contrario di quello che serve a un tetto di spesa.
 */

export interface BudgetState {
  /** Tetto impostato, in dollari. Null = nessun limite. */
  limitUsd: number | null;
  /** Speso dall'inizio del mese corrente. */
  spentUsd: number;
  /** Vero se il tetto è stato raggiunto. */
  exceeded: boolean;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function budgetState(workspaceId: string): Promise<BudgetState> {
  const ws = await db
    .select({ limit: schema.workspaces.monthlyBudgetUsd })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const limitUsd = ws[0]?.limit != null ? Number(ws[0].limit) : null;

  // Il join su agents serve solo al fallback per i run precedenti alla colonna
  // `uses_subscription`: per quelli vale il criterio di allora (runtime
  // `claude-code` = abbonamento). Stesso predicato di services/usage.ts.
  const spent = await db.execute<{ total: string }>(raw`
    select coalesce(sum(r.cost_usd) filter (
      where not coalesce(r.uses_subscription, a.runtime = 'claude-code')
    ), 0) as total
    from agent_runs r
    join agents a on a.id = r.agent_id
    where r.workspace_id = ${workspaceId}
      and r.queued_at >= ${startOfMonth().toISOString()}::timestamptz
  `);
  const spentUsd = Number(spent[0]?.total ?? 0);

  return {
    limitUsd,
    spentUsd,
    exceeded: limitUsd !== null && spentUsd >= limitUsd,
  };
}
