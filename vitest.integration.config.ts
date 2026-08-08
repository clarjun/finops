import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Integration tests. Require a reachable DATABASE_URL with migrations applied.
 *
 * Run serially: these share one database and assert on row counts, so parallel
 * files would interfere with each other.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@': resolve(__dirname, 'client/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['server/**/*.itest.ts'],
    globals: false,
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
