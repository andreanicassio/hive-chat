import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * as schema from './schema.js';
export * from './schema.js';

export interface DbOptions {
  url: string;
  /**
   * Dimensione del pool. Il server API e ogni worker agenti aprono il proprio
   * pool: teniamoli bassi, Postgres di default accetta 100 connessioni.
   */
  max?: number;
}

/**
 * Riconosce la forma «socket unix» della connessione, che `new URL` (usato
 * internamente da postgres.js) non sa parsare per via dell'host vuoto:
 *   postgres://utente:password@/database?host=/var/run/postgresql
 * È quella usata dai container degli agenti sviluppatore, che raggiungono
 * Postgres via socket montato invece che via rete.
 */
function parseSocketUrl(
  url: string,
): { username: string; password?: string; database: string; host: string } | null {
  const m = /^postgres(?:ql)?:\/\/([^:@/]+)(?::([^@/]+))?@\/([^?]+)\?host=(.+)$/.exec(url);
  if (!m) return null;
  const [, username, password, database, host] = m;
  return {
    username: decodeURIComponent(username!),
    password: password ? decodeURIComponent(password) : undefined,
    database: decodeURIComponent(database!),
    host: decodeURIComponent(host!),
  };
}

export function createDb(opts: DbOptions) {
  const base = {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  };
  const socket = parseSocketUrl(opts.url);
  const sql = socket ? postgres({ ...socket, ...base }) : postgres(opts.url, base);
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

export type Database = ReturnType<typeof createDb>['db'];
