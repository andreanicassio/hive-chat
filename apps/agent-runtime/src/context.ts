import { buildAgentContext, type AgentContext } from '@hive/db';
import { db } from './db.js';

/**
 * Il contesto degli agenti è logica condivisa (vive in @hive/db, così la usa
 * anche il server per i job dei runner). Qui è solo il wrapper che gli passa
 * la connessione del runtime.
 */
export type { AgentContext };

export function buildContext(args: {
  workspaceId: string;
  channelId: string;
  agentId: string;
  triggerMessageId: string | null;
  rawPrompt: string;
  fromAgentHandle: string | null;
}): Promise<AgentContext> {
  return buildAgentContext(db, args);
}
