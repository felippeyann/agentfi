import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';

// Load the root .env so DATABASE_URL, REDIS_URL, etc. are available
// when building the env block below (before test workers start).
loadDotenv({ path: resolve(process.cwd(), '../../.env') });

/**
 * Vitest config for end-to-end tests.
 * These tests run against a real Anvil node, real Postgres, and real Redis.
 * Anvil is started automatically by the globalSetup hook.
 *
 * Run locally (requires Postgres + Redis via docker-compose):
 *   docker-compose up -d postgres redis
 *   cd packages/backend && npm run test:e2e
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/e2e/**/*.e2e.ts'],
    globalSetup: ['src/__tests__/e2e/global-setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    // singleFork: test worker forks AFTER globalSetup, inheriting env vars
    // (contract addresses, Anvil RPC) written by globalSetup.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    env: {
      // NODE_ENV must be one of the accepted values in env.ts schema
      NODE_ENV: 'development',

      // Database + cache — always use local docker-compose instances for E2E.
      // Never use the production Upstash/Neon URLs from .env — those have
      // request limits and would pollute production data.
      DATABASE_URL: process.env['E2E_DATABASE_URL'] ?? 'postgresql://agentfi:agentfi@localhost:5432/agentfi',
      REDIS_URL:    'redis://localhost:6379',

      // Secrets — dummy values are fine; E2E mocks bypass Turnkey and Alchemy
      API_SECRET:               process.env['API_SECRET']               ?? 'e2e-test-secret-min-32-chars-long!!',
      ADMIN_SECRET:             process.env['ADMIN_SECRET']             ?? 'e2e-admin-secret-min-32-chars!!',
      ALCHEMY_API_KEY:          process.env['ALCHEMY_API_KEY']          ?? 'e2e-dummy',
      TURNKEY_API_PUBLIC_KEY:   process.env['TURNKEY_API_PUBLIC_KEY']   ?? 'e2e-dummy',
      TURNKEY_API_PRIVATE_KEY:  process.env['TURNKEY_API_PRIVATE_KEY']  ?? 'e2e-dummy',
      TURNKEY_ORGANIZATION_ID:  process.env['TURNKEY_ORGANIZATION_ID']  ?? 'e2e-dummy',

      // Fee wallet — overridden at runtime by globalSetup with Anvil deployer address
      OPERATOR_FEE_WALLET: process.env['OPERATOR_FEE_WALLET'] ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    },
  },
});
