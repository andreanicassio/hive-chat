import type {
  Agent,
  AgentSkill,
  Approval,
  CatalogModel,
  Channel,
  ChannelGroup,
  Invite,
  Message,
  PublicUser,
  Workspace,
  WorkspaceRole,
} from '@hive/shared';

/**
 * Client HTTP.
 *
 * Un solo punto d'ingresso, così la gestione degli errori è uniforme:
 * il server risponde sempre con `{ error: { code, message } }` e noi lo
 * trasformiamo in un'eccezione con un messaggio già mostrabile all'utente.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    credentials: 'same-origin',
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...rest.headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

  if (res.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    if (!res.ok) {
      throw new ApiError(res.status, 'network_error', `Errore di rete (${res.status})`);
    }
    return undefined as T;
  }

  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? 'Si è verificato un errore',
    );
  }
  return payload as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, json?: unknown) =>
  request<T>(path, { method: 'POST', json: json ?? {} });
const patch = <T,>(path: string, json: unknown) =>
  request<T>(path, { method: 'PATCH', json });
const put = <T,>(path: string, json?: unknown) =>
  request<T>(path, { method: 'PUT', json: json ?? {} });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

export interface BootstrapPayload {
  workspace: Workspace;
  groups: ChannelGroup[];
  channels: Channel[];
  agents: Agent[];
  members: Array<
    Pick<PublicUser, 'id' | 'name' | 'handle' | 'email' | 'avatarEmoji' | 'avatarColor'> & {
      role: WorkspaceRole;
      lastSeenAt: string | null;
    }
  >;
  joinedChannelIds: string[];
  capabilities: { anthropicConfigured: boolean; openrouterConfigured: boolean };
}

export const api = {
  /* --- autenticazione --- */
  register: (input: {
    email: string;
    password: string;
    name: string;
    inviteCode?: string;
  }) => post<{ user: PublicUser; joinedWorkspaceId: string | null }>('/api/auth/register', input),

  login: (input: { email: string; password: string }) =>
    post<{ user: PublicUser }>('/api/auth/login', input),

  logout: () => post<{ ok: true }>('/api/auth/logout'),

  me: () => get<{ user: PublicUser; workspaces: Workspace[] }>('/api/auth/me'),

  /* --- progetti --- */
  createWorkspace: (input: { name: string; iconEmoji?: string }) =>
    post<{ workspace: Workspace }>('/api/workspaces', input),

  bootstrap: (workspaceId: string) =>
    get<BootstrapPayload>(`/api/workspaces/${workspaceId}/bootstrap`),

  createGroup: (workspaceId: string, input: { name: string; emoji?: string | null }) =>
    post<{ group: ChannelGroup }>(`/api/workspaces/${workspaceId}/groups`, input),

  /* --- canali --- */
  createChannel: (
    workspaceId: string,
    input: {
      name: string;
      groupId?: string | null;
      topic?: string | null;
      visibility?: 'public' | 'private';
    },
  ) => post<{ channel: Channel }>(`/api/workspaces/${workspaceId}/channels`, input),

  updateChannel: (
    channelId: string,
    input: { topic?: string | null; purpose?: string | null; groupId?: string | null },
  ) => patch<{ channel: Channel }>(`/api/channels/${channelId}`, input),

  joinChannel: (channelId: string) => post<{ ok: true }>(`/api/channels/${channelId}/join`),
  leaveChannel: (channelId: string) => post<{ ok: true }>(`/api/channels/${channelId}/leave`),

  /* --- messaggi --- */
  messages: (channelId: string, opts?: { before?: string; limit?: number; threadRootId?: string }) => {
    const q = new URLSearchParams();
    if (opts?.before) q.set('before', opts.before);
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.threadRootId) q.set('threadRootId', opts.threadRootId);
    const qs = q.toString();
    return get<{ messages: Message[]; hasMore: boolean; nextCursor: string | null }>(
      `/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`,
    );
  },

  postMessage: (
    channelId: string,
    input: { body: string; threadRootId?: string | null; clientNonce?: string },
  ) =>
    post<{ message: Message; triggeredRuns: string[] }>(
      `/api/channels/${channelId}/messages`,
      input,
    ),

  editMessage: (messageId: string, body: string) =>
    patch<{ message: Message }>(`/api/messages/${messageId}`, { body }),

  deleteMessage: (messageId: string) => del<{ ok: true }>(`/api/messages/${messageId}`),

  toggleReaction: (messageId: string, emoji: string) =>
    put<{ reactions: Message['reactions'] }>(
      `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    ),

  markRead: (channelId: string, messageId?: string) =>
    post<{ ok: true }>(`/api/channels/${channelId}/read`, { messageId }),

  /* --- agenti --- */
  tools: () =>
    get<{
      tools: Array<{
        id: string;
        label: string;
        description: string;
        group: string;
        icon: string;
        availableFor: string[];
        dangerous: boolean;
        hasConfig: boolean;
      }>;
      defaults: Record<string, string[]>;
    }>('/api/tools'),

  models: (opts?: { kind?: 'assistant' | 'developer'; search?: string }) => {
    const q = new URLSearchParams();
    if (opts?.kind) q.set('kind', opts.kind);
    if (opts?.search) q.set('search', opts.search);
    const qs = q.toString();
    return get<{
      models: CatalogModel[];
      capabilities: { anthropicConfigured: boolean; openrouterConfigured: boolean };
      defaultModel: string;
    }>(`/api/models${qs ? `?${qs}` : ''}`);
  },

  createAgent: (workspaceId: string, input: Record<string, unknown>) =>
    post<{ agent: Agent }>(`/api/workspaces/${workspaceId}/agents`, input),

  updateAgent: (agentId: string, input: Record<string, unknown>) =>
    patch<{ agent: Agent }>(`/api/agents/${agentId}`, input),

  archiveAgent: (agentId: string) => del<{ ok: true }>(`/api/agents/${agentId}`),

  attachAgent: (agentId: string, channelId: string, autoRespond: boolean) =>
    put<{ ok: true }>(`/api/agents/${agentId}/channels/${channelId}`, { autoRespond }),

  detachAgent: (agentId: string, channelId: string) =>
    del<{ ok: true }>(`/api/agents/${agentId}/channels/${channelId}`),

  /* --- skill --- */
  skills: (agentId: string) => get<{ skills: AgentSkill[] }>(`/api/agents/${agentId}/skills`),

  saveSkill: (
    agentId: string,
    input: { name: string; description: string; body: string; enabled?: boolean; generatedByAi?: boolean },
  ) => post<{ skill: AgentSkill }>(`/api/agents/${agentId}/skills`, input),

  deleteSkill: (skillId: string) => del<{ ok: true }>(`/api/skills/${skillId}`),

  generateSkills: (
    workspaceId: string,
    input: { purpose: string; kind: 'assistant' | 'developer'; toolIds: string[]; count?: number },
  ) =>
    post<{ skills: Array<{ name: string; description: string; body: string }> }>(
      `/api/workspaces/${workspaceId}/skills/generate`,
      input,
    ),

  /* --- approvazioni --- */
  pendingApprovals: (workspaceId: string) =>
    get<{ approvals: Approval[] }>(`/api/workspaces/${workspaceId}/approvals`),

  decideApproval: (approvalId: string, allowed: boolean, reason?: string) =>
    post<{ approval: Approval }>(`/api/approvals/${approvalId}/decide`, { allowed, reason }),

  cancelRun: (runId: string) => post<{ ok: true }>(`/api/runs/${runId}/cancel`),

  /* --- inviti --- */
  createInvite: (workspaceId: string, input: { role?: string; email?: string | null }) =>
    post<{ invite: Invite }>(`/api/workspaces/${workspaceId}/invites`, input),

  inviteInfo: (code: string) =>
    get<{
      valid: boolean;
      workspaceName: string;
      workspaceIcon: string;
      role: string;
      email: string | null;
    }>(`/api/invites/${code}`),

  acceptInvite: (code: string) => post<{ workspaceId: string }>(`/api/invites/${code}/accept`),

  /* --- segreti --- */
  secrets: (workspaceId: string) =>
    get<{ secrets: Array<{ key: string; hint: string | null; updatedAt: string }> }>(
      `/api/workspaces/${workspaceId}/secrets`,
    ),

  setSecret: (workspaceId: string, key: string, value: string) =>
    put<{ ok: true; key: string; hint: string }>(
      `/api/workspaces/${workspaceId}/secrets/${key}`,
      { value },
    ),

  deleteSecret: (workspaceId: string, key: string) =>
    del<{ ok: true }>(`/api/workspaces/${workspaceId}/secrets/${key}`),

  /* --- contesto condiviso --- */
  context: (workspaceId: string) =>
    get<{
      context: {
        workspaceId: string;
        autoSummary: string | null;
        manualNotes: string | null;
        autoUpdatedAt: string | null;
        manualUpdatedAt: string | null;
      };
    }>(`/api/workspaces/${workspaceId}/context`),

  saveContext: (workspaceId: string, manualNotes: string | null) =>
    put<{ ok: true }>(`/api/workspaces/${workspaceId}/context`, { manualNotes }),
};
