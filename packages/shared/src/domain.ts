import { z } from 'zod';

/* ---------------------------------------------------------------------------
 * Identificatori e primitive
 * ------------------------------------------------------------------------ */

export const uuid = z.uuid();

/** Handle usato per @menzioni: minuscolo, senza spazi. */
export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'solo minuscole, cifre, punto, trattino e underscore');

/** Nome canale in stile Slack. */
export const channelNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'solo minuscole, cifre e trattini');

export const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/* ---------------------------------------------------------------------------
 * Ruoli e appartenenze
 * ------------------------------------------------------------------------ */

export const workspaceRoles = ['owner', 'admin', 'member', 'guest'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const workspaceRoleSchema = z.enum(workspaceRoles);

/** Precedenza dei ruoli: più alto = più permessi. */
export const roleRank: Record<WorkspaceRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return roleRank[role] >= roleRank[min];
}

/* ---------------------------------------------------------------------------
 * Attori: un messaggio può venire da un umano, da un agente o dal sistema
 * ------------------------------------------------------------------------ */

export const actorTypes = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof actorTypes)[number];
export const actorTypeSchema = z.enum(actorTypes);

export interface ActorRef {
  type: ActorType;
  id: string;
  name: string;
  handle: string;
  avatarEmoji: string | null;
  avatarColor: string | null;
}

/* ---------------------------------------------------------------------------
 * Utenti e workspace
 * ------------------------------------------------------------------------ */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  handle: string;
  avatarEmoji: string | null;
  avatarColor: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  iconEmoji: string;
  createdAt: string;
  /** Ruolo dell'utente corrente in questo workspace. */
  role?: WorkspaceRole;
}

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(64),
  slug: slugSchema.optional(),
  iconEmoji: z.string().min(1).max(8).default('🐝'),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

/* ---------------------------------------------------------------------------
 * Canali
 * ------------------------------------------------------------------------ */

export const channelVisibilities = ['public', 'private'] as const;
export type ChannelVisibility = (typeof channelVisibilities)[number];

export const channelKinds = ['channel', 'dm'] as const;
export type ChannelKind = (typeof channelKinds)[number];

export interface ChannelGroup {
  id: string;
  workspaceId: string;
  name: string;
  emoji: string | null;
  position: number;
}

export interface Channel {
  id: string;
  workspaceId: string;
  groupId: string | null;
  name: string;
  topic: string | null;
  purpose: string | null;
  visibility: ChannelVisibility;
  kind: ChannelKind;
  position: number;
  createdAt: string;
  archivedAt: string | null;
  /** Calcolati per l'utente corrente. */
  unreadCount?: number;
  hasMention?: boolean;
  /** Agenti agganciati a questo canale. */
  agentIds?: string[];
}

export const createChannelSchema = z.object({
  name: channelNameSchema,
  groupId: uuid.nullable().optional(),
  topic: z.string().max(280).nullable().optional(),
  purpose: z.string().max(1000).nullable().optional(),
  visibility: z.enum(channelVisibilities).default('public'),
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const createGroupSchema = z.object({
  name: z.string().min(1).max(48),
  emoji: z.string().max(8).nullable().optional(),
});

/* ---------------------------------------------------------------------------
 * Messaggi
 * ------------------------------------------------------------------------ */

/** Riferimento a una menzione dentro il corpo del messaggio. */
export interface MentionRef {
  type: 'user' | 'agent' | 'channel' | 'everyone';
  id: string | null;
  handle: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  /** true se l'utente corrente ha messo questa reazione. */
  mine: boolean;
  actors: Array<{ type: ActorType; id: string; name: string }>;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
}

/** Anteprima compatta del messaggio a cui si sta rispondendo. */
export interface ReplyPreview {
  id: string;
  authorName: string;
  authorType: ActorType;
  /** Prime parole del corpo, già senza markup di menzioni. */
  excerpt: string;
  deleted: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  threadRootId: string | null;
  /** Presente se il messaggio risponde a un altro. */
  replyTo: ReplyPreview | null;
  author: ActorRef;
  /** Markdown. Le menzioni sono nella forma `<@handle>` / `<#canale>`. */
  body: string;
  mentions: MentionRef[];
  reactions: Reaction[];
  attachments: Attachment[];
  /** Presente se il messaggio è l'output di un agente. */
  runId: string | null;
  /** Conteggio risposte se il messaggio è la radice di un thread. */
  replyCount: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export const postMessageSchema = z.object({
  body: z.string().min(1).max(16000),
  threadRootId: uuid.nullable().optional(),
  /** Id del messaggio a cui si risponde. */
  replyToId: uuid.nullable().optional(),
  /** Idempotenza lato client per evitare doppi invii. */
  clientNonce: z.string().max(64).optional(),
});
export type PostMessageInput = z.infer<typeof postMessageSchema>;

/* ---------------------------------------------------------------------------
 * Agenti
 * ------------------------------------------------------------------------ */

export const agentKinds = ['assistant', 'developer'] as const;
/** `assistant` = niente filesystem, solo tool. `developer` = Claude Code completo. */
export type AgentKind = (typeof agentKinds)[number];
export const agentKindSchema = z.enum(agentKinds);

export const agentStatuses = ['idle', 'thinking', 'working', 'waiting', 'error'] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof effortLevels)[number];

/* --- Runtime di esecuzione -------------------------------------------------
 *
 * Il `runtime` è l'harness che esegue davvero l'agente. È una dimensione
 * separata dal modello: lo stesso modello può girare su harness diversi.
 *
 *  `claude-code`      Claude Agent SDK, ovvero Claude Code come libreria.
 *                     Harness completo: filesystem, shell, subagent, skill,
 *                     permessi. Accetta solo modelli Claude, perché tutto
 *                     l'harness è costruito attorno a Claude.
 *                     È il default e l'unica opzione per gli agenti sviluppatore.
 *
 *  `openrouter-tools` Loop di tool-calling nostro sopra l'API OpenRouter.
 *                     Qualunque modello tool-capable (~270 e in crescita),
 *                     ma senza filesystem né shell: solo agenti assistente.
 *
 *  `opencode`         RISERVATO, non ancora implementato. Harness open source
 *                     per dare capacità da sviluppatore anche ai modelli non
 *                     Claude. Il valore esiste già qui perché aggiungerlo
 *                     domani non richieda una migrazione del database.
 */
export const agentRuntimes = ['claude-code', 'openrouter-tools', 'opencode'] as const;
export type AgentRuntime = (typeof agentRuntimes)[number];
export const agentRuntimeSchema = z.enum(agentRuntimes);

/** Runtime già utilizzabili. `opencode` è dichiarato ma non ancora attivo. */
export const implementedRuntimes: AgentRuntime[] = ['claude-code', 'openrouter-tools'];

/** Voce del catalogo modelli, sincronizzata da OpenRouter. */
export interface CatalogModel {
  /** Es. `anthropic/claude-opus-4.8` oppure `google/gemini-3.6-flash`. */
  id: string;
  /** Harness che eseguirà questo modello. */
  runtime: AgentRuntime;
  name: string;
  /** Casa che produce il modello, ricavata dal prefisso dell'id. */
  vendor: string;
  contextLength: number;
  /** Dollari per milione di token. */
  pricePromptPerM: number | null;
  priceCompletionPerM: number | null;
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** In evidenza in cima al selettore. */
  featured: boolean;
  /** Utilizzabile dagli agenti sviluppatore (solo i Claude). */
  devCapable: boolean;
  releasedAt: string | null;
}

/**
 * Il runtime non si sceglie a mano: lo deduciamo dal modello e dal tipo.
 * Claude Code è il default ovunque sia possibile, perché è l'harness migliore;
 * si scende su OpenRouter solo quando il modello scelto non è un Claude.
 */
export function runtimeForModel(modelId: string, kind: AgentKind): AgentRuntime {
  const isClaude = modelId.startsWith('anthropic/');
  if (isClaude) return 'claude-code';
  // Un modello non-Claude su un agente sviluppatore oggi non è eseguibile:
  // servirebbe un harness open source (vedi `opencode`, non ancora attivo).
  // Chi chiama deve intercettare questo caso e rifiutare la configurazione.
  return 'openrouter-tools';
}

/** Vero se la coppia modello + tipo di agente è eseguibile oggi. */
export function isRunnableConfig(
  modelId: string,
  kind: AgentKind,
): { ok: true } | { ok: false; reason: string } {
  const isClaude = modelId.startsWith('anthropic/');
  if (kind === 'developer' && !isClaude) {
    return {
      ok: false,
      reason:
        'Gli agenti sviluppatore girano su Claude Code, che accetta solo modelli Claude. ' +
        'Scegli un modello Anthropic, oppure crea un agente assistente.',
    };
  }
  return { ok: true };
}

/** Configurazione del repo su cui lavora un agente sviluppatore. */
export const repoConfigSchema = z.object({
  /** URL git da clonare nel container di progetto. Vuoto = cartella vuota. */
  gitUrl: z.string().max(500).nullable().default(null),
  branch: z.string().max(200).default('main'),
  /** Nome del token nei segreti del workspace usato per clone/push. */
  credentialKey: z.string().max(64).nullable().default(null),
  /** Comando di setup eseguito una volta all'avvio del container. */
  setupCommand: z.string().max(500).nullable().default(null),
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const mcpServerConfigSchema = z.object({
  name: z.string().min(1).max(64),
  /** stdio = processo locale; http = server remoto. */
  transport: z.enum(['stdio', 'http']),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).default([]),
  url: z.url().optional(),
  /** Nomi delle chiavi nei segreti del workspace da iniettare come env. */
  envKeys: z.array(z.string().max(64)).max(20).default([]),
});
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const agentToolGrantSchema = z.object({
  /** id dal catalogo tool (vedi tools.ts) */
  toolId: z.string().min(1).max(64),
  /** Config specifica del tool, validata contro lo schema del catalogo. */
  config: z.record(z.string(), z.unknown()).default({}),
  /**
   * Se true ogni invocazione richiede l'ok di un umano in chat,
   * anche se il tool non lo richiederebbe di suo.
   */
  requireApproval: z.boolean().default(false),
});
export type AgentToolGrant = z.infer<typeof agentToolGrantSchema>;

export interface Agent {
  id: string;
  workspaceId: string;
  handle: string;
  name: string;
  description: string | null;
  /** Testo in linguaggio naturale su cosa deve fare: guida la generazione skill. */
  purpose: string | null;
  kind: AgentKind;
  /** Id nel catalogo, es. `anthropic/claude-opus-4.8` o `google/gemini-3.6-flash`. */
  model: string;
  /** Dedotto dal modello: l'harness che esegue davvero l'agente. */
  runtime: AgentRuntime;
  /** Solo per i modelli Claude: gli altri lo ignorano. */
  effort: EffortLevel;
  avatarEmoji: string;
  avatarColor: string;
  systemPrompt: string | null;
  tools: AgentToolGrant[];
  mcpServers: McpServerConfig[];
  repo: RepoConfig | null;
  /** Risponde da solo quando qualcuno scrive nel canale senza taggarlo. */
  autoRespond: boolean;
  status: AgentStatus;
  statusLabel: string | null;
  createdAt: string;
  archivedAt: string | null;
  channelIds?: string[];
  skillCount?: number;
}

export const createAgentSchema = z.object({
  name: z.string().min(1).max(48),
  handle: handleSchema.optional(),
  kind: agentKindSchema.default('assistant'),
  description: z.string().max(280).nullable().optional(),
  purpose: z.string().max(4000).nullable().optional(),
  model: z.string().max(128).optional(),
  effort: z.enum(effortLevels).default('high'),
  avatarEmoji: z.string().min(1).max(8).default('🤖'),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  systemPrompt: z.string().max(20000).nullable().optional(),
  tools: z.array(agentToolGrantSchema).max(40).default([]),
  mcpServers: z.array(mcpServerConfigSchema).max(20).default([]),
  repo: repoConfigSchema.nullable().optional(),
  autoRespond: z.boolean().default(false),
  channelIds: z.array(uuid).max(100).default([]),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = createAgentSchema.partial();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

/* ---------------------------------------------------------------------------
 * Skill
 * ------------------------------------------------------------------------ */

export interface AgentSkill {
  id: string;
  agentId: string;
  /** Diventa il nome cartella in `.claude/skills/<name>/SKILL.md`. */
  name: string;
  /** Frontmatter `description`: decide quando Claude carica la skill. */
  description: string;
  /** Corpo markdown della skill. */
  body: string;
  enabled: boolean;
  generatedByAi: boolean;
  createdAt: string;
  updatedAt: string;
}

export const skillNameSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'solo minuscole, cifre e trattini');

export const upsertSkillSchema = z.object({
  name: skillNameSchema,
  description: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  enabled: z.boolean().default(true),
});
export type UpsertSkillInput = z.infer<typeof upsertSkillSchema>;

/** Richiesta di generazione skill via AI a partire dallo scopo dell'agente. */
export const generateSkillsSchema = z.object({
  purpose: z.string().min(10).max(4000),
  kind: agentKindSchema,
  toolIds: z.array(z.string()).max(40).default([]),
  count: z.number().int().min(1).max(6).default(3),
});
export type GenerateSkillsInput = z.infer<typeof generateSkillsSchema>;

/* ---------------------------------------------------------------------------
 * Esecuzioni degli agenti
 * ------------------------------------------------------------------------ */

export const runStatuses = [
  'queued',
  'running',
  'awaiting_approval',
  'done',
  'error',
  'cancelled',
] as const;
export type RunStatus = (typeof runStatuses)[number];

export interface AgentRun {
  id: string;
  agentId: string;
  channelId: string;
  triggerMessageId: string | null;
  responseMessageId: string | null;
  sdkSessionId: string | null;
  status: RunStatus;
  error: string | null;
  numTurns: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Evento normalizzato dello stream dell'agente.
 * È ciò che l'UI renderizza dentro la bolla del messaggio.
 */
export type RunEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.start' }
  | { type: 'thinking.delta'; text: string }
  | { type: 'thinking.end' }
  | {
      type: 'tool.start';
      toolUseId: string;
      name: string;
      /** Etichetta leggibile, es. "Legge src/auth.ts". */
      label: string;
      input: unknown;
    }
  | {
      type: 'tool.end';
      toolUseId: string;
      isError: boolean;
      /** Riassunto breve del risultato, non l'output completo. */
      summary: string;
    }
  | { type: 'subagent.start'; parentToolUseId: string; agentType: string }
  | { type: 'subagent.end'; parentToolUseId: string; summary: string }
  | { type: 'approval.requested'; approvalId: string }
  | { type: 'approval.resolved'; approvalId: string; allowed: boolean }
  | { type: 'handoff'; toAgentHandle: string }
  | { type: 'error'; message: string };

/* ---------------------------------------------------------------------------
 * Approvazioni umane per azioni irreversibili
 * ------------------------------------------------------------------------ */

export const approvalStatuses = ['pending', 'allowed', 'denied', 'expired'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export interface Approval {
  id: string;
  runId: string;
  channelId: string;
  agentId: string;
  toolName: string;
  /** Riassunto leggibile di cosa sta per succedere. */
  title: string;
  /** Il comando/diff esatto, mostrato in monospace nella card. */
  detail: string;
  input: unknown;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

export const decideApprovalSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().max(500).optional(),
});

/* ---------------------------------------------------------------------------
 * Contesto condiviso del workspace
 * ------------------------------------------------------------------------ */

/**
 * Il contesto base che tutti gli agenti di un progetto vedono.
 * Viene rigenerato automaticamente dall'attività del workspace, ma
 * un admin può fissare delle note manuali che non vengono sovrascritte.
 */
export interface WorkspaceContext {
  workspaceId: string;
  /** Generato: riassunto di scopo, canali, decisioni recenti. */
  autoSummary: string | null;
  /** Scritto a mano, ha priorità sull'auto. */
  manualNotes: string | null;
  autoUpdatedAt: string | null;
  manualUpdatedAt: string | null;
}

/* ---------------------------------------------------------------------------
 * Autenticazione
 * ------------------------------------------------------------------------ */

export const registerSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(10, 'almeno 10 caratteri').max(200),
  name: z.string().min(1).max(64),
  /** Codice d'invito: obbligatorio se l'istanza non è aperta alle registrazioni. */
  inviteCode: z.string().max(64).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createInviteSchema = z.object({
  role: workspaceRoleSchema.default('member'),
  email: z.email().max(200).nullable().optional(),
  /** Durata in ore. */
  ttlHours: z.number().int().min(1).max(24 * 30).default(24 * 7),
});

export interface Invite {
  id: string;
  workspaceId: string;
  code: string;
  role: WorkspaceRole;
  email: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  url: string;
}
