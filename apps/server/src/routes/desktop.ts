import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join } from 'node:path';
import { env } from '../env.js';

/**
 * Distribuzione dell'app desktop.
 *
 * La CI di GitHub, dopo aver compilato l'app su macOS, ne carica qui il tarball
 * (autenticata da un token). Il server lo salva in una cartella pubblica che
 * nginx serve, così chiunque installa con un solo comando `curl` — e siccome
 * `curl` non mette il file in quarantena, macOS NON mostra l'errore "damaged".
 */
export async function desktopRoutes(app: FastifyInstance): Promise<void> {
  // Il corpo è il binario grezzo dell'app: lo lasciamo passare come stream.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  app.put(
    '/api/desktop/publish/:filename',
    { bodyLimit: 300 * 1024 * 1024 },
    async (request, reply) => {
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!env.DESKTOP_UPLOAD_TOKEN || token !== env.DESKTOP_UPLOAD_TOKEN) {
        return reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'token di pubblicazione non valido' } });
      }
      const { filename } = z.object({ filename: z.string().min(1).max(120) }).parse(request.params);
      const version = z
        .object({ version: z.string().max(40).optional() })
        .parse(request.query).version;

      const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '');
      if (!safe) {
        return reply.code(400).send({ error: { code: 'bad_name', message: 'nome file non valido' } });
      }

      await mkdir(env.HIVE_DOWNLOAD_ROOT, { recursive: true });
      const dest = join(env.HIVE_DOWNLOAD_ROOT, safe);
      await pipeline(request.body as NodeJS.ReadableStream, createWriteStream(dest));
      if (version) {
        await writeFile(join(env.HIVE_DOWNLOAD_ROOT, 'VERSION-mac'), version.trim(), 'utf8');
      }

      const size = existsSync(dest) ? statSync(dest).size : 0;
      request.log.info(`[desktop] pubblicato ${safe} (${size} byte)${version ? ` v${version}` : ''}`);
      return { ok: true, file: safe, size, version: version ?? null };
    },
  );
}
