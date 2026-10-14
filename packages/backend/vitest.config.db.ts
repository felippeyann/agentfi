import { defineConfig } from 'vitest/config';

/**
 * Database-backed unit suites (`src/**\/*.db.test.ts`), run after the main
 * pass by `npm test` (and alone by `npm run test:db`).
 *
 * They exercise real routes and services against the Postgres in
 * DATABASE_URL (migrated, as in CI's Backend Tests job) and skip with a
 * warning when it is unreachable locally (CI fails instead). Files run one at
 * a time: each owns rows the global recovery scans read.
 *
 * Each file runs in its own child PROCESS (`pool: 'forks'`), not in a
 * worker thread (vitest 1.x's default `threads`). These suites load Prisma's
 * Node-API query engine; on Windows with Node 24 the whole run died with an
 * access violation (exit 139 / 0xC0000005) at a random point after a worker
 * thread that had used Prisma ended — 3 of 4 joint runs, item 7, 2026-10-14
 * (reproduction outside vitest: scripts/repro-prisma-worker-thread-crash.mjs;
 * details: docs/operations/local-validation.md §4). Forked files exit as
 * processes and never crashed. CI (Linux) passed either way.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
