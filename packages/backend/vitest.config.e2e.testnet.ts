import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';

loadDotenv({ path: resolve(process.cwd(), '../../.env') });

/**
 * E2E config for testnet smoke checks.
 *
 * Required env vars for tests to run (otherwise skipped):
 * - E2E_TESTNET_RPC_URL
 * - E2E_TESTNET_POLICY_MODULE_ADDRESS
 * - E2E_TESTNET_EXECUTOR_ADDRESS
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/e2e/testnet.smoke.e2e.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});
