/**
 * C5a — keeps the escrow rehearsal stack running for manual use:
 * Base Sepolia fork (Anvil) + AgentJobEscrow/ReputationHook deployed with
 * the C4 runbook script + the backend (local wallets, both workers), so
 * `examples/escrow-erc8183` (or curl, or the MCP server) can be pointed at it.
 *
 *   cd packages/backend
 *   E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run e2e:escrow-fork:stack
 *
 * Same env knobs as `npm run test:e2e:escrow-fork` (vitest.config.e2e.escrow-fork.ts),
 * plus ESCROW_EVALUATION_DELAY_SECONDS for the backend (default 0).
 * Ctrl+C stops the backend and Anvil. The dedicated DB and Redis DB are
 * emptied on start, exactly like the suite does.
 */

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { stopAnvil } from './global-setup.js';
import { flushTestRedis, readEscrowForkConfig, resetTestDatabase, startBackend, startEscrowFork } from './escrow-fork.harness.js';

loadDotenv({ path: resolve(process.cwd(), '../../.env') });

async function main(): Promise<void> {
  const config = readEscrowForkConfig();
  if (!config) {
    console.error('Set E2E_ANVIL_FORK_URL to a Base Sepolia RPC, e.g. E2E_ANVIL_FORK_URL=https://sepolia.base.org');
    process.exit(1);
  }

  await resetTestDatabase(config.databaseUrl);
  await flushTestRedis(config.redisUrl);
  const { context, anvil } = await startEscrowFork(config);
  const delay = process.env['ESCROW_EVALUATION_DELAY_SECONDS'] ?? '0';
  const backend = await startBackend(context, { name: 'stack', overrides: { ESCROW_EVALUATION_DELAY_SECONDS: delay } });

  console.log(`
Escrow rehearsal stack is up (Ctrl+C to stop):
  Anvil fork (chain ${context.chainId}, block ${context.forkBlockNumber})  ${context.anvilRpc}
  AgentJobEscrow   ${context.escrow}
  ReputationHook   ${context.hook}
  Backend          ${backend.url}   (log: ${backend.logFile})
  Evaluator        ${context.evaluator}   (Anvil test account 3)

Run the example in another terminal, from the repository root:
  AGENTFI_API_URL=${backend.url} \\
  AGENTFI_OPERATOR_SECRET=${context.apiSecret} \\
  AGENTFI_RPC_URL=${context.anvilRpc} AGENTFI_FORK_FUNDING=true \\
  node examples/escrow-erc8183/index.mjs
`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping backend and Anvil…');
    await backend.stop();
    stopAnvil(anvil);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
