import { applyMigrations } from '../scripts/apply-sql-migrations.mjs';

// Rebuilds the test database schema from the committed migrations before every run.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pitch2plan_test';
  await applyMigrations(url, { reset: true });
}
