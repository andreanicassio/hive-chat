import { create } from 'zustand';
import type {
  Agent,
  AgentStatus,
  Approval,
  Artifact,
  Channel,
  ChannelGroup,
  CreateArtifactInput,
  DocumentNode,
  Message,
  PublicUser,
  PushPayload,
  RunEvent,
  RunStatus,
  UpdateArtifactInput,
  Workspace,
  WorkspaceRole,
} from '@hive/shared';
import { api, type BootstrapPayload } from './lib/api.js';
import { realtime } from './lib/ws.js';
import { nativeNotifyShow } from './lib/native-notify.js';

/**
 * Stato del client.
 *
 * Una nota sulla forma: i messaggi stanno in una mappa per canale, non in un
 * unico elenco. Quando un agente scrive in streaming arrivano decine di
 * eventi al secondo su un solo canale: tenerli separati evita di ricalcolare
 * l'intera chat a ogni token.
 */

/** Le due schede del pannello laterale del canale. */
export type AsideTab = 'activity' | 'thread';

/**
 * Un evento con l'ora a cui è successo. Il tempo non viaggia nei pacchetti
 * realtime, quindi dal vivo è l'ora di arrivo; ricaricando la pagina è quella
 * registrata dal server. In entrambi i casi basta a misurare quanto è durata
 * un'operazione, che è ciò che mostra la tab di lavoro.
 */
export interface TimedRunEvent {
  event: RunEvent;
  at: number;
}

export interface RunState {
  runId: string;
  agentId: string;
  /** Serve a mostrare nel pannello Attività solo i run del canale che guardi. */
  channelId: string | null;
  /** Il messaggio che ha innescato il turno: cancellarlo ferma anche questo run. */
  triggerMessageId: string | null;
  /** Con cosa sta girando DAVVERO: registrato alla partenza, non dedotto. */
  model: string | null;
  effort: string | null;
  status: RunStatus;
  /** Eventi in ordine: tool usati, ragionamento, errori. */
  events: TimedRunEvent[];
  /** Vero mentre il testo sta ancora arrivando. */
  streaming: boolean;
  error: string | null;
  /** Passaggi dichiarati dal server: c'è anche quando la traccia non è caricata. */
  numTurns: number;
  startedAt: number | null;
  endedAt: number | null;
  /**
   * La traccia completa è già stata chiesta al server? Per i run conclusi non
   * la carichiamo all'apertura del canale — sarebbero decine di tracce per
   * niente — ma solo quando qualcuno apre la tab di lavoro.
   */
  eventsLoaded: boolean;
}

interface Member extends Pick<PublicUser, 'id' | 'name' | 'handle' | 'avatarEmoji' | 'avatarColor'> {
  email?: string;
  role: WorkspaceRole;
  lastSeenAt: string | null;
}

interface State {
  /* --- sessione --- */
  user: PublicUser | null;
  workspaces: Workspace[];
  bootLoading: boolean;

  /* --- progetto corrente --- */
  workspace: Workspace | null;
  groups: ChannelGroup[];
  channels: Channel[];
  agents: Agent[];
  members: Member[];
  joinedChannelIds: Set<string>;
  capabilities: {
    anthropicConfigured: boolean;
    openrouterConfigured: boolean;
    /** Come si sta autenticando davvero, già in italiano. */
    claudeAuthLabel: string;
  };

  /* --- conversazione --- */
  activeChannelId: string | null;
  /** Messaggio a cui si sta rispondendo nel canale attivo. */
  replyingTo: Message | null;
  messagesByChannel: Map<string, Message[]>;
  loadingChannel: boolean;
  hasMoreByChannel: Map<string, boolean>;

  /* --- thread ---
     Le risposte di un thread NON stanno nell'elenco del canale: nel canale il
     thread è rappresentato solo dalla barra "N risposte" sotto la radice. */
  threadsByRoot: Map<string, Message[]>;
  /** Thread mostrato nel pannello laterale, se ce n'è uno. */
  openThreadRootId: string | null;
  /** Pannello laterale del canale: attività dell'agente e thread. */
  asideOpen: boolean;
  asideTab: AsideTab;

  /* --- artifacts (checklist e documenti accanto alla chat) --- */
  artifactsByChannel: Map<string, Artifact[]>;
  /** Pannello laterale aperto/chiuso, e quale artifact è a fuoco. */
  artifactPanelOpen: boolean;

  /* --- documenti (base di conoscenza del progetto) --- */
  documentsByWorkspace: Map<string, DocumentNode[]>;
  documentsPanelOpen: boolean;

  /* --- realtime --- */
  connected: boolean;
  typingByChannel: Map<string, Map<string, { name: string; at: number }>>;
  onlineUserIds: Set<string>;
  runs: Map<string, RunState>;
  /**
   * Messaggi consegnati a un turno GIÀ in corso invece che a uno nuovo.
   * Chiave: id del messaggio. Si porta dietro il turno, perché quando quel
   * turno finisce il segnale deve spegnersi — prima restava a schermo per
   * sempre, e spariva solo ricaricando la pagina.
   */
  steered: Map<string, { agentId: string; runId: string; reading: boolean }>;
  /** Stato volatile degli agenti, per la barra in basso. */
  agentActivity: Map<string, { status: AgentStatus; label: string | null }>;
  approvals: Approval[];

  /* --- azioni --- */
  loadSession: () => Promise<void>;
  openWorkspace: (workspaceId: string) => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (name: string, icon: string) => Promise<string>;
  openChannel: (channelId: string) => Promise<void>;
  hydrateRuns: (channelId: string, messages: Message[]) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (
    channelId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string | null,
  ) => Promise<void>;
  setReplyingTo: (message: Message | null) => void;
  /** Carica la traccia di un run: la chiediamo solo quando serve davvero. */
  loadRunEvents: (messageId: string) => Promise<void>;
  openThread: (rootId: string) => void;
  loadThread: (channelId: string, rootId: string) => Promise<void>;
  setAsideOpen: (open: boolean) => void;
  setAsideTab: (tab: AsideTab) => void;
  /** Riscrive l'ordine dei canali di un gruppo, subito e solo qui. */
  reorderLocally: (groupId: string | null, channelIds: string[]) => void;
  loadArtifacts: (channelId: string) => Promise<void>;
  createArtifact: (channelId: string, input: CreateArtifactInput) => Promise<Artifact | null>;
  updateArtifactRemote: (artifactId: string, patch: UpdateArtifactInput) => Promise<void>;
  deleteArtifact: (artifactId: string, channelId: string) => Promise<void>;
  setArtifactPanelOpen: (open: boolean) => void;
  resyncChannel: (channelId: string) => Promise<void>;
  loadDocuments: (workspaceId: string) => Promise<void>;
  setDocumentsPanelOpen: (open: boolean) => void;
  handlePacket: (packet: unknown) => void;
  reset: () => void;
}

/**
 * Identificatore casuale.
 *
 * `crypto.randomUUID()` esiste solo in contesto sicuro (HTTPS o localhost):
 * servendo l'app su http://<ip-lan> sarebbe `undefined` e ogni invio
 * andrebbe in eccezione. Ripieghiamo su getRandomValues, che c'è sempre.
 */
function randomId(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Inserisce o sostituisce un artifact, tenendo i più recenti in cima. */
function upsertArtifact(
  byChannel: Map<string, Artifact[]>,
  artifact: Artifact,
): { artifactsByChannel: Map<string, Artifact[]> } {
  const next = new Map(byChannel);
  const list = (next.get(artifact.channelId) ?? []).filter((a) => a.id !== artifact.id);
  list.push(artifact);
  list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  next.set(artifact.channelId, list);
  return { artifactsByChannel: next };
}

/** Inserisce o sostituisce un nodo documento nell'albero del workspace. */
function upsertDocument(
  byWorkspace: Map<string, DocumentNode[]>,
  workspaceId: string,
  doc: DocumentNode,
): { documentsByWorkspace: Map<string, DocumentNode[]> } {
  const next = new Map(byWorkspace);
  const list = (next.get(workspaceId) ?? []).filter((d) => d.id !== doc.id);
  list.push(doc);
  next.set(workspaceId, list);
  return { documentsByWorkspace: next };
}

/** Inserisce o sostituisce un messaggio mantenendo l'ordine cronologico. */
function upsertMessage(list: Message[], message: Message): Message[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index !== -1) {
    const next = list.slice();
    next[index] = message;
    return next;
  }
  // Quasi sempre il messaggio nuovo è il più recente: controlliamo la coda
  // prima di cercare la posizione con una scansione.
  const last = list[list.length - 1];
  if (!last || last.createdAt <= message.createdAt) return [...list, message];
  const at = list.findIndex((m) => m.createdAt > message.createdAt);
  return [...list.slice(0, at), message, ...list.slice(at)];
}

/**
 * Modifica un messaggio ovunque si trovi: nel canale o dentro un thread.
 *
 * Un agente attivato dentro un thread risponde nel thread, quindi la bolla che
 * si riempie in streaming può stare in una delle due mappe: cercare solo fra i
 * messaggi del canale lascerebbe quelle risposte mute.
 */
function patchMessage(
  s: State,
  messageId: string,
  patch: (m: Message) => Message,
): Partial<State> {
  for (const [channelId, list] of s.messagesByChannel) {
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) continue;
    const updated = list.slice();
    updated[idx] = patch(updated[idx]!);
    const next = new Map(s.messagesByChannel);
    next.set(channelId, updated);
    return { messagesByChannel: next };
  }
  for (const [rootId, list] of s.threadsByRoot) {
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) continue;
    const updated = list.slice();
    updated[idx] = patch(updated[idx]!);
    const next = new Map(s.threadsByRoot);
    next.set(rootId, updated);
    return { threadsByRoot: next };
  }
  return {};
}

/**
 * Mette un messaggio dove va: nel canale se è una radice, nel thread se è una
 * risposta.
 *
 * Il realtime trasmette tutto a chi è nel canale, thread compresi — non
 * esistono sottoscrizioni per thread. Senza questo smistamento le risposte
 * comparirebbero in mezzo al canale, mentre la lettura via REST le esclude:
 * due percorsi che raccontano cose diverse. Qui vince la regola del design —
 * nel canale un thread è solo la sua barra "N risposte".
 */
function absorbMessage(s: State, message: Message): Partial<State> {
  if (!message.threadRootId) {
    const next = new Map(s.messagesByChannel);
    const list = next.get(message.channelId);
    if (list) next.set(message.channelId, upsertMessage(list, message));
    return { messagesByChannel: next };
  }

  const rootId = message.threadRootId;
  const threads = new Map(s.threadsByRoot);
  const known = threads.get(rootId);
  // Se il thread non l'abbiamo mai aperto non lo popoliamo a metà: sarebbe
  // un elenco con dei buchi. Il conteggio sulla radice basta a mostrarlo.
  const wasKnown = known !== undefined;
  if (wasKnown) threads.set(rootId, upsertMessage(known, message));

  const channels = new Map(s.messagesByChannel);
  const list = channels.get(message.channelId);
  const idx = list ? list.findIndex((m) => m.id === rootId) : -1;
  if (list && idx !== -1) {
    const root = list[idx]!;
    // Solo per un messaggio nuovo: un `message.updated` di una risposta già
    // vista non deve far salire il conteggio una seconda volta.
    const isNew = !wasKnown || !known.some((m) => m.id === message.id);
    const updated = list.slice();
    const participants = root.threadParticipants.some(
      (p) => p.id === message.author.id && p.type === message.author.type,
    )
      ? root.threadParticipants
      : [...root.threadParticipants, message.author].slice(-4);
    updated[idx] = {
      ...root,
      replyCount: isNew ? root.replyCount + 1 : root.replyCount,
      threadLastReplyAt: message.createdAt,
      threadParticipants: participants,
    };
    channels.set(message.channelId, updated);
  }

  return { threadsByRoot: threads, messagesByChannel: channels };
}

export const useStore = create<State>((set, get) => ({
  user: null,
  workspaces: [],
  bootLoading: true,

  workspace: null,
  groups: [],
  channels: [],
  agents: [],
  members: [],
  joinedChannelIds: new Set(),
  capabilities: { anthropicConfigured: false, openrouterConfigured: false, claudeAuthLabel: '' },

  activeChannelId: null,
  replyingTo: null,
  messagesByChannel: new Map(),
  loadingChannel: false,
  hasMoreByChannel: new Map(),

  threadsByRoot: new Map(),
  openThreadRootId: null,
  asideOpen: false,
  asideTab: 'activity',

  artifactsByChannel: new Map(),
  artifactPanelOpen: false,
  documentsByWorkspace: new Map(),
  documentsPanelOpen: false,

  connected: false,
  typingByChannel: new Map(),
  onlineUserIds: new Set(),
  runs: new Map(),
  steered: new Map(),
  agentActivity: new Map(),
  approvals: [],

  async loadSession() {
    try {
      const { user, workspaces } = await api.me();
      set({ user, workspaces, bootLoading: false });
    } catch {
      set({ user: null, workspaces: [], bootLoading: false });
    }
  },

  async openWorkspace(workspaceId) {
    const data: BootstrapPayload = await api.bootstrap(workspaceId);
    set({
      workspace: data.workspace,
      groups: data.groups,
      channels: data.channels,
      agents: data.agents,
      members: data.members,
      joinedChannelIds: new Set(data.joinedChannelIds),
      capabilities: data.capabilities,
      messagesByChannel: new Map(),
      threadsByRoot: new Map(),
      openThreadRootId: null,
      asideOpen: false,
      asideTab: 'activity',
      artifactsByChannel: new Map(),
      artifactPanelOpen: false,
      documentsByWorkspace: new Map(),
      documentsPanelOpen: false,
      runs: new Map(),
    });

    realtime.onStatusChange = (connected) => {
      const wasConnected = get().connected;
      set({ connected });
      // Il realtime non ha replay: quello che è passato mentre eravamo
      // scollegati è perso. Alla riconnessione ricarichiamo il canale aperto,
      // altrimenti restano buchi invisibili nella conversazione.
      if (connected && !wasConnected) {
        const channelId = get().activeChannelId;
        if (channelId) void get().resyncChannel(channelId);
      }
    };
    realtime.connect(workspaceId);
    realtime.subscribe(data.channels.map((c) => c.id));

    void api
      .pendingApprovals(workspaceId)
      .then(({ approvals }) => set({ approvals }))
      .catch(() => {});
  },

  async switchWorkspace(workspaceId) {
    // Ricordiamo l'ultimo progetto aperto, così al reload si torna qui.
    try {
      localStorage.setItem('hive:lastWorkspace', workspaceId);
    } catch {
      /* localStorage non disponibile: pazienza */
    }
    set({ activeChannelId: null });
    await get().openWorkspace(workspaceId);
  },

  async createWorkspace(name, icon) {
    const { workspace } = await api.createWorkspace({ name, iconEmoji: icon });
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
    await get().switchWorkspace(workspace.id);
    return workspace.id;
  },

  async openChannel(channelId) {
    // Dove sei rimasto. Alla ricarica si riapre questo, non il primo canale
    // dell'elenco: tornare ogni volta su #generale vuol dire ricominciare da
    // capo la navigazione a ogni aggiornamento.
    const wsId = get().workspace?.id;
    if (wsId) {
      try {
        localStorage.setItem(`hive:lastChannel:${wsId}`, channelId);
      } catch {
        /* archiviazione bloccata: si riparte dal primo canale, come prima */
      }
    }

    // Il thread aperto appartiene al canale che si sta lasciando: portarselo
    // dietro mostrerebbe risposte di un'altra conversazione.
    set((s) => ({
      activeChannelId: channelId,
      loadingChannel: true,
      replyingTo: null,
      openThreadRootId: null,
      asideTab: s.asideTab === 'thread' ? 'activity' : s.asideTab,
    }));
    realtime.subscribe([channelId]);
    // Questo canale è quello che si sta guardando: niente notifiche per ciò
    // che è già sotto gli occhi.
    realtime.focus(channelId);
    // Gli artifact del canale li carichiamo dietro le quinte.
    void get().loadArtifacts(channelId);

    // Se abbiamo già la cronologia mostriamola subito e aggiorniamo dietro.
    const cached = get().messagesByChannel.get(channelId);
    if (cached && cached.length > 0) set({ loadingChannel: false });

    try {
      const { messages, hasMore } = await api.messages(channelId, { limit: 50 });
      set((s) => {
        const next = new Map(s.messagesByChannel);
        next.set(channelId, messages);
        const more = new Map(s.hasMoreByChannel);
        more.set(channelId, hasMore);
        return { messagesByChannel: next, hasMoreByChannel: more, loadingChannel: false };
      });

      // Ricostruisce lo stato delle esecuzioni: `runs` vive solo in memoria e
      // dopo un refresh è vuota. Senza questo, ricaricando mentre un agente
      // scrive si perde la sezione dei tool — e, peggio, gli eventi che
      // arrivano dopo vengono scartati, perché `run.event` aggiorna solo le
      // voci già presenti.
      void get().hydrateRuns(channelId, messages);

      const last = messages[messages.length - 1];
      if (last) {
        void api.markRead(channelId, last.id).catch(() => {});
        set((s) => ({
          channels: s.channels.map((c) =>
            c.id === channelId ? { ...c, unreadCount: 0, hasMention: false } : c,
          ),
        }));
      }
    } catch {
      set({ loadingChannel: false });
    }
  },

  /**
   * Rimette in piedi `runs` dopo un ricaricamento della pagina.
   *
   * Gli eventi completi li chiediamo solo per le esecuzioni ancora in corso —
   * di solito zero o una — perché sono le uniche che stanno scrivendo adesso e
   * le uniche per cui la sezione dei tool deve tornare viva. Per le altre basta
   * la voce nella mappa: senza, i pacchetti `run.event` che arrivano dopo
   * verrebbero buttati via, e la tab di lavoro chiusa mostra comunque passaggi
   * e durata, che vengono dall'elenco dei run. La traccia dettagliata di un
   * run concluso arriva quando qualcuno apre la tab (`loadRunEvents`).
   */
  async hydrateRuns(channelId, messages) {
    const byMessage = new Set(messages.map((m) => m.id));
    let runs: Awaited<ReturnType<typeof api.channelRuns>>['runs'];
    try {
      ({ runs } = await api.channelRuns(channelId));
    } catch {
      return;
    }

    const mine = runs.filter((r) => r.responseMessageId && byMessage.has(r.responseMessageId));
    if (mine.length === 0) return;

    set((s) => {
      const next = new Map(s.runs);
      for (const r of mine) {
        // Non calpestiamo una voce già viva: i suoi eventi sono più freschi.
        if (next.has(r.responseMessageId!)) continue;
        next.set(r.responseMessageId!, {
          runId: r.id,
          agentId: r.agentId,
          channelId,
          triggerMessageId: r.triggerMessageId,
          model: r.model,
          effort: r.effort,
          status: r.status,
          events: [],
          streaming: r.status === 'running',
          error: r.error,
          numTurns: r.numTurns,
          startedAt: r.startedAt ? new Date(r.startedAt).getTime() : null,
          endedAt: r.endedAt ? new Date(r.endedAt).getTime() : null,
          eventsLoaded: false,
        });
      }
      return { runs: next };
    });

    const active = mine.filter((r) => r.status === 'running' || r.status === 'queued');
    for (const r of active) {
      await get().loadRunEvents(r.responseMessageId!);
    }
  },

  /**
   * Scarica la traccia completa di un run e la mette nella mappa.
   *
   * Gli eventi arrivati dal vivo nel frattempo vincono: rimetterci sotto lo
   * storico li duplicherebbe.
   */
  async loadRunEvents(messageId) {
    const run = get().runs.get(messageId);
    if (!run || run.eventsLoaded) return;
    // Segniamo subito, altrimenti due aperture ravvicinate della tab fanno
    // due richieste per la stessa traccia.
    set((s) => {
      const next = new Map(s.runs);
      const cur = next.get(messageId);
      if (cur) next.set(messageId, { ...cur, eventsLoaded: true });
      return { runs: next };
    });
    try {
      const { events } = await api.runEvents(run.runId);
      set((s) => {
        const next = new Map(s.runs);
        const cur = next.get(messageId);
        if (cur && cur.events.length === 0) {
          next.set(messageId, {
            ...cur,
            events: events.map((e) => ({ event: e.payload, at: new Date(e.createdAt).getTime() })),
          });
        }
        return { runs: next };
      });
    } catch {
      // Un run di cui non riusciamo a leggere la traccia non è un problema:
      // resta la bolla col testo, che è la cosa che conta. Riproviamo alla
      // prossima apertura.
      set((s) => {
        const next = new Map(s.runs);
        const cur = next.get(messageId);
        if (cur) next.set(messageId, { ...cur, eventsLoaded: false });
        return { runs: next };
      });
    }
  },

  openThread(rootId) {
    const channelId = get().activeChannelId;
    set({ openThreadRootId: rootId, asideOpen: true, asideTab: 'thread' });
    if (channelId) void get().loadThread(channelId, rootId);
  },

  async loadThread(channelId, rootId) {
    try {
      const { messages } = await api.messages(channelId, { threadRootId: rootId, limit: 100 });
      set((s) => {
        const next = new Map(s.threadsByRoot);
        next.set(rootId, messages);
        return { threadsByRoot: next };
      });
    } catch {
      // Se il caricamento fallisce il pannello resta con quello che ha già:
      // meglio di svuotarlo.
    }
  },

  setAsideOpen(open) {
    set({ asideOpen: open });
  },

  setAsideTab(tab) {
    set({ asideTab: tab });
  },

  reorderLocally(groupId, channelIds) {
    // Ottimistico: il server risponde con un `channel.updated` per ciascuno e
    // conferma. Senza, il canale trascinato tornerebbe al suo posto per il
    // tempo di un giro di rete, che si vede.
    const rank = new Map(channelIds.map((id, i) => [id, i] as const));
    set((s) => ({
      channels: s.channels.map((c) =>
        rank.has(c.id) ? { ...c, groupId, position: rank.get(c.id)! } : c,
      ),
    }));
  },

  async loadOlder(channelId) {
    const current = get().messagesByChannel.get(channelId) ?? [];
    const oldest = current[0];
    if (!oldest) return;
    const { messages, hasMore } = await api.messages(channelId, {
      before: oldest.createdAt,
      limit: 50,
    });
    if (messages.length === 0) return;
    set((s) => {
      const next = new Map(s.messagesByChannel);
      next.set(channelId, [...messages, ...current]);
      const more = new Map(s.hasMoreByChannel);
      more.set(channelId, hasMore);
      return { messagesByChannel: next, hasMoreByChannel: more };
    });
  },

  async sendMessage(channelId, body, attachmentIds, threadRootId) {
    // Nonce di idempotenza: se la rete inciampa e il client ritenta,
    // il server non crea un doppione.
    const clientNonce = randomId();
    // Rispondere dentro un thread è un'altra cosa dal citare un messaggio nel
    // canale: la citazione resta al composer del canale.
    const replyToId = threadRootId ? null : (get().replyingTo?.id ?? null);
    if (!threadRootId) set({ replyingTo: null });
    const { message } = await api.postMessage(channelId, {
      body,
      clientNonce,
      replyToId,
      ...(threadRootId ? { threadRootId } : {}),
      ...(attachmentIds?.length ? { attachmentIds } : {}),
    });
    // Lo mostriamo subito invece di aspettare il websocket: se la socket è
    // giù il messaggio non comparirebbe affatto. `upsertMessage` è per id,
    // quindi il pacchetto che arriverà dopo lo sostituisce senza duplicati.
    set((s) => absorbMessage(s, message));
  },

  setReplyingTo(message) {
    set({ replyingTo: message });
  },

  async loadArtifacts(channelId) {
    try {
      const { artifacts } = await api.listArtifacts(channelId);
      set((s) => {
        const next = new Map(s.artifactsByChannel);
        next.set(channelId, artifacts);
        return { artifactsByChannel: next };
      });
    } catch {
      /* un canale senza artifact non è un errore da mostrare */
    }
  },

  async createArtifact(channelId, input) {
    try {
      const { artifact } = await api.createArtifact(channelId, input);
      // Lo stato arriva anche dal websocket; lo mettiamo subito per reattività.
      set((s) => upsertArtifact(s.artifactsByChannel, artifact));
      set({ artifactPanelOpen: true });
      return artifact;
    } catch {
      return null;
    }
  },

  async updateArtifactRemote(artifactId, patch) {
    // Ottimistico dove ha senso (spunte, titolo, pin): aggiorniamo subito e
    // lasciamo che il websocket confermi. Per il testo dei doc pensa il componente.
    const { artifact } = await api.updateArtifact(artifactId, patch);
    set((s) => upsertArtifact(s.artifactsByChannel, artifact));
  },

  async deleteArtifact(artifactId, channelId) {
    await api.deleteArtifact(artifactId);
    set((s) => {
      const next = new Map(s.artifactsByChannel);
      next.set(channelId, (next.get(channelId) ?? []).filter((a) => a.id !== artifactId));
      return { artifactsByChannel: next };
    });
  },

  async resyncChannel(channelId) {
    try {
      const { messages, hasMore } = await api.messages(channelId, { limit: 50 });
      set((s) => {
        const next = new Map(s.messagesByChannel);
        next.set(channelId, messages);
        const more = new Map(s.hasMoreByChannel);
        more.set(channelId, hasMore);
        return { messagesByChannel: next, hasMoreByChannel: more };
      });
    } catch {
      /* riproveremo alla prossima riconnessione */
    }
  },

  setArtifactPanelOpen(open) {
    set({ artifactPanelOpen: open });
  },

  async loadDocuments(workspaceId) {
    try {
      const { documents } = await api.listDocuments(workspaceId);
      set((s) => {
        const next = new Map(s.documentsByWorkspace);
        next.set(workspaceId, documents);
        return { documentsByWorkspace: next };
      });
    } catch {
      /* un progetto senza documenti non è un errore da mostrare */
    }
  },

  setDocumentsPanelOpen(open) {
    set({ documentsPanelOpen: open });
  },

  handlePacket(raw) {
    const packet = raw as { t: string } & Record<string, unknown>;

    switch (packet.t) {
      case 'message.new':
      case 'message.updated': {
        let message = packet.message as Message;
        set((s) => {
          const list = s.messagesByChannel.get(message.channelId);
          const inThread = message.threadRootId
            ? s.threadsByRoot.get(message.threadRootId)
            : undefined;
          // Aggiornamento robusto: un message.updated parziale (es. quello
          // finale di un run) non deve cancellare campi che il mittente non
          // conosce. Preserviamo la citazione già presente sul messaggio.
          if (packet.t === 'message.updated') {
            const prev =
              list?.find((m) => m.id === message.id) ?? inThread?.find((m) => m.id === message.id);
            if (prev) {
              message = {
                ...message,
                replyTo: message.replyTo ?? prev.replyTo,
                reactions: message.reactions.length ? message.reactions : prev.reactions,
                // Idem per gli allegati: la ripubblicazione di fine run li
                // manda vuoti, e senza questo sparivano dalla bolla appena
                // l'agente finiva di scrivere.
                attachments: message.attachments.length ? message.attachments : prev.attachments,
                // E per il thread: `replyCount` arriva sempre dalla riga del
                // DB anche nelle ripubblicazioni fatte a mano, quindi è
                // autorevole e va preso com'è — anche quando scende a zero.
                // Ultima risposta e partecipanti invece lì non ci sono, e
                // senza questa rete la barra "N risposte" perdeva volti e ora
                // a fine turno di un agente.
                threadLastReplyAt: message.threadLastReplyAt ?? prev.threadLastReplyAt,
                threadParticipants: message.threadParticipants.length
                  ? message.threadParticipants
                  : prev.threadParticipants,
              };
            }
          }
          // Se non abbiamo il canale in memoria non lo popoliamo adesso:
          // verrà caricato all'apertura.
          const absorbed = absorbMessage(s, message);
          const next = absorbed.messagesByChannel ?? new Map(s.messagesByChannel);

          const isActive = s.activeChannelId === message.channelId;
          const fromMe = message.author.type === 'user' && message.author.id === s.user?.id;
          const channels =
            packet.t === 'message.new' && !isActive && !fromMe
              ? s.channels.map((c) =>
                  c.id === message.channelId
                    ? {
                        ...c,
                        unreadCount: (c.unreadCount ?? 0) + 1,
                        hasMention:
                          c.hasMention ||
                          message.mentions.some(
                            (m) => m.type === 'user' && m.id === s.user?.id,
                          ),
                      }
                    : c,
                )
              : s.channels;

          return { ...absorbed, messagesByChannel: next, channels };
        });
        break;
      }

      case 'message.deleted': {
        const { channelId, messageId, purged } = packet as unknown as {
          channelId: string;
          messageId: string;
          purged?: boolean;
        };
        set((s) => {
          const next = new Map(s.messagesByChannel);
          const list = next.get(channelId);
          if (list) {
            next.set(
              channelId,
              // `purged` = sparisce davvero. È la bolla di un agente fermato
              // prima che scrivesse: una lapide «messaggio eliminato» al suo
              // posto sarebbe un altro modo di lasciare traccia di niente.
              purged
                ? list.filter((m) => m.id !== messageId)
                : list.map((m) =>
                    m.id === messageId
                      ? { ...m, deletedAt: new Date().toISOString(), body: '' }
                      : m,
                  ),
            );
          }
          return { messagesByChannel: next };
        });
        break;
      }

      case 'reaction.changed': {
        const { channelId, messageId, reactions } = packet as unknown as {
          channelId: string;
          messageId: string;
          reactions: Message['reactions'];
        };
        set((s) => {
          const next = new Map(s.messagesByChannel);
          const list = next.get(channelId);
          if (list) {
            next.set(
              channelId,
              list.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
            );
          }
          return { messagesByChannel: next };
        });
        break;
      }

      case 'run.started': {
        const p = packet as unknown as {
          runId: string;
          agentId: string;
          channelId: string;
          messageId: string;
          triggerMessageId: string | null;
          model: string | null;
          effort: string | null;
        };
        set((s) => {
          const runs = new Map(s.runs);
          runs.set(p.messageId, {
            runId: p.runId,
            agentId: p.agentId,
            channelId: p.channelId,
            triggerMessageId: p.triggerMessageId ?? null,
            model: p.model ?? null,
            effort: p.effort ?? null,
            status: 'queued',
            events: [],
            streaming: false,
            error: null,
            numTurns: 0,
            startedAt: Date.now(),
            endedAt: null,
            // Nasce adesso: la traccia è quella che stiamo ricevendo.
            eventsLoaded: true,
          });
          return { runs };
        });
        break;
      }

      case 'run.delta': {
        const p = packet as unknown as { messageId: string; text: string; runId: string };
        set((s) => {
          // Il testo si accumula direttamente sul messaggio: la bolla in
          // chat è la stessa, si riempie mentre arriva.
          const patched = patchMessage(s, p.messageId, (m) => ({
            ...m,
            body: (m.body ?? '') + p.text,
          }));
          const runs = new Map(s.runs);
          const run = runs.get(p.messageId);
          if (run) runs.set(p.messageId, { ...run, streaming: true, status: 'running' });
          return { ...patched, runs };
        });
        break;
      }

      case 'run.event': {
        const p = packet as unknown as { messageId: string; event: RunEvent; at?: number };
        set((s) => {
          const runs = new Map(s.runs);
          const run = runs.get(p.messageId);
          if (run) {
            runs.set(p.messageId, {
              ...run,
              // L'ora la dice chi ha eseguito l'operazione, non chi riceve il
              // pacchetto: il runner locale manda gli eventi a lotti, e usare
              // l'arrivo appiattirebbe ogni durata del lotto a «0,00 s».
              events: [...run.events, { event: p.event, at: p.at ?? Date.now() }],
            });
          }
          // Un turno di ragionamento si è chiuso: quel testo ora vive nella
          // tab di lavoro, quindi va tolto dalla bolla. Senza questo il
          // ragionamento resterebbe nel canale fino a fine turno, che è
          // esattamente ciò che la tab serve a evitare.
          const patched =
            p.event.type === 'text.block'
              ? patchMessage(s, p.messageId, (m) => ({ ...m, body: '' }))
              : {};
          return { ...patched, runs };
        });
        break;
      }

      case 'run.status': {
        const p = packet as unknown as {
          messageId: string;
          status: RunStatus;
          error?: string | null;
        };
        set((s) => {
          const runs = new Map(s.runs);
          const run = runs.get(p.messageId);
          if (run) {
            const finished =
              p.status === 'done' || p.status === 'error' || p.status === 'cancelled';
            runs.set(p.messageId, {
              ...run,
              status: p.status,
              error: p.error ?? null,
              streaming: p.status === 'running',
              endedAt: finished ? (run.endedAt ?? Date.now()) : run.endedAt,
            });
            if (finished) {
              // Il turno è chiuso: si spegne anche il segnale sui messaggi
              // che erano stati infilati dentro. Restava acceso a turno
              // finito, e spariva solo ricaricando la pagina.
              const steered = new Map(s.steered);
              let changed = false;
              for (const [messageId, mark] of steered) {
                if (mark.runId !== run.runId) continue;
                steered.delete(messageId);
                changed = true;
              }
              if (changed) return { runs, steered };
            }
          }
          return { runs };
        });
        break;
      }

      case 'agent.status': {
        const p = packet as unknown as {
          agentId: string;
          status: AgentStatus;
          label: string | null;
        };
        set((s) => {
          const activity = new Map(s.agentActivity);
          if (p.status === 'idle') activity.delete(p.agentId);
          else activity.set(p.agentId, { status: p.status, label: p.label });
          return { agentActivity: activity };
        });
        break;
      }

      case 'approval.requested': {
        const approval = packet.approval as Approval;
        set((s) => ({ approvals: [approval, ...s.approvals.filter((a) => a.id !== approval.id)] }));
        break;
      }

      case 'approval.resolved': {
        const approval = packet.approval as Approval;
        set((s) => ({ approvals: s.approvals.filter((a) => a.id !== approval.id) }));
        break;
      }

      case 'typing': {
        const p = packet as unknown as { channelId: string; actorId: string; name: string };
        set((s) => {
          const next = new Map(s.typingByChannel);
          const forChannel = new Map(next.get(p.channelId) ?? []);
          forChannel.set(p.actorId, { name: p.name, at: Date.now() });
          next.set(p.channelId, forChannel);
          return { typingByChannel: next };
        });
        break;
      }

      case 'presence': {
        const p = packet as unknown as { userId: string; online: boolean };
        set((s) => {
          const online = new Set(s.onlineUserIds);
          if (p.online) online.add(p.userId);
          else online.delete(p.userId);
          return { onlineUserIds: online };
        });
        break;
      }

      case 'channel.created':
      case 'channel.updated': {
        const channel = packet.channel as Channel;
        set((s) => {
          const exists = s.channels.some((c) => c.id === channel.id);
          return {
            channels: exists
              ? s.channels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
              : [...s.channels, channel],
          };
        });
        realtime.subscribe([channel.id]);
        break;
      }

      case 'agent.upserted': {
        const agent = packet.agent as Agent;
        set((s) => {
          const exists = s.agents.some((a) => a.id === agent.id);
          return {
            agents: exists
              ? s.agents.map((a) => (a.id === agent.id ? agent : a))
              : [...s.agents, agent],
          };
        });
        break;
      }

      case 'artifact.new':
      case 'artifact.updated': {
        const artifact = packet.artifact as Artifact;
        set((s) => upsertArtifact(s.artifactsByChannel, artifact));
        break;
      }

      case 'artifact.deleted': {
        const p = packet as unknown as { channelId: string; artifactId: string };
        set((s) => {
          const next = new Map(s.artifactsByChannel);
          next.set(
            p.channelId,
            (next.get(p.channelId) ?? []).filter((a) => a.id !== p.artifactId),
          );
          return { artifactsByChannel: next };
        });
        break;
      }

      case 'channel.deleted': {
        const p = packet as unknown as { channelId: string };
        set((s) => ({
          channels: s.channels.filter((c) => c.id !== p.channelId),
          activeChannelId: s.activeChannelId === p.channelId ? null : s.activeChannelId,
        }));
        break;
      }

      case 'document.changed': {
        const p = packet as unknown as { workspaceId: string; document: DocumentNode };
        set((s) => upsertDocument(s.documentsByWorkspace, p.workspaceId, p.document));
        break;
      }

      case 'steer.delivered': {
        const p = packet as unknown as {
          messageId: string;
          agentId: string;
          runId: string;
          state: 'pending' | 'reading' | 'done';
        };
        set((s) => {
          const next = new Map(s.steered);
          if (p.state === 'done') next.delete(p.messageId);
          else
            next.set(p.messageId, {
              agentId: p.agentId,
              runId: p.runId,
              reading: p.state === 'reading',
            });
          return { steered: next };
        });
        break;
      }

      case 'notify': {
        // Solo l'app Mac se ne serve: altrove la stessa notifica arriva
        // (meglio) via push, e mostrarle entrambe vorrebbe dire due avvisi
        // per lo stesso evento.
        const p = packet as unknown as { payload: PushPayload };
        void nativeNotifyShow(p.payload);
        break;
      }

      case 'document.deleted': {
        const p = packet as unknown as { workspaceId: string; documentId: string };
        set((s) => {
          const next = new Map(s.documentsByWorkspace);
          next.set(
            p.workspaceId,
            (next.get(p.workspaceId) ?? []).filter((d) => d.id !== p.documentId),
          );
          return { documentsByWorkspace: next };
        });
        break;
      }

      default:
        break;
    }
  },

  reset() {
    realtime.disconnect();
    set({
      user: null,
      workspaces: [],
      workspace: null,
      groups: [],
      channels: [],
      agents: [],
      members: [],
      activeChannelId: null,
      messagesByChannel: new Map(),
      threadsByRoot: new Map(),
      openThreadRootId: null,
      asideOpen: false,
      asideTab: 'activity',
      artifactsByChannel: new Map(),
      artifactPanelOpen: false,
      documentsByWorkspace: new Map(),
      documentsPanelOpen: false,
      runs: new Map(),
      agentActivity: new Map(),
      approvals: [],
      joinedChannelIds: new Set(),
    });
  },
}));

/* Un solo aggancio globale al websocket: instrada tutto nello store. */
realtime.on((packet) => useStore.getState().handlePacket(packet));
