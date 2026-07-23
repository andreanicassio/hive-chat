import { createDb, schema } from '@hive/db';
import { env } from '../env.js';

const handle = createDb({ url: env.DATABASE_URL, max: 10 });

export const db = handle.db;
export const sql = handle.sql;
export { schema };

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await handle.close();
}
