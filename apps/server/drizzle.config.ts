import { defineConfig } from 'drizzle-kit';
import { env } from './src/env.js';

export default defineConfig({
  schema: '../../packages/db/src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: env.DATABASE_URL },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
