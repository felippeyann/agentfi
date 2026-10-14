/**
 * A6b — the stranded-QUEUED sweep against REAL BullMQ (Redis) and REAL
 * Postgres: the "never twice" guarantee rests on BullMQ's custom job ids (an
 * `add` whose `jobId` exists is not added again) and on the job states BullMQ
 * reports, so they are checked on a real queue, not on a fake.
 *
 *  - a QUEUED row with no job is added once under `tx-<id>`, even by three
 *    sweeps racing, and a fourth sweep finds it live and adds nothing;
 *  - a row whose job the route added (same id) is never duplicated;
 *  - a job that completed while the row was not runnable is replaced;
 *  - a job that failed for good without its handler settles the row like the
 *    handler (never stamped → FAILED, reservation released);
 *  - a stamped row with no live job is handed to the chain, never re-added.
 *
 * Each run uses its own queue name and obliterates it. Skipped with a warning
 * when Postgres or Redis is unreachable; on CI either missing fails the suite.
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
// The app's own queues are not used here (the sweep gets this file's queue);
// stubbing the module keeps its Queue instances from connecting.
vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: { add: async () => undefined, getJob: async () => undefined },
  deadLetterQueue: { add: async () => undefined },
}));
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify: async () => undefined } }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: async () => undefined,
  vetBindBeforeBroadcast: async () => null,
}));

import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "broadcastTxHash" FROM "Transaction" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

async function redisReady(): Promise<boolean> {
  const probe = new Redis(process.env['REDIS_URL'] as string, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const READY = (await databaseReady()) && (await redisReady());
if (!READY) {
  if (process.env['CI']) throw new Error('stranded-queued.bullmq.db.test.ts needs a migrated Postgres (DATABASE_URL) and Redis (REDIS_URL) on CI');
  console.warn('[stranded-queued.bullmq.db.test] Postgres or Redis unreachable — suite skipped');
}
const describeReal = READY ? describe : describe.skip;

const NAME_PREFIX = 'a6b-bullmq';
const RUN = randomBytes(3).toString('hex');
const QUEUE = `a6b-stranded-${RUN}`;
const CHAIN_ID = 84532;
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Modules = {
  db: typeof import('../db/client.js')['db'];
  recover: typeof import('../services/transaction/stranded-queued.js')['recoverStrandedQueuedTransactions'];
  createTransactionWithVolume: typeof import('../services/policy/daily-volume.js')['createTransactionWithVolume'];
  transactionJobId: typeof import('../queues/transaction-job-id.js')['transactionJobId'];
};
let m: Modules;
let connection: Redis;
let queue: Queue;
let seq = 0;

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) {
    await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
  }
  await m.db.agent.deleteMany({ where: agents });
}

/** A transfer row as the route leaves it: QUEUED, 20 USD reserved, its queue payload stored — and untouched for an hour. */
async function queuedTransfer(): Promise<{ id: string; agentId: string }> {
  seq++;
  const agent = await m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `a6b-bq-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_a6b',
      walletId: `a6b-bq-wallet-${RUN}-${seq}`,
      safeAddress: `0xa6b1${randomBytes(18).toString('hex')}`,
      chainIds: [CHAIN_ID],
      policy: { create: { maxValuePerTxEth: '10', maxValueForAutoApprovalEth: '10', maxDailyVolumeUsd: '1000', cooldownSeconds: 0 } },
    },
  });
  const created = await m.createTransactionWithVolume(m.db, {
    agentId: agent.id,
    valueUsd: '20',
    data: {
      agentId: agent.id,
      chainId: CHAIN_ID,
      status: 'QUEUED',
      type: 'TRANSFER',
      metadata: {
        queuePayload: {
          to: '0x000000000000000000000000000000000000dEaD',
          data: '0x',
          value: '10000000000000000',
          feeAmountWei: '0',
          feeBps: 30,
          routedViaExecutor: false,
        },
      },
    },
  });
  if (!created.ok) throw new Error('reservation refused');
  await m.db.$executeRaw`UPDATE "Transaction" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE "id" = ${created.transaction.id}`;
  return { id: created.transaction.id, agentId: agent.id };
}

/** Takes a row out of later sweeps (they scan every stale QUEUED row, not just this test's). */
async function retire(id: string): Promise<void> {
  await m.db.transaction.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'FAILED', error: 'test done' } });
  await (await queue.getJob(m.transactionJobId(id)))?.remove().catch(() => undefined);
}

function sweep() {
  return m.recover({ db: m.db, queue: queue as never, logger: quietLogger }, { olderThan: new Date(Date.now() - 60_000), limit: 500 });
}

async function jobsFor(transactionId: string) {
  const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized']);
  return jobs.filter((j) => (j?.data as { transactionId?: string } | undefined)?.transactionId === transactionId);
}

/** Runs the queue's jobs through a throwaway worker until `until` holds. */
async function drainWith(processor: () => Promise<unknown>, until: () => Promise<boolean>): Promise<void> {
  const worker = new Worker(QUEUE, processor, { connection: connection.duplicate(), concurrency: 1 });
  try {
    const deadline = Date.now() + 15_000;
    while (!(await until())) {
      if (Date.now() > deadline) throw new Error('worker did not finish in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await worker.close();
  }
}

async function volume(agentId: string): Promise<number> {
  const row = await m.db.dailyVolume.findFirst({ where: { agentId, date: new Date().toISOString().slice(0, 10) } });
  return row ? Number(row.volumeUsd) : 0;
}

describeReal('A6b — stranded-QUEUED sweep on real BullMQ + Postgres', () => {
  beforeAll(async () => {
    const [db, stranded, volumeMod, jobId] = await Promise.all([
      import('../db/client.js'),
      import('../services/transaction/stranded-queued.js'),
      import('../services/policy/daily-volume.js'),
      import('../queues/transaction-job-id.js'),
    ]);
    m = {
      db: db.db,
      recover: stranded.recoverStrandedQueuedTransactions,
      createTransactionWithVolume: volumeMod.createTransactionWithVolume,
      transactionJobId: jobId.transactionJobId,
    };
    connection = new Redis(process.env['REDIS_URL'] as string, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE, { connection });
    await wipe();
  });

  afterAll(async () => {
    if (!m) return;
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    connection?.disconnect();
    await wipe();
    await m.db.$disconnect();
  });

  it('BullMQ itself: a second add with an existing jobId returns the same job and adds nothing', async () => {
    const a = await queue.add('x', { transactionId: `probe-${RUN}` }, { jobId: `tx-probe-${RUN}` });
    const b = await queue.add('x', { transactionId: `probe-${RUN}`, other: true }, { jobId: `tx-probe-${RUN}` });
    expect(b.id).toBe(a.id);
    expect(await jobsFor(`probe-${RUN}`)).toHaveLength(1);
    await (await queue.getJob(`tx-probe-${RUN}`))?.remove();
  });

  it('a QUEUED row with no job is enqueued once under its own id, even by three sweeps racing; then it is live', async () => {
    const { id } = await queuedTransfer();
    await Promise.all([sweep(), sweep(), sweep()]);
    const jobs = await jobsFor(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(m.transactionJobId(id));
    expect(await jobs[0]!.getState()).toBe('waiting');
    expect(jobs[0]!.data).toMatchObject({ transactionId: id, value: '10000000000000000', feeBps: 30, tier: 'FREE' });

    await sweep();
    expect(await jobsFor(id)).toHaveLength(1);
    await retire(id);
  });

  it('a row whose job the route added (same id) is never duplicated', async () => {
    const { id } = await queuedTransfer();
    await queue.add('transfer', { transactionId: id }, { jobId: m.transactionJobId(id) });
    await sweep();
    const jobs = await jobsFor(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe('transfer'); // the route's job, untouched
    await retire(id);
  });

  it('a job that completed while the row was not runnable (still QUEUED, never stamped) is replaced by a fresh one', async () => {
    const { id } = await queuedTransfer();
    await queue.add('transfer', { transactionId: id }, { jobId: m.transactionJobId(id) });
    await drainWith(async () => ({ skipped: true }), async () => (await (await queue.getJob(m.transactionJobId(id)))?.getState()) === 'completed');

    await sweep();
    const job = await queue.getJob(m.transactionJobId(id));
    expect(await job?.getState()).toBe('waiting');
    expect(job?.data).toMatchObject({ transactionId: id, feeBps: 30 }); // rebuilt from the row, not the old job
    expect(await jobsFor(id)).toHaveLength(1);
    await retire(id);
  });

  it('a job that failed for good without its handler: the row is settled as the handler would have (never stamped → FAILED, reservation released)', async () => {
    const { id, agentId } = await queuedTransfer();
    expect(await volume(agentId)).toBeCloseTo(20, 6);
    await queue.add('transfer', { transactionId: id }, { jobId: m.transactionJobId(id), attempts: 1 });
    await drainWith(
      async () => {
        throw new Error('estimateGas: execution reverted');
      },
      async () => (await (await queue.getJob(m.transactionJobId(id)))?.getState()) === 'failed',
    );

    await sweep();
    const row = await m.db.transaction.findUnique({ where: { id }, select: { status: true, error: true, volumeState: true } });
    expect(row).toMatchObject({ status: 'FAILED', volumeState: 'RELEASED' });
    expect(row?.error).toMatch(/estimateGas: execution reverted/);
    expect(await volume(agentId)).toBeCloseTo(0, 6);
  });

  it('a row stamped for broadcast with no live job is handed to the chain (SUBMITTED with its hash) and never re-added', async () => {
    const { id, agentId } = await queuedTransfer();
    const hash = keccak256(toHex(`a6b-bq-${id}`));
    await m.db.$executeRaw`UPDATE "Transaction" SET "broadcastAttempts" = 1, "broadcastAttemptedAt" = NOW(), "broadcastTxHash" = ${hash} WHERE "id" = ${id}`;

    await sweep();
    expect(await jobsFor(id)).toHaveLength(0);
    const row = await m.db.transaction.findUnique({ where: { id }, select: { status: true, txHash: true, volumeState: true } });
    expect(row).toEqual({ status: 'SUBMITTED', txHash: hash, volumeState: 'RESERVED' });
    expect(await volume(agentId)).toBeCloseTo(20, 6);
  });
});
