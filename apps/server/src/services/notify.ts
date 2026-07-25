import { and, eq, inArray } from 'drizzle-orm';
import webpush, { WebPushError } from 'web-push';
import { defaultPushPrefs, type PushPayload, type PushPrefs } from '@hive/shared';
import { db, schema } from '../db/index.js';
import { redisPub } from '../lib/redis.js';
import { hub } from '../realtime/hub.js';
import { env } from '../env.js';

/**
 * Notifiche push.
 *
 * La parte difficile non è mandarle, è **non** mandarle. Una chat che avvisa
 * di tutto viene silenziata nel giro di un giorno, e a quel punto non serve
 * più a niente. Qui stanno le regole del silenzio, e sono più codice
 * dell'invio vero e proprio.
 */

const configured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:hive@dvnx.net',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
}

/** Finestra entro cui più avvisi sullo stesso canale diventano uno solo. */
const GROUP_WINDOW_SEC = 45;

/* -------------------------------------------------------------------------- */

export async function prefsFor(userId: string): Promise<PushPrefs> {
  const rows = await db
    .select()
    .from(schema.pushPrefs)
    .where(eq(schema.pushPrefs.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return defaultPushPrefs;
  return {
    mentions: row.mentions,
    approvals: row.approvals,
    runFinished: row.runFinished,
    runnerOffline: row.runnerOffline,
  };
}

/**
 * Manda davvero, a tutti i dispositivi di una persona.
 *
 * Un endpoint che risponde 404 o 410 è un dispositivo che non esiste più:
 * si cancella, altrimenti resta lì a far fallire ogni invio successivo.
 */
async function deliver(userId: string, payload: PushPayload): Promise<void> {
  if (!configured) return;
  const subs = await db
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId));
  if (subs.length === 0) return;

  const dead: string[] = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        const status = err instanceof WebPushError ? err.statusCode : 0;
        if (status === 404 || status === 410) dead.push(sub.endpoint);
        else console.error('[push] invio fallito:', (err as Error).message);
      }
    }),
  );

  if (dead.length > 0) {
    await db
      .delete(schema.pushSubscriptions)
      .where(inArray(schema.pushSubscriptions.endpoint, dead));
  }
}

/**
 * Il filtro che decide se una notifica parte.
 *
 * Tre no in fila, nell'ordine in cui costano meno: non a chi l'ha causata,
 * non di ciò che sta già guardando, non se ha detto di no.
 *
 * Non c'è nessun silenzio notturno: quello lo gestisce il dispositivo, che lo
 * fa meglio e in un posto solo. Duplicarlo qui avrebbe significato due
 * impostazioni in competizione, e notifiche che spariscono senza spiegazione.
 */
async function push(args: {
  userId: string;
  /** Chi ha causato l'evento: non si avvisa sé stessi. */
  actorUserId?: string | null;
  /** Se presente e la persona sta guardando questo canale, si tace. */
  channelId?: string | null;
  kind: keyof Pick<PushPrefs, 'mentions' | 'approvals' | 'runFinished' | 'runnerOffline'>;
  payload: PushPayload;
  /** Chiave per raggruppare: entro pochi secondi, il secondo avviso non parte. */
  groupKey?: string;
}): Promise<void> {
  if (!configured) return;
  if (args.actorUserId && args.actorUserId === args.userId) return;
  if (args.channelId && hub.isWatching(args.userId, args.channelId)) return;

  const prefs = await prefsFor(args.userId);
  if (!prefs[args.kind]) return;

  if (args.groupKey) {
    const key = `hive:push:grp:${args.userId}:${args.groupKey}`;
    const first = await redisPub.set(key, '1', 'EX', GROUP_WINDOW_SEC, 'NX');
    if (first === null) return;
  }

  await deliver(args.userId, args.payload);
}

/* --------------------------------- eventi --------------------------------- */

/** Qualcuno è stato taggato in un messaggio. */
export async function notifyMention(args: {
  channelId: string;
  channelName: string;
  authorName: string;
  authorUserId: string | null;
  excerpt: string;
  userIds: string[];
}): Promise<void> {
  await Promise.all(
    args.userIds.map((userId) =>
      push({
        userId,
        actorUserId: args.authorUserId,
        channelId: args.channelId,
        kind: 'mentions',
        groupKey: `m:${args.channelId}`,
        payload: {
          title: `${args.authorName} in #${args.channelName}`,
          body: args.excerpt,
          url: `/c/${args.channelId}`,
          tag: `mention:${args.channelId}`,
        },
      }),
    ),
  );
}

/** Un agente è fermo e aspetta una decisione. */
export async function notifyApproval(args: {
  userIds: string[];
  agentName: string;
  channelId: string;
  channelName: string;
  title: string;
}): Promise<void> {
  await Promise.all(
    args.userIds.map((userId) =>
      push({
        userId,
        // Niente `channelId`: anche guardando il canale, un permesso va
        // notificato — è bloccante, e la card si può perdere nello scroll.
        kind: 'approvals',
        payload: {
          title: `${args.agentName} chiede un permesso`,
          body: args.title,
          url: `/c/${args.channelId}`,
          tag: `approval:${args.channelId}`,
        },
      }),
    ),
  );
}

/** Un turno lanciato da qualcuno è finito. */
export async function notifyRunFinished(args: {
  userId: string;
  agentName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  cancelled: boolean;
}): Promise<void> {
  await push({
    userId: args.userId,
    channelId: args.channelId,
    kind: 'runFinished',
    payload: {
      title: `${args.agentName} ha finito`,
      body: args.cancelled ? 'Turno interrotto.' : `In #${args.channelName}`,
      url: `/c/${args.channelId}/m/${args.messageId}/lavoro`,
      tag: `run:${args.messageId}`,
    },
  });
}

/**
 * La macchina di qualcuno è spenta e il suo agente non può partire.
 *
 * È la notifica che qui vale più di tutte: senza, te ne accorgi solo aprendo
 * la chat e vedendo che non risponde nessuno.
 */
export async function notifyRunnerOffline(args: {
  userId: string;
  agentName: string;
  channelId: string;
}): Promise<void> {
  await push({
    userId: args.userId,
    kind: 'runnerOffline',
    groupKey: `offline:${args.agentName}`,
    payload: {
      title: 'Il tuo runner è spento',
      body: `${args.agentName} non può partire finché la tua macchina è offline.`,
      url: '/attivita',
      tag: 'runner-offline',
    },
  });
}

/** Gli utenti che fanno parte di un canale, per sapere chi avvisare. */
export async function channelMemberIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.channelMembers.memberId })
    .from(schema.channelMembers)
    .where(
      and(
        eq(schema.channelMembers.channelId, channelId),
        eq(schema.channelMembers.memberType, 'user'),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Prepara e manda la notifica di una menzione.
 *
 * Sta qui e non in `messages.ts` perché serve il nome del canale e un
 * estratto già ripulito dal markup: dettagli che riguardano la notifica, non
 * l'invio del messaggio.
 */
export async function notifyMentionForMessage(args: {
  channelId: string;
  authorName: string;
  authorUserId: string | null;
  body: string;
  userIds: string[];
}): Promise<void> {
  if (!configured || args.userIds.length === 0) return;
  const rows = await db
    .select({ name: schema.channels.name })
    .from(schema.channels)
    .where(eq(schema.channels.id, args.channelId))
    .limit(1);
  const channelName = rows[0]?.name ?? 'canale';

  const excerpt = args.body
    .replace(/<@([a-z0-9._-]+)>/g, '@$1')
    .replace(/<#([a-z0-9-]+)>/g, '#$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  await notifyMention({
    channelId: args.channelId,
    channelName,
    authorName: args.authorName,
    authorUserId: args.authorUserId,
    excerpt,
    userIds: args.userIds,
  });
}

/**
 * Avvisa chi aveva lanciato un turno che è finito.
 *
 * Si parte dal run e si risale al messaggio d'innesco: chi ha scritto quello
 * è la persona che aspetta la risposta. Se l'innesco è di un agente (una
 * catena di handoff) non si avvisa nessuno — non c'è una persona in attesa.
 */
export async function notifyRunFinishedById(runId: string): Promise<void> {
  if (!configured) return;
  const rows = await db
    .select({
      status: schema.agentRuns.status,
      channelId: schema.agentRuns.channelId,
      responseMessageId: schema.agentRuns.responseMessageId,
      agentName: schema.agents.name,
      authorType: schema.messages.authorType,
      authorId: schema.messages.authorId,
    })
    .from(schema.agentRuns)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentRuns.agentId))
    .innerJoin(schema.messages, eq(schema.messages.id, schema.agentRuns.triggerMessageId))
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run || run.authorType !== 'user' || !run.authorId || !run.responseMessageId) return;

  const channelRows = await db
    .select({ name: schema.channels.name })
    .from(schema.channels)
    .where(eq(schema.channels.id, run.channelId))
    .limit(1);

  await notifyRunFinished({
    userId: run.authorId,
    agentName: run.agentName,
    channelId: run.channelId,
    channelName: channelRows[0]?.name ?? 'canale',
    messageId: run.responseMessageId,
    cancelled: run.status === 'cancelled',
  });
}
