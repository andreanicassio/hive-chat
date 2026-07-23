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

export function createDb(opts: DbOptions) {
  const sql = postgres(opts.url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

export type Database = ReturnType<typeof createDb>['db'];
