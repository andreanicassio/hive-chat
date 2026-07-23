import type { FastifyReply, FastifyRequest } from 'fastify';
// Import di solo effetto: porta con sé le augmentation di tipo che aggiungono
// `reply.setCookie` / `request.cookies` all'interfaccia di Fastify.
import '@fastify/cookie';
import { and, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { sha256 } from './crypto.js';
import { forbidden, notFound, unauthorized } from './errors.js';
import { roleAtLeast, type WorkspaceRole } from '@hive/shared';
import { env, isProd } from '../env.js';

export const SESSION_COOKIE = 'hive_session';
/** Durata della sessione. Rinnovata a ogni uso (sliding window). */
export const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  handle: string;
  avatarEmoji: string | null;
  avatarColor: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    sessionId?: string;
  }
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Il server gira dietro nginx in HTTP sulla LAN: forzare `secure` qui
    // impedirebbe il login. Va acceso quando si mette HTTPS davanti.
    secure: isProd && env.PUBLIC_ORIGIN.startsWith('https://'),
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Risolve la sessione dal cookie. Non lancia: popola `request.user` se il
 * token è valido, altrimenti lascia tutto indefinito.
 */
export async function loadSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;

  const rows = await db
    .select({
      sessionId: schema.authSessions.id,
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      handle: schema.users.handle,
      avatarEmoji: schema.users.avatarEmoji,
      avatarColor: schema.users.avatarColor,
    })
    .from(schema.authSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
    .where(
      and(
        eq(schema.authSessions.tokenHash, sha256(token)),
        gt(schema.authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return;

  request.user = {
    id: row.userId,
    email: row.email,
    name: row.name,
    handle: row.handle,
    avatarEmoji: row.avatarEmoji,
    avatarColor: row.avatarColor,
  };
  request.sessionId = row.sessionId;

  // Sliding window: prolunga la sessione e traccia l'ultimo accesso.
  // Non blocchiamo la richiesta su questa scrittura.
  const next = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  void db
    .update(schema.authSessions)
    .set({ lastUsedAt: new Date(), expiresAt: next })
    .where(eq(schema.authSessions.id, row.sessionId))
    .catch(() => {});
}

/** Richiede un utente autenticato. */
export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

/**
 * Verifica che l'utente appartenga al workspace con almeno il ruolo indicato.
 * Restituisce il ruolo effettivo per i controlli più fini a valle.
 */
export async function requireMembership(
  request: FastifyRequest,
  workspaceId: string,
  minRole: WorkspaceRole = 'guest',
): Promise<{ user: AuthUser; role: WorkspaceRole }> {
  const user = requireUser(request);

  const rows = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, user.id),
      ),
    )
    .limit(1);

  const row = rows[0];
  // Non riveliamo l'esistenza di workspace a cui non si appartiene.
  if (!row) throw notFound('Progetto non trovato');

  const role = row.role as WorkspaceRole;
  if (!roleAtLeast(role, minRole)) {
    throw forbidden(`Serve il ruolo ${minRole} o superiore`);
  }
  return { user, role };
}

/** Risolve il workspace a partire da un canale, verificando l'accesso. */
export async function requireChannelAccess(
  request: FastifyRequest,
  channelId: string,
  minRole: WorkspaceRole = 'guest',
): Promise<{ user: AuthUser; role: WorkspaceRole; workspaceId: string }> {
  const rows = await db
    .select({
      workspaceId: schema.channels.workspaceId,
      visibility: schema.channels.visibility,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);

  const channel = rows[0];
  if (!channel) throw notFound('Canale non trovato');

  const { user, role } = await requireMembership(request, channel.workspaceId, minRole);

  // Sui canali privati serve essere membri espliciti.
  if (channel.visibility === 'private') {
    const member = await db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, 'user'),
          eq(schema.channelMembers.memberId, user.id),
        ),
      )
      .limit(1);
    if (member.length === 0 && !roleAtLeast(role, 'admin')) {
      throw notFound('Canale non trovato');
    }
  }

  return { user, role, workspaceId: channel.workspaceId };
}
