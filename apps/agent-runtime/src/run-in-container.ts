import { runJobSchema } from '@hive/shared';
import { executeJob } from './worker.js';
import { closeDb } from './db.js';
import { closeRedis } from './redis.js';

/**
 * Entrypoint eseguito DENTRO al container di isolamento.
 *
 * Riceve un singolo job serializzato nella variabile d'ambiente HIVE_JOB,
 * esegue lo stesso `executeJob` del worker (che emette gli eventi sul DB e su
 * Redis, entrambi raggiunti via socket unix montato) e poi esce, così che
 * `docker run --rm` rimuova il container. Nessun loop di coda qui: un
 * container = un turno.
 */
async function main(): Promise<void> {
  const raw = process.env.HIVE_JOB;
  if (!raw) throw new Error('HIVE_JOB mancante: il container è stato lanciato male.');
  const job = runJobSchema.parse(JSON.parse(raw));
  await executeJob(job);
}

main()
  .catch((err) => {
    console.error('[run-in-container] errore fatale:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
    // Chiusura netta: senza, le connessioni aperte terrebbero vivo il processo.
    process.exit(process.exitCode ?? 0);
  });
