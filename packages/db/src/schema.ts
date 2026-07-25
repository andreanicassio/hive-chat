import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ---------------------------------------------------------------------------
 * Utenti e sessioni
 * ------------------------------------------------------------------------ */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 200 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    handle: varchar('handle', { length: 32 }).notNull(),
    avatarEmoji: varchar('avatar_emoji', { length: 8 }),
    avatarColor: varchar('avatar_color', { length: 9 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    // L'email è unica a prescindere dal maiuscolo/minuscolo.
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    uniqueIndex('users_handle_idx').on(t.handle),
  ],
);

/** Sessioni di login: token opaco, hash su DB. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: varchar('user_agent', { length: 300 }),
    ip: varchar('ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('auth_sessions_token_idx').on(t.tokenHash),
    index('auth_sessions_user_idx').on(t.userId),
  ],
);

/* ---------------------------------------------------------------------------
 * Workspace (= progetto: può essere un'azienda intera o un singolo progetto)
 * ------------------------------------------------------------------------ */

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 48 }).notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    iconEmoji: varchar('icon_emoji', { length: 8 }).notNull().default('🐝'),
    /** Tetto di spesa mensile in dollari per gli agenti. Null = nessun limite. */
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 10, scale: 2 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('workspaces_slug_idx').on(t.slug)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 64 }).notNull(),
    role: varchar('role', { length: 16 }).notNull().default('member'),
    email: varchar('email', { length: 200 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('invites_code_idx').on(t.code),
    index('invites_workspace_idx').on(t.workspaceId),
  ],
);

/** Segreti per workspace (API key Anthropic, token git, credenziali HTTP). */
export const workspaceSecrets = pgTable(
  'workspace_secrets',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    /** AES-256-GCM, formato: iv:tag:ciphertext in base64. */
    valueEncrypted: text('value_encrypted').notNull(),
    /** Ultime 4 cifre o simili, per mostrare qualcosa in UI senza decifrare. */
    hint: varchar('hint', { length: 32 }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/* ---------------------------------------------------------------------------
 * Canali
 * ------------------------------------------------------------------------ */

export const channelGroups = pgTable(
  'channel_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 48 }).notNull(),
    emoji: varchar('emoji', { length: 8 }),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('channel_groups_workspace_idx').on(t.workspaceId)],
);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => channelGroups.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 48 }).notNull(),
    topic: varchar('topic', { length: 280 }),
    purpose: text('purpose'),
    visibility: varchar('visibility', { length: 16 }).notNull().default('public'),
    kind: varchar('kind', { length: 16 }).notNull().default('channel'),
    position: integer('position').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('channels_ws_name_idx').on(t.workspaceId, t.name),
    index('channels_workspace_idx').on(t.workspaceId),
  ],
);

/** Membri di un canale: possono essere utenti o agenti. */
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    memberType: varchar('member_type', { length: 8 }).notNull(), // user | agent
    memberId: uuid('member_id').notNull(),
    /** Solo per gli agenti: risponde anche senza essere taggato. */
    autoRespond: boolean('auto_respond').notNull().default(false),
    lastReadMessageId: uuid('last_read_message_id'),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.memberType, t.memberId] }),
    index('channel_members_member_idx').on(t.memberType, t.memberId),
  ],
);

/* ---------------------------------------------------------------------------
 * Messaggi
 * ------------------------------------------------------------------------ */

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    threadRootId: uuid('thread_root_id'),
    /** Messaggio a cui questo risponde: mostrato come citazione sopra il corpo. */
    replyToId: uuid('reply_to_id'),
    authorType: varchar('author_type', { length: 8 }).notNull(), // user | agent | system
    authorId: uuid('author_id'),
    body: text('body').notNull().default(''),
    /** Menzioni estratte, per notifiche e trigger agenti senza riparsare. */
    mentions: jsonb('mentions').notNull().default(sql`'[]'::jsonb`),
    /** Presente se il messaggio è l'output di un agente. */
    runId: uuid('run_id'),
    replyCount: integer('reply_count').notNull().default(0),
    clientNonce: varchar('client_nonce', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Query principale: ultimi messaggi di un canale.
    index('messages_channel_created_idx').on(t.channelId, t.createdAt),
    index('messages_thread_idx').on(t.threadRootId),
    // Idempotenza degli invii dal client.
    uniqueIndex('messages_nonce_idx')
      .on(t.channelId, t.clientNonce)
      .where(sql`${t.clientNonce} is not null`),
  ],
);

export const reactions = pgTable(
  'reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    actorType: varchar('actor_type', { length: 8 }).notNull(),
    actorId: uuid('actor_id').notNull(),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.actorType, t.actorId, t.emoji] })],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 300 }).notNull(),
    mime: varchar('mime', { length: 128 }).notNull(),
    size: integer('size').notNull(),
    storagePath: text('storage_path').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attachments_message_idx').on(t.messageId)],
);

/* ---------------------------------------------------------------------------
 * Agenti
 * ------------------------------------------------------------------------ */

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    handle: varchar('handle', { length: 32 }).notNull(),
    name: varchar('name', { length: 48 }).notNull(),
    description: varchar('description', { length: 280 }),
    purpose: text('purpose'),
    kind: varchar('kind', { length: 16 }).notNull().default('assistant'),
    /** Id nel catalogo modelli, es. `anthropic/claude-opus-4.8`. */
    model: varchar('model', { length: 128 }).notNull(),
    /** Harness che esegue: `claude-code`, `openrouter-tools`, (futuro) `opencode`. */
    runtime: varchar('runtime', { length: 24 }).notNull().default('claude-code'),
    effort: varchar('effort', { length: 8 }).notNull().default('high'),
    /** Quanto deve essere lunga la risposta finale in chat. */
    replyStyle: varchar('reply_style', { length: 16 }).notNull().default('normale'),
    replyStyleCustom: text('reply_style_custom'),
    avatarEmoji: varchar('avatar_emoji', { length: 8 }).notNull().default('🤖'),
    avatarColor: varchar('avatar_color', { length: 9 }).notNull(),
    systemPrompt: text('system_prompt'),
    tools: jsonb('tools').notNull().default(sql`'[]'::jsonb`),
    mcpServers: jsonb('mcp_servers').notNull().default(sql`'[]'::jsonb`),
    repo: jsonb('repo'),
    /** `server` (default) o `local`: dove gira il turno dell'agente. */
    execution: varchar('execution', { length: 8 }).notNull().default('server'),
    /** `ask` (conferma in chat) o `bypass` (autonomia totale, niente conferme). */
    permissionMode: varchar('permission_mode', { length: 8 }).notNull().default('ask'),
    /**
     * Su QUALE runner gira, quando `execution = 'local'`. Null = la prima
     * macchina disponibile fra quelle accese (comportamento storico).
     */
    runnerTokenId: uuid('runner_token_id'),
    autoRespond: boolean('auto_respond').notNull().default(false),
    /** Stato volatile mostrato nella barra in basso. */
    status: varchar('status', { length: 16 }).notNull().default('idle'),
    statusLabel: varchar('status_label', { length: 140 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('agents_ws_handle_idx').on(t.workspaceId, t.handle),
    index('agents_workspace_idx').on(t.workspaceId),
  ],
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 48 }).notNull(),
    description: varchar('description', { length: 500 }).notNull(),
    body: text('body').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    generatedByAi: boolean('generated_by_ai').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_skills_agent_name_idx').on(t.agentId, t.name)],
);

/* ---------------------------------------------------------------------------
 * Esecuzioni
 * ------------------------------------------------------------------------ */

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    triggerMessageId: uuid('trigger_message_id'),
    responseMessageId: uuid('response_message_id'),
    /** Session id dell'Agent SDK, per riprendere il filo nei turni successivi. */
    sdkSessionId: text('sdk_session_id'),
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    error: text('error'),
    /*
     * Modello ed effort con cui il turno è PARTITO.
     *
     * Si registrano qui e non si leggono dall'agente: la sua configurazione
     * può cambiare mentre il turno gira, e mostrare quella nuova vorrebbe
     * dire dire una cosa falsa su cosa sta davvero girando.
     */
    model: text('model'),
    effort: varchar('effort', { length: 10 }),
    numTurns: integer('num_turns').notNull().default(0),
    /**
     * Costo che l'harness attribuisce al run, a listino. Per i run in
     * abbonamento è un equivalente teorico: non lo paghi.
     */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /**
     * Il run è passato da un abbonamento (OAuth) invece che da una chiave a
     * consumo? Registrato al momento del run perché l'auth può cambiare, e
     * dedurlo a posteriori riscriverebbe anche il passato. NULL sui run
     * storici, precedenti a questa colonna.
     */
    usesSubscription: boolean('uses_subscription'),
    hop: integer('hop').notNull().default(0),
    /**
     * Il lavoro da eseguire, per intero. Sta QUI e non solo in Redis: se le
     * due cose divergono (turno annullato, runner morto, segnale di fine
     * perso) il turno resta «in coda» per sempre e blocca tutti quelli dopo,
     * senza che nessuno possa più ricostruirlo. Con il payload sulla riga,
     * la coda si ripara da sola.
     */
    job: jsonb('job'),
    /** Quando è stato mandato in esecuzione. Null = è ancora in attesa. */
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_runs_channel_idx').on(t.channelId),
    index('agent_runs_agent_idx').on(t.agentId),
    index('agent_runs_status_idx').on(t.status),
  ],
);

/** Traccia completa di un run: serve per il replay e per l'audit. */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: varchar('type', { length: 32 }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('run_events_run_seq_idx').on(t.runId, t.seq)],
);

/** Conferme umane richieste prima di eseguire azioni irreversibili. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    title: varchar('title', { length: 280 }).notNull(),
    detail: text('detail').notNull().default(''),
    input: jsonb('input').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: varchar('reason', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('approvals_run_idx').on(t.runId),
    index('approvals_status_idx').on(t.status),
  ],
);

/* ---------------------------------------------------------------------------
 * Catalogo modelli
 * ------------------------------------------------------------------------ */

/**
 * Sincronizzato periodicamente da https://openrouter.ai/api/v1/models.
 * Tenerlo su DB invece che chiamare OpenRouter a ogni apertura del selettore
 * evita di dipendere dalla loro disponibilità e permette di marcare a mano
 * i modelli "in evidenza" senza toccare il codice.
 */
export const modelCatalog = pgTable(
  'model_catalog',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    /** Harness con cui questo modello viene eseguito. */
    runtime: varchar('runtime', { length: 24 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    vendor: varchar('vendor', { length: 64 }).notNull(),
    contextLength: integer('context_length').notNull().default(0),
    /** Dollari per milione di token. */
    pricePromptPerM: numeric('price_prompt_per_m', { precision: 12, scale: 4 }),
    priceCompletionPerM: numeric('price_completion_per_m', { precision: 12, scale: 4 }),
    supportsTools: boolean('supports_tools').notNull().default(false),
    supportsReasoning: boolean('supports_reasoning').notNull().default(false),
    /** Mostrato in cima al selettore. */
    featured: boolean('featured').notNull().default(false),
    /** Usabile dagli agenti sviluppatore: vero solo per i modelli Claude. */
    devCapable: boolean('dev_capable').notNull().default(false),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Nascosto dal selettore senza cancellarlo (modello ritirato). */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  },
  (t) => [
    index('model_catalog_featured_idx').on(t.featured),
    index('model_catalog_vendor_idx').on(t.vendor),
  ],
);

/* ---------------------------------------------------------------------------
 * Contesto condiviso del progetto
 * ------------------------------------------------------------------------ */

export const workspaceContext = pgTable('workspace_context', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Rigenerato periodicamente dall'attività del workspace. */
  autoSummary: text('auto_summary'),
  /** Scritto a mano da un admin: non viene mai sovrascritto. */
  manualNotes: text('manual_notes'),
  /** Ultimo messaggio incluso nel riassunto, per fare gli aggiornamenti in delta. */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  autoUpdatedAt: timestamp('auto_updated_at', { withTimezone: true }),
  manualUpdatedAt: timestamp('manual_updated_at', { withTimezone: true }),
});

/* ---------------------------------------------------------------------------
 * Artifacts: documenti vivi accanto alla chat (checklist e fogli markdown).
 * Li manipolano sia le persone (a mano, dal pannello) sia gli agenti (via
 * tool), e ogni modifica si propaga in tempo reale come i messaggi.
 * ------------------------------------------------------------------------ */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** checklist | doc */
    type: varchar('type', { length: 16 }).notNull(),
    title: text('title').notNull().default(''),
    /**
     * Forma dipendente dal tipo:
     *   checklist → { items: [{ id, text, done }] }
     *   doc       → { markdown: string }
     */
    content: jsonb('content').notNull().default(sql`'{}'::jsonb`),
    /** Appuntato: compare nella striscia in cima alla chat. */
    pinned: boolean('pinned').notNull().default(true),
    createdByType: varchar('created_by_type', { length: 8 }).notNull(), // user | agent
    createdById: uuid('created_by_id'),
    /** Chi ha toccato per ultimo l'artifact (per la riga "aggiornato da"). */
    updatedByType: varchar('updated_by_type', { length: 8 }),
    updatedById: uuid('updated_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('artifacts_channel_idx').on(t.channelId, t.updatedAt)],
);

/* ---------------------------------------------------------------------------
 * Documenti: la base di conoscenza del progetto. Un albero di cartelle e file
 * a livello di workspace. I file sono di due nature:
 *   - testo modificabile (markdown/txt): il `content` vive qui, editabile in
 *     Hive o dagli agenti — come una wiki di progetto.
 *   - caricati (PDF, ecc.): il binario sta su disco (`storageKey`) e ne
 *     estraiamo il testo (`extractedText`) così gli agenti lo possono leggere.
 * Gestione "alla Claude Code": nel contesto degli agenti finisce solo l'INDICE
 * (percorsi + descrizioni); il contenuto lo leggono on-demand con un tool.
 * ------------------------------------------------------------------------ */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Cartella genitore (null = radice). Autoreferenza per l'albero. */
    parentId: uuid('parent_id'),
    /** `folder` | `file`. */
    kind: varchar('kind', { length: 8 }).notNull(),
    /** Nome mostrato / nome file, es. `auth.md`. Unico fra i fratelli. */
    name: varchar('name', { length: 200 }).notNull(),
    /** Riga di sintesi mostrata nell'indice (aiuta l'agente a decidere se aprire). */
    description: varchar('description', { length: 500 }),
    /** MIME dei file: `text/markdown`, `application/pdf`, … */
    mime: varchar('mime', { length: 100 }),
    /** Contenuto testuale editabile (markdown/txt). */
    content: text('content'),
    /** Chiave su disco per i binari caricati (PDF, immagini, …). */
    storageKey: text('storage_key'),
    /** Testo estratto dai binari, per lettura e ricerca degli agenti. */
    extractedText: text('extracted_text'),
    /** Byte del contenuto/binario, per la UI. */
    size: integer('size'),
    createdByType: varchar('created_by_type', { length: 8 }).notNull(), // user | agent
    createdById: uuid('created_by_id'),
    updatedByType: varchar('updated_by_type', { length: 8 }),
    updatedById: uuid('updated_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('documents_ws_parent_idx').on(t.workspaceId, t.parentId),
    uniqueIndex('documents_sibling_name_idx').on(t.workspaceId, t.parentId, t.name),
  ],
);

/* ---------------------------------------------------------------------------
 * Token dei runner locali: legano un runner (sul computer di una persona) al
 * suo account e al suo progetto. Il runner si autentica col token via HTTPS,
 * senza mai toccare il database né i segreti del server.
 * ------------------------------------------------------------------------ */
export const runnerTokens = pgTable(
  'runner_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 del token: il valore in chiaro si mostra una volta sola. */
    tokenHash: text('token_hash').notNull(),
    label: varchar('label', { length: 80 }),
    /** Come si è presentato l'ultima volta: nome macchina e cartella di lavoro. */
    lastHost: varchar('last_host', { length: 120 }),
    lastWorkdir: text('last_workdir'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('runner_tokens_hash_idx').on(t.tokenHash),
    index('runner_tokens_user_idx').on(t.userId),
  ],
);

/* ---------------------------------------------------------------------------
 * Notifiche push: un'iscrizione per browser/dispositivo. La stessa persona ne
 * ha tante quante sono le installazioni da cui ha dato il permesso.
 * ------------------------------------------------------------------------ */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * URL del servizio push del browser: è l'identità del dispositivo.
     * Unico perché la stessa installazione, riscrivendosi, deve aggiornare la
     * riga che c'è già invece di lasciarne in giro una copia morta.
     */
    endpoint: text('endpoint').notNull(),
    /** Chiave pubblica del client e segreto di autenticazione, per cifrare il payload. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId),
  ],
);

/** Preferenze di notifica: una riga per persona, creata alla prima lettura. */
export const pushPrefs = pgTable('push_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  mentions: boolean('mentions').notNull().default(true),
  approvals: boolean('approvals').notNull().default(true),
  /** Spento di default: un turno che finisce non è una cosa urgente. */
  runFinished: boolean('run_finished').notNull().default(false),
  runnerOffline: boolean('runner_offline').notNull().default(true),
});
