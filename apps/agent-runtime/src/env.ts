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
  /**
   * Isolamento degli agenti SVILUPPATORE (quelli con shell e filesystem):
   *  `docker` (default) — ogni turno gira dentro un container che monta solo
   *     la cartella del progetto: l'agente non vede né `~/.claude`, né `.env`,
   *     né gli altri progetti. È il confine forte, consigliato in produzione.
   *  `sandbox` — sandbox nativo dell'SDK (bubblewrap su Linux). Più leggero,
   *     ma su Ubuntu con `apparmor_restrict_unprivileged_userns=1` non parte e
   *     comunque non confina le letture. Tenuto solo per macchine non blindate.
   *  `none` — nessun isolamento. Solo se ti fidi di tutto il codice eseguito.
   */
  AGENT_ISOLATION: z.enum(['docker', 'sandbox', 'none']).default('docker'),
  HIVE_WORKSPACE_ROOT: z.string().default('/srv/hive/workspaces'),

  /**
   * Se impostato, questo processo è il RUNNER LOCALE di quell'utente: gira sul
   * suo computer, prende in carico solo i turni degli agenti `local` di sua
   * proprietà (coda dedicata), e annuncia la propria presenza. Lasciandolo
   * vuoto, il processo è il normale worker del server.
   */
  HIVE_RUNNER_USER_ID: z.string().uuid().optional(),
  /** Progetto servito dal runner "storico" a DB: le code sono per progetto. */
  HIVE_RUNNER_WORKSPACE_ID: z.string().uuid().optional(),
  /** Nome mostrato per questo runner (facoltativo, solo per i log). */
  HIVE_RUNNER_NAME: z.string().default(''),
  /**
   * Cartella di codice "viva" su cui far lavorare gli agenti sviluppatore di
   * questo runner: è il TUO codice già sul disco (dove di solito apri Claude
   * Code), non un clone. Se impostata, l'agente lavora direttamente lì e non
   * viene clonato nulla da GitHub. È il modo per replicare in chat il flusso
   * "SSH nel server → Claude Code nella cartella → lavoro live".
   */
  HIVE_RUNNER_WORKDIR: z.string().optional(),

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
