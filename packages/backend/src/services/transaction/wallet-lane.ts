/**
 * Per-wallet serial lanes (C3c, absorbs N1).
 *
 * Two kinds of serialization keep one wallet's transactions from stepping on
 * each other when the transaction worker runs with concurrency > 1, on more
 * than one process, or both:
 *
 *  1. **Broadcast lane** — `SubmitterService.submit` holds the lane
 *     `<chainId>:<from>` from the nonce read to the broadcast, and reads the
 *     nonce with `blockTag: 'pending'` (plus the last nonce this lane
 *     broadcast, `NonceStore`, for RPC providers whose nodes see the mempool a
 *     moment late). Two transactions of one wallet — a requester funding two
 *     jobs, a provider's ERC-8004 bind next to a `submit` for another job, an
 *     agent that is both requester and provider, two retry submits — get
 *     consecutive nonces instead of colliding on the same one.
 *  2. **Funding lane** — the ERC-8183 orchestrator holds `funding:<chainId>:<agentId>`
 *     while it decides which of a requester's jobs may send `approve` next, so
 *     `approve(escrow, budget)` → `fund` of one job never interleaves with
 *     another job's `approve` (which would overwrite the allowance and make one
 *     `fund` revert). The lane itself is the DB state (see
 *     `escrow-erc8183.service.ts` `pumpFunding`); the lock only makes the
 *     check-and-claim atomic across processes.
 *
 * `RedisLaneLock` is the production lock (SET NX PX + compare-and-delete, one
 * key per lane, shared by every API/worker process); `InMemoryLaneLock` is the
 * single-process equivalent used by tests.
 *
 * A1 (spec C3g-A1 §7.1, R2-P3-2): both locks also hand out a LEASE
 * (`acquire`) for callers that must prove, right before an irreversible step
 * (a broadcast), that the lane is still theirs: `assertHeld(minRemainingMs)`
 * checks, atomically in one Lua script, that the lane key still holds THIS
 * lease's token AND that its remaining TTL (`PTTL`) is at least the margin;
 * otherwise it throws `LeaseLostError`. The lane TTL is never renewed: a
 * lease whose TTL ran out is never authority again, even if no one took the
 * lane meanwhile (`assertHeld` also fails on the holder's own clock). The
 * window left between `assertHeld` and the send is bounded by the margin
 * and is declared (R2-P3-2): its worst case, two candidates in one nonce, is
 * what the evaluator transaction ledger resolves.
 *
 * The evaluator recovery script additionally holds `recoveryLockKey(chainId)`
 * (SET NX with owner + PID, long expiry, compare-and-delete release) so two
 * scripts never drive the same chain's recovery at once (§7.1).
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface LaneLock {
  /** Runs `fn` while holding lane `key` exclusively; waits for the current holder first. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * A held lane (A1, R2-P3-2). Not renewable: the lane frees itself when its
 * TTL runs out, and from then on `assertHeld` always throws.
 */
export interface LaneLease {
  /** The lane key as given to `acquire` (without the Redis prefix). */
  readonly key: string;
  /** Random per acquisition; the lane key holds it while the lease is ours. */
  readonly token: string;
  /** `Date.now()` taken just BEFORE the lane was requested (elapsed time is never under-counted; plan P17). */
  readonly acquiredAt: number;
  /**
   * Resolves only if the lane still holds this lease's token AND at least
   * `minRemainingMs` of its TTL remain (Redis `PTTL`, and the holder's own
   * clock). Otherwise — lost, expired, released, too close to expiry, or the
   * store could not be asked — throws `LeaseLostError`. Call it IMMEDIATELY
   * before the irreversible step.
   */
  assertHeld(minRemainingMs: number): Promise<void>;
  /** Compare-and-delete: frees the lane only while it still holds this token. Idempotent; never throws. */
  release(): Promise<void>;
}

/** A lane lock that also hands out leases (the production and in-memory locks both implement it). */
export interface LeaseLock extends LaneLock {
  /** Waits for lane `key` (up to `waitMs`, else `LaneTimeoutError`) and returns the lease. */
  acquire(key: string, opts?: { waitMs?: number }): Promise<LaneLease>;
}

export type LeaseLostReason = 'not-held' | 'expired' | 'margin' | 'released' | 'unverifiable';

/** The lease is not (or no longer provably) ours with the required margin: do not broadcast. */
export class LeaseLostError extends Error {
  constructor(
    public readonly lane: string,
    public readonly reason: LeaseLostReason,
    public readonly remainingMs: number | null,
    public readonly minRemainingMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Lane lease ${lane} is not held with ${minRemainingMs} ms to spare (${reason}${remainingMs === null ? '' : `, ${remainingMs} ms left`}): nothing may be broadcast under it`,
      options,
    );
    this.name = 'LeaseLostError';
  }
}

function assertMargin(lane: string, minRemainingMs: number): void {
  if (!Number.isFinite(minRemainingMs) || minRemainingMs < 0) {
    throw new LeaseLostError(lane, 'unverifiable', null, minRemainingMs);
  }
}

/** Remembers the last nonce a broadcast lane used, for a short window. */
export interface NonceStore {
  lastUsed(key: string): Promise<number | null>;
  recordUsed(key: string, nonce: number): Promise<void>;
}

export class LaneTimeoutError extends Error {
  constructor(
    public readonly lane: string,
    public readonly waitedMs: number,
  ) {
    super(`Wallet lane ${lane} is busy: not acquired within ${waitedMs} ms`);
    this.name = 'LaneTimeoutError';
  }
}

/** Broadcast lane key: one lane per sending address and chain. */
export function walletLaneKey(chainId: number, from: string): string {
  return `${chainId}:${from.toLowerCase()}`;
}

/** Funding lane key: one lane per requester agent and chain. */
export function fundingLaneKey(chainId: number, agentId: string): string {
  return `funding:${chainId}:${agentId}`;
}

/**
 * A1 §7.1: the evaluator key's lane. The SAME key as the broadcast lane of
 * that address (`walletLaneKey`), so the settlement worker, the recovery
 * script and anything else sending from the evaluator serialize on one lane.
 */
export function evaluatorLaneKey(chainId: number, evaluator: string): string {
  return walletLaneKey(chainId, evaluator);
}

/** A1 §7.1: the per-chain recovery lock (one recovery script per chain at a time). A full Redis key, no lane prefix. */
export function recoveryLockKey(chainId: number): string {
  return `agentfi:evaluator-recovery:${chainId}`;
}

// ── In-memory (tests, single process) ──────────────────────────────────────

/**
 * Single-process lanes. `run` keeps its historical semantics (FIFO, no TTL);
 * `acquire` joins the same FIFO and models the Redis lease: a TTL after which
 * the lane frees itself for the next waiter and `assertHeld` fails. Timers
 * follow `setTimeout` / `Date.now`, so vitest fake timers drive them.
 */
export class InMemoryLaneLock implements LeaseLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly opts: { ttlMs?: number; waitMs?: number } = {}) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async acquire(key: string, opts: { waitMs?: number } = {}): Promise<LaneLease> {
    const acquiredAt = Date.now();
    const ttlMs = this.opts.ttlMs ?? LANE_TTL_MS;
    const waitMs = opts.waitMs ?? this.opts.waitMs ?? LANE_WAIT_MS;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let freeLane!: () => void;
    const held = new Promise<void>((resolve) => {
      freeLane = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    const cleanup = () => {
      freeLane();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };

    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const turn = await Promise.race([
      previous.then(() => 'mine' as const),
      new Promise<'timeout'>((resolve) => {
        waitTimer = setTimeout(() => resolve('timeout'), waitMs);
      }),
    ]);
    clearTimeout(waitTimer);
    if (turn === 'timeout') {
      // Our place in the FIFO is handed on as soon as it comes up.
      void previous.then(cleanup);
      throw new LaneTimeoutError(key, waitMs);
    }

    const token = randomUUID();
    const holders = this.holders;
    holders.set(key, { token, expiresAt: Date.now() + ttlMs });
    const expiry = setTimeout(() => {
      // The TTL ran out: the lane frees itself, like a Redis key set with PX.
      if (holders.get(key)?.token === token) holders.delete(key);
      cleanup();
    }, ttlMs);
    (expiry as { unref?: () => void }).unref?.();

    let released = false;
    return {
      key,
      token,
      acquiredAt,
      async assertHeld(minRemainingMs: number): Promise<void> {
        assertMargin(key, minRemainingMs);
        if (released) throw new LeaseLostError(key, 'released', null, minRemainingMs);
        const holder = holders.get(key);
        if (!holder || holder.token !== token) throw new LeaseLostError(key, 'not-held', null, minRemainingMs);
        const remaining = holder.expiresAt - Date.now();
        if (remaining <= 0) throw new LeaseLostError(key, 'expired', remaining, minRemainingMs);
        if (remaining < minRemainingMs) throw new LeaseLostError(key, 'margin', remaining, minRemainingMs);
      },
      async release(): Promise<void> {
        if (released) return;
        released = true;
        clearTimeout(expiry);
        if (holders.get(key)?.token === token) {
          holders.delete(key);
          cleanup();
        }
      },
    };
  }
}

export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, { nonce: number; at: number }>();

  constructor(
    private readonly ttlMs = NONCE_MEMORY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async lastUsed(key: string): Promise<number | null> {
    const entry = this.entries.get(key);
    if (!entry || this.now() - entry.at > this.ttlMs) return null;
    return entry.nonce;
  }

  async recordUsed(key: string, nonce: number): Promise<void> {
    const current = await this.lastUsed(key);
    if (current === null || nonce > current) this.entries.set(key, { nonce, at: this.now() });
  }
}

// ── Redis (production, cross-process) ──────────────────────────────────────

/**
 * How long a broadcast lane may be held before Redis frees it on its own
 * (a crashed holder). Covers estimateGas + nonce + gas price reads, the
 * signature (Turnkey) and a broadcast with its fallback RPC.
 */
export const LANE_TTL_MS = 120_000;
/** How long a caller waits for a busy lane before giving up (BullMQ then retries the job). */
export const LANE_WAIT_MS = 120_000;
/**
 * How long the last broadcast nonce of a lane is trusted over the node's
 * pending count. Long enough for a load-balanced RPC to see the previous
 * broadcast, short enough that a dropped transaction cannot leave a
 * permanent nonce gap: after it the node's pending count wins again and the
 * next transaction fills the gap.
 */
export const NONCE_MEMORY_TTL_MS = 60_000;

const KEY_PREFIX = 'agentfi:lane:';
const NONCE_PREFIX = 'agentfi:lane-nonce:';
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

type LaneRedis = Pick<Redis, 'set' | 'get' | 'eval'>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A1 (R2-P3-2), one atomic step: the key still holds the token AND its PTTL
 * is at least the margin. Returns `{status, pttl}`: 1 held with the margin,
 * 0 held but under the margin, -1 not held (absent or another token), -2 held
 * without an expiry (never set by a lease; refused).
 */
export const ASSERT_HELD_SCRIPT = [
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then return {-1, -2} end",
  "local ttl = redis.call('pttl', KEYS[1])",
  'if ttl < 0 then return {-2, ttl} end',
  'if ttl < tonumber(ARGV[2]) then return {0, ttl} end',
  'return {1, ttl}',
].join('\n');

/**
 * Checks a Redis-held lease: the Lua answer first, then the holder's own
 * clock (`localDeadline`, computed from a time taken BEFORE the SET, so it is
 * never later than the key's real expiry). Any doubt throws.
 *
 * #194 review (4363039159): the time left is judged AFTER the awaited answer.
 * Both the local deadline and the PTTL are re-based on the clock at the
 * answer: the local remaining time is recomputed, and the PTTL loses the whole
 * round trip (the script ran at some point between the call and the answer,
 * so `pttl - roundTrip` never over-states what is left). A slow reply can only
 * make the check refuse, never accept a lease that expired or fell below the
 * margin while the answer was in flight.
 */
async function assertRedisLeaseHeld(
  redis: LaneRedis,
  lane: string,
  redisKey: string,
  token: string,
  localDeadline: number,
  minRemainingMs: number,
): Promise<void> {
  assertMargin(lane, minRemainingMs);
  const calledAt = Date.now();
  const localRemainingBefore = localDeadline - calledAt;
  if (localRemainingBefore <= 0) throw new LeaseLostError(lane, 'expired', localRemainingBefore, minRemainingMs);
  let answer: unknown;
  try {
    answer = await redis.eval(ASSERT_HELD_SCRIPT, 1, redisKey, token, String(Math.ceil(minRemainingMs)));
  } catch (err) {
    throw new LeaseLostError(lane, 'unverifiable', null, minRemainingMs, { cause: err });
  }
  const answeredAt = Date.now();
  const [status, pttl] = Array.isArray(answer) ? answer.map(Number) : [Number.NaN, Number.NaN];
  if (status === -1) throw new LeaseLostError(lane, 'not-held', null, minRemainingMs);
  if (status !== 0 && status !== 1) throw new LeaseLostError(lane, 'unverifiable', null, minRemainingMs);
  if (!Number.isFinite(pttl)) throw new LeaseLostError(lane, 'unverifiable', null, minRemainingMs);
  const localRemaining = localDeadline - answeredAt;
  const pttlNow = pttl! - Math.max(0, answeredAt - calledAt);
  const remaining = Math.min(pttlNow, localRemaining);
  if (remaining <= 0) throw new LeaseLostError(lane, 'expired', remaining, minRemainingMs);
  if (status === 0 || remaining < minRemainingMs) throw new LeaseLostError(lane, 'margin', remaining, minRemainingMs);
}

class RedisLaneLease implements LaneLease {
  private released = false;

  constructor(
    private readonly redis: LaneRedis,
    readonly key: string,
    private readonly redisKey: string,
    readonly token: string,
    readonly acquiredAt: number,
    private readonly localDeadline: number,
  ) {}

  async assertHeld(minRemainingMs: number): Promise<void> {
    if (this.released) throw new LeaseLostError(this.key, 'released', null, minRemainingMs);
    await assertRedisLeaseHeld(this.redis, this.key, this.redisKey, this.token, this.localDeadline, minRemainingMs);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // Compare-and-delete: never free a lane another holder took after our TTL ran out.
    await this.redis.eval(RELEASE_SCRIPT, 1, this.redisKey, this.token).catch(() => undefined);
  }
}

export class RedisLaneLock implements LeaseLock {
  constructor(
    private readonly redis: LaneRedis,
    private readonly opts: { ttlMs?: number; waitMs?: number } = {},
  ) {}

  async acquire(key: string, opts: { waitMs?: number } = {}): Promise<LaneLease> {
    const redisKey = KEY_PREFIX + key;
    const token = randomUUID();
    const ttlMs = this.opts.ttlMs ?? LANE_TTL_MS;
    const waitMs = opts.waitMs ?? this.opts.waitMs ?? LANE_WAIT_MS;
    const acquiredAt = Date.now();
    const deadline = acquiredAt + waitMs;
    let delay = 25;
    for (;;) {
      // Taken before each SET: the local deadline can only be EARLIER than the key's expiry.
      const attemptAt = Date.now();
      const acquired = await this.redis.set(redisKey, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') return new RedisLaneLease(this.redis, key, redisKey, token, acquiredAt, attemptAt + ttlMs);
      if (Date.now() >= deadline) throw new LaneTimeoutError(key, waitMs);
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 500);
    }
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(key);
    try {
      return await fn();
    } finally {
      await lease.release();
    }
  }
}

// ── Evaluator recovery lock (A1 §7.1) ──────────────────────────────────────

/**
 * How long the recovery lock outlives a script that died without releasing
 * it. Long on purpose (the lock covers a whole recovery: dry-run, the typed
 * confirmation, several nonces and their receipt waits); a live script
 * releases it at the end. An implementation parameter, not a spending cap.
 */
export const RECOVERY_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

/** Who holds the recovery lock (stored as JSON in the key; no secret in it). */
export interface RecoveryLockHolder {
  owner: string;
  pid: number;
  host: string | null;
  token: string;
  acquiredAt: string;
}

export interface RecoveryLockHandle {
  readonly key: string;
  readonly holder: RecoveryLockHolder;
  /** Throws `LeaseLostError` unless the key still holds exactly this holder's value (and `minRemainingMs` of TTL). */
  assertHeld(minRemainingMs?: number): Promise<void>;
  /** Compare-and-delete on the full value: true when this call freed it; false when it was no longer ours. Never throws. */
  release(): Promise<boolean>;
}

/** Another recovery is running on this chain (or a dead one's lock has not expired yet). */
export class RecoveryLockBusyError extends Error {
  constructor(
    readonly chainId: number,
    readonly holder: RecoveryLockHolder | null,
  ) {
    super(
      holder
        ? `Evaluator recovery lock for chain ${chainId} is held by ${holder.owner} (pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}) since ${holder.acquiredAt}`
        : `Evaluator recovery lock for chain ${chainId} is held`,
    );
    this.name = 'RecoveryLockBusyError';
  }
}

function parseHolder(raw: string | null): RecoveryLockHolder | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<RecoveryLockHolder>;
    if (typeof value.owner === 'string' && typeof value.pid === 'number' && typeof value.token === 'string') {
      return {
        owner: value.owner,
        pid: value.pid,
        host: typeof value.host === 'string' ? value.host : null,
        token: value.token,
        acquiredAt: typeof value.acquiredAt === 'string' ? value.acquiredAt : '',
      };
    }
  } catch {
    // fall through: unreadable value
  }
  return null;
}

/** The current holder of `recoveryLockKey(chainId)`, or null when free (or unreadable). */
export async function readRecoveryLock(redis: Pick<Redis, 'get'>, chainId: number): Promise<RecoveryLockHolder | null> {
  return parseHolder(await redis.get(recoveryLockKey(chainId)));
}

/**
 * SET NX PX of `recoveryLockKey(chainId)` with owner + PID (+ host) and a
 * random token. No wait: a busy lock throws `RecoveryLockBusyError` naming
 * the holder (the operator decides; the lock is never stolen).
 */
export async function acquireRecoveryLock(
  redis: LaneRedis,
  chainId: number,
  owner: { owner: string; pid?: number; host?: string | null },
  opts: { ttlMs?: number } = {},
): Promise<RecoveryLockHandle> {
  if (!owner.owner.trim()) throw new Error('acquireRecoveryLock: owner is required');
  const key = recoveryLockKey(chainId);
  const ttlMs = opts.ttlMs ?? RECOVERY_LOCK_TTL_MS;
  const holder: RecoveryLockHolder = {
    owner: owner.owner,
    pid: owner.pid ?? process.pid,
    host: owner.host ?? null,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const value = JSON.stringify(holder);
  const attemptAt = Date.now();
  const acquired = await redis.set(key, value, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') throw new RecoveryLockBusyError(chainId, parseHolder(await redis.get(key)));
  const localDeadline = attemptAt + ttlMs;
  let released = false;
  return {
    key,
    holder,
    async assertHeld(minRemainingMs = 0): Promise<void> {
      if (released) throw new LeaseLostError(key, 'released', null, minRemainingMs);
      await assertRedisLeaseHeld(redis, key, key, value, localDeadline, minRemainingMs);
    },
    async release(): Promise<boolean> {
      if (released) return false;
      released = true;
      const freed = await redis.eval(RELEASE_SCRIPT, 1, key, value).catch(() => 0);
      return Number(freed) === 1;
    },
  };
}

export class RedisNonceStore implements NonceStore {
  constructor(
    private readonly redis: LaneRedis,
    private readonly ttlMs = NONCE_MEMORY_TTL_MS,
  ) {}

  async lastUsed(key: string): Promise<number | null> {
    const raw = await this.redis.get(NONCE_PREFIX + key);
    if (raw === null) return null;
    const nonce = Number(raw);
    return Number.isSafeInteger(nonce) ? nonce : null;
  }

  async recordUsed(key: string, nonce: number): Promise<void> {
    // Only ever called inside the lane, so read-compare-write cannot race.
    const current = await this.lastUsed(key);
    if (current !== null && current >= nonce) return;
    await this.redis.set(NONCE_PREFIX + key, String(nonce), 'PX', this.ttlMs);
  }
}

/** Lock that does not lock (callers that run without Redis, e.g. a unit test that does not care). */
export const NO_LANE: LaneLock = { run: (_key, fn) => fn() };
