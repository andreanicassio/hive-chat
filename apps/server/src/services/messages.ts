import { and, eq, inArray, sql as raw } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, schema } from '../db/index.js';
import { hub } from '../realtime/hub.js';
import { redisPub } from '../lib/redis.js';
import { serializeMessage } from './serialize.js';
import {
  MAX_HANDOFF_HOPS,
  parseMentions,
  redisChannels,
  type MentionRef,
  type RunJob,
} from '@hive/shared';

/* ---------------------------------------------------------------------------
 * Risoluzione delle menzioni
 * ------------------------------------------------------------------------ */

interface ResolvedMentions {
  refs: MentionRef[];
  /** Agenti taggati esplicitamente, in ordine di apparizione. */
  agents: Array<{ id: string; handle: string }>;
  everyone: boolean;
}

/**
 * Traduce gli handle testuali in riferimenti con id.
 * Gli handle non risolti restano nel testo ma non generano notifiche:
 * scrivere `<@pippo>` per un utente inesistente non deve far fallire l'invio.
 */
export async function resolveMentions(
  workspaceId: string,
  body: string,
): Promise<ResolvedMentions> {
  const parsed = parseMentions(body);
  if (parsed.length === 0) return { refs: [], agents: [], everyone: false };

  const handles = parsed.filter((p) => p.kind === 'user').map((p) => p.handle);
  const channelNames = parsed.filter((p) => p.kind === 'channel').map((p) => p.handle);
  const everyone = parsed.some((p) => p.kind === 'everyone');

  const [userRows, agentRows, channelRows] = await Promise.all([
    handles.length
      ? db
          .select({ id: schema.users.id, handle: schema.users.handle })
          .from(schema.users)
          .innerJoin(
            schema.workspaceMembers,
            and(
              eq(schema.workspaceMembers.userId, schema.users.id),
              eq(schema.workspaceMembers.workspaceId, workspaceId),
            ),
          )
          .where(inArray(schema.users.handle, handles))
      : Promise.resolve([]),
    handles.length
      ? db
          .select({ id: schema.agents.id, handle: schema.agents.handle })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.workspaceId, workspaceId),
              inArray(schema.agents.handle, handles),
              raw`${schema.agents.archivedAt} is null`,
            ),
          )
      : Promise.resolve([]),
    channelNames.length
      ? db
          .select({ id: schema.channels.id, name: schema.channels.name })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.workspaceId, workspaceId),
              inArray(schema.channels.name, channelNames),
            ),
          )
      : Promise.resolve([]),
  ]);

  const userByHandle = new Map(userRows.map((r) => [r.handle, r.id]));
  const agentByHandle = new Map(agentRows.map((r) => [r.handle, r.id]));
  const channelByName = new Map(channelRows.map((r) => [r.name, r.id]));

  const refs: MentionRef[] = [];
  const agents: Array<{ id: string; handle: string }> = [];

  for (const p of parsed) {
    if (p.kind === 'everyone') {
      refs.push({ type: 'everyone', id: null, handle: 'everyone' });
      continue;
    }
    if (p.kind === 'channel') {
      const id = channelByName.get(p.handle);
      if (id) refs.push({ type: 'channel', id, handle: p.handle });
      continue;
    }
    // Un handle può essere di un utente o di un agente, mai di entrambi:
    // l'unicità è garantita a livello di workspace in fase di creazione.
    const agentId = agentByHandle.get(p.handle);
    if (agentId) {
      refs.push({ type: 'agent', id: agentId, handle: p.handle });
      agents.push({ id: agentId, handle: p.handle });
      continue;
    }
    const userId = userByHandle.get(p.handle);
    if (userId) refs.push({ type: 'user', id: userId, handle: p.handle });
  }

  return { refs, agents, everyone };
}

/* ---------------------------------------------------------------------------
 * Pubblicazione di un messaggio
 * ------------------------------------------------------------------------ */

export interface PostMessageArgs {
  workspaceId: string;
  channelId: string;
  author: { type: 'user' | 'agent' | 'system'; id: string | null };
  body: string;
  threadRootId?: string | null;
  replyToId?: string | null;
  clientNonce?: string | null;
  runId?: string | null;
  /** Non far partire agenti (usato per i messaggi generati dagli agenti stessi). */
  skipTriggers?: boolean;
  /** Profondità nella catena di handoff fra agenti. */
  hop?: number;
}

export async function postMessage(args: PostMessageArgs) {
  const { refs, agents } = await resolveMentions(args.workspaceId, args.body);

  const values = {
    channelId: args.channelId,
    threadRootId: args.threadRootId ?? null,
    replyToId: args.replyToId ?? null,
    authorType: args.author.type,
    authorId: args.author.id,
    body: args.body,
    mentions: refs,
    runId: args.runId ?? null,
    clientNonce: args.clientNonce ?? null,
  };

  // L'indice unico sul nonce è parziale (`where client_nonce is not null`):
  // Postgres pretende lo stesso predicato nella ON CONFLICT, altrimenti non
  // riconosce l'indice. Senza nonce non c'è conflitto possibile, quindi
  // facciamo una insert semplice.
  const inserted = args.clientNonce
    ? await db
        .insert(schema.messages)
        .values(values)
        .onConflictDoNothing({
          target: [schema.messages.channelId, schema.messages.clientNonce],
          where: raw`${schema.messages.clientNonce} is not null`,
        })
        .returning()
    : await db.insert(schema.messages).values(values).returning();

  let row = inserted[0];
  if (!row) {
    // Conflitto sul nonce: recupera il messaggio già salvato.
    const existing = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, args.channelId),
          eq(schema.messages.clientNonce, args.clientNonce!),
        ),
      )
      .limit(1);
    row = existing[0];
    if (!row) throw new Error('impossibile salvare il messaggio');
    return { message: await serializeMessage(row, null), triggeredRuns: [] as string[] };
  }

  if (args.threadRootId) {
    await db
      .update(schema.messages)
      .set({ replyCount: raw`${schema.messages.replyCount} + 1` })
      .where(eq(schema.messages.id, args.threadRootId));
  }

  const message = await serializeMessage(row, null);

  await hub.publish(args.workspaceId, {
    packet: { t: 'message.new', message },
    channelId: args.channelId,
  });

  // Chi non sta guardando il canale deve comunque vedere il badge aggiornarsi.
  const triggeredRuns: string[] = [];
  if (!args.skipTriggers) {
    triggeredRuns.push(
      ...(await triggerAgents({
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        message: row,
        mentionedAgents: agents,
        hop: args.hop ?? 0,
      })),
    );
  }

  return { message, triggeredRuns };
}

/* ---------------------------------------------------------------------------
 * Attivazione degli agenti
 * ------------------------------------------------------------------------ */

interface TriggerArgs {
  workspaceId: string;
  channelId: string;
  message: typeof schema.messages.$inferSelect;
  mentionedAgents: Array<{ id: string; handle: string }>;
  hop: number;
}

/**
 * Decide quali agenti devono rispondere a questo messaggio.
 *
 * Regole:
 *  - un agente taggato risponde sempre, purché sia membro del canale;
 *  - un agente con `autoRespond` sul canale risponde anche senza tag,
 *    ma solo a messaggi umani (altrimenti due agenti si rincorrono);
 *  - oltre MAX_HANDOFF_HOPS passaggi la catena si ferma.
 */
async function triggerAgents(args: TriggerArgs): Promise<string[]> {
  if (args.hop >= MAX_HANDOFF_HOPS) return [];

  const isHuman = args.message.authorType === 'user';

  // Agenti membri del canale, con la loro impostazione di auto-risposta.
  const members = await db
    .select({
      agentId: schema.agents.id,
      handle: schema.agents.handle,
      autoRespond: schema.channelMembers.autoRespond,
      archivedAt: schema.agents.archivedAt,
    })
    .from(schema.channelMembers)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.channelMembers.memberId))
    .where(
      and(
        eq(schema.channelMembers.channelId, args.channelId),
        eq(schema.channelMembers.memberType, 'agent'),
      ),
    );

  const mentionedIds = new Set(args.mentionedAgents.map((a) => a.id));

  // Rispondere (con la funzione "rispondi") al messaggio DI un agente equivale
  // a rivolgersi a quell'agente, anche senza taggarlo: in chat è il gesto
  // naturale per proseguire un discorso con lui. Vale solo per le risposte
  // umane: fra agenti restano i passaggi di consegne espliciti, altrimenti
  // due bot potrebbero rimbalzarsi risposte all'infinito.
  let repliedToAgentId: string | null = null;
  if (args.message.replyToId && isHuman) {
    const parent = await db
      .select({ authorType: schema.messages.authorType, authorId: schema.messages.authorId })
      .from(schema.messages)
      .where(eq(schema.messages.id, args.message.replyToId))
      .limit(1);
    const p = parent[0];
    if (p?.authorType === 'agent' && p.authorId) repliedToAgentId = p.authorId;
  }

  const toRun: Array<{ id: string; handle: string }> = [];

  for (const m of members) {
    if (m.archivedAt) continue;
    // Un agente non risponde a sé stesso.
    if (args.message.authorType === 'agent' && args.message.authorId === m.agentId) {
      continue;
    }
    if (mentionedIds.has(m.agentId)) {
      toRun.push({ id: m.agentId, handle: m.handle });
    } else if (repliedToAgentId === m.agentId) {
      toRun.push({ id: m.agentId, handle: m.handle });
    } else if (m.autoRespond && isHuman) {
      toRun.push({ id: m.agentId, handle: m.handle });
    }
  }

  const runIds: string[] = [];
  for (const agent of toRun) {
    const runId = await enqueueRun({
      workspaceId: args.workspaceId,
      agentId: agent.id,
      channelId: args.channelId,
      triggerMessageId: args.message.id,
      prompt: args.message.body,
      hop: args.hop,
      fromAgentHandle:
        args.message.authorType === 'agent' ? (args.message.authorId ?? null) : null,
    });
    runIds.push(runId);
  }
  return runIds;
}

export interface EnqueueRunArgs {
  workspaceId: string;
  agentId: string;
  channelId: string;
  triggerMessageId: string | null;
  prompt: string;
  hop: number;
  fromAgentHandle: string | null;
}

/**
 * La bolla di risposta dell'agente cita il messaggio che l'ha attivato.
 * Così il suo lavoro (e lo stato "sta ragionando") resta ancorato alla
 * domanda, invece di comparire staccato in fondo alla conversazione.
 */

/**
 * Mette in coda un turno di agente.
 *
 * Crea subito la bolla del messaggio vuota così l'utente vede comparire
 * l'agente con lo stato "in coda" e il testo poi ci scorre dentro.
 */
export async function enqueueRun(args: EnqueueRunArgs): Promise<string> {
  const runId = randomUUID();

  const placeholder = await db
    .insert(schema.messages)
    .values({
      channelId: args.channelId,
      authorType: 'agent',
      authorId: args.agentId,
      body: '',
      mentions: [],
      replyToId: args.triggerMessageId,
      runId,
    })
    .returning();

  const responseMessage = placeholder[0]!;

  await db.insert(schema.agentRuns).values({
    id: runId,
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
    responseMessageId: responseMessage.id,
    status: 'queued',
    hop: args.hop + 1,
  });

  const message = await serializeMessage(responseMessage, null);
  await hub.publish(args.workspaceId, {
    packet: { t: 'message.new', message },
    channelId: args.channelId,
  });
  await hub.publish(args.workspaceId, {
    packet: {
      t: 'run.started',
      runId,
      agentId: args.agentId,
      channelId: args.channelId,
      messageId: responseMessage.id,
    },
    channelId: args.channelId,
  });

  const job: RunJob = {
    runId,
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
    responseMessageId: responseMessage.id,
    prompt: args.prompt,
    fromAgentHandle: args.fromAgentHandle,
    hop: args.hop + 1,
  };

  // Instradamento: un agente `local` gira sul computer del suo proprietario,
  // tramite il runner. Gli altri sul server. La coda è una lista Redis su cui
  // il consumatore giusto fa BRPOP.
  const owner = await db
    .select({
      execution: schema.agents.execution,
      ownerId: schema.agents.createdBy,
      runnerTokenId: schema.agents.runnerTokenId,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, args.agentId))
    .limit(1);
  const agentExec = owner[0];

  if (agentExec?.execution === 'local' && agentExec.ownerId) {
    // Se l'agente ha scelto UNA macchina, il lavoro va solo lì; altrimenti
    // finisce nella coda generica, servita dalla prima macchina accesa.
    const target = agentExec.runnerTokenId;
    const online = target
      ? await redisPub.exists(redisChannels.runnerPresenceById(target))
      : await redisPub.exists(redisChannels.runnerPresence(agentExec.ownerId));
    if (online) {
      await redisPub.lpush(
        target
          ? redisChannels.runnerQueueById(target)
          : redisChannels.runnerQueue(agentExec.ownerId),
        JSON.stringify(job),
      );
    } else {
      // Nome della macchina scelta, se ce n'è una: il messaggio dice quale.
      let machine: string | null = null;
      if (target) {
        const t = await db
          .select({ label: schema.runnerTokens.label })
          .from(schema.runnerTokens)
          .where(eq(schema.runnerTokens.id, target))
          .limit(1);
        machine = t[0]?.label ?? null;
      }
      await failRunnerOffline(runId, responseMessage.id, args.workspaceId, args.channelId, machine);
    }
  } else {
    await redisPub.lpush(redisChannels.runQueue, JSON.stringify(job));
  }

  return runId;
}

/**
 * Chiude subito il run con una nota chiara quando l'agente gira in locale ma
 * il suo runner è spento: il turno non può partire da nessun'altra parte.
 */
async function failRunnerOffline(
  runId: string,
  responseMessageId: string,
  workspaceId: string,
  channelId: string,
  machine: string | null = null,
): Promise<void> {
  const note = machine
    ? `_Questo agente gira sulla macchina «${machine}», che ora è spenta. Accendi lì il runner e riprova._`
    : '_Questo agente gira su una macchina con il runner, e nessuna è accesa in ' +
      'questo momento. Avvia il runner e riprova._';
  await db
    .update(schema.agentRuns)
    .set({ status: 'error', error: 'runner offline', endedAt: new Date() })
    .where(eq(schema.agentRuns.id, runId));
  await db.update(schema.messages).set({ body: note }).where(eq(schema.messages.id, responseMessageId));

  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, responseMessageId))
    .limit(1);
  if (rows[0]) {
    const message = await serializeMessage(rows[0], null);
    await hub.publish(workspaceId, { packet: { t: 'message.updated', message }, channelId });
  }
  await hub.publish(workspaceId, {
    packet: {
      t: 'run.status',
      runId,
      messageId: responseMessageId,
      status: 'error',
      error: 'runner offline',
    },
    channelId,
  });
}
