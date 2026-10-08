import { defineConfig } from 'vitest/config';

/**
 * Database-backed unit suites (`src/**\/*.db.test.ts`), run after the main
 * pass by `npm test` (and alone by `npm run test:db`).
 *
 * They exercise real routes and services against the Postgres in
 * DATABASE_URL (migrated, as in CI's Backend Tests job) and skip with a
 * warning when it is unreachable locally (CI fails instead). Files run one at
 * a time: each owns rows the global recovery scans read.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
