import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**'],
    globalSetup: ['./test/global-setup.mjs'],
    fileParallelism: false, // integration tests share one database
    testTimeout: 20_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pitch2plan_test',
    },
  },
});
