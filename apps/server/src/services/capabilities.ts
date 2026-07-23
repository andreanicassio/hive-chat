import { existsSync, readFileSync } from 'node:fs';
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

export type ClaudeAuthSource = 'api-key' | 'oauth-env' | 'oauth-file' | 'none';

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
