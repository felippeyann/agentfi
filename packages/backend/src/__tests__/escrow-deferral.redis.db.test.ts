/**
 * Q7 — a deferral re-queues a BullMQ job WITHOUT consuming an attempt, on a
 * real Redis (REDIS_URL; CI's Backend Tests job has one). Covers the two
 * production paths the unit tests replace with fakes:
 *
 *  - `deferBullJob` (queues/defer-job.ts): `job.moveToDelayed` + `DelayedError`,
 *    used by the transaction worker for an escrow step whose chain is
 *    unverified — a job with `attempts: 1` deferred five times still runs, its
 *    `attemptsMade` stays 0 and no `failed` event fires (so the
 *    permanent-failure handler never marks the row FAILED or unwinds it);
 *  - `runSettlementJob` (queues/escrow-settlement.queue.ts): the settlement
 *    worker body turns `EscrowConfigUnverifiedError` into such a deferral and
 *    the same job settles on a later run once the gate opens.
 *
 * Skipped (with a warning) when Redis is unreachable; on CI it fails instead.
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

import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { deferBullJob } from '../queues/defer-job.js';
import type { Erc8183Deps, EscrowSettlementJobData } from '../services/job/escrow-erc8183.service.js';

const REDIS_URL = process.env['REDIS_URL']!;

async function redisReady(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, enableReadyCheck: false });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const REDIS_READY = await redisReady();
if (!REDIS_READY) {
  if (process.env['CI']) throw new Error('escrow-deferral.redis.db.test.ts needs Redis at REDIS_URL on CI');
  console.warn('[escrow-deferral.redis.db.test] REDIS_URL is not reachable — suite skipped');
}
const describeRedis = REDIS_READY ? describe : describe.skip;

const connection = { url: REDIS_URL, maxRetriesPerRequest: null as unknown as number, enableReadyCheck: false };
const RUN = `q7-defer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis('Q7 deferral on a real BullMQ / Redis', () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
  });

  async function harness<T>(name: string, processor: (job: Job<T>, token?: string) => Promise<unknown>) {
    const queueName = `${RUN}-${name}`;
    const queue = new Queue<T>(queueName, { connection });
    const events = new QueueEvents(queueName, { connection });
    await events.waitUntilReady();
    const failed: string[] = [];
    const worker = new Worker<T>(queueName, processor, { connection, concurrency: 1 });
    worker.on('failed', (_job, err) => failed.push(err.message));
    closers.push(() => queue.obliterate({ force: true }), () => queue.close(), () => events.close(), () => worker.close());
    return { queue, events, failed };
  }

  it('deferBullJob: a job with attempts: 1 deferred 5 times keeps attemptsMade 0, never fails, and completes on the 6th run', async () => {
    const seen: number[] = [];
    const { queue, events, failed } = await harness<{ n: number }>('tx', async (job, token) => {
      seen.push(job.attemptsMade);
      if (seen.length <= 5) await deferBullJob(job, token, 50); // at least 1 s (the helper's floor)
      return 'broadcast';
    });
    const job = await queue.add('erc8183-fund', { n: 1 }, { attempts: 1 });
    const result = await job.waitUntilFinished(events, 30_000);

    expect(result).toBe('broadcast');
    expect(seen).toEqual([0, 0, 0, 0, 0, 0]);
    expect(failed).toEqual([]);
    const done = await queue.getJob(job.id!);
    expect(await done?.getState()).toBe('completed');
  }, 60_000);

  it('runSettlementJob: EscrowConfigUnverifiedError is a deferral (no attempt, no failed event); the next run, verified, reconciles the job', async () => {
    const { runSettlementJob } = await import('../queues/escrow-settlement.queue.js');
    const queueModule = await import('../queues/escrow-settlement.queue.js');
    closers.push(() => queueModule.escrowSettlementQueue.close());

    let verified = false;
    const finalized: string[] = [];
    const row = {
      id: 'job-q7',
      status: 'PAYMENT_PENDING',
      escrowKind: 'erc8183',
      escrowChainId: 84532,
      escrowContract: '0x00000000000000000000000000000000000E5C20',
      onChainJobId: '7',
      onChainStatus: 'SUBMITTED',
      resolution: null,
      contestedAt: null,
      settleTxHash: null,
      feedbackStatus: null,
      feedbackFile: null,
      requester: { id: 'r', walletId: 'w', safeAddress: '0x1111111111111111111111111111111111111111' },
      provider: { id: 'p', walletId: 'w2', safeAddress: '0x2222222222222222222222222222222222222222' },
    };
    const deps = {
      db: {
        job: {
          findUnique: async () => row,
          update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data),
          updateMany: async () => ({ count: 0 }),
        },
      },
      // Submitted while unverified (the gate refuses before any claim); Completed by the time it is verified.
      publicClient: () => ({ readContract: async () => ({ status: verified ? 3 : 2, budget: 1n }) }),
      config: { chain: () => ({ chainId: 84532, escrow: row.escrowContract as Address, hook: null }) },
      configGate: (chainId: number) =>
        verified
          ? { allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }
          : { allowed: false, chainId, block: 'unverified', reason: 'test: chain unreadable', retryAfterSeconds: 1 },
      finalize: async (params: { jobId: string; outcome: string }) => {
        finalized.push(`${params.jobId}:${params.outcome}`);
      },
      releaseJobEscrow: async () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as Erc8183Deps;

    const attempts: number[] = [];
    const { queue, events, failed } = await harness<EscrowSettlementJobData>('settle', async (job, token) => {
      attempts.push(job.attemptsMade);
      if (attempts.length === 3) verified = true;
      return runSettlementJob(() => deps, job, token);
    });
    const job = await queue.add('settle', { jobId: 'job-q7', action: 'settle' }, { attempts: 1 });
    const result = await job.waitUntilFinished(events, 30_000);

    expect(attempts).toEqual([0, 0, 0]); // two deferrals, then the run that reconciled
    expect(failed).toEqual([]);
    expect(result).toMatchObject({ outcome: 'reconciled', onChainStatus: 'COMPLETED' });
    expect(row.onChainStatus).toBe('COMPLETED');
    expect(finalized).toEqual(['job-q7:CONFIRMED']);
  }, 60_000);
});
