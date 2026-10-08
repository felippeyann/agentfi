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
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/services/**', 'src/queues/**'],
    },
  },
});
