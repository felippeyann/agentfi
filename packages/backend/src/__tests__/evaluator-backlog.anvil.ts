/**
 * C3f item 1 on a REAL node (Anvil, `npm run test:anvil`): the evaluator key
 * blocked behind one transaction that is never mined, and what the backlog
 * check (`checkEvaluatorBacklog`) sees through viem's `getTransactionCount`.
 *
 * The evaluator signs with the node's `pending` nonce. A transaction that is
 * not mined (on a geth-family node: priced out by a fee spike, it stays
 * pending while blocks are produced) holds the key; the next evaluator
 * transaction (another job's settlement) gets the next nonce and waits behind
 * it — however well it is priced. Nothing in the backend moves it; the check
 * tells the operator which nonce / transaction / job blocks the key once it
 * has not moved for EVALUATOR_STUCK_ALERT_AFTER_MS. Anvil evicts a priced-out
 * transaction when it mines (geth keeps it), so "not mined" is simulated with
 * automine off and no block until the replacement.
 *
 * The last test is EVIDENCE FOR THE C3f PROPOSAL, not product behaviour: a
 * replacement of the stuck nonce (same nonce, higher fee) unblocks the queue
 * — the backend does not do this (decision pending).
 *
 * Anvil: `anvilTestPort(5)` (default 8750), chain id 84532. No contracts.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseGwei, type Hex } from 'viem';
import { anvilAccount, anvilTestPort, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';
import {
  EVALUATOR_STUCK_ALERT_AFTER_MS,
  __resetEvaluatorBacklogForTests,
  checkEvaluatorBacklog,
  type Erc8183Deps,
  type EscrowAlert,
} from '../services/job/escrow-erc8183.service.js';

const CHAIN_ID = 84532;
const evaluator = anvilAccount(4);
let chain: LocalChain;

beforeAll(async () => {
  chain = await startLocalChain({ port: anvilTestPort(5), chainId: CHAIN_ID });
});
afterAll(() => chain?.stop());
beforeEach(() => __resetEvaluatorBacklogForTests());

/** The deps the check reads: the evaluator address, the real read client, a job table holding `jobs`, a clock and the alert channel. */
function depsFor(jobs: Array<{ id: string; settleTxHash: Hex }>, alerts: EscrowAlert[], now: () => Date): Erc8183Deps {
  return {
    config: { evaluatorAddress: evaluator.address } as never,
    publicClient: () => chain.publicClient as never,
    db: { job: { findMany: async () => jobs } } as never,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now,
    alert: (a: EscrowAlert) => {
      alerts.push(a);
    },
  } as unknown as Erc8183Deps;
}

/** A transfer from the evaluator key with explicit fees (`nonce` fixed when given). */
async function send(fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, nonce?: number): Promise<Hex> {
  return chain.wallet(evaluator).sendTransaction({
    account: evaluator,
    chain: undefined,
    to: evaluator.address,
    value: 0n,
    gas: 21_000n,
    ...fees,
    ...(nonce !== undefined ? { nonce } : {}),
  });
}

describe('C3f item 1 — an evaluator key blocked behind one unmined transaction (real node)', () => {
  it('a transaction that is not mined holds the key; the next one gets the next nonce and waits behind it; the check names the nonce, the transaction and its job once', async () => {
    const start = await chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag: 'latest' });
    // "Never mined": on a geth-family node a transaction priced out by a fee spike stays pending while blocks
    // are produced; Anvil instead evicts it when it mines, so here nothing is mined while the two wait.
    await chain.rpc('evm_setAutomine', [false]);
    const stuck = await send({ maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') });
    // The next settlement is priced well above it, and still gets the next nonce (the node's pending count).
    const behind = await send({ maxFeePerGas: parseGwei('500'), maxPriorityFeePerGas: parseGwei('2') });
    expect((await chain.publicClient.getTransaction({ hash: behind })).nonce).toBe(start + 1);

    expect(await chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag: 'latest' })).toBe(start);
    expect(await chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag: 'pending' })).toBe(start + 2);
    await expect(chain.publicClient.getTransactionReceipt({ hash: behind })).rejects.toThrow(); // well priced, still not mined

    const alerts: EscrowAlert[] = [];
    let now = Date.now();
    const deps = depsFor([{ id: 'job-behind', settleTxHash: behind }, { id: 'job-stuck', settleTxHash: stuck }], alerts, () => new Date(now));
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toBeNull(); // first sight
    now += EVALUATOR_STUCK_ALERT_AFTER_MS + 1_000;
    const backlog = await checkEvaluatorBacklog(deps, CHAIN_ID);
    expect(backlog).toMatchObject({ stuckNonce: start, queued: 2, stuckTxHash: stuck, jobId: 'job-stuck' });
    expect(alerts).toEqual([expect.objectContaining({ kind: 'evaluator-stuck', chainId: CHAIN_ID, jobId: 'job-stuck' })]);
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toBeNull(); // not repeated within the interval
    expect(alerts).toHaveLength(1);

    // EVIDENCE FOR THE PROPOSAL (not done by the backend): the same nonce again, priced above the base fee,
    // replaces the stuck transaction; the one behind it is mined right after.
    const replacement = await send({ maxFeePerGas: parseGwei('600'), maxPriorityFeePerGas: parseGwei('3') }, start);
    await chain.rpc('evm_mine', []);
    await chain.rpc('evm_mine', []);
    expect((await chain.publicClient.getTransactionReceipt({ hash: replacement })).status).toBe('success');
    expect((await chain.publicClient.getTransactionReceipt({ hash: behind })).status).toBe('success');
    await expect(chain.publicClient.getTransactionReceipt({ hash: stuck })).rejects.toThrow(); // replaced: never mined
    expect(await chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag: 'latest' })).toBe(start + 2);

    now += EVALUATOR_STUCK_ALERT_AFTER_MS + 1_000;
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toBeNull(); // the key moves again: nothing to report
  });
});
