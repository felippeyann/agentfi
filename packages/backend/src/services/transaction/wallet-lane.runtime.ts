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
import { RedisLaneLock, RedisNonceStore, type LaneLock, type NonceStore } from './wallet-lane.js';

let client: Redis | null = null;
let lock: RedisLaneLock | null = null;
let nonces: RedisNonceStore | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, enableReadyCheck: false });
  }
  return client;
}

/** Cross-process lane lock (broadcast lanes and ERC-8183 funding lanes). */
export const walletLaneLock: LaneLock = {
  run(key, fn) {
    lock ??= new RedisLaneLock(redis());
    return lock.run(key, fn);
  },
};

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
