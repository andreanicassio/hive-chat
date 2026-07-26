import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import type { RunJob } from '@hive/shared';
import { db } from './db.js';
import { env } from './env.js';
import { resolveClaudeAuth } from './auth.js';
import { MissingClaudeAuthError } from './auth.js';
import { resolveWorkDir } from './workspace.js';
import { RunEmitter } from './emitter.js';

/**
 * Esecuzione isolata di un turno di agente SVILUPPATORE dentro un container.
 *
 * L'idea è semplice: il container esegue *esattamente* lo stesso `executeJob`
 * del percorso in-process, ma monta soltanto la cartella del progetto. Così
 * l'agente — che ha shell e filesystem — non può leggere `~/.claude`, il
 * `.env` del server, gli altri progetti o i file di sistema fuori dalla sua
 * working directory. Il token dell'abbonamento entra come variabile
 * d'ambiente (mai come file montato) e il database si raggiunge via socket
 * unix, senza esporre nulla in rete.
 */

// dist/container.js → dist → agent-runtime → apps → radice del monorepo.
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../../..');

/** Costruisce una DATABASE_URL che punta al socket unix di Postgres. */
function socketDatabaseUrl(): string {
  const u = new URL(env.DATABASE_URL);
  const db = u.pathname.replace(/^\//, '');
  return `postgres://${u.username}:${u.password}@/${db}?host=/var/run/postgresql`;
}

/** L'immagine del sandbox è pronta sulla macchina? */
async function imageAvailable(): Promise<boolean> {
  return await new Promise((res) => {
    const p = spawn('docker', ['image', 'inspect', env.AGENT_DEV_IMAGE], {
      stdio: 'ignore',
    });
    p.on('error', () => res(false));
    p.on('close', (code) => res(code === 0));
  });
}

/** Lo stato del run è già finale (evita doppie chiusure della bolla). */
async function runIsTerminal(runId: string): Promise<boolean> {
  const rows = await db
    .select({ status: schema.agentRuns.status })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  const s = rows[0]?.status;
  return s === 'done' || s === 'error' || s === 'cancelled';
}

/** Chiude la bolla con un errore quando è il container stesso a non partire. */
async function failRun(job: RunJob, message: string): Promise<void> {
  const emitter = new RunEmitter({
    runId: job.runId,
    workspaceId: job.workspaceId,
    channelId: job.channelId,
    agentId: job.agentId,
    messageId: job.responseMessageId,
  });
  await emitter.event({ type: 'error', message }).catch(() => {});
  await emitter.finish({ status: 'error', error: message }).catch(() => {});
}

export async function runInContainer(job: RunJob): Promise<void> {
  // Pre-volo: se manca l'immagine o le credenziali Claude, meglio un errore
  // chiaro in chat che un container che parte e muore.
  if (!(await imageAvailable())) {
    await failRun(
      job,
      `L'immagine di isolamento «${env.AGENT_DEV_IMAGE}» non è disponibile. ` +
        `Costruiscila con lo script deploy/build-sandbox.sh e riprova.`,
    );
    return;
  }

  let authEnv: Record<string, string>;
  try {
    const auth = await resolveClaudeAuth(job.workspaceId, job.triggeredByUserId);
    authEnv = auth.envVars;
  } catch (err) {
    await failRun(
      job,
      err instanceof MissingClaudeAuthError
        ? err.message
        : `Impossibile risolvere le credenziali Claude: ${(err as Error).message}`,
    );
    return;
  }

  const workDir = await resolveWorkDir({
    workspaceId: job.workspaceId,
    agentId: job.agentId,
    kind: 'developer',
  });

  // La home di Claude Code (transcript delle sessioni per il `resume`, cache)
  // vive fuori dal progetto ma persiste fra un turno e l'altro dello stesso
  // workspace: senza, la continuità del filo si perderebbe a ogni container.
  const claudeHome = join(env.HIVE_WORKSPACE_ROOT, job.workspaceId, '.claude-home');
  await mkdir(claudeHome, { recursive: true });

  const containerName = `hive-run-${job.runId}`;

  // Variabili passate al processo dentro al container. Tutto ciò che serve a
  // `executeJob` per girare: DB e Redis via socket, chiave dei segreti,
  // credenziali dei modelli, e il job serializzato.
  const containerEnv: Record<string, string> = {
    NODE_ENV: 'production',
    HOME: '/home/node',
    DATABASE_URL: socketDatabaseUrl(),
    REDIS_URL: '/run/redis/redis-server.sock',
    SECRETS_KEY: env.SECRETS_KEY,
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    HIVE_CLAUDE_AUTH: env.HIVE_CLAUDE_AUTH,
    HIVE_WORKSPACE_ROOT: env.HIVE_WORKSPACE_ROOT,
    // Dentro al container il confine è il container stesso: niente bwrap.
    AGENT_ISOLATION: 'none',
    AGENT_RUN_TIMEOUT_MS: String(env.AGENT_RUN_TIMEOUT_MS),
    APPROVAL_TIMEOUT_MS: String(env.APPROVAL_TIMEOUT_MS),
    HIVE_JOB: JSON.stringify(job),
    ...authEnv,
  };

  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(containerEnv)) {
    if (v !== undefined && v !== '') envArgs.push('-e', `${k}=${v}`);
  }

  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--init',
    // Gira come uid/gid 1000: sull'host è l'utente `andrea`, quindi i file
    // creati nel repo restano suoi e non di root.
    '--user',
    '1000:1000',
    // Difesa in profondità: nessuna capability, nessun privilegio nuovo.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // Tetti di risorse: un build impazzito non deve mettere in ginocchio il server.
    '--memory',
    '2g',
    '--memory-swap',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '512',
    ...envArgs,
    // Codice dell'app in sola lettura, sugli STESSI percorsi assoluti dell'host
    // così i symlink dei workspace npm (@hive/*) si risolvono senza copie.
    '-v',
    `${appRoot}/node_modules:${appRoot}/node_modules:ro`,
    '-v',
    `${appRoot}/packages:${appRoot}/packages:ro`,
    '-v',
    `${appRoot}/apps:${appRoot}/apps:ro`,
    '-v',
    `${appRoot}/package.json:${appRoot}/package.json:ro`,
    // L'UNICA cartella scrivibile e l'UNICA parte del filesystem host visibile
    // all'agente: il progetto su cui lavora.
    '-v',
    `${workDir}:${workDir}:rw`,
    // Home di Claude Code, persistente per la continuità delle sessioni.
    '-v',
    `${claudeHome}:/home/node/.claude:rw`,
    // DB e coda via socket unix montati (nessuna porta esposta in rete).
    '-v',
    '/var/run/postgresql:/var/run/postgresql:ro',
    '-v',
    '/run/redis:/run/redis:ro',
    '-w',
    workDir,
    env.AGENT_DEV_IMAGE,
    'node',
    `${appRoot}/apps/agent-runtime/dist/run-in-container.js`,
  ];

  console.log(`[container] avvio ${containerName} per il run ${job.runId}`);

  const exitCode = await new Promise<number>((res) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });

    // Rete di sicurezza: se il container si pianta oltre il timeout del run,
    // lo abbattiamo. In condizioni normali è `executeJob` dentro al container
    // a gestire annullamento e timeout, emettendo lui la chiusura.
    const backstop = setTimeout(
      () => {
        console.warn(`[container] timeout backstop: killing ${containerName}`);
        spawn('docker', ['kill', containerName], { stdio: 'ignore' });
      },
      env.AGENT_RUN_TIMEOUT_MS + 60_000,
    );

    proc.on('error', (err) => {
      clearTimeout(backstop);
      console.error(`[container] impossibile lanciare docker:`, err.message);
      res(-1);
    });
    proc.on('close', (code) => {
      clearTimeout(backstop);
      res(code ?? -1);
    });
  });

  // Se il container è uscito con errore MA il run non risulta chiuso, la bolla
  // resterebbe appesa: la chiudiamo noi con un messaggio d'errore.
  if (exitCode !== 0 && !(await runIsTerminal(job.runId))) {
    await failRun(
      job,
      `Il container dell'agente è terminato in modo anomalo (codice ${exitCode}).`,
    );
  }
}
