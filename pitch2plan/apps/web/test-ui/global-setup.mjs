import { spawn } from 'node:child_process';
import { applyMigrations } from '../../../scripts/apply-sql-migrations.mjs';

const PORT = 3101;
const DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pitch2plan_test';

export default async function setup() {
  await applyMigrations(DB, { reset: true });
  const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: DB, ALLOW_DEV_AUTH: 'true', AI_PROVIDER: 'mock', AUTH_SECRET: 'ui-test-secret-ui-test-secret-0000', LOG_LEVEL: 'silent', NODE_ENV: 'production', WORKER_MODE: 'inline' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d)); server.stderr.on('data', (d) => (out += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { try { process.kill(-server.pid); } catch { /* gone */ } throw new Error(`Next server did not start (did you run \`npm run build\`?)\n${out}`); }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.env.UI_TEST_BASE = `http://localhost:${PORT}`;
  return () => { try { process.kill(-server.pid); } catch { /* already stopped */ } };
}
