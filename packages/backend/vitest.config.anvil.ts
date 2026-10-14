import { defineConfig } from 'vitest/config';

/**
 * Suites against REAL local contracts (`src/**\/*.anvil.ts`, `npm run test:anvil`).
 *
 * Each suite starts its own Anvil (`ANVIL_TEST_PORT_BASE`, default 8745, plus
 * a per-suite offset — see `__tests__/helpers/anvil-contracts.ts`) and deploys
 * the contracts from the Foundry artifacts, so `forge build` must have run in
 * packages/contracts and `anvil` must be on PATH or in ~/.foundry/bin. Suites
 * that also need Postgres use DATABASE_URL (migrated) and skip with a warning
 * when it is unreachable outside CI. Files run one at a time.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.anvil.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
