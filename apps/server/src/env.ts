import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Carica `.env` dalla radice del monorepo senza dipendenze esterne.
 * Non sovrascrive variabili già presenti nell'ambiente: in produzione
 * comandano systemd e l'ambiente reale, il file è solo per lo sviluppo.
 */
function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ o src/ → apps/server → apps → radice
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

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'deve essere 64 caratteri esadecimali (openssl rand -hex 32)');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_ORIGIN: z.string().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  AUTH_SECRET: hex32,
  SECRETS_KEY: hex32,

  ANTHROPIC_API_KEY: z.string().default(''),
  /**
   * Token long-lived dell'abbonamento Claude, da `claude setup-token`.
   * Se presente viene preferito alla API key (vedi HIVE_CLAUDE_AUTH).
   */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().default(''),
  /**
   * Come autenticare gli agenti Claude:
   *  `auto`         usa l'abbonamento se disponibile, altrimenti la API key
   *  `subscription` solo abbonamento; se manca, l'agente non parte
   *  `api-key`      solo API key, ignora l'abbonamento
   */
  HIVE_CLAUDE_AUTH: z.enum(['auto', 'subscription', 'api-key']).default('auto'),
  /**
   * Consente di leggere direttamente ~/.claude/.credentials.json quando non
   * c'è un token esplicito. Comodo su questa macchina, ma non funziona dentro
   * i container: lì serve per forza CLAUDE_CODE_OAUTH_TOKEN.
   */
  HIVE_CLAUDE_CREDENTIALS_FILE: z
    .string()
    .default(`${process.env.HOME ?? '/home/andrea'}/.claude/.credentials.json`),
  /** Chiave OpenRouter: abilita gli agenti assistente su modelli non-Claude. */
  OPENROUTER_API_KEY: z.string().default(''),
  HIVE_DEFAULT_MODEL: z.string().default('anthropic/claude-opus-4-8'),
  /** Ogni quante ore risincronizzare il catalogo modelli da OpenRouter. */
  MODEL_SYNC_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(12),

  AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  AGENT_CONTAINER_IDLE_TTL: z.coerce.number().int().min(60).default(900),
  AGENT_DEV_IMAGE: z.string().default('hive/dev-sandbox:latest'),
  AGENT_ISOLATION: z.enum(['docker', 'sandbox', 'none']).default('docker'),

  HIVE_WORKSPACE_ROOT: z.string().default('/srv/hive/workspaces'),
  HIVE_UPLOAD_ROOT: z.string().default('/srv/hive/uploads'),
  /** Dove finiscono gli artefatti pubblici (app desktop) serviti da nginx. */
  HIVE_DOWNLOAD_ROOT: z.string().default('/srv/hive/downloads'),
  /**
   * Segreto con cui la CI di GitHub pubblica sul server la build dell'app
   * (PUT /api/desktop/publish). Deve combaciare col secret DESKTOP_UPLOAD_TOKEN
   * su GitHub. Vuoto = pubblicazione disabilitata.
   */
  DESKTOP_UPLOAD_TOKEN: z.string().default(''),

  /** Se false, ci si registra solo con un codice d'invito valido. */
  ALLOW_OPEN_SIGNUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(
    `\nConfigurazione non valida. Controlla il file .env:\n${issues}\n\n` +
      `Suggerimento: copia .env.example in .env e genera i segreti con:\n` +
      `  openssl rand -hex 32\n`,
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
