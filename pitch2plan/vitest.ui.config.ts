import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// UI tests mount the real client components in jsdom and drive them against the real production server
// (started in global setup) and a real Postgres. Run `npm run build` first.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['apps/web/test-ui/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globalSetup: ['./apps/web/test-ui/global-setup.mjs'],
    setupFiles: ['./apps/web/test-ui/setup.tsx'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
