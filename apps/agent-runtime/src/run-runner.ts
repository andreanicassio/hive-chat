import { startRunnerClient } from './runner-client.js';

/**
 * Entrypoint del runner LOCALE (a token, via HTTPS). Non importa nulla che
 * dipenda dal database: gira sul computer di una persona.
 */
startRunnerClient().catch((err) => {
  console.error('[runner] errore fatale:', err);
  process.exit(1);
});
