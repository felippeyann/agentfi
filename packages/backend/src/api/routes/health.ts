import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { Redis } from 'ioredis';
import { getWalletService } from '../../services/wallet/index.js';
import { env } from '../../config/env.js';
import { createChainPublicClient } from '../../config/chains.js';
const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
});
const turnkey = getWalletService();

async function checkDatabase(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

async function checkRpc(): Promise<boolean> {
  try {
    const client = createChainPublicClient(1);
    await client.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

async function checkTurnkey(): Promise<boolean> {
  return turnkey.healthCheck();
}

export interface ReadinessChecks {
  database: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  rpc: () => Promise<boolean>;
  turnkey: () => Promise<boolean>;
}

export interface HealthRoutesOptions {
  /** Dependency probes (tests inject fakes). */
  checks?: ReadinessChecks;
  /** How long one readiness result is reused (default 5 s). */
  readyCacheMs?: number;
  /** `/health/ready` requests per client IP per minute (default 30). */
  readyMaxPerMinute?: number;
  now?: () => number;
}

interface ReadyResult {
  statusCode: 200 | 503;
  body: { status: 'ready' | 'degraded'; checks: Record<keyof ReadinessChecks, boolean>; timestamp: string };
}

/**
 * Fixed-window per-key counter kept in process memory: `/health/ready` must
 * keep answering when Redis (the global rate limiter's store) is the thing
 * that is down. The map is cleared whenever it grows past `maxKeys`.
 */
export class InProcessWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds to wait when `key` is over the limit, null when the request may proceed. */
  hit(key: string): number | null {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.windows.clear();
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count++;
    return window.count > this.max ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : null;
  }
}

export async function healthRoutes(fastify: FastifyInstance, opts: HealthRoutesOptions = {}) {
  const checks: ReadinessChecks = opts.checks ?? {
    database: checkDatabase,
    redis: checkRedis,
    rpc: checkRpc,
    turnkey: checkTurnkey,
  };
  const now = opts.now ?? Date.now;
  const readyCacheMs = opts.readyCacheMs ?? 5_000;
  const limiter = new InProcessWindowLimiter(opts.readyMaxPerMinute ?? 30, 60_000, now);

  // S6: `/health/ready` is unauthenticated and outside the global rate limit,
  // and each call hit the database, Redis, the RPC provider and Turnkey's API
  // (quota). One probe now serves every caller for `readyCacheMs`, concurrent
  // callers share the in-flight probe, and each client IP gets its own
  // in-process limit.
  let cached: { at: number; result: ReadyResult } | null = null;
  let inFlight: Promise<ReadyResult> | null = null;

  async function probe(): Promise<ReadyResult> {
    const [database, redisOk, rpc, turnkeyOk] = await Promise.all([
      checks.database(),
      checks.redis(),
      checks.rpc(),
      checks.turnkey(),
    ]);
    const results = { database, redis: redisOk, rpc, turnkey: turnkeyOk };
    const allHealthy = Object.values(results).every(Boolean);
    return {
      statusCode: allHealthy ? 200 : 503,
      body: { status: allHealthy ? 'ready' : 'degraded', checks: results, timestamp: new Date(now()).toISOString() },
    };
  }

  async function readiness(): Promise<ReadyResult> {
    if (cached && now() - cached.at < readyCacheMs) return cached.result;
    if (!inFlight) {
      inFlight = probe()
        .then((result) => {
          cached = { at: now(), result };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /**
   * GET /health — basic liveness check (no dependencies).
   */
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  /**
   * GET /health/ready — readiness check (all dependencies must be healthy).
   * Cached for a few seconds and rate-limited per client IP (S6).
   */
  fastify.get('/health/ready', async (request, reply) => {
    const retryAfter = limiter.hit(request.ip);
    if (retryAfter !== null) {
      return reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({ error: `Rate limit exceeded. Retry after ${retryAfter} seconds.` });
    }
    const result = await readiness();
    return reply.code(result.statusCode).send(result.body);
  });
}
