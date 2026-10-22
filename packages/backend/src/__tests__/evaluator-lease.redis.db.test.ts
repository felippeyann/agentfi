/**
 * A1 (spec C3g-A1 §7.1, R2-P3-2, plan P17) — the lane lease and the recovery
 * lock on a REAL Redis (REDIS_URL; for the A1 fronts the dedicated container
 * `redis://127.0.0.1:6391/<n>`, never the shared 6379).
 *
 * Proves, with the production Lua scripts:
 *  - token mismatch → `assertHeld` throws `not-held`, and the release leaves the other value alone;
 *  - expiry → the old lease throws, another holder takes the lane;
 *  - the `assertHeld` margin is measured on the key's real PTTL;
 *  - two holders (two lock instances, i.e. two processes) never hold one lane at once;
 *  - a release only frees the lane while it still holds the releaser's token;
 *  - the recovery lock: SET NX with owner + PID, the second acquirer is told
 *    who holds it, only the owner's handle releases it.
 *
 * Keys are unique per run and deleted afterwards; nothing is flushed.
 * Skipped (with a warning) when Redis is unreachable; on CI it fails instead.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LaneTimeoutError,
  LeaseLostError,
  RecoveryLockBusyError,
  RedisLaneLock,
  acquireRecoveryLock,
  readRecoveryLock,
  recoveryLockKey,
} from '../services/transaction/wallet-lane.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6391/2';

async function connect(): Promise<Redis | null> {
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, enableReadyCheck: false });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const REDIS = await connect();
if (!REDIS) {
  if (process.env['CI']) throw new Error('evaluator-lease.redis.db.test.ts needs Redis at REDIS_URL on CI');
  console.warn('[evaluator-lease.redis.db] REDIS_URL not reachable — suite skipped');
}
const describeRedis = REDIS ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = `a1-lease-${Date.now().toString(36)}-${process.pid}`;
// Chain ids no real deployment uses, so the fixed recovery key never meets another test's.
const CHAIN_A = 990_000 + (process.pid % 9_000);
const CHAIN_B = CHAIN_A + 1;

async function reasonOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LeaseLostError);
  return (err as LeaseLostError).reason;
}

beforeAll(async () => {
  await REDIS?.del(recoveryLockKey(CHAIN_A), recoveryLockKey(CHAIN_B));
});

afterAll(async () => {
  if (!REDIS) return;
  const keys = await REDIS.keys(`agentfi:lane:${prefix}*`);
  if (keys.length > 0) await REDIS.del(...keys);
  await REDIS.del(recoveryLockKey(CHAIN_A), recoveryLockKey(CHAIN_B));
  await REDIS.quit().catch(() => undefined);
});

describeRedis('lane lease on a real Redis', () => {
  it('token mismatch: assertHeld throws not-held and the release does not delete the other value', async () => {
    const lock = new RedisLaneLock(REDIS!, { ttlMs: 5_000 });
    const lease = await lock.acquire(`${prefix}:mismatch`);
    await lease.assertHeld(1_000);
    await REDIS!.set(`agentfi:lane:${prefix}:mismatch`, 'another-token', 'PX', 5_000);
    expect(await reasonOf(lease.assertHeld(0))).toBe('not-held');
    await lease.release();
    expect(await REDIS!.get(`agentfi:lane:${prefix}:mismatch`)).toBe('another-token');
  });

  it('expiry: past its TTL the lease throws, and another holder takes the lane', async () => {
    const lock = new RedisLaneLock(REDIS!, { ttlMs: 300 });
    const lease = await lock.acquire(`${prefix}:expiry`);
    await sleep(400);
    expect(['expired', 'not-held']).toContain(await reasonOf(lease.assertHeld(0)));
    const other = await new RedisLaneLock(REDIS!, { ttlMs: 5_000 }).acquire(`${prefix}:expiry`, { waitMs: 500 });
    await other.assertHeld(1_000);
    expect(await reasonOf(lease.assertHeld(0))).not.toBe('released');
    await other.release();
  });

  it("assertHeld margin is checked against the key's PTTL", async () => {
    const lock = new RedisLaneLock(REDIS!, { ttlMs: 2_000 });
    const lease = await lock.acquire(`${prefix}:margin`);
    await lease.assertHeld(1_500);
    await sleep(700);
    const err = await lease.assertHeld(1_500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).reason).toBe('margin');
    expect((err as LeaseLostError).remainingMs).toBeLessThan(1_500);
    expect((err as LeaseLostError).remainingMs).toBeGreaterThan(0);
    await lease.assertHeld(500);
    await lease.release();
    expect(await reasonOf(lease.assertHeld(0))).toBe('released');
  });

  it('two holders (two lock instances) never hold one lane at once', async () => {
    const a = new RedisLaneLock(REDIS!, { ttlMs: 5_000 });
    const b = new RedisLaneLock(REDIS!, { ttlMs: 5_000 });
    const first = await a.acquire(`${prefix}:two`);
    await expect(b.acquire(`${prefix}:two`, { waitMs: 150 })).rejects.toBeInstanceOf(LaneTimeoutError);
    const waiting = b.acquire(`${prefix}:two`, { waitMs: 3_000 });
    await sleep(100);
    await first.assertHeld(1_000);
    await first.release();
    const second = await waiting;
    await second.assertHeld(1_000);
    expect(await reasonOf(first.assertHeld(0))).toBe('released');
    expect(second.token).not.toBe(first.token);
    await second.release();
  });

  it('release only by the owner: an expired holder releasing late never frees the next holder', async () => {
    const slow = await new RedisLaneLock(REDIS!, { ttlMs: 200 }).acquire(`${prefix}:owner`);
    await sleep(300);
    const next = await new RedisLaneLock(REDIS!, { ttlMs: 5_000 }).acquire(`${prefix}:owner`, { waitMs: 500 });
    await slow.release();
    expect(await REDIS!.get(`agentfi:lane:${prefix}:owner`)).toBe(next.token);
    await next.assertHeld(1_000);
    await next.release();
    expect(await REDIS!.get(`agentfi:lane:${prefix}:owner`)).toBeNull();
  });
});

describeRedis('evaluator recovery lock on a real Redis', () => {
  it('SET NX with owner + PID; the second acquirer is told who holds it; only the owner releases', async () => {
    const mine = await acquireRecoveryLock(REDIS!, CHAIN_A, { owner: 'operator-a', host: 'ops-host' }, { ttlMs: 10_000 });
    expect(mine.key).toBe(`agentfi:evaluator-recovery:${CHAIN_A}`);
    expect(await REDIS!.pttl(mine.key)).toBeGreaterThan(9_000);
    expect(await readRecoveryLock(REDIS!, CHAIN_A)).toMatchObject({ owner: 'operator-a', pid: process.pid, host: 'ops-host' });

    const busy = await acquireRecoveryLock(REDIS!, CHAIN_A, { owner: 'operator-b', pid: 1 }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(RecoveryLockBusyError);
    expect((busy as RecoveryLockBusyError).holder).toMatchObject({ owner: 'operator-a', pid: process.pid });

    // Another chain is independent.
    const other = await acquireRecoveryLock(REDIS!, CHAIN_B, { owner: 'operator-b', pid: 1 }, { ttlMs: 10_000 });
    expect(await other.release()).toBe(true);

    await mine.assertHeld(5_000);
    expect(await mine.release()).toBe(true);
    expect(await readRecoveryLock(REDIS!, CHAIN_A)).toBeNull();
    expect(await reasonOf(mine.assertHeld())).toBe('released');
  });

  it('a holder whose lock expired and was retaken cannot release (owner check) nor assert it', async () => {
    const stale = await acquireRecoveryLock(REDIS!, CHAIN_A, { owner: 'crashed', pid: 99 }, { ttlMs: 200 });
    await sleep(300);
    const fresh = await acquireRecoveryLock(REDIS!, CHAIN_A, { owner: 'operator-c', pid: 3 }, { ttlMs: 10_000 });
    expect(['expired', 'not-held']).toContain(await reasonOf(stale.assertHeld()));
    expect(await stale.release()).toBe(false);
    expect(await readRecoveryLock(REDIS!, CHAIN_A)).toMatchObject({ owner: 'operator-c', pid: 3 });
    expect(await fresh.release()).toBe(true);
  });
});
