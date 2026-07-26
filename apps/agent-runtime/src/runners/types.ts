import type { EmitterLike } from '../emitter.js';
import type { AgentContext } from '../context.js';
import type { schema } from '@hive/db';

/**
 * Interfaccia comune dei runtime di esecuzione.
 *
 * Ogni harness (Claude Code, loop OpenRouter, in futuro OpenCode) implementa
 * questa firma e produce lo stesso stream di eventi normalizzati. È il punto
 * in cui si aggancia un nuovo harness senza toccare né la chat né la UI.
 */

export type AgentRow = typeof schema.agents.$inferSelect;

export interface RunnerInput {
  agent: AgentRow;
  context: AgentContext;
  emitter: EmitterLike;
  runId: string;
  workspaceId: string;
  /** Chi ha chiesto il turno: decide con quali credenziali gira. */
  triggeredByUserId?: string | null;
  channelId: string;
  /** Directory di lavoro: repo del progetto per gli sviluppatori, scratch per gli altri. */
  workDir: string;
  /** Sessione precedente da riprendere, per la continuità del filo nel canale. */
  resumeSessionId: string | null;
  /** Segnalato quando l'utente annulla il run. */
  signal: AbortSignal;
  /**
   * Runner locale (HTTP): niente server MCP hive (che richiede il DB) e auth
   * dalle credenziali locali invece che dai segreti del workspace.
   */
  disableHiveTools?: boolean;
  authEnvOverride?: Record<string, string>;
}

export interface RunnerResult {
  finalText: string;
  numTurns: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Il turno è girato su un abbonamento? Serve alla pagina Utilizzo per
   * mostrare in euro solo quello che paghi davvero, a token.
   */
  usesSubscription: boolean;
  sessionId: string | null;
  /** Handle degli agenti a cui passare la palla, estratti dalla risposta. */
  handoffs: string[];
}

export interface Runner {
  readonly id: string;
  run(input: RunnerInput): Promise<RunnerResult>;
}
