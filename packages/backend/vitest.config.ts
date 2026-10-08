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
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/services/**', 'src/queues/**'],
    },
  },
});
