import { and, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/**
 * Tetto di spesa mensile per progetto.
 *
 * Ogni turno di un agente costa: senza un limite, una persona può avviarne
 * centinaia in un minuto e la bolletta se ne accorge dopo. Qui controlliamo
 * PRIMA di far partire un turno, non dopo.
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

  const spent = await db
    .select({ total: sql<string>`coalesce(sum(${schema.agentRuns.costUsd}), 0)` })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.workspaceId, workspaceId),
        gte(schema.agentRuns.queuedAt, startOfMonth()),
      ),
    );
  const spentUsd = Number(spent[0]?.total ?? 0);

  return {
    limitUsd,
    spentUsd,
    exceeded: limitUsd !== null && spentUsd >= limitUsd,
  };
}
