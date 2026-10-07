/**
 * Vitest globalSetup of `npm run test:e2e:escrow-fork` (task C5a).
 *
 * Without E2E_ANVIL_FORK_URL it does nothing and provides `escrowFork: null`,
 * so the suite is reported as skipped and the run stays green (CI has no
 * Base Sepolia RPC). With it: resets the dedicated DB and Redis logical DB,
 * starts the Base Sepolia fork and deploys the escrow + hook
 * (`escrow-fork.harness.ts`). Anvil plumbing comes from `global-setup.ts`.
 */

import type { GlobalSetupContext } from 'vitest/node';
import type { ChildProcess } from 'child_process';
import { stopAnvil } from './global-setup.js';
import { flushTestRedis, readEscrowForkConfig, resetTestDatabase, startEscrowFork } from './escrow-fork.harness.js';

let anvil: ChildProcess | null = null;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const config = readEscrowForkConfig();
  if (!config) {
    console.log('[e2e:escrow-fork] E2E_ANVIL_FORK_URL is not set — skipping the escrow fork rehearsal.');
    provide('escrowFork', null);
    return;
  }

  console.log(`[e2e:escrow-fork] Resetting ${new URL(config.databaseUrl).pathname.slice(1)} and Redis ${config.redisUrl}…`);
  await resetTestDatabase(config.databaseUrl);
  await flushTestRedis(config.redisUrl);

  const stack = await startEscrowFork(config);
  anvil = stack.anvil;
  provide('escrowFork', stack.context);
}

export async function teardown(): Promise<void> {
  if (anvil) {
    stopAnvil(anvil);
    anvil = null;
    console.log('[e2e:escrow-fork] Anvil stopped.');
  }
}
