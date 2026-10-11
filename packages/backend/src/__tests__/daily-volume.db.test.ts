/**
 * A6 — DailyVolume accounting of ordinary transactions on REAL Postgres.
 *
 * The finding (A3, 2026-10): an ordinary transaction reserved its USD value in
 * `DailyVolume` when the policy validated it (enqueue), was counted AGAIN when
 * it confirmed (`addDailyVolumeAtomic` in `runPostConfirmation`), and nothing
 * gave the reservation back when it never executed (FAILED / REVERTED /
 * refused after validation). Reproduced here end to end:
 *
 *   - the real `api/routes/transactions.ts` (transfer, batch, idempotency,
 *     cooldown, approval threshold) and the real admin approve/reject routes;
 *   - the real transaction processor (`processTransactionJob`,
 *     `runPostConfirmation`, `handleFailedTransactionJob`,
 *     `repollSubmittedTransactions`) and the real pre-submit guard;
 *   - the real legacy A2A payment path (`reserveJobEscrow`,
 *     `executeA2APayment`, the payment finalizer).
 *
 * Faked (explicitly): the BullMQ transaction queue (jobs are captured and run
 * by `runJob` with BullMQ's last-attempt semantics), the submitter and the
 * receipt monitor (no chain: a broadcast is a callback, a receipt is a
 * `recordReceiptOnce` call), the simulator (always succeeds unless a test says
 * otherwise), the price oracle (1 ETH = 2000 USD, USDC = 1 USD), notifications
 * and the ERC-8183 runtime (no escrow job here). Everything that decides how
 * much USD is counted, and when it is released, runs against Postgres.
 *
 * Skipped (with a warning) when DATABASE_URL is not a reachable, migrated
 * database; on CI (`CI` set) an unreachable database fails the suite.
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
  return {
    /** Jobs the routes enqueued, in order. */
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    /** Simulator verdict for the next calls (true = success). */
    simulationSucceeds: true,
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
    add: async (name: string, data: Record<string, unknown>) => {
      h.queued.push({ name, data });
      return { id: `job-${h.queued.length}` };
    },
  },
}));
vi.mock('../services/transaction/price.service.js', () => ({
  // 1 ETH = 2000 USD; token amounts are priced at 1 USD per whole unit (USDC).
  weiToUsd: async (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6),
  tokenAmountToUsd: async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6),
}));
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: class {
    async simulate() {
      return h.simulationSucceeds
        ? { success: true, gasUsed: '21000', gasPrice: '1', simulationId: `sim-${Math.random()}`, provider: 'stub' }
        : { success: false, gasUsed: '0', gasPrice: '1', error: 'execution reverted', simulationId: `sim-${Math.random()}`, provider: 'stub' };
    }
  },
}));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  // No ERC-8183 job in this suite; the processor and the guard import it.
  onEscrowTxOutcome: async () => undefined,
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
}));
vi.mock('../config/contracts.js', async () => {
  const actual = await vi.importActual<typeof import('../config/contracts.js')>('../config/contracts.js');
  return {
    ...actual,
    // The batch route needs an AgentExecutor on the chain; nothing is broadcast.
    getContracts: (chainId: number) => ({
      ...actual.getContracts(chainId),
      executor: '0x00000000000000000000000000000000000E8ec0',
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import type { TransactionJobData } from '../queues/transaction.processor.js';

// ── Database availability ──────────────────────────────────────────────────

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "volumeUsd" FROM "DailyVolume" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('daily-volume.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[daily-volume.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
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
};
let m: Modules;

const NAME_PREFIX = 'a6-vol';
const CHAIN_ID = 84532;
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ADMIN = { 'x-admin-secret': process.env['ADMIN_SECRET'] as string };
const RUN = randomBytes(3).toString('hex');
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
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
      apiKeyHash: `a6-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_a6',
      walletId: `a6-wallet-${RUN}-${seq}`,
      safeAddress: `0xa6a6${randomBytes(18).toString('hex')}`,
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

/** POST /v1/transactions/transfer of `amount` ETH (or of a token when `token` is set). */
function transfer(a: FastifyInstance, amount = '0.01', extra: Record<string, unknown> = {}) {
  return a.inject({
    method: 'POST',
    url: '/v1/transactions/transfer',
    payload: { chainId: CHAIN_ID, token: 'ETH', to: RECIPIENT, amount, ...extra },
  });
}

/** The queued job of a transaction the route created. */
function jobOf(transactionId: string): TransactionJobData {
  const found = h.queued.find((q) => q.data['transactionId'] === transactionId);
  if (!found) throw new Error(`no queued job for ${transactionId}`);
  return found.data as unknown as TransactionJobData;
}

type Broadcast = 'ok' | 'fail-before-broadcast' | 'fail-after-broadcast';
type Receipt = 'success' | 'reverted' | 'none';

/**
 * Runs one queued transaction job the way the BullMQ worker does: up to
 * `attempts` tries, `handleFailedTransactionJob` after the last failed one,
 * then waits for the detached confirmation monitor.
 *
 * The fake submitter calls `onBeforeBroadcast` (when the processor passes it)
 * right before its "broadcast", like the real one does after signing.
 */
async function runJob(
  data: TransactionJobData,
  opts: {
    broadcast?: Broadcast | Broadcast[];
    receipt?: Receipt;
    attempts?: number;
    beforeAttempt?: (attempt: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 1;
  const behaviours = Array.isArray(opts.broadcast) ? opts.broadcast : [opts.broadcast ?? 'ok'];
  const monitors: Array<Promise<void>> = [];
  let attempt = 0;
  const submitter = {
    async submit(params: { onBeforeBroadcast?: (hash: Hex) => Promise<void> }) {
      const behaviour = behaviours[Math.min(attempt - 1, behaviours.length - 1)];
      if (behaviour === 'fail-before-broadcast') throw new Error('estimateGas: execution reverted');
      const hash = keccak256(toHex(`${data.transactionId}:${attempt}:${Math.random()}`));
      await params.onBeforeBroadcast?.(hash);
      if (behaviour === 'fail-after-broadcast') throw new Error('sendRawTransaction: both RPCs timed out');
      return { txHash: hash, nonce: attempt };
    },
  };
  const monitor = {
    async waitForConfirmation({ transactionId }: { transactionId: string }) {
      if ((opts.receipt ?? 'success') === 'none') return { status: 'TIMEOUT' as const, recorded: false as const };
      return m.recordReceiptOnce(m.db, transactionId, {
        status: opts.receipt === 'reverted' ? 'reverted' : 'success',
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
      });
    },
  };
  const deps = {
    db: m.db,
    submitter: submitter as never,
    monitor,
    feeService: { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never,
    logger: quietLogger,
    trackMonitor: (p: Promise<void>) => monitors.push(p),
  };
  for (attempt = 1; attempt <= attempts; attempt++) {
    await opts.beforeAttempt?.(attempt);
    try {
      await m.processor.processTransactionJob({ data }, deps);
      break;
    } catch (err) {
      if (attempt === attempts) {
        await m.processor.handleFailedTransactionJob(
          { data, attemptsMade: attempts, opts: { attempts } },
          err as Error,
          { db: m.db, deadLetterQueue: { add: async () => undefined } as never, logger: quietLogger },
        );
      }
    }
  }
  await Promise.all(monitors);
}

async function txStatus(id: string): Promise<string | undefined> {
  return (await m.db.transaction.findUnique({ where: { id }, select: { status: true } }))?.status;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describeDb('A6 — DailyVolume of ordinary transactions on Postgres', () => {
  beforeAll(async () => {
    const [db, routes, admin, handler, processor, monitor, escrow] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/routes/admin.js'),
      import('../api/errors/handler.js'),
      import('../queues/transaction.processor.js'),
      import('../services/transaction/monitor.service.js'),
      import('../services/policy/escrow.service.js'),
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
    };
    await wipe();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    h.queued.length = 0;
    h.simulationSucceeds = true;
  });

  // ── Counted once ─────────────────────────────────────────────────────────

  it('a confirmed ETH transfer is counted once (was: reserved at enqueue AND added again at confirmation)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01'); // 20 USD
    expect(res.statusCode).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);

    await runJob(jobOf(res.json().transactionId), { receipt: 'success' });
    expect(await txStatus(res.json().transactionId)).toBe('CONFIRMED');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('a confirmation replayed twice (monitor + re-poll, or a duplicate callback) does not count again', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    const data = jobOf(res.json().transactionId);
    await runJob(data, { receipt: 'success' });
    await Promise.all([
      m.processor.runPostConfirmation({ db: m.db, feeService: { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never, logger: quietLogger }, data),
      m.processor.runPostConfirmation({ db: m.db, feeService: { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never, logger: quietLogger }, data),
    ]);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('N concurrent transfers near the daily limit: exactly the ones that fit are accepted, then counted once', async () => {
    const agent = await mkAgent({ maxDailyVolumeUsd: '100' });
    const a = await app(agent.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => transfer(a, '0.01'))); // 8 × 20 USD
    const accepted = results.filter((r) => r.statusCode === 202);
    const refused = results.filter((r) => r.statusCode === 403);
    expect(accepted).toHaveLength(5);
    expect(refused).toHaveLength(3);
    expect(await volume(agent.id)).toBeCloseTo(100, 6);

    for (const r of accepted) await runJob(jobOf(r.json().transactionId), { receipt: 'success' });
    expect(await volume(agent.id)).toBeCloseTo(100, 6);
  });

  it('two concurrent requests with the same idempotencyKey create one transaction and reserve once', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const key = `idem-${RUN}-${seq}`;
    const [r1, r2] = await Promise.all([
      transfer(a, '0.01', { idempotencyKey: key }),
      transfer(a, '0.01', { idempotencyKey: key }),
    ]);
    expect([r1.statusCode, r2.statusCode].every((c) => c === 200 || c === 202)).toBe(true);
    const rows = await m.db.transaction.findMany({ where: { agentId: agent.id } });
    expect(rows).toHaveLength(1);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  // ── Released exactly when the transaction never executed ──────────────────

  it('a REVERTED transaction gives its reservation back (value never moved)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    await runJob(jobOf(res.json().transactionId), { receipt: 'reverted' });
    expect(await txStatus(res.json().transactionId)).toBe('REVERTED');
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  it('a permanent failure BEFORE any broadcast (all attempts) gives the reservation back', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    await runJob(jobOf(res.json().transactionId), { broadcast: 'fail-before-broadcast', attempts: 3 });
    expect(await txStatus(res.json().transactionId)).toBe('FAILED');
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  it('the failed handler fired twice (duplicate event) releases once — other reservations untouched', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const failing = await transfer(a, '0.01');
    const confirmed = await transfer(a, '0.01');
    await runJob(jobOf(confirmed.json().transactionId), { receipt: 'success' });
    const data = jobOf(failing.json().transactionId);
    const failDeps = { db: m.db, deadLetterQueue: { add: async () => undefined } as never, logger: quietLogger };
    const err = new Error('estimateGas: execution reverted');
    await Promise.all([
      m.processor.handleFailedTransactionJob({ data, attemptsMade: 3, opts: { attempts: 3 } }, err, failDeps),
      m.processor.handleFailedTransactionJob({ data, attemptsMade: 3, opts: { attempts: 3 } }, err, failDeps),
    ]);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('the pre-submit guard failing a paused agent gives the reservation back', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    await m.db.agent.update({ where: { id: agent.id }, data: { active: false } });
    await runJob(jobOf(res.json().transactionId));
    expect(await txStatus(res.json().transactionId)).toBe('FAILED');
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  it('a cooldown refusal does not leave a reservation behind', async () => {
    const agent = await mkAgent({ cooldownSeconds: 3600 });
    const a = await app(agent.id);
    const first = await transfer(a, '0.01');
    expect(first.statusCode).toBe(202);
    const second = await transfer(a, '0.02');
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toMatch(/Cooldown/);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('a simulation failure after the policy check does not leave a reservation behind', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    h.simulationSucceeds = false;
    const res = await transfer(a, '0.01');
    expect(res.statusCode).toBe(422);
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  it('an operator rejection of a PENDING_APPROVAL transaction gives the reservation back', async () => {
    const agent = await mkAgent({ maxValueForAutoApprovalEth: '0.001' });
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('PENDING_APPROVAL');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
    const rej = await a.inject({ method: 'POST', url: `/admin/transactions/${res.json().transactionId}/reject`, headers: ADMIN });
    expect(rej.statusCode).toBe(200);
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });

  it('two concurrent operator approvals enqueue the transaction once', async () => {
    const agent = await mkAgent({ maxValueForAutoApprovalEth: '0.001' });
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    const id = res.json().transactionId;
    const [x, y] = await Promise.all([
      a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN }),
      a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect(h.queued.filter((q) => q.data['transactionId'] === id)).toHaveLength(1);
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  // ── Kept while the transaction may still settle ───────────────────────────

  it('a permanent failure AFTER a broadcast attempt keeps the reservation (the transaction may still mine)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    await runJob(jobOf(res.json().transactionId), { broadcast: 'fail-after-broadcast', attempts: 3 });
    expect(await txStatus(res.json().transactionId)).toBe('FAILED');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('a guard failure on a retry after an earlier broadcast attempt keeps the reservation', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    const data = jobOf(res.json().transactionId);
    // Attempt 1 throws after its broadcast attempt (BullMQ retries); the
    // operator pauses the agent before attempt 2, whose guard fails the row.
    await runJob(data, {
      broadcast: ['fail-after-broadcast', 'ok'],
      attempts: 3,
      beforeAttempt: async (n) => {
        if (n === 2) await m.db.agent.update({ where: { id: agent.id }, data: { active: false } });
      },
    });
    expect(await txStatus(data.transactionId)).toBe('FAILED');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  it('a transaction the re-poll declares dropped keeps its reservation', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '0.01');
    await runJob(jobOf(res.json().transactionId), { receipt: 'none' });
    expect(await txStatus(res.json().transactionId)).toBe('SUBMITTED');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
    const summary = await m.processor.repollSubmittedTransactions(
      {
        db: m.db,
        feeService: { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never,
        logger: quietLogger,
        getReceipt: async () => null,
        isKnownTransaction: async () => false,
      },
      { olderThanMs: 0, dropAfterMs: 0, limit: 50 },
    );
    expect(summary.dropped).toBeGreaterThanOrEqual(1);
    expect(await txStatus(res.json().transactionId)).toBe('FAILED');
    expect(await volume(agent.id)).toBeCloseTo(20, 6);
  });

  // ── Paths that used to count twice or not at all ───────────────────────────

  it('legacy A2A payment: the job reservation is the only count (confirmed), and a revert gives it back', async () => {
    const requester = await mkAgent();
    const provider = await mkAgent();
    const reward = { amount: '0.01', token: 'ETH', chainId: CHAIN_ID }; // 20 USD

    async function paidJob() {
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
      return { job, paid };
    }

    const ok = await paidJob();
    await runJob(jobOf(ok.paid.transactionId), { receipt: 'success' });
    expect((await m.db.job.findUnique({ where: { id: ok.job.id } }))?.status).toBe('COMPLETED');
    expect(await volume(requester.id)).toBeCloseTo(20, 6);

    const bad = await paidJob();
    expect(await volume(requester.id)).toBeCloseTo(40, 6);
    await runJob(jobOf(bad.paid.transactionId), { receipt: 'reverted' });
    expect((await m.db.job.findUnique({ where: { id: bad.job.id } }))?.status).toBe('PAYMENT_FAILED');
    expect(await volume(requester.id)).toBeCloseTo(20, 6);
  });

  it('a batch carrying native value is held to the daily limit and counted once', async () => {
    const agent = await mkAgent({ maxDailyVolumeUsd: '100' });
    const a = await app(agent.id);
    const tooMuch = await a.inject({
      method: 'POST',
      url: '/v1/transactions/batch',
      payload: { chainId: CHAIN_ID, actions: [{ to: RECIPIENT, value: '30000000000000000' }, { to: RECIPIENT, value: '30000000000000000' }] }, // 2 × 60 USD
    });
    expect(tooMuch.statusCode).toBe(403);
    expect(await volume(agent.id)).toBeCloseTo(0, 6);

    const fits = await a.inject({
      method: 'POST',
      url: '/v1/transactions/batch',
      payload: { chainId: CHAIN_ID, actions: [{ to: RECIPIENT, value: '20000000000000000' }, { to: RECIPIENT, value: '10000000000000000' }] }, // 40 + 20 USD
    });
    expect(fits.statusCode).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(60, 6);
    await runJob(jobOf(fits.json().transactionId), { receipt: 'success' });
    expect(await volume(agent.id)).toBeCloseTo(60, 6);
  });

  it('an ERC-20 transfer reserves its USD value and releases it on revert', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const res = await transfer(a, '25', { token: USDC });
    expect(res.statusCode).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(25, 6);
    await runJob(jobOf(res.json().transactionId), { receipt: 'reverted' });
    expect(await volume(agent.id)).toBeCloseTo(0, 6);
  });
});
