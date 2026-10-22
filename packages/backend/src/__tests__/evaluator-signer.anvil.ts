/**
 * A1 front F2 on a REAL node (Anvil, `npm run test:anvil`): the evaluator
 * signer's explicit signing and identical rebroadcast, the lane lease guard
 * and the per-node reads.
 *
 *  - `signExplicit` + `sendRaw`: the same input signs the same bytes (same
 *    hash); the node keeps the explicit nonce, gas and fees; the identical
 *    bytes sent again are "already known"; after mining they are "nonce too
 *    low"; a same-nonce tx priced lower is "underpriced" — all typed
 *    outcomes, none thrown.
 *  - `writeContract` with a lease that is lost while the transaction is being
 *    recorded (`onBeforeBroadcast`): LeaseLostError, the node never sees the
 *    signed hash, the pending nonce does not move.
 *  - `writeContract` with `chooseNonce` above the node's pending: re-prepared
 *    with that explicit nonce, mined after the transaction it waited for.
 *  - `readNodeViews` over two endpoints, one of them down: the live node is
 *    reported with nonces, known / receipt per hash and the safe head; the
 *    down node as an error (sanitized), nothing concluded.
 *
 * Anvil: `anvilTestPort(8)` (default 8753), chain id 84532. No contracts: the
 * `writeContract` target is an EOA called with a no-output function, which
 * simulates and estimates like any call.
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAbi, parseGwei, type Hex } from 'viem';
import { ANVIL_KEYS, anvilAccount, anvilTestPort, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';
import { createEvaluatorSigner, type EvaluatorA1Signer, type PreparedEvaluatorTx } from '../services/escrow/evaluator-signer.js';
import { readBaseFeeAndPriorityP90, readNodeViews } from '../services/escrow/evaluator-rpc.js';
import { InMemoryLaneLock, LeaseLostError, evaluatorLaneKey, type LaneLease } from '../services/transaction/wallet-lane.js';

const CHAIN_ID = 84532;
const PORT = anvilTestPort(8);
const DEAD_URL = `http://127.0.0.1:${PORT + 97}`; // nothing listens here: the "down" node
const evaluator = anvilAccount(4);
const target = anvilAccount(3).address;
const PING_ABI = parseAbi(['function ping()']);
let chain: LocalChain;
let signer: EvaluatorA1Signer;
const lanes = new InMemoryLaneLock();
let lease: LaneLease;

beforeAll(async () => {
  chain = await startLocalChain({ port: PORT, chainId: CHAIN_ID });
  // The signer sends through RPC_URL_<chainId> (read when it is created).
  process.env[`RPC_URL_${CHAIN_ID}`] = chain.rpcUrl;
  signer = createEvaluatorSigner(CHAIN_ID, ANVIL_KEYS[4] as Hex);
  expect(signer.address).toBe(evaluator.address);
});
afterAll(() => {
  delete process.env[`RPC_URL_${CHAIN_ID}`];
  chain?.stop();
});
beforeEach(async () => {
  await chain.rpc('evm_setAutomine', [true]);
  lease = await lanes.acquire(evaluatorLaneKey(CHAIN_ID, evaluator.address), { waitMs: 1_000 });
  return () => lease.release();
});

const nonceAt = (blockTag: 'latest' | 'pending') => chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag });

function transfer(nonce: number, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) {
  return { to: target, data: '0x' as Hex, value: 1n, nonce, gas: 21_000n, maxFeePerGas, maxPriorityFeePerGas };
}

describe('A1 signer on a real node', () => {
  it('signExplicit + sendRaw: identical bytes → same hash, explicit fields kept, "already known", then "nonce too low"; a cheaper same-nonce tx is "underpriced"', async () => {
    await chain.rpc('evm_setAutomine', [false]);
    const n = await nonceAt('pending');
    const input = transfer(n, parseGwei('7'), parseGwei('2'));
    const tx = await signer.signExplicit(input);
    const again = await signer.signExplicit(input);
    expect(again.raw).toBe(tx.raw);
    expect(again.hash).toBe(tx.hash);

    expect(await signer.sendRaw(tx.raw, { lease, minLeaseMs: 30_000 })).toEqual({ kind: 'accepted', hash: tx.hash });
    const onNode = await chain.publicClient.getTransaction({ hash: tx.hash });
    expect(onNode).toMatchObject({ nonce: n, gas: 21_000n, maxFeePerGas: parseGwei('7'), maxPriorityFeePerGas: parseGwei('2'), to: target.toLowerCase(), value: 1n });

    const dup = await signer.sendRaw(again.raw, { lease, minLeaseMs: 30_000 });
    expect(dup).toMatchObject({ kind: 'already-known', hash: tx.hash });

    const cheaper = await signer.signExplicit(transfer(n, parseGwei('6'), parseGwei('1')));
    expect(await signer.sendRaw(cheaper.raw, { lease, minLeaseMs: 30_000 })).toMatchObject({ kind: 'underpriced', hash: cheaper.hash });

    await chain.rpc('evm_mine', []);
    expect((await chain.publicClient.getTransactionReceipt({ hash: tx.hash })).status).toBe('success');
    const resent = await signer.sendRaw(tx.raw, { lease, minLeaseMs: 30_000 }); // Anvil: "nonce too low" once mined
    expect(resent).toMatchObject({ kind: 'nonce-too-low', hash: tx.hash });
    expect(await signer.sendRaw(cheaper.raw, { lease, minLeaseMs: 30_000 })).toMatchObject({ kind: 'nonce-too-low', hash: cheaper.hash });
  });

  it('a lease lost while the tx is being recorded: LeaseLostError, the node never sees the hash, the nonce does not move', async () => {
    const before = await nonceAt('pending');
    let recorded: PreparedEvaluatorTx | null = null;
    const err = await signer
      .writeContract(
        { address: target, abi: PING_ABI, functionName: 'ping', args: [] },
        {
          lease,
          minLeaseMs: 30_000,
          onBeforeBroadcast: async (_hash, tx) => {
            recorded = tx;
            await lease.release(); // e.g. the lane TTL ran out during the DB write
          },
        },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseLostError);
    expect(recorded).not.toBeNull();
    expect(recorded!.nonce).toBe(before);
    await expect(chain.publicClient.getTransaction({ hash: recorded!.hash })).rejects.toThrow();
    expect(await nonceAt('pending')).toBe(before);

    // And a lease past its TTL never sends either (no hook call, nothing broadcast).
    const short = await new InMemoryLaneLock({ ttlMs: 30 }).acquire('short');
    await new Promise((r) => setTimeout(r, 60));
    const hook = vi.fn(async () => undefined);
    await expect(
      signer.writeContract({ address: target, abi: PING_ABI, functionName: 'ping', args: [] }, { lease: short, minLeaseMs: 0, onBeforeBroadcast: hook }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(hook).not.toHaveBeenCalled();
    expect(await nonceAt('pending')).toBe(before);
  });

  it('chooseNonce above the pending nonce re-prepares with that explicit nonce; the tx waits for the one below and both mine', async () => {
    await chain.rpc('evm_setAutomine', [false]);
    const n = await nonceAt('pending');
    // A live candidate at n that the node has not seen yet (signed, recorded, not sent): the lagging-pending case.
    const head = await signer.signExplicit(transfer(n, parseGwei('5'), parseGwei('1')));
    let signed: PreparedEvaluatorTx | null = null;
    const hash = await signer.writeContract(
      { address: target, abi: PING_ABI, functionName: 'ping', args: [] },
      {
        lease,
        minLeaseMs: 30_000,
        chooseNonce: async (pending) => {
          expect(pending).toBe(n);
          return n + 1; // max(pending, highest live + 1)
        },
        onBeforeBroadcast: async (_h, tx) => {
          signed = tx;
        },
      },
    );
    expect(signed!.nonce).toBe(n + 1);
    expect((await chain.publicClient.getTransaction({ hash })).nonce).toBe(n + 1);
    expect(await signer.sendRaw(head.raw, { lease, minLeaseMs: 30_000 })).toMatchObject({ kind: 'accepted' });
    await chain.rpc('evm_mine', []);
    expect((await chain.publicClient.getTransactionReceipt({ hash: head.hash })).status).toBe('success');
    expect((await chain.publicClient.getTransactionReceipt({ hash })).status).toBe('success');
    expect(await nonceAt('latest')).toBe(n + 2);
  });

  it('readNodeViews over two endpoints, one down: the live node reports nonces, known / receipt per hash and the safe head; the down node is an error', async () => {
    await chain.rpc('evm_setAutomine', [false]);
    const n = await nonceAt('pending');
    const mined = await signer.signExplicit(transfer(n, parseGwei('5'), parseGwei('1')));
    await signer.sendRaw(mined.raw, { lease, minLeaseMs: 30_000 });
    await chain.rpc('evm_mine', []);
    const pending = await signer.signExplicit(transfer(n + 1, parseGwei('5'), parseGwei('1')));
    await signer.sendRaw(pending.raw, { lease, minLeaseMs: 30_000 });
    const unknown = (await signer.signExplicit(transfer(n + 2, parseGwei('5'), parseGwei('1')))).hash; // signed, never sent

    const views = await readNodeViews(CHAIN_ID, evaluator.address, [mined.hash, pending.hash, unknown], {
      proofTag: 'safe',
      urls: [chain.rpcUrl, DEAD_URL],
    });
    expect(views).toHaveLength(2);
    const [live, down] = views;
    expect(live).toMatchObject({ ok: true, index: 0, nonceLatest: n + 1, noncePending: n + 2 });
    expect(live!.node).toBe(`#0 127.0.0.1:${PORT}`);
    expect(live!.known).toEqual({ [mined.hash]: true, [pending.hash]: true, [unknown]: false });
    expect(live!.receipts![mined.hash]).toMatchObject({ txHash: mined.hash, status: 'success' });
    expect(live!.receipts![pending.hash]).toBeNull();
    expect(live!.receipts![unknown]).toBeNull();
    expect(live!.safeHead!.number).toBeLessThanOrEqual(live!.blockNumber!);
    expect(typeof live!.nonceAtTag).toBe('number');
    expect(live!.blockTimestamp).toBeGreaterThan(0n);

    expect(down).toMatchObject({ ok: false, index: 1, node: `#1 127.0.0.1:${PORT + 97}` });
    expect(down!.error).toBeTruthy();
    expect(down!.nonceLatest).toBeUndefined();

    const latestK = await readNodeViews(CHAIN_ID, evaluator.address, [], { proofTag: 1n, urls: [chain.rpcUrl] });
    expect(latestK[0]).toMatchObject({ ok: true, proofBlockNumber: live!.blockNumber! - 1n, nonceAtTag: n });

    await chain.rpc('evm_mine', []);
  });

  it('readBaseFeeAndPriorityP90 reads eth_feeHistory on the node', async () => {
    await chain.rpc('evm_mine', []);
    const fees = await readBaseFeeAndPriorityP90(CHAIN_ID, 3, { client: chain.publicClient });
    expect(fees.blocks).toBe(3);
    expect(fees.baseFee).toBeGreaterThan(0n);
    expect(fees.nextBaseFee).toBeGreaterThan(0n);
    expect(fees.priorityP90).toBeGreaterThanOrEqual(0n);
  });
});
