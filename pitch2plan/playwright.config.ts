import { defineConfig } from '@playwright/test';

const PORT = 3100;
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  // Runs against the production build (run `npm run build` first). Uses the mock AI provider.
  webServer: {
    command: `npm run start -w @pitch2plan/web -- -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ALLOW_DEV_AUTH: 'true', AI_PROVIDER: 'mock', LOG_LEVEL: 'warn', WORKER_MODE: 'inline' },
  },
});
