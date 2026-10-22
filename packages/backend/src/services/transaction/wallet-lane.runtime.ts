/**
 * Process-wide wallet lanes on the shared Redis (see `wallet-lane.ts`).
 *
 * One lazily connected ioredis client serves every lane of the process; the
 * locks themselves live in Redis, so the API (when it runs the transaction
 * worker) and every `worker.ts` replica share them. Commands fail after a few
 * retries instead of hanging when Redis is down: the submit then throws and
 * BullMQ retries the job, which needs Redis anyway.
 */

import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import {
  RedisLaneLock,
  RedisNonceStore,
  acquireRecoveryLock,
  readRecoveryLock,
  type LeaseLock,
  type NonceStore,
  type RecoveryLockHandle,
  type RecoveryLockHolder,
} from './wallet-lane.js';

let client: Redis | null = null;
let lock: RedisLaneLock | null = null;
let nonces: RedisNonceStore | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, enableReadyCheck: false });
  }
  return client;
}

/**
 * Cross-process lane lock (broadcast lanes and ERC-8183 funding lanes), with
 * the A1 lease API (`acquire` → token / `assertHeld` / `release`).
 */
export const walletLaneLock: LeaseLock = {
  run(key, fn) {
    lock ??= new RedisLaneLock(redis());
    return lock.run(key, fn);
  },
  acquire(key, opts) {
    lock ??= new RedisLaneLock(redis());
    return lock.acquire(key, opts);
  },
};

/** A1 §7.1: takes `agentfi:evaluator-recovery:<chainId>` on the shared Redis (throws `RecoveryLockBusyError` when held). */
export function acquireEvaluatorRecoveryLock(
  chainId: number,
  owner: { owner: string; pid?: number; host?: string | null },
  opts?: { ttlMs?: number },
): Promise<RecoveryLockHandle> {
  return acquireRecoveryLock(redis(), chainId, owner, opts);
}

/** A1 §7.1: who holds the recovery lock of `chainId` (null when free). */
export function readEvaluatorRecoveryLock(chainId: number): Promise<RecoveryLockHolder | null> {
  return readRecoveryLock(redis(), chainId);
}

/** Last nonce broadcast per lane (short-lived, see NONCE_MEMORY_TTL_MS). */
export const walletNonceStore: NonceStore = {
  lastUsed(key) {
    nonces ??= new RedisNonceStore(redis());
    return nonces.lastUsed(key);
  },
  recordUsed(key, nonce) {
    nonces ??= new RedisNonceStore(redis());
    return nonces.recordUsed(key, nonce);
  },
};

/** Closes the lane client (graceful shutdown). */
export async function closeWalletLanes(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
    lock = null;
    nonces = null;
  }
}
