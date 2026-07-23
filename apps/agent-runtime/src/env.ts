import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../.env'),
    resolve(here, '../../../../.env'),
    resolve(process.cwd(), '.env'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key in process.env) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return;
  }
}

loadDotEnv();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  SECRETS_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  PUBLIC_ORIGIN: z.string().default('http://localhost:8080'),

  ANTHROPIC_API_KEY: z.string().default(''),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().default(''),
  HIVE_CLAUDE_AUTH: z.enum(['auto', 'subscription', 'api-key']).default('auto'),
  HIVE_CLAUDE_CREDENTIALS_FILE: z
    .string()
    .default(`${process.env.HOME ?? '/home/andrea'}/.claude/.credentials.json`),
  OPENROUTER_API_KEY: z.string().default(''),

  AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  AGENT_CONTAINER_IDLE_TTL: z.coerce.number().int().min(60).default(900),
  AGENT_DEV_IMAGE: z.string().default('hive/dev-sandbox:latest'),
  AGENT_ISOLATION: z.enum(['docker', 'local']).default('docker'),
  HIVE_WORKSPACE_ROOT: z.string().default('/srv/hive/workspaces'),

  /** Timeout di un singolo turno di agente. */
  AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(20 * 60_000),
  /** Quanto attendere una conferma umana prima di considerarla scaduta. */
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    'Configurazione del runtime non valida:\n' +
      parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
  );
  process.exit(1);
}

export const env = parsed.data;
