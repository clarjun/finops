import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Two test suites, split by whether they need a database.
 *
 *   *.test.ts     pure unit tests. No I/O, run anywhere, including CI without
 *                 a Postgres service.
 *   *.itest.ts    integration tests. Require a local DATABASE_URL and exercise
 *                 real SQL — which is the only way to prove tenant isolation,
 *                 since the whole point is what the database returns.
 *
 * `npm test` runs unit tests only, so the default path stays fast and has no
 * external dependency. `npm run test:integration` runs the rest.
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
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
    // Integration tests are opted into explicitly.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'],
    globals: false,
  },
});
