/**
 * Unit tests — per-wallet lanes and the submitter's nonce handling (C3c / N1).
 *
 *  - `InMemoryLaneLock` / `RedisLaneLock`: one holder per key at a time,
 *    other keys independent, a lane freed after a throw, a stale holder's
 *    release never frees the next holder (compare-and-delete). The Redis test
 *    runs against REDIS_URL when it answers (CI has Redis) and is skipped
 *    otherwise.
 *  - `SubmitterService` against the in-memory chain: two transactions of one
 *    wallet submitted concurrently collide on the nonce without the lane
 *    (control) and get consecutive nonces with it; the last broadcast nonce
 *    beats a pending count that lags; a broadcast whose answer was lost but
 *    which a node knows is returned as a success instead of being re-signed.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';

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
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import {
  InMemoryLaneLock,
  InMemoryNonceStore,
  LaneTimeoutError,
  RedisLaneLock,
  RedisNonceStore,
  walletLaneKey,
} from '../services/transaction/wallet-lane.js';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { FakeEscrowChain, FakeWallets, SIM_USDC } from './helpers/fake-escrow-chain.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs two critical sections on the same lane and records how they interleave. */
async function overlapOf(run: (key: string, fn: () => Promise<void>) => Promise<void>, keyA: string, keyB: string): Promise<string[]> {
  const events: string[] = [];
  const section = (name: string) => async () => {
    events.push(`${name}:in`);
    await sleep(20);
    events.push(`${name}:out`);
  };
  await Promise.all([run(keyA, section('a')), run(keyB, section('b'))]);
  return events;
}

describe('InMemoryLaneLock', () => {
  it('serializes one key and leaves other keys concurrent', async () => {
    const lock = new InMemoryLaneLock();
    const run = (key: string, fn: () => Promise<void>) => lock.run(key, fn);
    expect(await overlapOf(run, 'k', 'k')).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
    expect(await overlapOf(run, 'k1', 'k2')).toEqual(['a:in', 'b:in', 'a:out', 'b:out']);
  });

  it('frees the lane when the holder throws', async () => {
    const lock = new InMemoryLaneLock();
    await expect(lock.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await lock.run('k', async () => 'next')).toBe('next');
  });

  it('keys broadcast lanes by chain and lower-cased sender', () => {
    expect(walletLaneKey(84532, '0xAbC0000000000000000000000000000000000001')).toBe('84532:0xabc0000000000000000000000000000000000001');
  });
});

describe('InMemoryNonceStore', () => {
  it('keeps the highest nonce for the TTL, then forgets it', async () => {
    let now = 1_000;
    const store = new InMemoryNonceStore(60_000, () => now);
    await store.recordUsed('lane', 4);
    await store.recordUsed('lane', 3);
    expect(await store.lastUsed('lane')).toBe(4);
    now += 60_001;
    expect(await store.lastUsed('lane')).toBeNull();
  });
});

// ── Redis (cross-process) ──────────────────────────────────────────────────

async function redisReachable(url: string): Promise<Redis | null> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const REDIS = await redisReachable(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
if (!REDIS) console.warn('[wallet-lane.test] REDIS_URL not reachable — RedisLaneLock tests skipped');
const describeRedis = REDIS ? describe : describe.skip;
afterAll(async () => {
  await REDIS?.quit().catch(() => undefined);
});

describeRedis('RedisLaneLock (REDIS_URL)', () => {
  const prefix = `c3c-test-${Date.now().toString(36)}`;

  it('serializes one key across two lock instances (two processes) and leaves other keys concurrent', async () => {
    const first = new RedisLaneLock(REDIS!);
    const second = new RedisLaneLock(REDIS!);
    const run = (key: string, fn: () => Promise<void>) => (key.endsWith('#b') ? second : first).run(key.replace('#b', ''), fn);
    expect(await overlapOf(run, `${prefix}:same`, `${prefix}:same#b`)).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
    expect(await overlapOf(run, `${prefix}:one`, `${prefix}:two#b`)).toEqual(['a:in', 'b:in', 'a:out', 'b:out']);
  });

  it('gives up with LaneTimeoutError while another holder keeps the lane', async () => {
    const holder = new RedisLaneLock(REDIS!, { ttlMs: 5_000 });
    const waiter = new RedisLaneLock(REDIS!, { waitMs: 150 });
    let release!: () => void;
    const held = holder.run(`${prefix}:busy`, () => new Promise<void>((resolve) => (release = resolve)));
    await sleep(20);
    await expect(waiter.run(`${prefix}:busy`, async () => 'never')).rejects.toBeInstanceOf(LaneTimeoutError);
    release();
    await held;
    expect(await waiter.run(`${prefix}:busy`, async () => 'after')).toBe('after');
  });

  it("a holder whose TTL ran out never frees the next holder's lane (compare-and-delete)", async () => {
    const slow = new RedisLaneLock(REDIS!, { ttlMs: 50 });
    const fast = new RedisLaneLock(REDIS!, { ttlMs: 5_000, waitMs: 2_000 });
    const key = `${prefix}:ttl`;
    const slowRun = slow.run(key, () => sleep(150)); // its TTL expires mid-section
    await sleep(80);
    let fastInside = false;
    const fastRun = fast.run(key, async () => {
      fastInside = true;
      await sleep(150); // the slow holder releases meanwhile — must not free this lane
      expect(await REDIS!.get(`agentfi:lane:${key}`)).not.toBeNull();
    });
    await Promise.all([slowRun, fastRun]);
    expect(fastInside).toBe(true);
  });

  it('RedisNonceStore keeps the highest nonce per lane', async () => {
    const store = new RedisNonceStore(REDIS!, 5_000);
    await store.recordUsed(`${prefix}:n`, 7);
    await store.recordUsed(`${prefix}:n`, 5);
    expect(await store.lastUsed(`${prefix}:n`)).toBe(7);
    expect(await store.lastUsed(`${prefix}:missing`)).toBeNull();
  });
});

// ── SubmitterService nonces ────────────────────────────────────────────────

function approveCall(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [spender, amount],
  });
}

function setup(opts: { lane: boolean; client?: (chain: FakeEscrowChain) => unknown }) {
  const chain = new FakeEscrowChain();
  const wallets = new FakeWallets();
  const from = wallets.create('w1');
  const submitter = new SubmitterService({
    wallet: wallets,
    ...(opts.lane ? { lane: new InMemoryLaneLock(), nonces: new InMemoryNonceStore() } : {}),
    client: () => (opts.client ? opts.client(chain) : chain.rpcClient) as never,
  });
  const submit = (amount: bigint) =>
    submitter.submit({ chainId: 84532, walletId: 'w1', from: getAddress(from), to: SIM_USDC, data: approveCall(getAddress('0x00000000000000000000000000000000000e5c20'), amount), value: 0n });
  return { chain, from, submit };
}

describe('SubmitterService — one wallet, concurrent transactions (N1)', () => {
  it('control: without the lane two concurrent submits read the same nonce and one broadcast is refused', async () => {
    const { chain, submit } = setup({ lane: false });
    const results = await Promise.allSettled([submit(1n), submit(2n)]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(chain.rejectedBroadcasts.join()).toMatch(/nonce too low/);
  });

  it('with the lane: consecutive nonces, both broadcast, nothing refused', async () => {
    const { chain, submit } = setup({ lane: true });
    const results = await Promise.all([submit(1n), submit(2n), submit(3n)]);
    expect(results.map((r) => r.nonce).sort()).toEqual([0, 1, 2]);
    expect(chain.rejectedBroadcasts).toEqual([]);
    expect(chain.broadcasts).toHaveLength(3);
  });

  it('reads the pending count, and the last broadcast nonce wins over a pending count that lags (load-balanced RPC)', async () => {
    let lagging = false;
    const { chain, submit } = setup({
      lane: true,
      client: (c) => ({
        ...c.rpcClient,
        // A node behind the balancer that has not seen the previous broadcast yet.
        getTransactionCount: async (args: { address: Address; blockTag?: 'latest' | 'pending' }) =>
          lagging ? 0 : c.rpcClient.getTransactionCount(args),
      }),
    });
    chain.autoMine = false;
    expect((await submit(1n)).nonce).toBe(0);
    lagging = true;
    expect((await submit(2n)).nonce).toBe(1);
    expect(chain.rejectedBroadcasts).toEqual([]);
  });

  it('a broadcast whose answer was lost but which a node knows is a success (no second signature)', async () => {
    const { chain, submit } = setup({ lane: true });
    chain.dropResponse = () => true;
    const result = await submit(5n);
    expect(result.nonce).toBe(0);
    expect(chain.broadcasts).toHaveLength(1);
    expect(chain.getTransaction(result.txHash).nonce).toBe(0);
  });

  it('a lost answer no node knows still throws (BullMQ retries)', async () => {
    const { chain, submit } = setup({ lane: true });
    chain.dropResponse = () => true;
    chain.dropResponseHide = true;
    await expect(submit(5n)).rejects.toThrow();
  });
});
