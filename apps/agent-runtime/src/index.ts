import { existsSync, readFileSync } from 'node:fs';
import { startWorker, stopWorker } from './worker.js';
import { closeDb } from './db.js';
import { closeRedis } from './redis.js';
import { env } from './env.js';

/**
 * Riporta la credenziale che verrà davvero usata.
 * Deve controllare anche il file di Claude Code, non solo l'ambiente:
 * dire "nessuna credenziale" mentre invece c'è manderebbe fuori strada
 * chi sta diagnosticando un problema.
 */
function describeClaudeAuth(): string {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'token di abbonamento da variabile d’ambiente';
  if (env.HIVE_CLAUDE_AUTH !== 'api-key' && existsSync(env.HIVE_CLAUDE_CREDENTIALS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(env.HIVE_CLAUDE_CREDENTIALS_FILE, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string };
      };
      const oauth = raw.claudeAiOauth;
      if (oauth?.accessToken) {
        const expired = oauth.expiresAt != null && oauth.expiresAt <= Date.now();
        if (!expired) {
          const plan = oauth.subscriptionType ? ` (${oauth.subscriptionType})` : '';
          const until = oauth.expiresAt
            ? `, valido fino alle ${new Date(oauth.expiresAt).toLocaleTimeString('it-IT')}`
            : '';
          return `abbonamento dal file credenziali${plan}${until}`;
        }
        return (
          'il token nel file credenziali è scaduto — rigeneralo con `claude setup-token` ' +
          'e mettilo in CLAUDE_CODE_OAUTH_TOKEN'
        );
      }
    } catch {
      /* file illeggibile: cadiamo sui casi sotto */
    }
  }
  if (env.ANTHROPIC_API_KEY) return 'API key';
  return 'NESSUNA credenziale trovata: gli agenti Claude falliranno';
}

console.log('[hive] runtime agenti in avvio');
console.log(`[hive]   concorrenza  : ${env.AGENT_MAX_CONCURRENCY} turni simultanei`);
console.log(`[hive]   isolamento   : ${env.AGENT_ISOLATION}`);
console.log(`[hive]   auth Claude  : ${env.HIVE_CLAUDE_AUTH} — ${describeClaudeAuth()}`);
console.log(
  `[hive]   OpenRouter   : ${env.OPENROUTER_API_KEY ? 'configurato' : 'non configurato'}`,
);

const shutdown = async (signal: string) => {
  console.log(`[hive] ricevuto ${signal}, chiusura`);
  stopWorker();
  // Diamo ai run in corso qualche secondo per chiudersi in modo pulito.
  await new Promise((r) => setTimeout(r, 2000));
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await startWorker();
