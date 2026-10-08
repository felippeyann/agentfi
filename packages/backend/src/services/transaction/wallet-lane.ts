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
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface LaneLock {
  /** Runs `fn` while holding lane `key` exclusively; waits for the current holder first. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
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

// ── In-memory (tests, single process) ──────────────────────────────────────

export class InMemoryLaneLock implements LaneLock {
  private readonly tails = new Map<string, Promise<void>>();

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

export class RedisLaneLock implements LaneLock {
  constructor(
    private readonly redis: LaneRedis,
    private readonly opts: { ttlMs?: number; waitMs?: number } = {},
  ) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = KEY_PREFIX + key;
    const token = randomUUID();
    const ttlMs = this.opts.ttlMs ?? LANE_TTL_MS;
    const waitMs = this.opts.waitMs ?? LANE_WAIT_MS;
    const deadline = Date.now() + waitMs;
    let delay = 25;
    for (;;) {
      const acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') break;
      if (Date.now() >= deadline) throw new LaneTimeoutError(key, waitMs);
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 500);
    }
    try {
      return await fn();
    } finally {
      // Compare-and-delete: never free a lane another holder took after our TTL ran out.
      await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token).catch(() => undefined);
    }
  }
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
