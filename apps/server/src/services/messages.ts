import { and, eq, inArray, sql as raw, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, schema } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { hub } from '../realtime/hub.js';
import { notifyMentionForMessage, notifyRunnerOffline } from './notify.js';
import { redisPub } from '../lib/redis.js';
import { serializeMessage } from './serialize.js';
import { budgetState } from './budget.js';
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
  /** Allegati caricati prima dell'invio, da agganciare a questo messaggio. */
  attachmentIds?: string[];
}

export async function postMessage(args: PostMessageArgs) {
  const { refs, agents } = await resolveMentions(args.workspaceId, args.body);

  // Si può rispondere e aprire thread solo su messaggi di QUESTO canale.
  // Senza questo controllo si poteva citare un messaggio di un canale privato
  // (l'anteprima ne riporta autore ed estratto) o gonfiare il contatore delle
  // risposte di un messaggio altrui.
  for (const ref of [args.replyToId, args.threadRootId]) {
    if (!ref) continue;
    const target = await db
      .select({ channelId: schema.messages.channelId })
      .from(schema.messages)
      .where(eq(schema.messages.id, ref))
      .limit(1);
    if (!target[0] || target[0].channelId !== args.channelId) {
      throw badRequest('bad_reference', 'The quoted message is not in this channel.');
    }
  }

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
    if (!row) throw new Error("couldn't save the message");
    return { message: await serializeMessage(row, null), triggeredRuns: [] as string[] };
  }

  if (args.threadRootId) {
    await bumpReplyCount(args.workspaceId, args.threadRootId, 1);
  }

  // Aggancia gli allegati caricati prima dell'invio. Solo i propri e solo
  // quelli ancora liberi: così non ci si appropria dei file di altri.
  const uploader = args.author.type === 'user' ? args.author.id : null;
  if (args.attachmentIds?.length && uploader) {
    await db
      .update(schema.attachments)
      .set({ messageId: row.id })
      .where(
        and(
          inArray(schema.attachments.id, args.attachmentIds),
          eq(schema.attachments.workspaceId, args.workspaceId),
          eq(schema.attachments.uploadedBy, uploader),
          isNull(schema.attachments.messageId),
        ),
      );
  }

  const message = await serializeMessage(row, null);

  await hub.publish(args.workspaceId, {
    packet: { t: 'message.new', message },
    channelId: args.channelId,
  });

  // Notifica a chi è stato taggato. Fuori dal percorso della risposta HTTP:
  // se il servizio push è lento o rotto, l'invio del messaggio non deve
  // rallentare né fallire per questo.
  const mentionedUserIds = refs
    .filter((r) => r.type === 'user' && r.id)
    .map((r) => r.id as string);
  if (mentionedUserIds.length > 0 && args.author.type === 'user') {
    void notifyMentionForMessage({
      channelId: args.channelId,
      authorName: message.author.name,
      authorUserId: args.author.id,
      body: args.body,
      userIds: mentionedUserIds,
    }).catch((err: unknown) => console.error('[push] menzione:', err));
  }

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

/**
 * Muove il contatore delle risposte di una radice e ne ripubblica il DTO.
 *
 * Senza la ripubblicazione la barra «N risposte» resta ferma sul numero che il
 * client aveva quando ha caricato il canale: il thread vive in un'altra vista,
 * quindi nessun altro pacchetto la aggiorna. Il conteggio non scende sotto zero
 * — una cancellazione di troppo lo manderebbe in negativo per sempre.
 */
export async function bumpReplyCount(
  workspaceId: string,
  rootId: string,
  delta: 1 | -1,
): Promise<void> {
  const updated = await db
    .update(schema.messages)
    .set({
      replyCount:
        delta > 0
          ? raw`${schema.messages.replyCount} + 1`
          : raw`greatest(${schema.messages.replyCount} - 1, 0)`,
    })
    .where(eq(schema.messages.id, rootId))
    .returning();
  const root = updated[0];
  if (!root) return;
  const message = await serializeMessage(root, null);
  await hub.publish(workspaceId, {
    packet: { t: 'message.updated', message },
    channelId: root.channelId,
  });
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
      // Si risponde dove ci si è parlati: se l'innesco sta dentro un thread,
      // l'agente risponde lì. Se l'innesco è la RADICE di un thread
      // (`threadRootId` nullo) resta una conversazione di canale.
      threadRootId: args.message.threadRootId,
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
  /** Thread in cui l'agente deve rispondere, `null` per il canale. */
  threadRootId?: string | null;
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
/**
 * Fa partire i messaggi rimasti in attesa per un agente in un canale.
 *
 * Si chiama quando un turno finisce: se nel frattempo sono arrivati altri
 * messaggi, li uniamo in un solo turno nuovo — l'agente li legge tutti
 * insieme, come farebbe una persona che torna e trova due righe.
 */
export async function flushPendingPrompts(agentId: string, channelId: string): Promise<void> {
  const key = redisChannels.pendingPrompts(agentId, channelId);
  // Uno alla volta: il primo parte, gli altri restano in coda e toccherà a
  // loro quando anche questo avrà finito.
  const raw = await redisPub.rpop(key);
  if (!raw) return;
  const job = JSON.parse(raw) as RunJob;
  await dispatchJob(job);
}

/** Manda un turno già creato alla coda che lo eseguirà. */
async function dispatchJob(job: RunJob): Promise<void> {
  const agentExec = (
    await db
      .select({
        execution: schema.agents.execution,
        ownerId: schema.agents.createdBy,
        runnerTokenId: schema.agents.runnerTokenId,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, job.agentId))
      .limit(1)
  )[0];

  if (agentExec?.execution === 'local' && agentExec.ownerId) {
    const target = agentExec.runnerTokenId;

    // Senza una macchina scelta non si indovina. Prima si finiva su una coda
    // condivisa e il turno lo prendeva la prima accesa — ognuna con la sua
    // cartella di lavoro, spesso un altro repo: non era bilanciamento del
    // carico, era sorteggiare su quale codice si lavora. Adesso l'agente non
    // si può nemmeno salvare così; questo resta per le righe vecchie.
    if (!target) {
      await failRunnerOffline(
        job.runId,
        job.responseMessageId,
        job.workspaceId,
        job.channelId,
        null,
        'no_runner_chosen',
      );
      return;
    }

    if (await redisPub.exists(redisChannels.runnerPresenceById(target))) {
      await redisPub.lpush(redisChannels.runnerQueueById(target), JSON.stringify(job));
      return;
    }

    // Una macchina vista da poco probabilmente si sta solo riavviando (es.
    // per un aggiornamento): il lavoro resta in coda e lo prende appena
    // torna, invece di far comparire un errore per pochi secondi di assenza.
    const t = await db
      .select({ label: schema.runnerTokens.label, lastSeenAt: schema.runnerTokens.lastSeenAt })
      .from(schema.runnerTokens)
      .where(eq(schema.runnerTokens.id, target))
      .limit(1);
    const seen = t[0]?.lastSeenAt;
    if (seen && Date.now() - seen.getTime() < 5 * 60_000) {
      await redisPub.lpush(redisChannels.runnerQueueById(target), JSON.stringify(job));
      return;
    }

    await failRunnerOffline(
      job.runId,
      job.responseMessageId,
      job.workspaceId,
      job.channelId,
      t[0]?.label ?? null,
    );
    return;
  }
  await redisPub.lpush(redisChannels.runQueue, JSON.stringify(job));
}

/** Stati in cui un turno è ancora vivo. */
const ACTIVE_RUN_STATES = ['queued', 'running', 'awaiting_approval'];

/**
 * Ferma un turno, ovunque si trovi.
 *
 * Un turno può essere in tre posti diversi, e ognuno vuole il suo segnale:
 *
 * 1. **Ancora in coda.** Nessuno lo sta guardando, quindi non c'è niente da
 *    interrompere: lo marchiamo `cancelled` e chi lo preleverà lo salterà.
 *    Chiudiamo anche la sua bolla, altrimenti resterebbe un messaggio vuoto
 *    dell'agente lì per sempre — e uno stato non terminale blocca i messaggi
 *    successivi per quell'agente in quel canale.
 * 2. **In esecuzione sul worker del server.** È iscritto a `runCancel`: un
 *    publish gli fa abortire la query, e sarà lui a scrivere lo stato finale.
 * 3. **In esecuzione su un runner locale.** Non vede Redis. Lasciamo la
 *    bandierina `runCancelled`, che il runner incontra al primo invio di
 *    eventi (ne fa uno ogni mezzo secondo mentre lavora) e allora abortisce.
 *
 * Non sappiamo con certezza in quale dei tre casi siamo — fra la SELECT e il
 * segnale il turno può essere partito — quindi mandiamo tutti e tre. Costano
 * niente e sono innocui a vuoto.
 */
export async function cancelRun(runId: string): Promise<{ alreadyFinished: boolean }> {
  const rows = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  const run = rows[0];
  if (!run || !ACTIVE_RUN_STATES.includes(run.status)) return { alreadyFinished: true };

  // Dura un'ora: molto più di qualsiasi turno, ma non resta lì per sempre se
  // il runner che doveva leggerla non torna più.
  await redisPub.set(redisChannels.runCancelled(runId), '1', 'EX', 3600);
  await redisPub.publish(redisChannels.runCancel(runId), '1');

  // Solo se è ancora in coda: se è partito, lo stato finale lo scrive chi lo
  // sta eseguendo, e sovrascriverlo da qui vorrebbe dire correre con lui.
  const closed = await db
    .update(schema.agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
    .returning();

  if (closed.length > 0 && run.responseMessageId) {
    // Il turno era ancora in coda: l'agente non ha letto niente e non ha
    // scritto niente. La sua bolla non diventa una nota — «richiesta
    // annullata» racconta un fatto che non è successo — ma sparisce.
    await db.delete(schema.messages).where(eq(schema.messages.id, run.responseMessageId));
    await hub.publish(run.workspaceId, {
      packet: {
        t: 'message.deleted',
        channelId: run.channelId,
        messageId: run.responseMessageId,
        purged: true,
      },
      channelId: run.channelId,
    });
    await hub.publish(run.workspaceId, {
      packet: {
        t: 'run.status',
        runId,
        messageId: run.responseMessageId,
        status: 'cancelled',
        error: null,
      },
      channelId: run.channelId,
    });
  }

  return { alreadyFinished: false };
}

/**
 * Ferma i turni che un messaggio ha fatto partire.
 *
 * Serve quando qualcuno cancella un proprio messaggio: se quel messaggio ha
 * messo al lavoro un agente, la richiesta va ritirata. Cancellare il testo e
 * lasciare l'agente a rispondere a qualcosa che non c'è più sarebbe metà
 * lavoro, e costerebbe pure.
 */
export async function cancelRunsTriggeredBy(messageId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.triggerMessageId, messageId),
        inArray(schema.agentRuns.status, ACTIVE_RUN_STATES),
      ),
    );
  for (const row of rows) await cancelRun(row.id);
  return rows.length;
}

/**
 * Turno già in corso per questo agente in questo canale?
 *
 * Serve per non far partire due turni in parallelo sulla stessa sessione:
 * si pesterebbero i piedi a vicenda. Il secondo messaggio va in coda.
 */
async function activeRunFor(agentId: string, channelId: string): Promise<string | null> {
  const rows = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.agentId, agentId),
        eq(schema.agentRuns.channelId, channelId),
        inArray(schema.agentRuns.status, ACTIVE_RUN_STATES),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function enqueueRun(args: EnqueueRunArgs): Promise<string> {
  // Se l'agente sta già lavorando qui, il messaggio si accoda: lo riprenderà
  // appena finito, senza perdere nulla e senza turni sovrapposti.
  // Se l'agente sta già lavorando qui, ci sono due strade:
  //  - il turno in corso accetta input a caldo → il messaggio entra LÌ, e
  //    l'agente lo legge subito (come scrivere nel terminale mentre lavora);
  //  - altrimenti creiamo il turno ma lo lasciamo in coda.
  const queueBehind = await activeRunFor(args.agentId, args.channelId);
  if (queueBehind && (await redisPub.exists(redisChannels.steerable(queueBehind)))) {
    const delivered = await redisPub.publish(redisChannels.steer(queueBehind), args.prompt);
    // `publish` dice a quanti è arrivato: se a nessuno, il turno non stava
    // più ascoltando e ripieghiamo sulla coda.
    if (delivered > 0) return queueBehind;
  }

  const runId = randomUUID();

  // Con cosa parte questo turno. Si registra sul run perché la configurazione
  // dell'agente può cambiare mentre lavora: chi guarda deve vedere quello che
  // sta girando adesso, non quello che girerà la prossima volta.
  const agentConfig = (
    await db
      .select({ model: schema.agents.model, effort: schema.agents.effort })
      .from(schema.agents)
      .where(eq(schema.agents.id, args.agentId))
      .limit(1)
  )[0];
  // Tetto di spesa: se il progetto ha finito il budget del mese, il turno
  // non parte. Lo diciamo in chat invece di far sparire il messaggio.
  const budget = await budgetState(args.workspaceId);

  const threadRootId = args.threadRootId ?? null;

  const placeholder = await db
    .insert(schema.messages)
    .values({
      channelId: args.channelId,
      threadRootId,
      authorType: 'agent',
      authorId: args.agentId,
      body: '',
      mentions: [],
      replyToId: args.triggerMessageId,
      runId,
    })
    .returning();

  const responseMessage = placeholder[0]!;

  // Anche la bolla dell'agente è una risposta del thread: conta nel totale
  // della radice come conterebbe quella di una persona.
  if (threadRootId) await bumpReplyCount(args.workspaceId, threadRootId, 1);

  await db.insert(schema.agentRuns).values({
    id: runId,
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    channelId: args.channelId,
    triggerMessageId: args.triggerMessageId,
    responseMessageId: responseMessage.id,
    status: 'queued',
    model: agentConfig?.model ?? null,
    effort: agentConfig?.effort ?? null,
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
      triggerMessageId: args.triggerMessageId,
      model: agentConfig?.model ?? null,
      effort: agentConfig?.effort ?? null,
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
    threadRootId,
    prompt: args.prompt,
    fromAgentHandle: args.fromAgentHandle,
    hop: args.hop + 1,
  };

  if (budget.exceeded) {
    const note =
      `_Spending cap reached: this project has spent $${budget.spentUsd.toFixed(2)} ` +
      `of the $${budget.limitUsd?.toFixed(2)} set for this month. Raise the limit in ` +
      `Settings → Usage to start the agents again._`;
    await db
      .update(schema.agentRuns)
      .set({ status: 'error', error: 'budget exhausted', endedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    await db
      .update(schema.messages)
      .set({ body: note })
      .where(eq(schema.messages.id, responseMessage.id));
    const rows = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, responseMessage.id))
      .limit(1);
    if (rows[0]) {
      const updated = await serializeMessage(rows[0], null);
      await hub.publish(args.workspaceId, {
        packet: { t: 'message.updated', message: updated },
        channelId: args.channelId,
      });
    }
    await hub.publish(args.workspaceId, {
      packet: {
        t: 'run.status',
        runId,
        messageId: responseMessage.id,
        status: 'error',
        error: 'budget exhausted',
      },
      channelId: args.channelId,
    });
    return runId;
  }

  if (queueBehind) {
    await redisPub.lpush(
      redisChannels.pendingPrompts(args.agentId, args.channelId),
      JSON.stringify(job),
    );
    await redisPub.expire(redisChannels.pendingPrompts(args.agentId, args.channelId), 7200);
    return runId;
  }

  await dispatchJob(job);
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
  reason: 'offline' | 'no_runner_chosen' = 'offline',
): Promise<void> {
  const note =
    reason === 'no_runner_chosen'
      ? '_Questo agente gira su una macchina tua, ma non è stato detto quale. ' +
        'Aprilo e scegli la macchina: ognuna ha la sua cartella di lavoro._'
      : machine
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

  // Avvisa il proprietario dell'agente: è la notifica più utile di tutte,
  // perché altrimenti lo scopri solo aprendo la chat e vedendo il silenzio.
  const owner = await db
    .select({ userId: schema.agents.createdBy, name: schema.agents.name })
    .from(schema.agentRuns)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentRuns.agentId))
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  const row = owner[0];
  if (row?.userId) {
    void notifyRunnerOffline({
      userId: row.userId,
      agentName: row.name,
      channelId,
    }).catch((err: unknown) => console.error('[push] runner offline:', err));
  }
}
