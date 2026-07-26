import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { env } from '../env.js';

/**
 * Quali modelli può davvero far girare questo server.
 *
 * Deve rispecchiare la stessa risoluzione che fa il runtime agenti, incluso
 * il file credenziali di Claude Code: controllare le sole variabili
 * d'ambiente direbbe "nessuna credenziale" mentre gli agenti stanno
 * tranquillamente rispondendo, ed è esattamente il modo di far perdere
 * mezz'ora a chi legge.
 */

export type ClaudeAuthSource =
  | 'api-key'
  | 'oauth-env'
  | 'oauth-file'
  | 'workspace'
  | 'none';

export interface Capabilities {
  /** Vero se gli agenti su modelli Claude possono partire. */
  anthropicConfigured: boolean;
  /** Vero se gli agenti su modelli non-Claude possono partire. */
  openrouterConfigured: boolean;
  claudeAuthSource: ClaudeAuthSource;
  /** Testo già pronto da mostrare, in italiano. */
  claudeAuthLabel: string;
}

function readSubscriptionToken(): { ok: boolean; expired: boolean; plan: string | null } {
  const path = env.HIVE_CLAUDE_CREDENTIALS_FILE;
  if (!path || !existsSync(path)) return { ok: false, expired: false, plan: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
    };
    const oauth = raw.claudeAiOauth;
    if (!oauth?.accessToken) return { ok: false, expired: false, plan: null };
    const expired = oauth.expiresAt != null && oauth.expiresAt <= Date.now();
    return { ok: !expired, expired, plan: oauth.subscriptionType ?? null };
  } catch {
    return { ok: false, expired: false, plan: null };
  }
}

/**
 * Le chiavi impostate sul PROGETTO.
 *
 * Il pannello delle credenziali promette che «hanno la precedenza su quelle
 * del server», ed è vero — il runtime le guarda per prime. Questo controllo
 * però non le guardava affatto: chi configurava il token qui vedeva
 * «Agenti Claude: non configurati» sopra un campo marcato «impostata», e
 * sotto la riga che gli garantiva che quella chiave contava di più.
 */
async function workspaceKeys(workspaceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = await db
      .select({ key: schema.workspaceSecrets.key, value: schema.workspaceSecrets.valueEncrypted })
      .from(schema.workspaceSecrets)
      .where(eq(schema.workspaceSecrets.workspaceId, workspaceId));
    for (const r of rows) {
      // Presente ma indecifrabile non è presente: meglio dirlo che far
      // partire un agente che poi fallisce in chat.
      try {
        if (decryptSecret(r.value)) out.add(r.key);
      } catch {
        /* chiave illeggibile: la si ignora */
      }
    }
  } catch {
    /* database non raggiungibile: si ricade sulle credenziali del server */
  }
  return out;
}

/**
 * Cosa può far girare questo progetto.
 *
 * Senza `workspaceId` risponde solo per il server: è il comportamento di
 * prima, che resta valido dove il progetto non c'è.
 */
export async function computeCapabilitiesFor(workspaceId?: string): Promise<Capabilities> {
  const keys = workspaceId ? await workspaceKeys(workspaceId) : new Set<string>();
  const base = computeCapabilities();
  const openrouter = base.openrouterConfigured || keys.has('OPENROUTER_API_KEY');

  // Le chiavi del progetto vincono, come dice il pannello.
  if (!base.anthropicConfigured) {
    if (keys.has('CLAUDE_CODE_OAUTH_TOKEN')) {
      return {
        anthropicConfigured: true,
        openrouterConfigured: openrouter,
        claudeAuthSource: 'workspace',
        claudeAuthLabel: 'abbonamento Claude (token del progetto)',
      };
    }
    if (keys.has('ANTHROPIC_API_KEY')) {
      return {
        anthropicConfigured: true,
        openrouterConfigured: openrouter,
        claudeAuthSource: 'workspace',
        claudeAuthLabel: 'API key Anthropic del progetto',
      };
    }
  }
  return { ...base, openrouterConfigured: openrouter };
}

export function computeCapabilities(): Capabilities {
  const mode = env.HIVE_CLAUDE_AUTH;
  const allowSubscription = mode !== 'api-key';
  const allowApiKey = mode !== 'subscription';

  if (allowSubscription && env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      anthropicConfigured: true,
      openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
      claudeAuthSource: 'oauth-env',
      claudeAuthLabel: 'abbonamento Claude (token configurato)',
    };
  }

  if (allowSubscription) {
    const sub = readSubscriptionToken();
    if (sub.ok) {
      return {
        anthropicConfigured: true,
        openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
        claudeAuthSource: 'oauth-file',
        claudeAuthLabel: `abbonamento Claude${sub.plan ? ` (${sub.plan})` : ''}`,
      };
    }
    // Un token scaduto è un caso a sé: la API key può ancora salvare la
    // situazione, ma vale la pena dirlo.
    if (sub.expired && !allowApiKey) {
      return {
        anthropicConfigured: false,
        openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
        claudeAuthSource: 'none',
        claudeAuthLabel:
          'il token dell’abbonamento è scaduto — rigeneralo con `claude setup-token`',
      };
    }
  }

  if (allowApiKey && env.ANTHROPIC_API_KEY) {
    return {
      anthropicConfigured: true,
      openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
      claudeAuthSource: 'api-key',
      claudeAuthLabel: 'API key Anthropic',
    };
  }

  return {
    anthropicConfigured: false,
    openrouterConfigured: Boolean(env.OPENROUTER_API_KEY),
    claudeAuthSource: 'none',
    claudeAuthLabel:
      'nessuna credenziale Claude: usa `claude setup-token` oppure imposta ANTHROPIC_API_KEY',
  };
}
