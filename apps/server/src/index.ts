import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, isProd } from './env.js';
import { AppError } from './lib/errors.js';
import { loadSession } from './lib/auth.js';
import { closeDb } from './db/index.js';
import { closeRedis } from './lib/redis.js';
import { hub } from './realtime/hub.js';
import { startModelSync } from './services/models.js';
import { startRunReaper } from './services/reaper.js';

import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { channelRoutes } from './routes/channels.js';
import { agentRoutes } from './routes/agents.js';
import { approvalRoutes } from './routes/approvals.js';
import { artifactRoutes } from './routes/artifacts.js';
import { documentRoutes } from './routes/documents.js';
import { fileRoutes } from './routes/files.js';
import { desktopRoutes } from './routes/desktop.js';
import { runnerTokenRoutes } from './routes/runner.js';
import { runnerApiRoutes } from './routes/runner-api.js';
import { websocketRoutes } from './realtime/ws.js';

const app = Fastify({
  logger: isProd
    ? { level: 'info' }
    : {
        level: 'info',
        transport: undefined,
      },
  // nginx sta davanti: senza questo `request.ip` sarebbe sempre 127.0.0.1
  // e il rate limit colpirebbe tutti insieme.
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(cookie, { secret: env.AUTH_SECRET });
await app.register(cors, {
  origin: isProd ? [env.PUBLIC_ORIGIN] : true,
  credentials: true,
});
await app.register(rateLimit, {
  max: 600,
  timeWindow: '1 minute',
  // Il realtime passa da WebSocket, non da HTTP: non va limitato qui.
  allowList: (req) => req.url.startsWith('/ws'),
});
await app.register(websocket, {
  options: { maxPayload: 1024 * 1024 },
});
// Upload dei documenti (PDF, ecc.): fino a 25 MB per file.
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/* Risolve la sessione per ogni richiesta prima degli handler. */
app.addHook('onRequest', async (request) => {
  await loadSession(request);
});

/* Gestione centralizzata degli errori: niente stack trace verso il client. */
app.setErrorHandler((error, request, reply) => {
  if (error instanceof AppError) {
    return reply
      .code(error.status)
      .send({ error: { code: error.code, message: error.message, details: error.details } });
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return reply.code(400).send({
      error: {
        code: 'validation_error',
        message: first
          ? `${first.path.join('.') || 'campo'}: ${first.message}`
          : 'Dati non validi',
        details: error.issues,
      },
    });
  }
  if ((error as { statusCode?: number }).statusCode === 429) {
    return reply
      .code(429)
      .send({ error: { code: 'rate_limited', message: 'Troppe richieste, riprova tra poco' } });
  }

  request.log.error({ err: error }, 'errore non gestito');
  return reply
    .code(500)
    .send({ error: { code: 'internal_error', message: 'Errore interno del server' } });
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
    return reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Endpoint non trovato' } });
  }
  // Tutto il resto è una rotta del client: serviamo la SPA.
  return reply.sendFile('index.html');
});

/* --------------------------------------------------------------- rotte */

app.get('/api/health', async () => ({
  ok: true,
  time: new Date().toISOString(),
  connections: hub.size,
}));

await app.register(authRoutes);
await app.register(workspaceRoutes);
await app.register(channelRoutes);
await app.register(agentRoutes);
await app.register(approvalRoutes);
await app.register(artifactRoutes);
await app.register(documentRoutes);
await app.register(fileRoutes);
await app.register(desktopRoutes);
await app.register(runnerTokenRoutes);
await app.register(runnerApiRoutes);
await app.register(websocketRoutes);

/* In produzione il server serve anche i file statici della PWA. */
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(staticPlugin, { root: webDist, wildcard: false });
  app.log.info(`interfaccia servita da ${webDist}`);
}

/* ------------------------------------------------------------- avvio */

startModelSync();
// Chiude i turni rimasti appesi (macchina morta, conferma mai data).
startRunReaper();

const close = async (signal: string) => {
  app.log.info(`ricevuto ${signal}, chiusura in corso`);
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
};
process.on('SIGTERM', () => void close('SIGTERM'));
process.on('SIGINT', () => void close('SIGINT'));

try {
  await app.listen({ host: env.SERVER_HOST, port: env.SERVER_PORT });
  app.log.info(`Hive in ascolto su http://${env.SERVER_HOST}:${env.SERVER_PORT}`);
} catch (err) {
  app.log.error({ err }, 'avvio fallito');
  process.exit(1);
}
