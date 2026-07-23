import { create } from 'zustand';
import type {
  Agent,
  AgentStatus,
  Approval,
  Channel,
  ChannelGroup,
  Message,
  PublicUser,
  RunEvent,
  RunStatus,
  Workspace,
  WorkspaceRole,
} from '@hive/shared';
import { api, type BootstrapPayload } from './lib/api.js';
import { realtime } from './lib/ws.js';

/**
 * Stato del client.
 *
 * Una nota sulla forma: i messaggi stanno in una mappa per canale, non in un
 * unico elenco. Quando un agente scrive in streaming arrivano decine di
 * eventi al secondo su un solo canale: tenerli separati evita di ricalcolare
 * l'intera chat a ogni token.
 */

export interface RunState {
  runId: string;
  agentId: string;
  status: RunStatus;
  /** Eventi in ordine: tool usati, ragionamento, errori. */
  events: RunEvent[];
  /** Vero mentre il testo sta ancora arrivando. */
  streaming: boolean;
  error: string | null;
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

  /* --- realtime --- */
  connected: boolean;
  typingByChannel: Map<string, Map<string, { name: string; at: number }>>;
  onlineUserIds: Set<string>;
  runs: Map<string, RunState>;
  /** Stato volatile degli agenti, per la barra in basso. */
  agentActivity: Map<string, { status: AgentStatus; label: string | null }>;
  approvals: Approval[];

  /* --- azioni --- */
  loadSession: () => Promise<void>;
  openWorkspace: (workspaceId: string) => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, body: string) => Promise<void>;
  setReplyingTo: (message: Message | null) => void;
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

  connected: false,
  typingByChannel: new Map(),
  onlineUserIds: new Set(),
  runs: new Map(),
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
      runs: new Map(),
    });

    realtime.onStatusChange = (connected) => set({ connected });
    realtime.connect(workspaceId);
    realtime.subscribe(data.channels.map((c) => c.id));

    void api
      .pendingApprovals(workspaceId)
      .then(({ approvals }) => set({ approvals }))
      .catch(() => {});
  },

  async openChannel(channelId) {
    set({ activeChannelId: channelId, loadingChannel: true, replyingTo: null });
    realtime.subscribe([channelId]);

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

  async sendMessage(channelId, body) {
    // Nonce di idempotenza: se la rete inciampa e il client ritenta,
    // il server non crea un doppione.
    const clientNonce = randomId();
    const replyToId = get().replyingTo?.id ?? null;
    set({ replyingTo: null });
    await api.postMessage(channelId, { body, clientNonce, replyToId });
    // Il messaggio arriva dal websocket: non lo inseriamo qui per evitare
    // di vederlo comparire due volte.
  },

  setReplyingTo(message) {
    set({ replyingTo: message });
  },

  handlePacket(raw) {
    const packet = raw as { t: string } & Record<string, unknown>;

    switch (packet.t) {
      case 'message.new':
      case 'message.updated': {
        let message = packet.message as Message;
        set((s) => {
          const next = new Map(s.messagesByChannel);
          const list = next.get(message.channelId);
          // Aggiornamento robusto: un message.updated parziale (es. quello
          // finale di un run) non deve cancellare campi che il mittente non
          // conosce. Preserviamo la citazione già presente sul messaggio.
          if (packet.t === 'message.updated' && list) {
            const prev = list.find((m) => m.id === message.id);
            if (prev) {
              message = {
                ...message,
                replyTo: message.replyTo ?? prev.replyTo,
                reactions: message.reactions.length ? message.reactions : prev.reactions,
              };
            }
          }
          // Se non abbiamo il canale in memoria non lo popoliamo adesso:
          // verrà caricato all'apertura.
          if (list) next.set(message.channelId, upsertMessage(list, message));

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

          return { messagesByChannel: next, channels };
        });
        break;
      }

      case 'message.deleted': {
        const { channelId, messageId } = packet as unknown as {
          channelId: string;
          messageId: string;
        };
        set((s) => {
          const next = new Map(s.messagesByChannel);
          const list = next.get(channelId);
          if (list) {
            next.set(
              channelId,
              list.map((m) =>
                m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), body: '' } : m,
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
          messageId: string;
        };
        set((s) => {
          const runs = new Map(s.runs);
          runs.set(p.messageId, {
            runId: p.runId,
            agentId: p.agentId,
            status: 'queued',
            events: [],
            streaming: false,
            error: null,
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
          const next = new Map(s.messagesByChannel);
          for (const [channelId, list] of next) {
            const idx = list.findIndex((m) => m.id === p.messageId);
            if (idx === -1) continue;
            const updated = list.slice();
            updated[idx] = { ...updated[idx]!, body: (updated[idx]!.body ?? '') + p.text };
            next.set(channelId, updated);
            break;
          }
          const runs = new Map(s.runs);
          const run = runs.get(p.messageId);
          if (run) runs.set(p.messageId, { ...run, streaming: true, status: 'running' });
          return { messagesByChannel: next, runs };
        });
        break;
      }

      case 'run.event': {
        const p = packet as unknown as { messageId: string; event: RunEvent };
        set((s) => {
          const runs = new Map(s.runs);
          const run = runs.get(p.messageId);
          if (run) runs.set(p.messageId, { ...run, events: [...run.events, p.event] });
          return { runs };
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
            runs.set(p.messageId, {
              ...run,
              status: p.status,
              error: p.error ?? null,
              streaming: p.status === 'running',
            });
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
      runs: new Map(),
      agentActivity: new Map(),
      approvals: [],
      joinedChannelIds: new Set(),
    });
  },
}));

/* Un solo aggancio globale al websocket: instrada tutto nello store. */
realtime.on((packet) => useStore.getState().handlePacket(packet));
