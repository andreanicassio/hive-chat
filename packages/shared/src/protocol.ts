import { z } from 'zod';
import type {
  Agent,
  AgentStatus,
  Approval,
  Artifact,
  DocumentNode,
  Channel,
  Message,
  Reaction,
  RunEvent,
  RunStatus,
} from './domain.js';

/**
 * Protocollo WebSocket.
 *
 * Il client apre una sola socket per workspace. Il server pubblica tutto
 * su Redis; ogni nodo API inoltra ai propri client sottoscritti.
 *
 * Regola: i messaggi sono piccoli. Lo streaming di testo di un agente passa
 * per `run.delta`, che porta solo il pezzo nuovo — non il testo intero.
 */

/* ------------------------------- Client → Server ------------------------- */

export const clientPacketSchema = z.discriminatedUnion('t', [
  /** Entra nel workspace: il server manda lo stato iniziale. */
  z.object({ t: z.literal('hello'), workspaceId: z.uuid() }),
  /** Segue gli eventi di questi canali (quello aperto + quelli in sidebar). */
  z.object({ t: z.literal('subscribe'), channelIds: z.array(z.uuid()).max(200) }),
  z.object({ t: z.literal('unsubscribe'), channelIds: z.array(z.uuid()).max(200) }),
  /** Sta scrivendo. Il server fa da rate-limit e rimbalza agli altri. */
  z.object({ t: z.literal('typing'), channelId: z.uuid() }),
  /** Segna il canale come letto fino a questo messaggio. */
  z.object({
    t: z.literal('read'),
    channelId: z.uuid(),
    messageId: z.uuid(),
  }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientPacket = z.infer<typeof clientPacketSchema>;

/* ------------------------------- Server → Client ------------------------- */

export type ServerPacket =
  | { t: 'ready'; userId: string; workspaceId: string; serverTime: string }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string }

  /* --- messaggi --- */
  | { t: 'message.new'; message: Message }
  | { t: 'message.updated'; message: Message }
  | { t: 'message.deleted'; channelId: string; messageId: string }
  | {
      t: 'reaction.changed';
      channelId: string;
      messageId: string;
      reactions: Reaction[];
    }

  /* --- presenza --- */
  | { t: 'typing'; channelId: string; actorId: string; name: string }
  | { t: 'presence'; userId: string; online: boolean }

  /* --- canali e agenti --- */
  | { t: 'channel.created'; channel: Channel }
  | { t: 'channel.updated'; channel: Channel }
  | { t: 'agent.upserted'; agent: Agent }
  | {
      t: 'agent.status';
      agentId: string;
      status: AgentStatus;
      /** Testo mostrato nella barra di stato in basso, es. "Sto leggendo auth.ts". */
      label: string | null;
      channelId: string | null;
    }

  /* --- esecuzioni degli agenti --- */
  | {
      t: 'run.started';
      runId: string;
      agentId: string;
      channelId: string;
      /** Bolla-messaggio già creata e vuota, da riempire in streaming. */
      messageId: string;
    }
  | { t: 'run.delta'; runId: string; messageId: string; text: string }
  | { t: 'run.event'; runId: string; messageId: string; event: RunEvent }
  | {
      t: 'run.status';
      runId: string;
      messageId: string;
      status: RunStatus;
      error?: string | null;
      /** Posizione in coda quando status = queued. */
      queuePosition?: number;
    }

  /* --- approvazioni umane --- */
  | { t: 'approval.requested'; approval: Approval }
  | { t: 'approval.resolved'; approval: Approval }

  /* --- artifacts (checklist e documenti accanto alla chat) --- */
  | { t: 'artifact.new'; artifact: Artifact }
  | { t: 'artifact.updated'; artifact: Artifact }
  | { t: 'artifact.deleted'; channelId: string; artifactId: string }

  /* --- documenti (base di conoscenza del progetto) --- */
  | { t: 'document.changed'; workspaceId: string; document: DocumentNode }
  | { t: 'document.deleted'; workspaceId: string; documentId: string };

/* --------------------------------- Canali Redis -------------------------- */

export const redisChannels = {
  /** Fanout di tutti gli eventi di un workspace verso i nodi API. */
  workspace: (workspaceId: string) => `hive:ws:${workspaceId}`,
  /** Coda dei run eseguiti sul server, consumata dal worker del server. */
  runQueue: 'hive:runs:queue',
  /**
   * Coda dei run affidati al runner locale di un utente (esecuzione sul suo
   * computer). Il runner fa BRPOP su questa chiave.
   */
  runnerQueue: (userId: string) => `hive:runs:runner:${userId}`,
  /**
   * Presenza del runner di un utente: chiave con TTL che il runner rinnova a
   * intervalli. Se manca, il runner è considerato offline.
   */
  runnerPresence: (userId: string) => `hive:runner:${userId}`,
  /**
   * Comandi "fuori turno" per il runner di un utente: servono a leggere e
   * scrivere file sulla sua macchina (es. il CLAUDE.md del progetto) senza
   * far partire un turno dell'agente. Il runner fa poll su questa lista.
   */
  runnerCommands: (userId: string) => `hive:runner:cmd:${userId}`,
  /** Risultato di un comando, atteso dal server (chiave con TTL). */
  runnerCommandResult: (commandId: string) => `hive:runner:cmdres:${commandId}`,
  /** Richieste di annullamento run. */
  runCancel: (runId: string) => `hive:runs:cancel:${runId}`,
  /** Risposta a una richiesta di approvazione, attesa dal worker. */
  approvalReply: (approvalId: string) => `hive:approval:${approvalId}`,
} as const;

/** Secondi di validità della presenza del runner (rinnovata più spesso). */
export const RUNNER_PRESENCE_TTL_SEC = 30;

/** Payload messo in coda per far girare un agente. */
export const runJobSchema = z.object({
  runId: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  channelId: z.uuid(),
  triggerMessageId: z.uuid().nullable(),
  responseMessageId: z.uuid(),
  /** Il testo con cui è stato invocato l'agente. */
  prompt: z.string(),
  /** Handle dell'agente che ha fatto handoff, se questo run nasce da un passaggio. */
  fromAgentHandle: z.string().nullable().default(null),
  /** Profondità della catena di handoff, per fermare i loop tra agenti. */
  hop: z.number().int().min(0).max(8).default(0),
});
export type RunJob = z.infer<typeof runJobSchema>;

/** Risposta a un'approvazione, dal nodo API al worker che sta aspettando. */
export const approvalReplySchema = z.object({
  approvalId: z.uuid(),
  allowed: z.boolean(),
  reason: z.string().nullable().default(null),
  decidedBy: z.uuid().nullable(),
});
export type ApprovalReply = z.infer<typeof approvalReplySchema>;

/** Numero massimo di passaggi consecutivi tra agenti prima di fermarsi. */
export const MAX_HANDOFF_HOPS = 4;
