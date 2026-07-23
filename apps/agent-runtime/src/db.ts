import { createDb, type Database } from '@hive/db';
import { env } from './env.js';

// Pool piccolo: i worker sono più d'uno e non devono esaurire le
// connessioni disponibili su Postgres.
const handle = createDb({ url: env.DATABASE_URL, max: 5 });

// Annotazione esplicita: senza, TypeScript proverebbe a nominare il tipo
// dedotto passando per un percorso relativo dentro node_modules.
export const db: Database = handle.db;
export const closeDb: () => Promise<void> = handle.close;
