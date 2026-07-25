import { z } from 'zod';
import type {
  Agent,
  AgentStatus,
  Approval,
  Artifact,
  DocumentNode,
  Channel,
  Message,
  PushPayload,
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
  /**
   * Il canale che questa scheda ha davvero davanti agli occhi, `null` quando
   * la finestra è nascosta o non c'è nessun canale aperto.
   *
   * Non basta `subscribe` per saperlo: il client si iscrive a TUTTI i canali
   * della sidebar per tenere aggiornati i contatori. Serve un segnale
   * distinto, altrimenti risulterebbe che stai guardando ovunque — e le
   * notifiche push non partirebbero mai.
   */
  z.object({ t: z.literal('focus'), channelId: z.uuid().nullable() }),
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
  /*
   * `purged`: il messaggio va tolto dall'elenco, non sostituito da «messaggio
   * eliminato». Serve alla bolla di un agente fermato prima che dicesse una
   * parola: non c'è niente da commemorare, quel turno non è mai esistito.
   */
  | { t: 'message.deleted'; channelId: string; messageId: string; purged?: boolean }
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
  | { t: 'channel.deleted'; channelId: string }
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
      /**
       * Il messaggio che ha fatto partire il turno. Serve al client per
       * sapere, prima di cancellarlo, che cancellandolo ferma anche l'agente.
       */
      triggerMessageId: string | null;
      /** Modello ed effort con cui il turno è partito, per mostrarli dal vivo. */
      model: string | null;
      effort: string | null;
    }
  | { t: 'run.delta'; runId: string; messageId: string; text: string }
  | {
      t: 'run.event';
      runId: string;
      messageId: string;
      event: RunEvent;
      /**
       * Quando è successo davvero, in millisecondi epoch.
       * Il runner locale accumula gli eventi e li manda a lotti ogni mezzo
       * secondo: senza questo, inizio e fine di un'operazione veloce arrivano
       * insieme e ogni durata risulta «0,00 s».
       */
      at: number;
    }
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
  | { t: 'document.deleted'; workspaceId: string; documentId: string }
  /*
   * Una notifica consegnata sul filo, non via push.
   *
   * Serve all'app Mac: il suo motore web non ha le push (né PushManager né
   * Notification), quindi lì l'unico modo di avvisare è dirglielo mentre è
   * connessa e lasciare che sia il guscio a mostrare la notifica di sistema.
   * Chi ha le push la ignora, altrimenti riceverebbe tutto due volte.
   */
  | { t: 'notify'; payload: PushPayload }
  /*
   * Il messaggio è entrato nel turno che l'agente sta già facendo, invece di
   * aprirne uno nuovo. Senza questo segnale in chat non si vedrebbe niente —
   * nessuna bolla nuova, nessuna riga in coda — e sembrerebbe ignorato.
   */
  | {
      t: 'steer.delivered';
      channelId: string;
      messageId: string;
      runId: string;
      agentId: string;
      /**
       * `pending`: consegnato al turno, che però non l'ha ancora ritirato —
       * sul runner locale può passare qualche secondo.
       * `reading`: il turno ce l'ha in mano davvero.
       * `done`: il turno è finito, il segnale si spegne.
       *
       * Erano tutti «sta leggendo» fin dal primo istante, il che era una
       * bugia all'inizio e restava a schermo per sempre alla fine.
       */
      state: 'pending' | 'reading' | 'done';
    };

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
  /**
   * Coda generica: i turni di agenti che non hanno scelto una macchina.
   * È legata anche al PROGETTO, altrimenti un runner installato per un
   * progetto potrebbe prendere lavoro di un altro e girare nella cartella
   * sbagliata.
   */
  runnerQueue: (userId: string, workspaceId: string) =>
    `hive:runs:runner:${userId}:${workspaceId}`,
  /** Coda di UNA macchina precisa: usata quando l'agente sceglie il runner. */
  runnerQueueById: (tokenId: string) => `hive:runs:runner:t:${tokenId}`,
  /** Presenza di UNA macchina precisa. */
  runnerPresenceById: (tokenId: string) => `hive:runner:t:${tokenId}`,
  /**
   * Presenza del runner di un utente: chiave con TTL che il runner rinnova a
   * intervalli. Se manca, il runner è considerato offline.
   */
  runnerPresence: (userId: string, workspaceId: string) =>
    `hive:runner:${userId}:${workspaceId}`,
  /**
   * Comandi "fuori turno" per il runner di un utente: servono a leggere e
   * scrivere file sulla sua macchina (es. il CLAUDE.md del progetto) senza
   * far partire un turno dell'agente. Il runner fa poll su questa lista.
   */
  runnerCommands: (userId: string) => `hive:runner:cmd:${userId}`,
  /** Comandi per UNA macchina precisa. */
  runnerCommandsById: (tokenId: string) => `hive:runner:cmd:t:${tokenId}`,
  /** Risultato di un comando, atteso dal server (chiave con TTL). */
  runnerCommandResult: (commandId: string) => `hive:runner:cmdres:${commandId}`,
  /**
   * Messaggi arrivati mentre l'agente stava già lavorando in quel canale:
   * restano qui e partono appena il turno in corso finisce, invece di far
   * partire un secondo turno in parallelo sulla stessa sessione.
   */
  pendingPrompts: (agentId: string, channelId: string) =>
    `hive:pending:${agentId}:${channelId}`,
  /**
   * Segnale «questo agente ha finito qui»: lo pubblica chi esegue il turno.
   * Serve a far ripartire i messaggi in coda SEMPRE, anche quando nessuno
   * è collegato in quel momento (il fanout dei client è sottoscritto solo
   * su richiesta, questo canale no).
   */
  runFinished: 'hive:runs:finished',
  /**
   * Messaggi iniettati DENTRO un turno già in corso ("steering"): l'agente li
   * legge subito e decide se cambiare rotta, come quando scrivi mentre Claude
   * Code sta lavorando nel terminale.
   */
  steer: (runId: string) => `hive:steer:${runId}`,
  /**
   * Marcatore con TTL: presente finché quel turno è in grado di ricevere
   * messaggi a caldo. Se manca, il messaggio va nella coda normale.
   */
  steerable: (runId: string) => `hive:steerable:${runId}`,
  /**
   * I testi in attesa di essere iniettati nel turno.
   *
   * La lista esiste perché il pub/sub non basta: raggiunge solo chi è
   * connesso a Redis, e il runner locale gira sulla macchina di chi lo ha
   * installato, che Redis non ce l'ha. Lì il testo se lo porta indietro il
   * viaggio che il runner fa già ogni pochi secondi per sapere se l'hai
   * fermato. Il canale `steer` resta come campanello per chi invece Redis
   * lo vede.
   */
  steerQueue: (runId: string) => `hive:steer:q:${runId}`,
  /** Richieste di annullamento run. */
  runCancel: (runId: string) => `hive:runs:cancel:${runId}`,
  /**
   * Bandierina con TTL: «questo run è stato annullato».
   *
   * `runCancel` è pub/sub, quindi arriva solo a chi è già in ascolto — cioè al
   * worker del server, e solo dopo che ha preso il job. Il runner locale non
   * vede Redis e un job ancora in coda non ha nessuno in ascolto: per loro
   * serve qualcosa che resti lì finché non lo si legge.
   */
  runCancelled: (runId: string) => `hive:runs:cancelled:${runId}`,
  /** Risposta a una richiesta di approvazione, attesa dal worker. */
  approvalReply: (approvalId: string) => `hive:approval:${approvalId}`,
  /**
   * Richieste di notifica push che nascono FUORI dal processo API (il worker
   * degli agenti). Solo l'API ha le socket dei client, quindi solo lì si sa
   * chi sta già guardando e non va disturbato: il worker si limita a dire
   * «è successo questo», il resto lo decide chi ascolta.
   */
  notify: 'hive:notify',
  /**
   * Guardia con TTL: una richiesta di notifica la serve un nodo API solo,
   * anche se sono tutti iscritti a `notify`.
   */
  notifyOnce: (key: string) => `hive:notify:once:${key}`,
  /**
   * Contatore per raggruppare le notifiche push: più eventi con lo stesso tag
   * entro pochi secondi diventano una notifica sola («3 nuovi messaggi in …»).
   */
  pushGroup: (userId: string, tag: string) => `hive:push:g:${userId}:${tag}`,
} as const;

/** Richiesta di notifica push da un processo che non è l'API. */
export const notifyRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), approvalId: z.uuid() }),
  z.object({ kind: z.literal('run-finished'), runId: z.uuid() }),
]);
export type NotifyRequest = z.infer<typeof notifyRequestSchema>;

/**
 * Finestra di raggruppamento delle notifiche push, in secondi.
 * Abbastanza larga da fondere una raffica di messaggi, abbastanza stretta da
 * non nascondere una notizia arrivata dopo.
 */
export const PUSH_GROUP_WINDOW_SEC = 30;

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
  /**
   * Thread in cui si svolge il turno: la risposta va lì e il contesto è quello
   * del thread. `null` quando il turno vive nel canale.
   * Ha un default perché i job già in coda al momento dell'aggiornamento non
   * hanno il campo, e non devono far fallire il parse.
   */
  threadRootId: z.uuid().nullable().default(null),
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
