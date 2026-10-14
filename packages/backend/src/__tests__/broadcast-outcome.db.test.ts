/**
 * A6b — what happens to a transaction (and the reservation behind it) once a
 * signed broadcast may have left the process, on REAL Postgres.
 *
 * A6 (#163) stamps `broadcastAttemptedAt` / `broadcastAttempts` after signing
 * and before every broadcast, and keeps an ordinary transaction's DailyVolume
 * reservation (HELD) when it fails after a stamp. The A6 reviews left these
 * paths open; each is reproduced here before it is fixed:
 *
 *  1. Stamp → SUBMITTED window: a redelivery's pre-submit guard (agent paused)
 *     or the failed handler of a stalled redelivery FAILS a row another
 *     delivery has already stamped and sent; for a legacy A2A payment the
 *     FAILED finalizer refunds the Job's reservation and marks PAYMENT_FAILED,
 *     then the first delivery's SUBMITTED write overwrites FAILED and the
 *     payment confirms with its reservation gone.
 *  2. An A2A payment whose every attempt failed AFTER a broadcast stamp: the
 *     outcome is unknown (the signed transaction may still be mined), yet the
 *     failed handler — and the recovery scan for a FAILED row — finalize it as
 *     PAYMENT_FAILED and give the reservation back.
 *  5. A row left QUEUED with no BullMQ job (a crash between the QUEUED write —
 *     route creation, operator approval, A2A payment — and the enqueue) is
 *     never processed, and the operator cannot re-approve it (400).
 *  6. A broadcast whose SUBMITTED write fails (database error) is retried by
 *     BullMQ; the retry signs a NEW transaction with the next nonce (the C3c
 *     wallet lane) and broadcasts it: the value moves twice.
 *
 * Real: Postgres, the transaction routes, the admin approve route, the
 * processor (`processTransactionJob`, `handleFailedTransactionJob`,
 * `repollSubmittedTransactions`), the pre-submit guard, the legacy A2A payment
 * (`reserveJobEscrow`, `executeA2APayment`, the finalizer), the payment
 * recovery tick, and — for item 6 — the real `SubmitterService` with its
 * wallet lane and nonce store against the in-memory chain of
 * `helpers/fake-escrow-chain.ts`. Faked: the BullMQ queues (an in-memory queue
 * with BullMQ's custom-id semantics: a second `add` with an existing `jobId`
 * is a no-op), the price oracle (1 ETH = 2000 USD), the simulator,
 * notifications and the ERC-8183 runtime (no escrow job here).
 *
 * Skipped (with a warning) when DATABASE_URL is not a reachable, migrated
 * database; on CI an unreachable database fails the suite.
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => {
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
  // Q9: the suite runs on Base Sepolia (84532), a testnet, where a spend is
  // priced only with a configured synthetic test price — the values the price
  // mock below always assumed (1 ETH = 2000 USD, USDC = 1 USD).
  process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2000,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1';

  type JobState = 'waiting' | 'active' | 'delayed' | 'completed' | 'failed';
  interface FakeJob {
    id: string;
    name: string;
    data: Record<string, unknown>;
    opts: Record<string, unknown> | undefined;
    state: JobState;
    failedReason?: string;
  }
  const jobs = new Map<string, FakeJob>();
  let auto = 0;
  const handle = (job: FakeJob) => ({
    id: job.id,
    name: job.name,
    data: job.data,
    opts: job.opts ?? {},
    get failedReason() {
      return job.failedReason;
    },
    attemptsMade: job.state === 'failed' ? 3 : 0,
    getState: async () => (jobs.get(job.id) === job ? job.state : 'unknown'),
    remove: async () => {
      jobs.delete(job.id);
    },
  });
  return {
    jobs,
    /** Every job `add` created (not the deduplicated ones), in order. */
    added: [] as FakeJob[],
    handle,
    /** BullMQ `Queue.add`: a custom `jobId` that already exists is not added again. */
    add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
      const id = typeof opts?.['jobId'] === 'string' ? (opts['jobId'] as string) : `auto-${++auto}`;
      const existing = jobs.get(id);
      if (existing) return handle(existing);
      const job: FakeJob = { id, name, data, opts, state: 'waiting' };
      jobs.set(id, job);
      this.added.push(job);
      return handle(job);
    },
  };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('bullmq', () => ({
  Queue: class {
    add = async () => undefined;
    getJob = async () => undefined;
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));
vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: {
    add: async (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => h.add(name, data, opts),
    getJob: async (id: string) => {
      const job = h.jobs.get(id);
      return job ? h.handle(job) : undefined;
    },
  },
  deadLetterQueue: { add: async () => undefined },
  repollSubmittedTransactionsNow: async () => ({ scanned: 0, confirmed: 0, reverted: 0, dropped: 0, pending: 0, errors: 0 }),
}));
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: async (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6),
  tokenAmountToUsd: async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6),
}));
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: class {
    async simulate() {
      return { success: true, gasUsed: '21000', gasPrice: '1', simulationId: `sim-${Math.random()}`, provider: 'stub' };
    }
  },
}));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  // No ERC-8183 job in this suite; the processor, the guard and the recovery tick import it.
  onEscrowTxOutcome: async () => undefined,
  vetBindBeforeBroadcast: async () => null,
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
  recoverErc8183Job: async () => 'none',
  reconcileEscrowJobs: async () => ({ scanned: 0 }),
  alertExpiringReviews: async () => 0,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import type { TransactionJobData } from '../queues/transaction.processor.js';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { InMemoryLaneLock, InMemoryNonceStore } from '../services/transaction/wallet-lane.js';
import { FakeEscrowChain, FakeWallets } from './helpers/fake-escrow-chain.js';

// ── Database availability ──────────────────────────────────────────────────

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "broadcastAttempts" FROM "Transaction" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('broadcast-outcome.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[broadcast-outcome.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

// ── Modules under test (after env + mocks) ─────────────────────────────────

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  executeA2APayment: typeof import('../api/routes/transactions.js')['executeA2APayment'];
  adminRoutes: typeof import('../api/routes/admin.js')['adminRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  processor: typeof import('../queues/transaction.processor.js');
  recordReceiptOnce: typeof import('../services/transaction/monitor.service.js')['recordReceiptOnce'];
  reserveJobEscrow: typeof import('../services/policy/escrow.service.js')['reserveJobEscrow'];
  runPaymentRecoveryTick: typeof import('../queues/payment-recovery.queue.js')['runPaymentRecoveryTick'];
};
let m: Modules;

const NAME_PREFIX = 'a6b-out';
const CHAIN_ID = 84532;
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const ADMIN = { 'x-admin-secret': process.env['ADMIN_SECRET'] as string };
const RUN = randomBytes(3).toString('hex');
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const noFees = { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never;
let seq = 0;

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  await m.db.job.deleteMany({ where: { OR: [{ requester: agents }, { provider: agents }] } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) {
    await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
  }
  await m.db.agent.deleteMany({ where: agents });
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function mkAgent(policy: Record<string, unknown> = {}) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `a6b-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_a6b',
      walletId: `a6b-wallet-${RUN}-${seq}`,
      safeAddress: `0xa6b0${randomBytes(18).toString('hex')}`,
      chainIds: [CHAIN_ID],
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '10',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
          ...policy,
        },
      },
    },
  });
}

async function volume(agentId: string, date = utcDay()): Promise<number> {
  const row = await m.db.dailyVolume.findFirst({ where: { agentId, date } });
  return row ? Number(row.volumeUsd) : 0;
}

async function app(agentId: string): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  m.registerErrorHandler(a);
  a.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string; agentTier: string }).agentId = agentId;
    (request as unknown as { agentId: string; agentTier: string }).agentTier = 'FREE';
  });
  await a.register(m.transactionRoutes);
  await a.register(m.adminRoutes);
  await a.ready();
  return a;
}

function transfer(a: FastifyInstance, amount = '0.01') {
  return a.inject({
    method: 'POST',
    url: '/v1/transactions/transfer',
    payload: { chainId: CHAIN_ID, token: 'ETH', to: RECIPIENT, amount },
  });
}

/** Jobs added for a transaction (deduplicated adds are not counted). */
function jobsOf(transactionId: string) {
  return h.added.filter((j) => j.data['transactionId'] === transactionId);
}

function jobOf(transactionId: string): TransactionJobData {
  const found = jobsOf(transactionId)[0];
  if (!found) throw new Error(`no queued job for ${transactionId}`);
  return found.data as unknown as TransactionJobData;
}

/** As if the process died before (or right after) the enqueue: the BullMQ job does not exist. */
function loseJobsOf(transactionId: string): void {
  for (const job of jobsOf(transactionId)) h.jobs.delete(job.id);
}

async function age(transactionId: string): Promise<void> {
  await m.db.$executeRaw`UPDATE "Transaction" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE "id" = ${transactionId}`;
}

async function ageJob(jobId: string): Promise<void> {
  await m.db.$executeRaw`UPDATE "Job" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE "id" = ${jobId}`;
}

type Receipt = 'success' | 'reverted' | 'none';

function monitorFor(receipt: Receipt) {
  return {
    async waitForConfirmation({ transactionId }: { transactionId: string }) {
      if (receipt === 'none') return { status: 'TIMEOUT' as const, recorded: false as const };
      return m.recordReceiptOnce(m.db, transactionId, {
        status: receipt === 'reverted' ? 'reverted' : 'success',
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
      });
    },
  };
}

function depsFor(submitter: unknown, receipt: Receipt, monitors: Array<Promise<void>>, extra: Record<string, unknown> = {}) {
  return {
    db: m.db,
    submitter: submitter as never,
    monitor: monitorFor(receipt),
    feeService: noFees,
    logger: quietLogger,
    trackMonitor: (p: Promise<void>) => monitors.push(p),
    ...extra,
  };
}

const failDeps = () => ({ db: m.db, deadLetterQueue: { add: async () => undefined } as never, logger: quietLogger });

/** A submitter that must never be reached. */
const neverSubmitter = {
  async submit(): Promise<never> {
    throw new Error('must not submit');
  },
};

/**
 * The first delivery: signs, gets its broadcast stamped, "sends" — then stalls
 * before returning, i.e. before the processor writes SUBMITTED + txHash.
 */
function stalledBroadcaster(transactionId: string) {
  let release!: () => void;
  const mayReturn = new Promise<void>((resolve) => (release = resolve));
  let sent!: () => void;
  const broadcast = new Promise<void>((resolve) => (sent = resolve));
  const hash = keccak256(toHex(`stalled-${transactionId}-${Math.random()}`));
  const state = { broadcasts: 0 };
  const submitter = {
    async submit(params: { onBeforeBroadcast?: (hash: Hex) => Promise<void> }) {
      try {
        await params.onBeforeBroadcast?.(hash);
      } catch (err) {
        sent();
        throw err;
      }
      state.broadcasts++;
      sent();
      await mayReturn;
      return { txHash: hash, nonce: 1 };
    },
  };
  return { submitter, hash, broadcast, release, state };
}

type Broadcast = 'ok' | 'fail-before-broadcast' | 'fail-after-broadcast';

/**
 * Runs a job the way the BullMQ worker does (as in daily-volume.db.test.ts):
 * up to `attempts` tries, `handleFailedTransactionJob` after the last failed
 * one, then the detached monitors. Returns the hashes the fake submitter got
 * stamped, in order.
 */
async function runJob(
  data: TransactionJobData,
  opts: { broadcast?: Broadcast | Broadcast[]; receipt?: Receipt; attempts?: number } = {},
): Promise<Hex[]> {
  const attempts = opts.attempts ?? 1;
  const behaviours = Array.isArray(opts.broadcast) ? opts.broadcast : [opts.broadcast ?? 'ok'];
  const monitors: Array<Promise<void>> = [];
  const stamped: Hex[] = [];
  let attempt = 0;
  const submitter = {
    async submit(params: { onBeforeBroadcast?: (hash: Hex) => Promise<void> }) {
      const behaviour = behaviours[Math.min(attempt - 1, behaviours.length - 1)];
      if (behaviour === 'fail-before-broadcast') throw new Error('estimateGas: execution reverted');
      const hash = keccak256(toHex(`${data.transactionId}:${attempt}:${Math.random()}`));
      await params.onBeforeBroadcast?.(hash);
      stamped.push(hash);
      if (behaviour === 'fail-after-broadcast') throw new Error('sendRawTransaction: both RPCs timed out');
      return { txHash: hash, nonce: attempt };
    },
  };
  const deps = depsFor(submitter, opts.receipt ?? 'success', monitors);
  for (attempt = 1; attempt <= attempts; attempt++) {
    try {
      await m.processor.processTransactionJob({ data }, deps);
      break;
    } catch (err) {
      if (attempt === attempts) {
        await m.processor.handleFailedTransactionJob({ data, attemptsMade: attempts, opts: { attempts } }, err as Error, failDeps());
      }
    }
  }
  await Promise.all(monitors);
  return stamped;
}

async function txRow(id: string) {
  return m.db.transaction.findUnique({
    where: { id },
    select: { status: true, txHash: true, volumeState: true, broadcastAttempts: true, error: true },
  });
}

async function jobRow(id: string) {
  return m.db.job.findUnique({ where: { id }, select: { status: true, reservationStatus: true } });
}

/** A legacy A2A job (reward 0.01 ETH = 20 USD reserved on the Job) with its payment transaction created and enqueued. */
async function paidA2AJob() {
  const requester = await mkAgent();
  const provider = await mkAgent();
  const reward = { amount: '0.01', token: 'ETH', chainId: CHAIN_ID };
  const reservation = await m.reserveJobEscrow({ requesterId: requester.id, reward });
  expect(reservation.success).toBe(true);
  const job = await m.db.job.create({
    data: {
      requesterId: requester.id,
      providerId: provider.id,
      payload: {},
      reward,
      status: 'PAYMENT_PENDING',
      reservedAmount: reward.amount,
      reservedToken: reward.token,
      reservedChainId: reward.chainId,
      reservedAt: new Date(),
      reservationStatus: 'PENDING',
      ...(reservation.success && reservation.reservedValueUsd ? { reservedValueUsd: reservation.reservedValueUsd } : {}),
    },
  });
  const paid = await m.executeA2APayment({
    requesterId: requester.id,
    providerSafeAddress: provider.safeAddress,
    amount: reward.amount,
    token: reward.token,
    chainId: CHAIN_ID,
    jobId: job.id,
    intentId: `a2a-payment:${job.id}`,
  });
  expect(await volume(requester.id)).toBeCloseTo(20, 6);
  return { requester, provider, job, paid };
}

// ── Suite ──────────────────────────────────────────────────────────────────

describeDb('A6b — outcomes after a broadcast attempt, on Postgres', () => {
  beforeAll(async () => {
    const [db, routes, admin, handler, processor, monitor, escrow, recovery] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/routes/admin.js'),
      import('../api/errors/handler.js'),
      import('../queues/transaction.processor.js'),
      import('../services/transaction/monitor.service.js'),
      import('../services/policy/escrow.service.js'),
      import('../queues/payment-recovery.queue.js'),
    ]);
    m = {
      db: db.db,
      transactionRoutes: routes.transactionRoutes,
      executeA2APayment: routes.executeA2APayment,
      adminRoutes: admin.adminRoutes,
      registerErrorHandler: handler.registerErrorHandler,
      processor,
      recordReceiptOnce: monitor.recordReceiptOnce,
      reserveJobEscrow: escrow.reserveJobEscrow,
      runPaymentRecoveryTick: recovery.runPaymentRecoveryTick,
    };
    await wipe();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    h.jobs.clear();
    h.added.length = 0;
  });

  // ── 1. The stamp → SUBMITTED window ────────────────────────────────────────

  it('item 1 (guard): a redelivery blocked by a pause while the first delivery is between its broadcast and its SUBMITTED write does not refund an A2A payment that is then mined', async () => {
    const { requester, job, paid } = await paidA2AJob();
    const data = jobOf(paid.transactionId);
    const monitors: Array<Promise<void>> = [];
    const first = stalledBroadcaster(data.transactionId);
    const firstDelivery = m.processor.processTransactionJob({ data }, depsFor(first.submitter, 'success', monitors));
    await first.broadcast; // stamped and sent; SUBMITTED not written yet

    await m.db.agent.update({ where: { id: requester.id }, data: { active: false } });
    const second = await m.processor.processTransactionJob({ data }, depsFor(neverSubmitter, 'success', monitors));
    expect(second.txHash).toBeNull();

    first.release();
    await firstDelivery;
    await Promise.all(monitors);

    expect(first.state.broadcasts).toBe(1);
    expect(await txRow(data.transactionId)).toMatchObject({ status: 'CONFIRMED', txHash: first.hash });
    // The payment was mined: the job is paid and its reservation consumed, not refunded.
    expect(await jobRow(job.id)).toEqual({ status: 'COMPLETED', reservationStatus: 'RELEASED' });
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
  });

  it('item 1 (failed handler): the failed handler of a stalled redelivery does not refund an A2A payment the first delivery has sent but not yet recorded', async () => {
    const { requester, job, paid } = await paidA2AJob();
    const data = jobOf(paid.transactionId);
    const monitors: Array<Promise<void>> = [];
    const first = stalledBroadcaster(data.transactionId);
    const firstDelivery = m.processor.processTransactionJob({ data }, depsFor(first.submitter, 'success', monitors));
    await first.broadcast;

    // BullMQ declared the first delivery stalled; the redelivery failed for good.
    await m.processor.handleFailedTransactionJob(
      { data, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('job stalled more than allowable limit'),
      failDeps(),
    );

    first.release();
    await firstDelivery;
    await Promise.all(monitors);

    expect(await txRow(data.transactionId)).toMatchObject({ status: 'CONFIRMED', txHash: first.hash });
    expect(await jobRow(job.id)).toEqual({ status: 'COMPLETED', reservationStatus: 'RELEASED' });
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
  });

  it('item 1 (ordinary): the same window on an ordinary transfer — the receipt decides the reservation (a single broadcast that reverted releases it)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    const data = jobOf(res.json().transactionId);
    const monitors: Array<Promise<void>> = [];
    const first = stalledBroadcaster(data.transactionId);
    const firstDelivery = m.processor.processTransactionJob({ data }, depsFor(first.submitter, 'reverted', monitors));
    await first.broadcast;

    await m.db.agent.update({ where: { id: agent.id }, data: { active: false } });
    await m.processor.processTransactionJob({ data }, depsFor(neverSubmitter, 'reverted', monitors));

    first.release();
    await firstDelivery;
    await Promise.all(monitors);

    expect(await txRow(data.transactionId)).toMatchObject({ status: 'REVERTED', txHash: first.hash, volumeState: 'RELEASED' });
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  // ── 2. A2A payment failed after a broadcast attempt ─────────────────────────

  it('item 2: an A2A payment whose every attempt failed after a broadcast stamp keeps the job PAYMENT_PENDING and its reservation; the receipt then completes it', async () => {
    const { requester, job, paid } = await paidA2AJob();
    const data = jobOf(paid.transactionId);
    const stamped = await runJob(data, { broadcast: 'fail-after-broadcast', attempts: 3 });
    expect(stamped).toHaveLength(3);

    // Outcome unknown: nothing refunded, nothing finalized.
    expect(await jobRow(job.id)).toEqual({ status: 'PAYMENT_PENDING', reservationStatus: 'PENDING' });
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
    // The chain decides: the row carries the hash of the last signed attempt for the re-poll.
    const lastHash = stamped[stamped.length - 1];
    expect(await txRow(data.transactionId)).toMatchObject({ status: 'SUBMITTED', txHash: lastHash });

    // It was mined after all.
    const summary = await m.processor.repollSubmittedTransactions(
      {
        db: m.db,
        feeService: noFees,
        logger: quietLogger,
        getReceipt: async (_chainId, hash) => (hash === lastHash ? { status: 'success', gasUsed: 21_000n, effectiveGasPrice: 1n } : null),
        isKnownTransaction: async () => true,
      },
      { olderThanMs: 0, dropAfterMs: 0, limit: 500 },
    );
    expect(summary.confirmed).toBeGreaterThanOrEqual(1);
    expect(await jobRow(job.id)).toEqual({ status: 'COMPLETED', reservationStatus: 'RELEASED' });
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
  });

  it('item 2: … and when no node ever knew it (dropped after the grace), the re-poll fails it and only then is the reservation given back', async () => {
    const { requester, job, paid } = await paidA2AJob();
    const data = jobOf(paid.transactionId);
    await runJob(data, { broadcast: 'fail-after-broadcast', attempts: 3 });
    expect(await jobRow(job.id)).toEqual({ status: 'PAYMENT_PENDING', reservationStatus: 'PENDING' });

    await m.processor.repollSubmittedTransactions(
      { db: m.db, feeService: noFees, logger: quietLogger, getReceipt: async () => null, isKnownTransaction: async () => false },
      { olderThanMs: 0, dropAfterMs: 0, limit: 500 },
    );
    expect((await txRow(data.transactionId))?.status).toBe('FAILED');
    expect(await jobRow(job.id)).toEqual({ status: 'PAYMENT_FAILED', reservationStatus: 'CANCELLED' });
    expect(await volume(requester.id)).toBeCloseTo(0, 6);
  });

  it('item 2 (recovery scan): a FAILED A2A payment row stamped for broadcast without a recorded hash is not refunded by the PAYMENT_PENDING scan', async () => {
    const { requester, job, paid } = await paidA2AJob();
    // As left by the failed handler before this fix (or by a row stamped before it).
    await m.db.transaction.update({
      where: { id: paid.transactionId },
      data: { status: 'FAILED', error: 'sendRawTransaction: both RPCs timed out', broadcastAttemptedAt: new Date(), broadcastAttempts: 1 },
    });
    await ageJob(job.id);

    await m.runPaymentRecoveryTick();
    expect(await jobRow(job.id)).toEqual({ status: 'PAYMENT_PENDING', reservationStatus: 'PENDING' });
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
  });

  // ── 6. A lost SUBMITTED write must not lead to a second payment ────────────

  it('item 6: a broadcast whose SUBMITTED write failed is not signed and sent again by the retry (real submitter, wallet lane and nonce store)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    const id = res.json().transactionId as string;

    const chain = new FakeEscrowChain();
    const wallets = new FakeWallets();
    const walletId = `a6b-real-${RUN}-${seq}`;
    const from = getAddress(wallets.create(walletId));
    const submitter = new SubmitterService({
      wallet: { signTransaction: (p) => wallets.signTransaction(p) },
      lane: new InMemoryLaneLock(),
      nonces: new InMemoryNonceStore(),
      client: () => chain.rpcClient as never,
    });
    const data = { ...jobOf(id), walletId, from };
    const isKnownTransaction = async (_chainId: number, hash: Hex) => {
      try {
        chain.getTransaction(hash);
        return true;
      } catch {
        return false;
      }
    };
    const monitors: Array<Promise<void>> = [];

    // Attempt 1: the node takes the transaction; the SUBMITTED write then fails (pool timeout).
    let failedWrite = false;
    const flakyTransaction = new Proxy(m.db.transaction, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if ((prop === 'update' || prop === 'updateMany') && typeof value === 'function') {
          return (args: { data?: { status?: string } }) => {
            if (!failedWrite && args?.data?.status === 'SUBMITTED') {
              failedWrite = true;
              return Promise.reject(new Error('Timed out fetching a new connection from the connection pool'));
            }
            return (value as (a: unknown) => Promise<unknown>).call(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const flakyDb = new Proxy(m.db, {
      get(target, prop) {
        if (prop === 'transaction') return flakyTransaction;
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(
      m.processor.processTransactionJob({ data }, { ...depsFor(submitter, 'none', monitors, { isKnownTransaction }), db: flakyDb as never }),
    ).rejects.toThrow(/connection pool/);
    expect(chain.broadcasts).toHaveLength(1);

    // Attempt 2 (BullMQ retry): the row still looks QUEUED without a hash.
    await m.processor.processTransactionJob({ data }, depsFor(submitter, 'none', monitors, { isKnownTransaction }));
    await Promise.all(monitors);

    expect(chain.broadcasts).toHaveLength(1); // was 2: nonce 0, then nonce 1 — the value moved twice
    expect(await txRow(id)).toMatchObject({ status: 'SUBMITTED', txHash: chain.broadcasts[0]!.hash });
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  // ── 5. QUEUED rows with no BullMQ job ──────────────────────────────────────

  it('item 5 (admin approve): a row the approval flipped to QUEUED but never enqueued (crash) is re-enqueued once by the recovery tick, then runs', async () => {
    const agent = await mkAgent({ maxValueForAutoApprovalEth: '0.001' });
    const a = await app(agent.id);
    const id = (await transfer(a, '0.01')).json().transactionId as string;
    // The approval's QUEUED write landed; the process died before transactionQueue.add.
    await m.db.transaction.update({ where: { id }, data: { status: 'QUEUED' } });
    const again = await a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN });
    expect(again.statusCode).toBe(400); // the operator cannot approve it again
    await age(id);

    await m.runPaymentRecoveryTick();
    expect(jobsOf(id)).toHaveLength(1);
    await m.runPaymentRecoveryTick(); // its job exists now: not added twice
    expect(jobsOf(id)).toHaveLength(1);

    await runJob(jobOf(id), { receipt: 'success' });
    expect(await txRow(id)).toMatchObject({ status: 'CONFIRMED', volumeState: 'COMMITTED' });
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('item 5 (route): a transfer created QUEUED whose enqueue never happened is re-enqueued once', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = (await transfer(a, '0.01')).json().transactionId as string;
    loseJobsOf(id);
    h.added.length = 0;
    await age(id);

    await m.runPaymentRecoveryTick();
    await m.runPaymentRecoveryTick();
    expect(jobsOf(id)).toHaveLength(1);
    await runJob(jobOf(id), { receipt: 'success' });
    expect((await txRow(id))?.status).toBe('CONFIRMED');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('item 5 (A2A): a payment row whose enqueue never happened is re-enqueued (the job is not refunded as an orphan) and completes', async () => {
    const { requester, job, paid } = await paidA2AJob();
    loseJobsOf(paid.transactionId);
    h.added.length = 0;
    await age(paid.transactionId);
    await ageJob(job.id);

    await m.runPaymentRecoveryTick();
    expect(jobsOf(paid.transactionId)).toHaveLength(1);
    expect(await jobRow(job.id)).toEqual({ status: 'PAYMENT_PENDING', reservationStatus: 'PENDING' });
    await runJob(jobOf(paid.transactionId), { receipt: 'success' });
    expect(await jobRow(job.id)).toEqual({ status: 'COMPLETED', reservationStatus: 'RELEASED' });
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
  });

  it('item 5: a QUEUED row whose job failed for good but whose failed handler never ran (crash) is settled like the handler would have: never broadcast → FAILED and released', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = (await transfer(a, '0.01')).json().transactionId as string;
    for (const job of jobsOf(id)) {
      job.state = 'failed';
      job.failedReason = 'estimateGas: execution reverted';
    }
    await age(id);

    await m.runPaymentRecoveryTick();
    expect(await txRow(id)).toMatchObject({ status: 'FAILED', volumeState: 'RELEASED' });
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  it('item 5: a QUEUED row stamped for broadcast whose job is gone is handed to the chain (SUBMITTED with the stamped hash), never re-sent', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = (await transfer(a, '0.01')).json().transactionId as string;
    // An attempt was signed and stamped (with the hash of what it sent) and the
    // process died before the outcome was written or BullMQ retried the job.
    const hash = keccak256(toHex(`stamped-${id}`));
    await m.db.$executeRaw`UPDATE "Transaction" SET "broadcastAttempts" = 1, "broadcastAttemptedAt" = NOW() WHERE "id" = ${id}`;
    await m.db.$executeRaw`UPDATE "Transaction" SET "broadcastTxHash" = ${hash} WHERE "id" = ${id}`.catch(() => undefined);
    loseJobsOf(id);
    h.added.length = 0;
    await age(id);

    await m.runPaymentRecoveryTick();
    expect(jobsOf(id)).toHaveLength(0); // not re-enqueued: a signed attempt may be on its way
    expect(await txRow(id)).toMatchObject({ status: 'SUBMITTED', txHash: hash });
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  // ── 4. Approved on a later UTC day ─────────────────────────────────────────

  it('item 4: a PENDING_APPROVAL transaction approved on a later UTC day counts on the day it is approved (and executed), not on its creation day', async () => {
    const agent = await mkAgent({ maxValueForAutoApprovalEth: '0.001' });
    const a = await app(agent.id);
    const id = (await transfer(a, '0.01')).json().transactionId as string;
    // As if the request came in yesterday: the reservation sits on yesterday's row.
    const yesterday = utcDay(new Date(Date.now() - 86_400_000));
    await m.db.transaction.update({ where: { id }, data: { volumeReservedDate: yesterday } });
    await m.db.dailyVolume.update({ where: { agentId_date: { agentId: agent.id, date: utcDay() } }, data: { volumeUsd: '0' } });
    await m.db.dailyVolume.create({ data: { agentId: agent.id, date: yesterday, volumeUsd: '20' } });

    const approved = await a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN });
    expect(approved.statusCode).toBe(200);

    expect(await volume(agent.id)).toBeCloseTo(20, 6); // today's limit sees it
    expect(await volume(agent.id, yesterday)).toBeCloseTo(0, 6);
    expect((await m.db.transaction.findUnique({ where: { id }, select: { volumeReservedDate: true } }))?.volumeReservedDate).toBe(utcDay());

    // Its settlement follows it: a revert releases it from today.
    await runJob(jobOf(id), { receipt: 'reverted' });
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, yesterday)).toBeCloseTo(0, 6);
  });

  it('item 4: an approval on the creation day leaves the reservation where it is', async () => {
    const agent = await mkAgent({ maxValueForAutoApprovalEth: '0.001' });
    const a = await app(agent.id);
    const id = (await transfer(a, '0.01')).json().transactionId as string;
    expect((await a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN })).statusCode).toBe(200);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
    expect((await m.db.transaction.findUnique({ where: { id }, select: { volumeReservedDate: true, volumeState: true } }))).toEqual({
      volumeReservedDate: utcDay(),
      volumeState: 'RESERVED',
    });
  });
});
