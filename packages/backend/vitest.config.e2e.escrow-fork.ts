import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';

// Same convenience as the other E2E configs: E2E_ANVIL_FORK_URL may live in
// the root .env. Nothing else from it reaches the rehearsal — the backend
// child processes get an explicit env (escrow-fork.harness.ts `backendEnv`).
loadDotenv({ path: resolve(process.cwd(), '../../.env') });

/**
 * ERC-8183 escrow + ERC-8004 reputation rehearsal on a local Anvil fork of
 * Base Sepolia (task C5a). See docs/project/testnet-log.md, "Fork rehearsal".
 *
 *   E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run test:e2e:escrow-fork
 *
 * Required for the suite to run (otherwise it is skipped, exit 0):
 * - E2E_ANVIL_FORK_URL           Base Sepolia RPC to fork (chain 84532)
 *
 * Optional:
 * - E2E_ANVIL_FORK_BLOCK_NUMBER  fork block (default pinned in the harness; `latest` = unpinned)
 * - E2E_ESCROW_ANVIL_PORT        Anvil port (default 8546, so it can run next to test:e2e on 8545)
 * - E2E_ESCROW_BACKEND_PORT      backend port (default 3155)
 * - E2E_DATABASE_URL             dedicated Postgres DB, emptied on every run
 *                                (default postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_escrow)
 * - E2E_ESCROW_REDIS_URL         dedicated Redis logical DB, flushed on every run (default redis://localhost:6379/13)
 *
 * Needs Foundry (forge + anvil), Postgres and Redis (docker-compose).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/e2e/escrow-erc8183.fork.e2e.ts'],
    globalSetup: ['src/__tests__/e2e/escrow-fork.global-setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
