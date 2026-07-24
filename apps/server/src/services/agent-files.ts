import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redisPub } from '../lib/redis.js';
import { env } from '../env.js';
import { badRequest } from '../lib/errors.js';
import { redisChannels } from '@hive/shared';

/**
 * Lettura/scrittura del CLAUDE.md del progetto su cui lavora un agente.
 *
 * Il file è quello VERO sul disco, nella cartella di lavoro dell'agente:
 *  - agente `server`  → cartella sul server, la tocchiamo direttamente;
 *  - agente `local`   → sta sul computer della persona: passiamo dal runner
 *    con un comando fuori turno (il runner deve essere acceso).
 */

export interface ClaudeMdResult {
  content: string;
  path: string;
  /** `server` = file sul server, `runner` = file sulla macchina dell'utente. */
  source: 'server' | 'runner';
  exists: boolean;
}

/** Cartella di lavoro di un agente che gira SUL SERVER. */
export function serverWorkDir(agent: { id: string; workspaceId: string; kind: string }): string {
  const base = join(env.HIVE_WORKSPACE_ROOT, agent.workspaceId);
  return agent.kind === 'developer' ? join(base, 'project') : join(base, 'scratch', agent.id);
}

/* ----------------------------------------------------- comandi al runner */

interface RunnerCommand {
  id: string;
  op: 'claudeMd.read' | 'claudeMd.write';
  content?: string;
}

/** Invia un comando al runner dell'utente e ne attende il risultato. */
async function askRunner(
  userId: string,
  command: Omit<RunnerCommand, 'id'>,
): Promise<{ ok: boolean; content?: string; path?: string; exists?: boolean; error?: string }> {
  const online = await redisPub.get(redisChannels.runnerPresence(userId));
  if (!online) {
    throw badRequest(
      'runner_offline',
      'Il runner sul tuo computer è spento: accendilo per leggere o modificare il CLAUDE.md del progetto.',
    );
  }
  const id = randomUUID();
  await redisPub.lpush(
    redisChannels.runnerCommands(userId),
    JSON.stringify({ id, ...command } satisfies RunnerCommand),
  );
  // Il runner fa poll ogni pochi secondi: aspettiamo il risultato.
  const key = redisChannels.runnerCommandResult(id);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const raw = await redisPub.get(key);
    if (raw) {
      await redisPub.del(key);
      return JSON.parse(raw) as { ok: boolean; content?: string; path?: string; exists?: boolean; error?: string };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw badRequest('runner_timeout', 'Il runner non ha risposto in tempo. È ancora acceso?');
}

/* ------------------------------------------------------------- lettura */

export async function readClaudeMd(agent: {
  id: string;
  workspaceId: string;
  kind: string;
  execution: string;
  createdBy: string | null;
}): Promise<ClaudeMdResult> {
  if (agent.execution === 'local') {
    if (!agent.createdBy) throw badRequest('no_owner', 'Agente senza proprietario.');
    const res = await askRunner(agent.createdBy, { op: 'claudeMd.read' });
    if (!res.ok) throw badRequest('runner_error', res.error ?? 'Lettura fallita sul runner.');
    return {
      content: res.content ?? '',
      path: res.path ?? 'CLAUDE.md',
      source: 'runner',
      exists: res.exists ?? false,
    };
  }
  const dir = serverWorkDir(agent);
  const path = join(dir, 'CLAUDE.md');
  try {
    return { content: await readFile(path, 'utf8'), path, source: 'server', exists: true };
  } catch {
    return { content: '', path, source: 'server', exists: false };
  }
}

/* ------------------------------------------------------------ scrittura */

export async function writeClaudeMd(
  agent: {
    id: string;
    workspaceId: string;
    kind: string;
    execution: string;
    createdBy: string | null;
  },
  content: string,
): Promise<ClaudeMdResult> {
  if (agent.execution === 'local') {
    if (!agent.createdBy) throw badRequest('no_owner', 'Agente senza proprietario.');
    const res = await askRunner(agent.createdBy, { op: 'claudeMd.write', content });
    if (!res.ok) throw badRequest('runner_error', res.error ?? 'Scrittura fallita sul runner.');
    return { content, path: res.path ?? 'CLAUDE.md', source: 'runner', exists: true };
  }
  const dir = serverWorkDir(agent);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'CLAUDE.md');
  await writeFile(path, content, 'utf8');
  return { content, path, source: 'server', exists: true };
}
