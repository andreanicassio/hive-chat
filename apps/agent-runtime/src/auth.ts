import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';
import { decryptSecret } from './crypto.js';
import { env } from './env.js';

/**
 * Autenticazione dei modelli Claude.
 *
 * Ordine di risoluzione, dal più specifico al più generale:
 *
 *   1. segreti del workspace          → ogni progetto può avere il proprio conto
 *   2. variabili d'ambiente del server
 *   3. file credenziali di Claude Code (~/.claude/.credentials.json)
 *
 * Dentro ciascun livello, `HIVE_CLAUDE_AUTH` decide se preferire il token
 * dell'abbonamento o la API key. Il default (`auto`) preferisce l'abbonamento.
 *
 * Nota sui container: il file delle credenziali NON è visibile dentro i
 * container degli agenti sviluppatore. Lì serve un token esplicito, che si
 * ottiene con `claude setup-token` ed è pensato apposta per l'uso headless.
 */

export interface ClaudeAuth {
  /** Variabili da passare al processo dell'SDK. */
  envVars: Record<string, string>;
  /** Come è stato autenticato, per la diagnostica e per la UI. */
  source:
    | 'user-oauth'
    | 'user-api-key'
    | 'workspace-oauth'
    | 'workspace-api-key'
    | 'server-oauth'
    | 'server-api-key'
    | 'credentials-file';
  usesSubscription: boolean;
}

export class MissingClaudeAuthError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'MissingClaudeAuthError';
  }
}

async function workspaceSecret(workspaceId: string, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: schema.workspaceSecrets.valueEncrypted })
    .from(schema.workspaceSecrets)
    .where(
      and(
        eq(schema.workspaceSecrets.workspaceId, workspaceId),
        eq(schema.workspaceSecrets.key, key),
      ),
    )
    .limit(1);
  const enc = rows[0]?.value;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    // Chiave di cifratura cambiata o dato corrotto: meglio ignorare che
    // far fallire il run con un errore criptico.
    console.warn(`[auth] segreto ${key} del workspace ${workspaceId} non decifrabile`);
    return null;
  }
}

/**
 * Le chiavi della PERSONA che ha innescato il turno.
 *
 * Vengono prima di tutto: un turno lo paga chi lo chiede. Prima stavano solo
 * sul progetto, quindi chiunque fosse invitato spendeva l'abbonamento di chi
 * l'aveva configurato — e il proprietario non aveva modo di accorgersene,
 * perché nemmeno registravamo chi avesse innescato cosa.
 */
async function userSecret(userId: string, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: schema.userSecrets.valueEncrypted })
    .from(schema.userSecrets)
    .where(and(eq(schema.userSecrets.userId, userId), eq(schema.userSecrets.key, key)))
    .limit(1);
  const enc = rows[0]?.value;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    console.warn(`[auth] segreto ${key} dell'utente ${userId} non decifrabile`);
    return null;
  }
}

/** Il progetto permette di ricadere sulle proprie chiavi? */
async function fallbackAllowed(workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ on: schema.workspaces.secretFallback })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.on ?? false;
}

/**
 * Legge il token dell'abbonamento dal file di Claude Code.
 * Restituisce null se assente o già scaduto: in quel caso è meglio passare
 * alla API key che far partire un run destinato a fallire.
 */
function tokenFromCredentialsFile(): string | null {
  const path = env.HIVE_CLAUDE_CREDENTIALS_FILE;
  if (!path || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && oauth.expiresAt <= Date.now()) {
      console.warn(
        '[auth] il token in .credentials.json è scaduto. ' +
          'Genera un token durevole con `claude setup-token`.',
      );
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/**
 * Con quali credenziali gira questo turno.
 *
 * Tre livelli, dal più specifico: la persona che l'ha chiesto, il progetto,
 * il server. Le chiavi del progetto entrano in gioco solo se il proprietario
 * ha acceso la ricaduta — spenta di default, perché se la spesa deve essere
 * di ciascuno il default deve dirlo.
 */
export async function resolveClaudeAuth(
  workspaceId: string,
  triggeredByUserId?: string | null,
): Promise<ClaudeAuth> {
  const mode = env.HIVE_CLAUDE_AUTH;
  const preferSubscription = mode === 'auto' || mode === 'subscription';

  const [userToken, userKey] = triggeredByUserId
    ? await Promise.all([
        userSecret(triggeredByUserId, 'CLAUDE_CODE_OAUTH_TOKEN'),
        userSecret(triggeredByUserId, 'ANTHROPIC_API_KEY'),
      ])
    : [null, null];

  // Chi ha la sua chiave non ha bisogno di nient'altro. Chi non ce l'ha
  // ricade sul progetto solo se il progetto lo consente; altrimenti resta
  // senza, e glielo diciamo in chiaro invece di far pagare qualcun altro.
  const hasOwn = Boolean(userToken || userKey);
  const canFallBack = hasOwn || !triggeredByUserId || (await fallbackAllowed(workspaceId));

  const [wsToken, wsKey] = canFallBack
    ? await Promise.all([
        workspaceSecret(workspaceId, 'CLAUDE_CODE_OAUTH_TOKEN'),
        workspaceSecret(workspaceId, 'ANTHROPIC_API_KEY'),
      ])
    : [null, null];

  const candidates: Array<{
    token: string | null;
    source: ClaudeAuth['source'];
    kind: 'oauth' | 'api-key';
  }> = preferSubscription
    ? [
        { token: userToken, source: 'user-oauth', kind: 'oauth' },
        { token: wsToken, source: 'workspace-oauth', kind: 'oauth' },
        { token: env.CLAUDE_CODE_OAUTH_TOKEN || null, source: 'server-oauth', kind: 'oauth' },
        { token: tokenFromCredentialsFile(), source: 'credentials-file', kind: 'oauth' },
        { token: userKey, source: 'user-api-key', kind: 'api-key' },
        { token: wsKey, source: 'workspace-api-key', kind: 'api-key' },
        { token: env.ANTHROPIC_API_KEY || null, source: 'server-api-key', kind: 'api-key' },
      ]
    : [
        { token: userKey, source: 'user-api-key', kind: 'api-key' },
        { token: wsKey, source: 'workspace-api-key', kind: 'api-key' },
        { token: env.ANTHROPIC_API_KEY || null, source: 'server-api-key', kind: 'api-key' },
        { token: userToken, source: 'user-oauth', kind: 'oauth' },
        { token: wsToken, source: 'workspace-oauth', kind: 'oauth' },
        { token: env.CLAUDE_CODE_OAUTH_TOKEN || null, source: 'server-oauth', kind: 'oauth' },
        { token: tokenFromCredentialsFile(), source: 'credentials-file', kind: 'oauth' },
      ];

  // In modalità esclusiva scartiamo l'altro tipo invece di ripiegarci sopra.
  const filtered = candidates.filter((c) => {
    if (mode === 'subscription') return c.kind === 'oauth';
    if (mode === 'api-key') return c.kind === 'api-key';
    return true;
  });

  for (const c of filtered) {
    if (!c.token) continue;
    return {
      envVars:
        c.kind === 'oauth'
          ? { CLAUDE_CODE_OAUTH_TOKEN: c.token }
          : { ANTHROPIC_API_KEY: c.token },
      source: c.source,
      usesSubscription: c.kind === 'oauth',
    };
  }

  throw new MissingClaudeAuthError(
    mode === 'subscription'
      ? 'Nessun token di abbonamento disponibile. Genera un token con `claude setup-token` ' +
        'e impostalo come CLAUDE_CODE_OAUTH_TOKEN nel .env oppure fra i segreti del progetto.'
      : 'Nessuna credenziale Claude configurata. Imposta CLAUDE_CODE_OAUTH_TOKEN ' +
        '(da `claude setup-token`) oppure ANTHROPIC_API_KEY.',
  );
}

/** Chiave OpenRouter, con precedenza al segreto del workspace. */
export async function resolveOpenRouterKey(workspaceId: string): Promise<string> {
  const wsKey = await workspaceSecret(workspaceId, 'OPENROUTER_API_KEY');
  const key = wsKey ?? env.OPENROUTER_API_KEY;
  if (!key) {
    throw new MissingClaudeAuthError(
      'Serve una chiave OpenRouter per far girare questo agente. ' +
        'Impostala in OPENROUTER_API_KEY oppure fra i segreti del progetto.',
    );
  }
  return key;
}
