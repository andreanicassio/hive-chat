import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, closeDb } from './index.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, '../../drizzle');

console.log('Applico le migrazioni da', folder);
await migrate(db, { migrationsFolder: folder });
console.log('Migrazioni applicate.');
await closeDb();
