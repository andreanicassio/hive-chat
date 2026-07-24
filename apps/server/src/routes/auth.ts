import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull, sql as raw } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  clearSessionCookie,
  requireUser,
  setSessionCookie,
  SESSION_TTL_DAYS,
} from '../lib/auth.js';
import { hashPassword, newSessionToken, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { colorFor, loginSchema, registerSchema, slugifyHandle } from '@hive/shared';
import { env } from '../env.js';

/** Cerca un handle libero partendo dal nome, aggiungendo un suffisso se serve. */
async function uniqueHandle(base: string): Promise<string> {
  const root = slugifyHandle(base);
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = attempt === 0 ? root : `${root}${attempt + 1}`;
    const taken = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.handle, candidate))
      .limit(1);
    if (taken.length === 0) return candidate;
  }
  return `${root}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------------------------------------- register */
  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const email = input.email.trim().toLowerCase();

    // Se le registrazioni libere sono chiuse serve un invito valido.
    let invite: typeof schema.invites.$inferSelect | undefined;
    if (input.inviteCode) {
      const rows = await db
        .select()
        .from(schema.invites)
        .where(
          and(
            eq(schema.invites.code, input.inviteCode),
            isNull(schema.invites.usedAt),
            isNull(schema.invites.revokedAt),
            gt(schema.invites.expiresAt, new Date()),
          ),
        )
        .limit(1);
      invite = rows[0];
      if (!invite) throw badRequest('invalid_invite', 'Invito non valido o scaduto');
      if (invite.email && invite.email.toLowerCase() !== email) {
        throw badRequest('invite_email_mismatch', 'Questo invito è per un altro indirizzo');
      }
    } else if (!env.ALLOW_OPEN_SIGNUP) {
      throw badRequest('invite_required', 'Serve un invito per registrarsi');
    }

    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(raw`lower(${schema.users.email}) = ${email}`)
      .limit(1);
    if (existing.length > 0) {
      throw conflict('email_taken', 'Esiste già un account con questa email');
    }

    const passwordHash = await hashPassword(input.password);
    const handle = await uniqueHandle(input.name);

    const created = await db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        name: input.name.trim(),
        handle,
        avatarColor: colorFor(email),
      })
      .returning();
    const user = created[0]!;

    // Un invito consumato aggancia subito l'utente al progetto.
    if (invite) {
      await db
        .insert(schema.workspaceMembers)
        .values({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role })
        .onConflictDoNothing();
      await db
        .update(schema.invites)
        .set({ usedBy: user.id, usedAt: new Date() })
        .where(eq(schema.invites.id, invite.id));
    }

    const { token, hash } = newSessionToken();
    await db.insert(schema.authSessions).values({
      userId: user.id,
      tokenHash: hash,
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
      ip: request.ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000),
    });
    setSessionCookie(reply, token);

    return reply.code(201).send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        handle: user.handle,
        avatarEmoji: user.avatarEmoji,
        avatarColor: user.avatarColor,
        createdAt: user.createdAt.toISOString(),
        lastSeenAt: null,
      },
      joinedWorkspaceId: invite?.workspaceId ?? null,
    });
  });

  /* ------------------------------------------------------------------- login */
  app.post(
    '/api/auth/login',
    // Il limite globale (600/min per IP) è troppo generoso per il login:
    // qui stringiamo, così tentare password a raffica non è praticabile.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const email = input.email.trim().toLowerCase();

    const rows = await db
      .select()
      .from(schema.users)
      .where(raw`lower(${schema.users.email}) = ${email}`)
      .limit(1);
    const user = rows[0];

    // Verifichiamo comunque una password fittizia quando l'utente non esiste,
    // così il tempo di risposta non rivela quali email sono registrate.
    const ok = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyPassword(
          '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$3f0Z0ZQZ0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
          input.password,
        );

    if (!user || !ok) throw unauthorized('Email o password non corretti');

    const { token, hash } = newSessionToken();
    await db.insert(schema.authSessions).values({
      userId: user.id,
      tokenHash: hash,
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
      ip: request.ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000),
    });
    await db
      .update(schema.users)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.users.id, user.id));

    setSessionCookie(reply, token);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        handle: user.handle,
        avatarEmoji: user.avatarEmoji,
        avatarColor: user.avatarColor,
        createdAt: user.createdAt.toISOString(),
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
      },
    };
  });

  /* ------------------------------------------------------------------ logout */
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.sessionId) {
      await db
        .delete(schema.authSessions)
        .where(eq(schema.authSessions.id, request.sessionId));
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  /* --------------------------------------------------------------------- me */
  app.get('/api/auth/me', async (request) => {
    const user = requireUser(request);
    const memberships = await db
      .select({
        id: schema.workspaces.id,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        iconEmoji: schema.workspaces.iconEmoji,
        createdAt: schema.workspaces.createdAt,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaces.id, schema.workspaceMembers.workspaceId),
      )
      .where(
        and(
          eq(schema.workspaceMembers.userId, user.id),
          isNull(schema.workspaces.archivedAt),
        ),
      )
      .orderBy(schema.workspaces.createdAt);

    return {
      user,
      workspaces: memberships.map((w) => ({
        id: w.id,
        slug: w.slug,
        name: w.name,
        iconEmoji: w.iconEmoji,
        createdAt: w.createdAt.toISOString(),
        role: w.role,
      })),
    };
  });
}
