import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { requireMembership, requireUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { encryptSecret, newInviteCode, secretHint } from '../lib/crypto.js';
import {
  agentChannelMap,
  serializeAgent,
  lastMessages,
  serializeChannel,
  serializeMessages,
  unreadCounts,
} from '../services/serialize.js';
import {
  createInviteSchema,
  createWorkspaceSchema,
  createGroupSchema,
  redisChannels,
  slugifyHandle,
  type Invite,
} from '@hive/shared';
import { redisPub } from '../lib/redis.js';
import { env } from '../env.js';
import { computeCapabilities, computeCapabilitiesFor } from '../services/capabilities.js';
import { usageReport } from '../services/usage.js';
import { budgetState } from '../services/budget.js';

/** Canali creati con ogni nuovo progetto, per non partire da una schermata vuota. */
const STARTER_CHANNELS = [
  { name: 'generale', topic: 'Conversazione di tutti i giorni', groupName: null },
  { name: 'annunci', topic: 'Comunicazioni importanti', groupName: null },
];

async function uniqueSlug(base: string): Promise<string> {
  const root = slugifyHandle(base);
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, candidate))
      .limit(1);
    if (taken.length === 0) return candidate;
  }
  return `${root}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------- crea un nuovo progetto */
  app.post('/api/workspaces', async (request, reply) => {
    const user = requireUser(request);
    const input = createWorkspaceSchema.parse(request.body);
    const slug = await uniqueSlug(input.slug ?? input.name);

    const created = await db
      .insert(schema.workspaces)
      .values({
        slug,
        name: input.name.trim(),
        iconEmoji: input.iconEmoji,
        createdBy: user.id,
      })
      .returning();
    const workspace = created[0]!;

    await db.insert(schema.workspaceMembers).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
    });

    // Canali iniziali, con l'utente già dentro.
    for (const [i, c] of STARTER_CHANNELS.entries()) {
      const ch = await db
        .insert(schema.channels)
        .values({
          workspaceId: workspace.id,
          name: c.name,
          topic: c.topic,
          position: i,
          createdBy: user.id,
        })
        .returning();
      await db.insert(schema.channelMembers).values({
        channelId: ch[0]!.id,
        memberType: 'user',
        memberId: user.id,
      });
    }

    await db.insert(schema.workspaceContext).values({ workspaceId: workspace.id });

    return reply.code(201).send({
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        iconEmoji: workspace.iconEmoji,
        createdAt: workspace.createdAt.toISOString(),
        role: 'owner' as const,
      },
    });
  });

  /* ------------------------------------- stato iniziale completo di un progetto */
  app.get('/api/workspaces/:workspaceId/bootstrap', async (request) => {
    const { workspaceId } = z
      .object({ workspaceId: z.uuid() })
      .parse(request.params);
    const { user, role } = await requireMembership(request, workspaceId);

    const [wsRows, groupRows, channelRows, agentRows, memberRows, unread, lastByChannel] =
      await Promise.all([
        db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1),
        db
          .select()
          .from(schema.channelGroups)
          .where(eq(schema.channelGroups.workspaceId, workspaceId))
          .orderBy(asc(schema.channelGroups.position)),
        db
          .select()
          .from(schema.channels)
          .where(
            and(eq(schema.channels.workspaceId, workspaceId), isNull(schema.channels.archivedAt)),
          )
          .orderBy(asc(schema.channels.position), asc(schema.channels.name)),
        db
          .select()
          .from(schema.agents)
          .where(and(eq(schema.agents.workspaceId, workspaceId), isNull(schema.agents.archivedAt)))
          .orderBy(asc(schema.agents.name)),
        db
          .select({
            id: schema.users.id,
            name: schema.users.name,
            handle: schema.users.handle,
            email: schema.users.email,
            avatarEmoji: schema.users.avatarEmoji,
            avatarColor: schema.users.avatarColor,
            role: schema.workspaceMembers.role,
            lastSeenAt: schema.users.lastSeenAt,
          })
          .from(schema.workspaceMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
          .where(eq(schema.workspaceMembers.workspaceId, workspaceId)),
        unreadCounts(workspaceId, user.id),
        lastMessages(workspaceId),
      ]);

    const workspace = wsRows[0];
    if (!workspace) throw notFound('Progetto non trovato');

    const agentChannels = await agentChannelMap(agentRows.map((a) => a.id));

    // Canali di cui l'utente è membro: gli altri pubblici restano scopribili.
    const myChannels = await db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.memberType, 'user'),
          eq(schema.channelMembers.memberId, user.id),
        ),
      );
    const joined = new Set(myChannels.map((r) => r.channelId));

    // Per gli agenti che girano in locale, segnaliamo se il runner del loro
    // proprietario è acceso in questo momento: la UI lo mostra.
    const localOwnerIds = [
      ...new Set(
        agentRows
          .filter((a) => a.execution === 'local' && a.createdBy)
          .map((a) => a.createdBy as string),
      ),
    ];
    const onlineOwners = new Set<string>();
    if (localOwnerIds.length > 0) {
      const flags = await Promise.all(
        localOwnerIds.map((id) => redisPub.exists(redisChannels.runnerPresence(id, workspaceId))),
      );
      localOwnerIds.forEach((id, i) => {
        if (flags[i]) onlineOwners.add(id);
      });
    }

    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        iconEmoji: workspace.iconEmoji,
        createdAt: workspace.createdAt.toISOString(),
        secretFallback: workspace.secretFallback,
        role,
      },
      groups: groupRows.map((g) => ({
        id: g.id,
        workspaceId: g.workspaceId,
        name: g.name,
        emoji: g.emoji,
        position: g.position,
      })),
      channels: channelRows
        // I privati a cui non appartieni non compaiono nemmeno.
        .filter((c) => c.visibility === 'public' || joined.has(c.id))
        .map((c) =>
          serializeChannel(c, {
            unreadCount: unread.get(c.id)?.unread ?? 0,
            hasMention: unread.get(c.id)?.mention ?? false,
            lastMessage: lastByChannel.get(c.id) ?? null,
            agentIds: agentRows
              .filter((a) => (agentChannels.get(a.id) ?? []).includes(c.id))
              .map((a) => a.id),
          }),
        ),
      agents: agentRows.map((a) =>
        serializeAgent(a, {
          channelIds: agentChannels.get(a.id) ?? [],
          ...(a.execution === 'local'
            ? { runnerOnline: a.createdBy ? onlineOwners.has(a.createdBy) : false }
            : {}),
        }),
      ),
      members: memberRows.map((m) => ({
        id: m.id,
        name: m.name,
        handle: m.handle,
        email: m.email,
        avatarEmoji: m.avatarEmoji,
        avatarColor: m.avatarColor,
        role: m.role,
        lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      })),
      joinedChannelIds: [...joined],
      /**
       * Capacità reali del server. Include il token dell'abbonamento e il
       * file credenziali, non solo le variabili d'ambiente: altrimenti la UI
       * direbbe "nessuna credenziale" mentre gli agenti stanno rispondendo.
       */
      capabilities: await computeCapabilitiesFor(workspaceId, user.id),
    };
  });

  /* ----------------------------------------------------- gruppi di canali */
  app.post('/api/workspaces/:workspaceId/groups', async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'member');
    const input = createGroupSchema.parse(request.body);

    const maxPos = await db
      .select({ position: schema.channelGroups.position })
      .from(schema.channelGroups)
      .where(eq(schema.channelGroups.workspaceId, workspaceId))
      .orderBy(asc(schema.channelGroups.position));

    const created = await db
      .insert(schema.channelGroups)
      .values({
        workspaceId,
        name: input.name.trim(),
        emoji: input.emoji ?? null,
        position: (maxPos.at(-1)?.position ?? -1) + 1,
      })
      .returning();

    return reply.code(201).send({ group: created[0] });
  });

  /* ------------------------------------------------------------- membri */
  /* ------------------------------------------------------------- ricerca */
  /*
   * Cerca fra i messaggi del progetto.
   *
   * Cerchiamo con ILIKE su un indice trigramma e non con la ricerca
   * full-text: qui si scrive in italiano e in inglese nella stessa frase, e
   * un dizionario che sa una lingua sola sbaglia lo stemming dell'altra. Il
   * trigramma non sa niente di nessuna lingua, quindi non sbaglia — e trova
   * anche i pezzi di parola, che è come si cerca davvero in una chat.
   *
   * Solo i canali di cui sei membro: la ricerca non è una porta di servizio
   * per leggere i canali privati altrui.
   */
  app.get('/api/workspaces/:workspaceId/search', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'member');
    const { q, limit } = z
      .object({
        q: z.string().trim().min(2).max(200),
        limit: z.coerce.number().int().min(1).max(50).default(30),
      })
      .parse(request.query);

    const mine = await db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
      .where(
        and(
          eq(schema.channels.workspaceId, workspaceId),
          eq(schema.channelMembers.memberType, 'user'),
          eq(schema.channelMembers.memberId, user.id),
        ),
      );
    const channelIds = mine.map((r) => r.channelId);
    if (channelIds.length === 0) return { results: [] };

    const rows = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.channelId, channelIds),
          isNull(schema.messages.deletedAt),
          ilike(schema.messages.body, `%${q}%`),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(limit);

    const messages = await serializeMessages(rows, { type: 'user', id: user.id });
    return { results: messages };
  });

  app.get('/api/workspaces/:workspaceId/members', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId);
    const rows = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        handle: schema.users.handle,
        email: schema.users.email,
        avatarEmoji: schema.users.avatarEmoji,
        avatarColor: schema.users.avatarColor,
        role: schema.workspaceMembers.role,
        joinedAt: schema.workspaceMembers.joinedAt,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    return { members: rows };
  });

  /* ------------------------------------------------------------- inviti */
  app.post('/api/workspaces/:workspaceId/invites', async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { user, role } = await requireMembership(request, workspaceId, 'admin');
    const input = createInviteSchema.parse(request.body);

    // Nessuno può invitare qualcuno più in alto di sé.
    if (input.role === 'owner' && role !== 'owner') {
      throw forbidden('Solo un owner può invitare altri owner');
    }

    const code = newInviteCode();
    const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);

    const created = await db
      .insert(schema.invites)
      .values({
        workspaceId,
        code,
        role: input.role,
        email: input.email ?? null,
        createdBy: user.id,
        expiresAt,
      })
      .returning();
    const row = created[0]!;

    const invite: Invite = {
      id: row.id,
      workspaceId: row.workspaceId,
      code: row.code,
      role: row.role as Invite['role'],
      email: row.email,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      usedAt: null,
      url: `${env.PUBLIC_ORIGIN}/invito/${row.code}`,
    };
    return reply.code(201).send({ invite });
  });

  app.get('/api/workspaces/:workspaceId/invites', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'admin');
    const rows = await db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.workspaceId, workspaceId))
      .orderBy(asc(schema.invites.createdAt));
    return {
      invites: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        code: r.code,
        role: r.role,
        email: r.email,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        usedAt: r.usedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        url: `${env.PUBLIC_ORIGIN}/invito/${r.code}`,
      })),
    };
  });

  /** Anteprima pubblica di un invito: serve alla pagina di registrazione. */
  app.get('/api/invites/:code', async (request) => {
    const { code } = z.object({ code: z.string().max(64) }).parse(request.params);
    const rows = await db
      .select({
        workspaceName: schema.workspaces.name,
        workspaceIcon: schema.workspaces.iconEmoji,
        role: schema.invites.role,
        email: schema.invites.email,
        expiresAt: schema.invites.expiresAt,
        usedAt: schema.invites.usedAt,
        revokedAt: schema.invites.revokedAt,
      })
      .from(schema.invites)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.invites.workspaceId))
      .where(eq(schema.invites.code, code))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('Invito non trovato');
    const valid = !row.usedAt && !row.revokedAt && row.expiresAt > new Date();
    return {
      valid,
      workspaceName: row.workspaceName,
      workspaceIcon: row.workspaceIcon,
      role: row.role,
      email: row.email,
    };
  });

  /** Accetta un invito da utente già registrato. */
  app.post('/api/invites/:code/accept', async (request) => {
    const { code } = z.object({ code: z.string().max(64) }).parse(request.params);
    const user = requireUser(request);

    const rows = await db.select().from(schema.invites).where(eq(schema.invites.code, code)).limit(1);
    const invite = rows[0];
    if (!invite) throw notFound('Invito non trovato');
    if (invite.usedAt || invite.revokedAt || invite.expiresAt <= new Date()) {
      throw badRequest('invite_expired', 'Invito non più valido');
    }
    if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw badRequest('invite_email_mismatch', 'Questo invito è per un altro indirizzo');
    }

    const existing = await db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, invite.workspaceId),
          eq(schema.workspaceMembers.userId, user.id),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(schema.workspaceMembers).values({
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role,
      });
      // Aggancia l'utente ai canali pubblici, altrimenti entra e non vede niente.
      const publicChannels = await db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.workspaceId, invite.workspaceId),
            eq(schema.channels.visibility, 'public'),
            isNull(schema.channels.archivedAt),
          ),
        );
      if (publicChannels.length > 0) {
        await db
          .insert(schema.channelMembers)
          .values(
            publicChannels.map((c) => ({
              channelId: c.id,
              memberType: 'user' as const,
              memberId: user.id,
            })),
          )
          .onConflictDoNothing();
      }
    }

    await db
      .update(schema.invites)
      .set({ usedBy: user.id, usedAt: new Date() })
      .where(eq(schema.invites.id, invite.id));

    return { workspaceId: invite.workspaceId };
  });

  /* ------------------------------------------------------------ segreti */
  const secretKeySchema = z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'usa MAIUSCOLE_CON_UNDERSCORE');

  /* ------------------------------------------------ chiavi della PERSONA */
  //
  // Non stanno sul progetto: un turno lo paga chi lo chiede. Valgono in
  // tutti i progetti in cui l'utente sta, e non le vede nessun altro —
  // nemmeno il proprietario del progetto.
  app.get('/api/me/secrets', async (request) => {
    const user = requireUser(request);
    const rows = await db
      .select({
        key: schema.userSecrets.key,
        updatedAt: schema.userSecrets.updatedAt,
      })
      .from(schema.userSecrets)
      .where(eq(schema.userSecrets.userId, user.id));
    // Il valore non esce mai: si può sostituire, non rileggere.
    return { secrets: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
  });

  app.put('/api/me/secrets/:key', async (request) => {
    const user = requireUser(request);
    const { key } = z.object({ key: secretKeySchema }).parse(request.params);
    const { value } = z.object({ value: z.string().min(1).max(8000) }).parse(request.body);
    await db
      .insert(schema.userSecrets)
      .values({ userId: user.id, key, valueEncrypted: encryptSecret(value), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.userSecrets.userId, schema.userSecrets.key],
        set: { valueEncrypted: encryptSecret(value), updatedAt: new Date() },
      });
    return { ok: true, key };
  });

  app.delete('/api/me/secrets/:key', async (request) => {
    const user = requireUser(request);
    const { key } = z.object({ key: secretKeySchema }).parse(request.params);
    await db
      .delete(schema.userSecrets)
      .where(and(eq(schema.userSecrets.userId, user.id), eq(schema.userSecrets.key, key)));
    return { ok: true };
  });

  app.get('/api/workspaces/:workspaceId/secrets', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'admin');
    const rows = await db
      .select({
        key: schema.workspaceSecrets.key,
        hint: schema.workspaceSecrets.hint,
        updatedAt: schema.workspaceSecrets.updatedAt,
      })
      .from(schema.workspaceSecrets)
      .where(eq(schema.workspaceSecrets.workspaceId, workspaceId));
    // Il valore non esce mai dal server: solo il suggerimento.
    return { secrets: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
  });

  app.put('/api/workspaces/:workspaceId/secrets/:key', async (request) => {
    const { workspaceId, key } = z
      .object({ workspaceId: z.uuid(), key: secretKeySchema })
      .parse(request.params);
    const { user } = await requireMembership(request, workspaceId, 'admin');
    const { value } = z.object({ value: z.string().min(1).max(8000) }).parse(request.body);

    await db
      .insert(schema.workspaceSecrets)
      .values({
        workspaceId,
        key,
        valueEncrypted: encryptSecret(value),
        hint: secretHint(value),
        updatedBy: user.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.workspaceSecrets.workspaceId, schema.workspaceSecrets.key],
        set: {
          valueEncrypted: encryptSecret(value),
          hint: secretHint(value),
          updatedBy: user.id,
          updatedAt: new Date(),
        },
      });

    return { ok: true, key, hint: secretHint(value) };
  });

  app.delete('/api/workspaces/:workspaceId/secrets/:key', async (request) => {
    const { workspaceId, key } = z
      .object({ workspaceId: z.uuid(), key: secretKeySchema })
      .parse(request.params);
    await requireMembership(request, workspaceId, 'admin');
    await db
      .delete(schema.workspaceSecrets)
      .where(
        and(
          eq(schema.workspaceSecrets.workspaceId, workspaceId),
          eq(schema.workspaceSecrets.key, key),
        ),
      );
    return { ok: true };
  });

  /* ---------------------------------------------- contesto condiviso */
  app.get('/api/workspaces/:workspaceId/context', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId);
    const rows = await db
      .select()
      .from(schema.workspaceContext)
      .where(eq(schema.workspaceContext.workspaceId, workspaceId))
      .limit(1);
    const row = rows[0];
    return {
      context: {
        workspaceId,
        autoSummary: row?.autoSummary ?? null,
        manualNotes: row?.manualNotes ?? null,
        autoUpdatedAt: row?.autoUpdatedAt?.toISOString() ?? null,
        manualUpdatedAt: row?.manualUpdatedAt?.toISOString() ?? null,
      },
    };
  });

  /* --------------------------------------------------- utilizzo e costi */
  /* --------------------------------------------- tetto di spesa mensile */
  app.put('/api/workspaces/:workspaceId/budget', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'admin');
    const { monthlyBudgetUsd } = z
      .object({ monthlyBudgetUsd: z.number().min(0).max(100000).nullable() })
      .parse(request.body);
    await db
      .update(schema.workspaces)
      .set({ monthlyBudgetUsd: monthlyBudgetUsd === null ? null : String(monthlyBudgetUsd) })
      .where(eq(schema.workspaces.id, workspaceId));
    return { budget: await budgetState(workspaceId) };
  });

  /**
   * Se manca la chiave della persona, si usa quella del progetto?
   *
   * Lo decide chi possiede il progetto, ed è spento di default: se la spesa
   * deve essere di ciascuno, il default deve dirlo. Acceso è comodo e
   * riporta al problema che questa funzione esiste per risolvere.
   */
  app.put('/api/workspaces/:workspaceId/secret-fallback', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'owner');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    await db
      .update(schema.workspaces)
      .set({ secretFallback: enabled })
      .where(eq(schema.workspaces.id, workspaceId));
    return { ok: true, secretFallback: enabled };
  });

  app.get('/api/workspaces/:workspaceId/usage', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    // Solo admin/owner vedono i costi del progetto.
    await requireMembership(request, workspaceId, 'admin');
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(request.query);
    const report = await usageReport(workspaceId, days);
    return { ...report, budget: await budgetState(workspaceId) };
  });

  app.put('/api/workspaces/:workspaceId/context', async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await requireMembership(request, workspaceId, 'admin');
    const { manualNotes } = z
      .object({ manualNotes: z.string().max(20000).nullable() })
      .parse(request.body);

    await db
      .insert(schema.workspaceContext)
      .values({ workspaceId, manualNotes, manualUpdatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.workspaceContext.workspaceId,
        set: { manualNotes, manualUpdatedAt: new Date() },
      });
    return { ok: true };
  });
}
