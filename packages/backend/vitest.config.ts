import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Suites that own rows in the real Postgres (`*.db.test.ts`) run in their
    // own, sequential pass (`vitest.config.db.ts`, second half of `npm test`):
    // `agent.search.test.ts` empties every table before each of its tests,
    // which a suite running in a parallel worker cannot survive.
    exclude: [...configDefaults.exclude, 'src/**/*.db.test.ts'],
    // Several suites import the whole route graph in `beforeAll` (dynamic
    // import after env stubs); with ~55 files in parallel on a slow runner the
    // default 10 s hook budget was hit (admin.pause.routes.test.ts, 2 of 4
    // local runs during C3c). Tests keep the default per-test timeout.
    hookTimeout: 30_000,
    // Each file runs in its own child PROCESS (`pool: 'forks'`, as in
    // vitest.config.db.ts), not in a worker thread (vitest 1.x's default
    // `threads`). A file that constructs a PrismaClient loads Prisma's
    // Node-API engine into its thread — with a real query
    // (`agent.search.test.ts`) or only through the `db/client.ts` singleton
    // it never uses (`pnl.service.test.ts`) — and on Windows / Node 24 the
    // whole run then died at a random later point (exit 139 / 0xC0000005),
    // even after every test had passed (T2, 2026-10-21; measurements in
    // docs/operations/local-validation.md §4). The whole suite rather than a
    // `poolMatchGlobs` list: any new file reaching `db/client.ts` unmocked
    // loads the engine too, and vitest 1.6 matches those globs against
    // absolute paths without `dot`, so `**/…` silently misses a checkout
    // under a dot directory. CI (Linux) passed either way.
    pool: 'forks',
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/services/**', 'src/queues/**'],
    },
  },
});
