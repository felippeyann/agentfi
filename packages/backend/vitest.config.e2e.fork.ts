import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';

loadDotenv({ path: resolve(process.cwd(), '../../.env') });

/**
 * E2E config for local Anvil fork mode.
 *
 * Required env vars:
 * - E2E_ANVIL_FORK_URL
 *
 * Optional env vars:
 * - E2E_ANVIL_FORK_BLOCK_NUMBER
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/e2e/**/*.e2e.ts'],
    globalSetup: ['src/__tests__/e2e/global-setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    env: {
      NODE_ENV: 'development',
      DATABASE_URL:
        process.env['E2E_DATABASE_URL'] ??
        'postgresql://agentfi:agentfi@localhost:5432/agentfi',
      REDIS_URL: 'redis://localhost:6379',
      API_SECRET:
        process.env['API_SECRET'] ?? 'e2e-test-secret-min-32-chars-long!!',
      ADMIN_SECRET:
        process.env['ADMIN_SECRET'] ?? 'e2e-admin-secret-min-32-chars!!',
      ALCHEMY_API_KEY: process.env['ALCHEMY_API_KEY'] ?? 'e2e-dummy',
      TURNKEY_API_PUBLIC_KEY:
        process.env['TURNKEY_API_PUBLIC_KEY'] ?? 'e2e-dummy',
      TURNKEY_API_PRIVATE_KEY:
        process.env['TURNKEY_API_PRIVATE_KEY'] ?? 'e2e-dummy',
      TURNKEY_ORGANIZATION_ID:
        process.env['TURNKEY_ORGANIZATION_ID'] ?? 'e2e-dummy',
      OPERATOR_FEE_WALLET:
        process.env['OPERATOR_FEE_WALLET'] ??
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      E2E_ANVIL_FORK_REQUIRED: 'true',
      E2E_ANVIL_FORK_URL: process.env['E2E_ANVIL_FORK_URL'] ?? '',
      E2E_ANVIL_FORK_BLOCK_NUMBER:
        process.env['E2E_ANVIL_FORK_BLOCK_NUMBER'] ?? '',
    },
  },
});
