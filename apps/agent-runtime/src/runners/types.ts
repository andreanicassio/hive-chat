import type { RunEmitter } from '../emitter.js';
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
  emitter: RunEmitter;
  runId: string;
  workspaceId: string;
  channelId: string;
  /** Directory di lavoro: repo del progetto per gli sviluppatori, scratch per gli altri. */
  workDir: string;
  /** Sessione precedente da riprendere, per la continuità del filo nel canale. */
  resumeSessionId: string | null;
  /** Segnalato quando l'utente annulla il run. */
  signal: AbortSignal;
}

export interface RunnerResult {
  finalText: string;
  numTurns: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sessionId: string | null;
  /** Handle degli agenti a cui passare la palla, estratti dalla risposta. */
  handoffs: string[];
}

export interface Runner {
  readonly id: string;
  run(input: RunnerInput): Promise<RunnerResult>;
}
