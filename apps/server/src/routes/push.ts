import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  defaultPushPrefs,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  updatePushPrefsSchema,
} from '@hive/shared';
import { db, schema } from '../db/index.js';
import { requireUser } from '../lib/auth.js';
import { env } from '../env.js';
import { prefsFor } from '../services/notify.js';

/**
 * Iscrizione ai push e preferenze.
 *
 * L'iscrizione è per **dispositivo**, non per persona: chi usa Hive sul
 * telefono e sul portatile ha due righe, e togliersi dalle notifiche su uno
 * non deve zittire l'altro. Le preferenze invece sono per persona: «di cosa
 * voglio essere avvisato» non cambia da un dispositivo all'altro.
 */
export async function pushRoutes(app: FastifyInstance): Promise<void> {
  /** La chiave pubblica VAPID. `null` se il server non è configurato. */
  app.get('/api/push/key', async () => ({
    publicKey: env.VAPID_PUBLIC_KEY || null,
  }));

  app.post('/api/push/subscribe', async (request) => {
    const user = requireUser(request);
    const input = pushSubscribeSchema.parse(request.body);

    await db
      .insert(schema.pushSubscriptions)
      .values({
        userId: user.id,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
      })
      // Lo stesso endpoint può cambiare padrone: succede su un dispositivo
      // condiviso, o quando si esce e rientra con un altro account.
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: {
          userId: user.id,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          lastUsedAt: new Date(),
        },
      });

    return { ok: true as const };
  });

  app.delete('/api/push/subscribe', async (request) => {
    requireUser(request);
    const { endpoint } = pushUnsubscribeSchema.parse(request.body);
    await db
      .delete(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.endpoint, endpoint));
    return { ok: true as const };
  });

  app.get('/api/push/prefs', async (request) => {
    const user = requireUser(request);
    return { prefs: await prefsFor(user.id) };
  });

  app.patch('/api/push/prefs', async (request) => {
    const user = requireUser(request);
    const input = updatePushPrefsSchema.parse(request.body);

    await db
      .insert(schema.pushPrefs)
      .values({ userId: user.id, ...defaultPushPrefs, ...input })
      .onConflictDoUpdate({ target: schema.pushPrefs.userId, set: input });

    return { prefs: await prefsFor(user.id) };
  });
}
