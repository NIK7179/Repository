// Engine-free migration runner. Applies packages/db/prisma/migrations/*/migration.sql in order.
// Intended for CI, tests and networks where Prisma's schema engine cannot be downloaded.
// Normal development should use `npm run db:migrate` (prisma migrate deploy).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export async function applyMigrations(connectionString, { reset = false } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (reset) await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.query('CREATE TABLE IF NOT EXISTS _sql_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const dir = join(root, 'packages/db/prisma/migrations');
    const names = readdirSync(dir).filter((n) => existsSync(join(dir, n, 'migration.sql'))).sort();
    for (const name of names) {
      const done = await client.query('SELECT 1 FROM _sql_migrations WHERE name = $1', [name]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
        await client.query('INSERT INTO _sql_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`applied ${name}`);
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
  } finally { await client.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  await applyMigrations(url, { reset: process.argv.includes('--reset') });
}
