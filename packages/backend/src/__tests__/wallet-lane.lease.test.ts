/**
 * A1 (spec C3g-A1 §7.1, R2-P3-2) — the lane LEASE API, without Redis.
 *
 *  - `InMemoryLaneLock.acquire`: one holder per key; a TTL after which the
 *    lane frees itself and the old lease is never authority again; the
 *    `assertHeld` margin; a release that never frees the next holder; a
 *    waiter that times out without wedging the FIFO; `run` and `acquire`
 *    exclude each other.
 *  - `RedisLaneLock` and the recovery lock against a FAKE Redis that
 *    interprets the two Lua scripts (compare-and-delete; GET == token AND
 *    PTTL ≥ margin): token mismatch, margin, a key without expiry, Redis
 *    unreachable (fail closed), and the holder's own clock (a lease past its
 *    TTL is refused even when the store still shows the token).
 *  The same behaviours on a REAL Redis: `evaluator-lease.redis.db.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSERT_HELD_SCRIPT,
  InMemoryLaneLock,
  LaneTimeoutError,
  LeaseLostError,
  RecoveryLockBusyError,
  RedisLaneLock,
  acquireRecoveryLock,
  evaluatorLaneKey,
  readRecoveryLock,
  recoveryLockKey,
  walletLaneKey,
} from '../services/transaction/wallet-lane.js';

/** A Redis stand-in for SET NX PX / GET / EVAL of the lane scripts, on `Date.now()` (fake timers drive it). */
class FakeRedis {
  readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  /** When set, keys never expire in the store (to prove the holder's own clock still refuses). */
  frozen = false;
  failEval = false;
  /**
   * #194 review (id 4363039159): a SLOW answer — the assert-held script is evaluated at call time, then the
   * (fake) clock moves this many ms before the answer is returned, as a delayed network reply would.
   */
  assertHeldReplyDelayMs = 0;

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (!this.frozen && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: string, px: string, ttl: number, nx: string): Promise<'OK' | null> {
    expect([px, nx]).toEqual(['PX', 'NX']);
    if (this.live(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async eval(script: string, _n: number, key: string, ...args: string[]): Promise<unknown> {
    if (this.failEval) throw new Error('connect ECONNREFUSED redis://user:hunter2@10.0.0.5:6379');
    const entry = this.live(key);
    if (script === ASSERT_HELD_SCRIPT) {
      if (!entry || entry.value !== args[0]) return [-1, -2];
      if (entry.expiresAt === null) return [-2, -1];
      const ttl = entry.expiresAt - Date.now();
      const answer = ttl < Number(args[1]) ? [0, ttl] : [1, ttl];
      if (this.assertHeldReplyDelayMs > 0) vi.setSystemTime(Date.now() + this.assertHeldReplyDelayMs);
      return answer;
    }
    if (script.includes("redis.call('del'")) {
      if (entry && entry.value === args[0]) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    throw new Error(`unexpected script: ${script}`);
  }
}

async function lostReason(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LeaseLostError);
  return (err as LeaseLostError).reason;
}

describe('lane keys', () => {
  it('the evaluator lane IS the broadcast lane of the evaluator address; the recovery lock has its own key', () => {
    expect(evaluatorLaneKey(84532, '0xAbC0000000000000000000000000000000000001')).toBe(walletLaneKey(84532, '0xabc0000000000000000000000000000000000001'));
    expect(recoveryLockKey(84532)).toBe('agentfi:evaluator-recovery:84532');
  });
});

describe('InMemoryLaneLock leases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('one holder per key; the next acquire waits for release; tokens differ; other keys are free', async () => {
    const lock = new InMemoryLaneLock({ ttlMs: 10_000 });
    const first = await lock.acquire('k');
    const other = await lock.acquire('other');
    let second: Awaited<ReturnType<typeof lock.acquire>> | null = null;
    const waiting = lock.acquire('k').then((l) => (second = l));
    await vi.advanceTimersByTimeAsync(50);
    expect(second).toBeNull();
    await first.assertHeld(0);
    await first.release();
    await waiting;
    expect(second!.token).not.toBe(first.token);
    await second!.assertHeld(5_000);
    expect(await lostReason(first.assertHeld(0))).toBe('released');
    await other.assertHeld(0);
  });

  it('assertHeld enforces the remaining-TTL margin', async () => {
    const lock = new InMemoryLaneLock({ ttlMs: 1_000 });
    const lease = await lock.acquire('k');
    await lease.assertHeld(900);
    await vi.advanceTimersByTimeAsync(700);
    expect(await lostReason(lease.assertHeld(500))).toBe('margin');
    await lease.assertHeld(200);
    await expect(lease.assertHeld(-1)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('a lease past its TTL is never authority again; the lane frees itself; its late release never frees the next holder', async () => {
    const lock = new InMemoryLaneLock({ ttlMs: 1_000 });
    const old = await lock.acquire('k');
    let next: Awaited<ReturnType<typeof lock.acquire>> | null = null;
    const waiting = lock.acquire('k').then((l) => (next = l));
    await vi.advanceTimersByTimeAsync(1_001);
    await waiting;
    expect(next).not.toBeNull();
    expect(await lostReason(old.assertHeld(0))).toBe('not-held');
    await old.release(); // late: must not touch the new holder
    await next!.assertHeld(500);
  });

  it('a waiter that times out throws LaneTimeoutError and does not wedge the lane', async () => {
    const lock = new InMemoryLaneLock({ ttlMs: 60_000 });
    const holder = await lock.acquire('k');
    const timedOut = lock.acquire('k', { waitMs: 100 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(150);
    expect(await timedOut).toBeInstanceOf(LaneTimeoutError);
    await holder.release();
    const after = await lock.acquire('k', { waitMs: 100 });
    await after.assertHeld(0);
  });

  it('run and acquire exclude each other on one key', async () => {
    const lock = new InMemoryLaneLock({ ttlMs: 60_000 });
    const lease = await lock.acquire('k');
    let ran = false;
    const running = lock.run('k', async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(ran).toBe(false);
    await lease.release();
    await running;
    expect(ran).toBe(true);
  });
});

describe('RedisLaneLock leases — Lua semantics on a fake Redis', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET == token AND PTTL >= margin; a foreign token is not-held; the release is compare-and-delete', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLaneLock(redis as never, { ttlMs: 1_000 });
    const lease = await lock.acquire('k');
    expect(redis.store.get('agentfi:lane:k')!.value).toBe(lease.token);
    await lease.assertHeld(900);
    await vi.advanceTimersByTimeAsync(600);
    expect(await lostReason(lease.assertHeld(500))).toBe('margin');
    await lease.assertHeld(300);

    redis.store.set('agentfi:lane:k', { value: 'someone-else', expiresAt: Date.now() + 5_000 });
    expect(await lostReason(lease.assertHeld(0))).toBe('not-held');
    await lease.release();
    expect(redis.store.get('agentfi:lane:k')!.value).toBe('someone-else');
  });

  it("the holder's own clock refuses a lease past its TTL even if the store still shows the token", async () => {
    const redis = new FakeRedis();
    redis.frozen = true;
    const lock = new RedisLaneLock(redis as never, { ttlMs: 1_000 });
    const lease = await lock.acquire('k');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await lostReason(lease.assertHeld(0))).toBe('expired');
  });

  it('fails closed: Redis unreachable → unverifiable (no URL in the message); a key without expiry → unverifiable', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLaneLock(redis as never, { ttlMs: 1_000 });
    const lease = await lock.acquire('k');
    redis.failEval = true;
    const err = await lease.assertHeld(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).reason).toBe('unverifiable');
    expect((err as Error).message).not.toMatch(/hunter2|10\.0\.0\.5/);
    redis.failEval = false;
    redis.store.set('agentfi:lane:k', { value: lease.token, expiresAt: null });
    expect(await lostReason(lease.assertHeld(0))).toBe('unverifiable');
  });

  it('run() keeps working on top of acquire/release', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLaneLock(redis as never, { ttlMs: 1_000 });
    expect(await lock.run('k', async () => (redis.store.has('agentfi:lane:k') ? 'held' : 'free'))).toBe('held');
    expect(redis.store.has('agentfi:lane:k')).toBe(false);
  });

  // #194 review id 4363039159 (P2, exclusion safety) — FIXED: the local remaining time and the PTTL were taken
  // BEFORE the awaited Redis answer; both are now re-based on the clock at the answer. A reply delayed past the deadline (or below the margin) must not be accepted: both
  // evaluator send paths broadcast right after assertHeld.
  it('#194-4363039159: a Redis answer delayed PAST the lease deadline → expired (not accepted)', async () => {
    const redis = new FakeRedis();
    redis.frozen = true; // the store still shows the token: only the holder's clock can refuse
    const lock = new RedisLaneLock(redis as never, { ttlMs: 1_000 });
    const lease = await lock.acquire('k');
    redis.assertHeldReplyDelayMs = 1_200;
    expect(await lostReason(lease.assertHeld(0))).toBe('expired');
  });

  it('#194-4363039159: a Redis answer delayed BELOW the margin → margin (not accepted)', async () => {
    const redis = new FakeRedis();
    const lock = new RedisLaneLock(redis as never, { ttlMs: 1_000 });
    const lease = await lock.acquire('k');
    redis.assertHeldReplyDelayMs = 600; // evaluated with 1 000 ms left (≥ 500), answered with ~400 ms left
    expect(await lostReason(lease.assertHeld(500))).toBe('margin');
  });
});

describe('recovery lock — owner + PID, compare-and-delete (fake Redis)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('SET NX with owner and PID; a second acquire names the holder; only the owner releases', async () => {
    const redis = new FakeRedis();
    const mine = await acquireRecoveryLock(redis as never, 84532, { owner: 'alice', pid: 4242, host: 'ops-1' }, { ttlMs: 10_000 });
    expect(await readRecoveryLock(redis as never, 84532)).toMatchObject({ owner: 'alice', pid: 4242, host: 'ops-1' });
    const busy = await acquireRecoveryLock(redis as never, 84532, { owner: 'bob', pid: 7 }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(RecoveryLockBusyError);
    expect((busy as RecoveryLockBusyError).holder).toMatchObject({ owner: 'alice', pid: 4242 });
    expect((busy as Error).message).toMatch(/alice \(pid 4242 on ops-1\)/);
    await mine.assertHeld();

    // Expired, then taken by bob: alice's late release frees nothing.
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await lostReason(mine.assertHeld())).toBe('expired');
    const bobs = await acquireRecoveryLock(redis as never, 84532, { owner: 'bob', pid: 7 }, { ttlMs: 10_000 });
    expect(await mine.release()).toBe(false);
    expect(await readRecoveryLock(redis as never, 84532)).toMatchObject({ owner: 'bob', pid: 7 });
    await bobs.assertHeld(1_000);
    expect(await bobs.release()).toBe(true);
    expect(await readRecoveryLock(redis as never, 84532)).toBeNull();
    expect(await bobs.release()).toBe(false);
  });

  it('#194-4363039159: the recovery lock — a Redis answer delayed past its deadline → expired (not accepted)', async () => {
    const redis = new FakeRedis();
    redis.frozen = true;
    const mine = await acquireRecoveryLock(redis as never, 84532, { owner: 'alice', pid: 4242 }, { ttlMs: 10_000 });
    redis.assertHeldReplyDelayMs = 10_500;
    expect(await lostReason(mine.assertHeld())).toBe('expired');
  });

  it('refuses an empty owner', async () => {
    await expect(acquireRecoveryLock(new FakeRedis() as never, 1, { owner: ' ' })).rejects.toThrow(/owner is required/);
  });
});
