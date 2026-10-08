/**
 * C3c regression suite — the ERC-8183 escrow flow with the chain as the
 * source of truth (second adversarial review, 2026-10-08).
 *
 * Runs against a real Postgres (DATABASE_URL, migrated) with the real
 * `api/routes/jobs.ts`, the real orchestrator, the real transaction
 * processor + SubmitterService + MonitorService, the real payment finalizer
 * and reservation service, and the real payment-recovery tick. Faked: the
 * BullMQ queues (drained by `drive()` with BullMQ's retry semantics), the
 * chain (`helpers/fake-escrow-chain.ts`: nonces, mempool, signed raw
 * transactions, the escrow/USDC/registry state machines) and the evaluator
 * signer. Price reads are 1 USDC = 1 USD.
 *
 * Every scenario of the review report is here, each one failing on the code
 * before C3c:
 *  - fund FAILED but mined / fund REVERTED after its first broadcast mined /
 *    fund dropped then mined — the job follows the chain, never stranded
 *  - fund monitor lost — re-poll (tick and boot) funds the job, ACCEPT works,
 *    a cancellation refunds, the expiry sweep refunds whatever the DB says
 *  - submit monitor lost — re-poll settles it, the provider is paid
 *  - settle while the DB says ACCEPTED but the chain says Submitted
 *  - identity monitor lost — the provider's lane unblocks
 *  - two concurrent PATCH COMPLETED (looped) — one wins, no result + refund
 *  - one requester funding two jobs at once — both funded (funding lane)
 *  - an agent that is requester and provider — no nonce collision (broadcast lane)
 *  - a lost cancellation refund — recovery re-enqueues it; low evaluator gas alerted
 *  - a cancellation of a job Submitted on-chain — refused and alerted
 *
 * Skipped (with a warning) when DATABASE_URL is not a reachable, migrated
 * database; on CI (`CI` set) an unreachable database fails the suite.
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
  // The recovery tick treats every row as stale here (the suite controls time).
  process.env['PAYMENT_RECOVERY_STALE_THRESHOLD_SEC'] = '0';
  process.env['ESCROW_RECONCILE_STALE_SEC'] = '0';
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
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: async () => '0',
  tokenAmountToUsd: async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6),
}));
vi.mock('../api/routes/transactions.js', () => ({ executeA2APayment: async () => ({ transactionId: null, status: 'QUEUED' }) }));
vi.mock('../queues/transaction.queue.js', async () => {
  const reg = await vi.importActual<typeof import('./helpers/escrow-sim-registry.js')>('./helpers/escrow-sim-registry.js');
  return {
    transactionQueue: { add: async () => undefined },
    repollSubmittedTransactionsNow: (opts?: { olderThanMs?: number }) => reg.simRepoll()(opts),
    drainTransactionMonitors: async () => 0,
    startTransactionWorker: () => ({ on() {}, async close() {} }),
  };
});
vi.mock('../services/job/escrow-erc8183.runtime.js', async () => {
  const svc = await vi.importActual<typeof import('../services/job/escrow-erc8183.service.js')>('../services/job/escrow-erc8183.service.js');
  const reg = await vi.importActual<typeof import('./helpers/escrow-sim-registry.js')>('./helpers/escrow-sim-registry.js');
  return {
    erc8183Config: reg.simConfig,
    erc8183Deps: () => reg.simDeps(),
    isErc8183Enabled: (chainId: number) => svc.isErc8183EnabledWith(reg.simConfig, chainId),
    getEscrowToken: (chainId: number) => svc.getEscrowToken(reg.simDeps(), chainId),
    startEscrow: (p: Parameters<typeof svc.startEscrow>[1]) => svc.startEscrow(reg.simDeps(), p),
    onEscrowTxOutcome: (o: Parameters<typeof svc.onEscrowTxOutcome>[1]) => svc.onEscrowTxOutcome(reg.simDeps(), o),
    enqueueSubmit: (p: Parameters<typeof svc.enqueueSubmit>[1]) => svc.enqueueSubmit(reg.simDeps(), p),
    requestCancellationReject: (p: Parameters<typeof svc.requestCancellationReject>[1]) => svc.requestCancellationReject(reg.simDeps(), p),
    recoverErc8183Job: (j: Parameters<typeof svc.recoverErc8183Job>[1]) => svc.recoverErc8183Job(reg.simDeps(), j),
    reconcileEscrowJobs: (o: Parameters<typeof svc.reconcileEscrowJobs>[1]) => svc.reconcileEscrowJobs(reg.simDeps(), o),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { FakeEscrowChain, FakeWallets, JobStatus, SIM_ESCROW } from './helpers/fake-escrow-chain.js';
import { setSimDeps, setSimRepoll, simConfig, SIM_EVALUATOR } from './helpers/escrow-sim-registry.js';
import { InMemoryLaneLock, InMemoryNonceStore } from '../services/transaction/wallet-lane.js';
import type { Erc8183Deps, EscrowAlert, EscrowSettlementJobData } from '../services/job/escrow-erc8183.service.js';
import type { TransactionJobData } from '../queues/transaction.processor.js';

// ── Database availability ──────────────────────────────────────────────────

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "onChainStatus", "deferredSubmitAt" FROM "Job" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('escrow-chain-truth.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[escrow-chain-truth.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

// ── Modules under test (after env + mocks) ─────────────────────────────────

type Modules = {
  db: typeof import('../db/client.js')['db'];
  jobRoutes: typeof import('../api/routes/jobs.js')['jobRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  svc: typeof import('../services/job/escrow-erc8183.service.js');
  processor: typeof import('../queues/transaction.processor.js');
  SubmitterService: typeof import('../services/transaction/submitter.service.js')['SubmitterService'];
  MonitorService: typeof import('../services/transaction/monitor.service.js')['MonitorService'];
  releaseJobEscrow: typeof import('../services/policy/escrow.service.js')['releaseJobEscrow'];
  finalizeA2APaymentJob: typeof import('../services/job/payment-finalizer.service.js')['finalizeA2APaymentJob'];
  runPaymentRecoveryTick: typeof import('../queues/payment-recovery.queue.js')['runPaymentRecoveryTick'];
  repollSubmittedAtBoot: typeof import('../worker-process.js')['repollSubmittedAtBoot'];
};
let m: Modules;

const NAME_PREFIX = 'c3c-sim';
const CHAIN_ID = 84532;
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  await m.db.job.deleteMany({ where: { OR: [{ requester: agents }, { provider: agents }] } });
  await m.db.agentIdentity.deleteMany({ where: { agent: agents } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
  await m.db.agent.deleteMany({ where: agents });
}

// ── Simulation harness ─────────────────────────────────────────────────────

interface QueuedTx {
  data: TransactionJobData;
  attempts: number;
}
interface QueuedSettlement {
  data: EscrowSettlementJobData;
  attempts: number;
}

interface Sim {
  chain: FakeEscrowChain;
  wallets: FakeWallets;
  deps: Erc8183Deps;
  alerts: EscrowAlert[];
  /** Escrow steps whose confirmation monitor "dies" (the receipt is never recorded by it). */
  lostMonitors: Set<string>;
  /** Re-poll drop grace (ms). */
  dropAfterMs: number;
  txQueue: QueuedTx[];
  settlements: Map<string, QueuedSettlement>;
  settlementAddFails: ((data: EscrowSettlementJobData) => boolean) | null;
  now: () => Date;
  drive(maxRounds?: number): Promise<void>;
  agent(label: string): Promise<{ id: string; walletId: string; safeAddress: string }>;
  app(agentId: string): Promise<FastifyInstance>;
}

let sim: Sim;
let seq = 0;
const RUN = Date.now().toString(36);

function makeSim(opts: { lane?: boolean } = {}): Sim {
  const chain = new FakeEscrowChain();
  const wallets = new FakeWallets();
  const alerts: EscrowAlert[] = [];
  const lostMonitors = new Set<string>();
  const txQueue: QueuedTx[] = [];
  const settlements = new Map<string, QueuedSettlement>();
  const monitors: Promise<void>[] = [];
  let nowOffsetMs = 0;

  const s: Sim = {
    chain,
    wallets,
    alerts,
    lostMonitors,
    dropAfterMs: 30 * 60_000,
    txQueue,
    settlements,
    settlementAddFails: null,
    now: () => new Date(Date.now() + nowOffsetMs),
    deps: undefined as unknown as Erc8183Deps,
    drive: async () => undefined,
    agent: async () => ({ id: '', walletId: '', safeAddress: '' }),
    app: async () => Fastify(),
  };
  Object.defineProperty(s, 'nowOffsetMs', { get: () => nowOffsetMs, set: (v: number) => (nowOffsetMs = v) });

  const deps: Erc8183Deps = {
    db: m.db,
    queue: {
      add: (async (_name: string, data: TransactionJobData) => {
        txQueue.push({ data, attempts: 0 });
        return undefined;
      }) as never,
    },
    settlement: {
      async add(data) {
        if (s.settlementAddFails?.(data)) throw new Error('settlement queue unavailable (Redis outage)');
        const key = `${data.action}-${data.jobId}`;
        if (!settlements.has(key)) settlements.set(key, { data, attempts: 0 });
      },
    },
    publicClient: () => chain.publicClient as never,
    evaluatorSigner: () => chain.evaluatorSigner(SIM_EVALUATOR) as never,
    config: simConfig,
    releaseJobEscrow: (jobId) => m.releaseJobEscrow(jobId),
    finalize: (params) => m.finalizeA2APaymentJob(params),
    logger: quietLogger,
    now: () => s.now(),
    lanes: new InMemoryLaneLock(),
    alert: (alert) => {
      alerts.push(alert);
    },
  };
  s.deps = deps;

  const feeService = { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined };
  const submitter = new m.SubmitterService({
    wallet: wallets,
    ...(opts.lane === false ? {} : { lane: new InMemoryLaneLock(), nonces: new InMemoryNonceStore() }),
    client: () => chain.rpcClient as never,
  });
  const realMonitor = new m.MonitorService(m.db, {
    getReceipt: async (_chainId, hash) => chain.getReceipt(hash),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const monitor = {
    async waitForConfirmation(p: { txHash: Hex; chainId: number; transactionId: string }) {
      const row = await m.db.transaction.findUnique({ where: { id: p.transactionId }, select: { metadata: true } });
      const step = (row?.metadata as { escrowStep?: string } | null)?.escrowStep;
      // The worker died (restart, shutdown) before this monitor saw the receipt.
      if (step && lostMonitors.has(step)) return { status: 'TIMEOUT' as const, recorded: false as const };
      return realMonitor.waitForConfirmation(p);
    },
  };
  const processorDeps = {
    db: m.db,
    submitter,
    monitor,
    feeService,
    logger: quietLogger,
    trackMonitor: (p: Promise<void>) => {
      monitors.push(p);
    },
  };

  setSimRepoll((o) =>
    m.processor.repollSubmittedTransactions(
      {
        db: m.db,
        feeService,
        logger: quietLogger,
        getReceipt: async (_chainId, hash) => {
          try {
            return chain.getReceipt(hash);
          } catch (err) {
            if (err instanceof TransactionReceiptNotFoundError) return null;
            throw err;
          }
        },
        isKnownTransaction: async (_chainId, hash) => {
          try {
            chain.getTransaction(hash);
            return true;
          } catch {
            return false;
          }
        },
        now: () => s.now(),
      },
      { olderThanMs: o?.olderThanMs ?? 0, dropAfterMs: o?.dropAfterMs ?? s.dropAfterMs, limit: 100 },
    ),
  );

  async function runTx(q: QueuedTx): Promise<void> {
    q.attempts++;
    try {
      await m.processor.processTransactionJob({ data: q.data, attemptsMade: q.attempts - 1, opts: { attempts: 3 } }, processorDeps);
    } catch (err) {
      if (q.attempts < 3) {
        txQueue.push(q); // BullMQ retry (backoff elided)
        return;
      }
      await m.processor.handleFailedTransactionJob({ data: q.data, attemptsMade: q.attempts, opts: { attempts: 3 } }, err as Error, {
        db: m.db,
        deadLetterQueue: { add: async () => undefined } as never,
        logger: quietLogger,
      });
    }
  }

  async function runSettlement(q: QueuedSettlement): Promise<void> {
    q.attempts++;
    try {
      await m.svc.processSettlementJob(deps, { data: q.data, attemptsMade: q.attempts - 1, opts: { attempts: 3 } });
    } catch (err) {
      if (q.attempts < 3) {
        const key = `${q.data.action}-${q.data.jobId}`;
        if (!settlements.has(key)) settlements.set(key, q);
        return;
      }
      await m.svc.handleFailedSettlementJob(deps, { data: q.data, attemptsMade: q.attempts, opts: { attempts: 3 } }, err as Error);
    }
  }

  /** Runs worker rounds until the queues drain (or exactly `rounds` rounds when given). */
  s.drive = async (rounds?: number) => {
    const limit = rounds ?? 200;
    for (let round = 0; round < limit; round++) {
      const txBatch = txQueue.splice(0);
      const settleBatch = [...settlements.values()];
      settlements.clear();
      if (txBatch.length === 0 && settleBatch.length === 0) return;
      // The worker processes a round concurrently (concurrency > 1).
      await Promise.all(txBatch.map(runTx));
      await Promise.all(monitors.splice(0));
      // One settlement at a time (the settlement worker's concurrency is 1).
      for (const q of settleBatch) await runSettlement(q);
    }
    if (rounds === undefined) throw new Error('drive(): queues did not drain');
  };

  s.agent = async (label) => {
    const walletId = `${NAME_PREFIX}-${RUN}-${label}-${++seq}`;
    const safeAddress = wallets.create(walletId);
    chain.mintUsdc(safeAddress as Hex, parseUnits('1000', 6));
    return m.db.agent.create({
      data: { name: `${NAME_PREFIX} ${label}`, apiKeyHash: walletId, apiKeyPrefix: 'sim', walletId, safeAddress, chainIds: [CHAIN_ID] },
      select: { id: true, walletId: true, safeAddress: true },
    });
  };

  s.app = async (agentId) => {
    const app = Fastify({ logger: false });
    m.registerErrorHandler(app);
    app.addHook('preHandler', async (request: { agentId?: string; agentTier?: string }) => {
      request.agentId = agentId;
      request.agentTier = 'FREE';
    });
    await app.register(m.jobRoutes);
    return app;
  };

  setSimDeps(deps);
  return s;
}

function setNowOffset(ms: number): void {
  (sim as unknown as { nowOffsetMs: number }).nowOffsetMs = ms;
}

async function postJob(requesterId: string, providerId: string, amount = '5'): Promise<string> {
  const app = await sim.app(requesterId);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    payload: { providerId, payload: { task: 'c3c' }, reward: { amount, token: 'USDC', chainId: CHAIN_ID } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function patchJob(agentId: string, jobId: string, payload: Record<string, unknown>) {
  const app = await sim.app(agentId);
  return app.inject({ method: 'PATCH', url: `/v1/jobs/${jobId}`, payload });
}

async function job(jobId: string) {
  return m.db.job.findUniqueOrThrow({ where: { id: jobId } });
}

async function stepRows(jobId: string, step: string) {
  return m.db.transaction.findMany({
    where: { OR: [{ intentId: `erc8183:${step}:${jobId}` }, { intentId: { startsWith: `erc8183:${step}:${jobId}#` } }] },
    orderBy: { createdAt: 'asc' },
  });
}

function onChain(jobId: string | null | undefined) {
  return sim.chain.jobs.get(BigInt(jobId!))!;
}

const BUDGET = parseUnits('5', 6);
const START_USDC = parseUnits('1000', 6);

// ── Suite ──────────────────────────────────────────────────────────────────

describeDb('C3c — escrow chain truth (Postgres, real route + orchestrator + processor)', () => {
  beforeAll(async () => {
    const [dbMod, jobsMod, handlerMod, svc, processor, submitterMod, monitorMod, escrowMod, finalizerMod, recoveryMod, workerMod] =
      await Promise.all([
        import('../db/client.js'),
        import('../api/routes/jobs.js'),
        import('../api/errors/handler.js'),
        import('../services/job/escrow-erc8183.service.js'),
        import('../queues/transaction.processor.js'),
        import('../services/transaction/submitter.service.js'),
        import('../services/transaction/monitor.service.js'),
        import('../services/policy/escrow.service.js'),
        import('../services/job/payment-finalizer.service.js'),
        import('../queues/payment-recovery.queue.js'),
        import('../worker-process.js'),
      ]);
    m = {
      db: dbMod.db,
      jobRoutes: jobsMod.jobRoutes,
      registerErrorHandler: handlerMod.registerErrorHandler,
      svc,
      processor,
      SubmitterService: submitterMod.SubmitterService,
      MonitorService: monitorMod.MonitorService,
      releaseJobEscrow: escrowMod.releaseJobEscrow,
      finalizeA2APaymentJob: finalizerMod.finalizeA2APaymentJob,
      runPaymentRecoveryTick: recoveryMod.runPaymentRecoveryTick,
      repollSubmittedAtBoot: workerMod.repollSubmittedAtBoot,
    };
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    m.svc.__resetEscrowTokenCacheForTests();
    sim = makeSim();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    setSimDeps(null);
    setSimRepoll(null);
    await m.db.$disconnect();
  });

  /** Requester + provider, a job funded on-chain, the provider's ERC-8004 identity bound. */
  async function fundedJob(): Promise<{ requester: { id: string; safeAddress: string }; provider: { id: string; safeAddress: string }; jobId: string }> {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED', providerAgentIdStatus: 'BOUND' });
    return { requester, provider, jobId };
  }

  it('baseline: create → fund → bind → accept → submit → complete, provider paid once', async () => {
    const { requester, provider, jobId } = await fundedJob();
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { ok: true } })).statusCode).toBe(200);
    await sim.drive();
    const done = await job(jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', reservationStatus: 'RELEASED' });
    expect(onChain(done.onChainJobId).status).toBe(JobStatus.Completed);
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - (BUDGET * 30n) / 10_000n);
  });

  // ── Finding 1: fund ──────────────────────────────────────────────────────

  it('fund FAILED but mined (monitor lost, then the RPC loses sight of it): the job advances to FUNDED from getJob, never unwinds', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.lostMonitors.add('fund');
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'PENDING', onChainStatus: 'APPROVED' });
    const [fundRow] = await stepRows(jobId, 'fund');
    expect(fundRow).toMatchObject({ status: 'SUBMITTED' });
    expect(onChain((await job(jobId)).onChainJobId).status).toBe(JobStatus.Funded);

    // The RPC no longer returns the receipt or the transaction: the re-poll
    // declares it dropped (FAILED). Before C3c that unwound the job: FAILED,
    // reservation released, USDC locked with no path back.
    sim.chain.hideFromRpc(fundRow!.txHash as Hex);
    sim.dropAfterMs = 0;
    sim.lostMonitors.clear();
    await m.runPaymentRecoveryTick();
    await sim.drive();

    expect((await stepRows(jobId, 'fund'))[0]).toMatchObject({ status: 'FAILED' });
    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED', reservationStatus: 'PENDING' });
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
  });

  it('fund REVERTED because its first broadcast mined (lost RPC answer, retry with the next nonce): advances from the chain', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.chain.dropResponse = ({ functionName }) => functionName === 'fund';
    sim.chain.dropResponseHide = true; // the submitter cannot find the hash either
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();

    const funds = sim.chain.broadcasts.filter((b) => b.functionName === 'fund');
    expect(funds).toHaveLength(2); // the lost one (mined) and the retry (reverts: InvalidStatus)
    expect((await stepRows(jobId, 'fund'))[0]).toMatchObject({ status: 'REVERTED' });
    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED', reservationStatus: 'PENDING' });
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
  });

  it('a lost RPC answer the node still knows is recognised by the submitter: one fund, no revert', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.chain.dropResponse = ({ functionName }) => functionName === 'fund';
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    expect(sim.chain.broadcasts.filter((b) => b.functionName === 'fund')).toHaveLength(1);
    expect((await stepRows(jobId, 'fund'))[0]).toMatchObject({ status: 'CONFIRMED' });
    expect(await job(jobId)).toMatchObject({ onChainStatus: 'FUNDED' });
  });

  it('fund dropped (job unwound) and mined afterwards: the reconciliation refunds it through the evaluator', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    // The fund stays in the mempool; its monitor runs out of attempts (row stays SUBMITTED).
    sim.chain.hold = ({ functionName }) => functionName === 'fund';
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    sim.chain.hold = null;
    const [fundRow] = await stepRows(jobId, 'fund');
    expect(fundRow).toMatchObject({ status: 'SUBMITTED' });
    expect(await job(jobId)).toMatchObject({ status: 'PENDING', onChainStatus: 'APPROVED' });

    // Evicted from every mempool: dropped → FAILED → chain Open → unwound.
    sim.chain.evict(fundRow!.txHash as Hex);
    sim.dropAfterMs = 0;
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'FAILED', onChainStatus: 'FAILED', reservationStatus: 'CANCELLED' });

    // Somebody re-broadcasts it and it mines: the budget is locked on a FAILED job.
    sim.chain.reinject(fundRow!.txHash as Hex);
    expect(onChain((await job(jobId)).onChainJobId).status).toBe(JobStatus.Funded);

    await m.runPaymentRecoveryTick();
    await sim.drive();
    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'FAILED', onChainStatus: 'REJECTED' });
    expect(onChain(after.onChainJobId).status).toBe(JobStatus.Rejected);
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
    expect(sim.chain.usdcOf(SIM_ESCROW)).toBe(0n);
  });

  it('fund monitor lost: the recovery tick re-polls it — FUNDED, the provider can ACCEPT (409 before)', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.lostMonitors.add('fund');
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ onChainStatus: 'APPROVED' });
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(409);

    sim.lostMonitors.clear();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED', providerAgentIdStatus: 'BOUND' });
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
  });

  it('fund monitor lost: the boot re-poll (worker restart) funds the job too', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.lostMonitors.add('fund');
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ onChainStatus: 'APPROVED' });
    sim.lostMonitors.clear();
    await m.repollSubmittedAtBoot();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ onChainStatus: 'FUNDED' });
  });

  it('fund monitor lost: a cancellation still schedules the refund (the reject reads the chain), no wait for expiry', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.lostMonitors.add('fund');
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ onChainStatus: 'APPROVED' });

    expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(200);
    await sim.drive();
    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'CANCELLED', onChainStatus: 'REJECTED' });
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
  });

  it('fund monitor lost past expiresAt: the expiry sweep claims the refund from the chain although the DB says APPROVED', async () => {
    const requester = await sim.agent('requester');
    const provider = await sim.agent('provider');
    sim.lostMonitors.add('fund');
    const jobId = await postJob(requester.id, provider.id);
    await sim.drive();
    const before = await job(jobId);
    expect(before).toMatchObject({ onChainStatus: 'APPROVED' });

    setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
    sim.chain.time = onChain(before.onChainJobId).expiredAt + 1n;
    await m.svc.processSettlementJob(sim.deps, { data: { jobId: '*', action: 'sweep' } });
    await sim.drive();
    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'FAILED', onChainStatus: 'EXPIRED' });
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
  });

  // ── Finding 1: submit and settle ─────────────────────────────────────────

  it('submit monitor lost: the re-poll records it, the settlement pays the provider (instead of a refund at expiry)', async () => {
    const { requester, provider, jobId } = await fundedJob();
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    sim.lostMonitors.add('submit');
    expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { ok: 1 } })).statusCode).toBe(200);
    await sim.drive();
    const stuck = await job(jobId);
    expect(stuck).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'FUNDED' });
    expect(onChain(stuck.onChainJobId).status).toBe(JobStatus.Submitted);

    sim.lostMonitors.clear();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBeGreaterThan(START_USDC);
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);
  });

  it('settle acts on chain Submitted while the DB says ACCEPTED (reconciles the DB first, then completes)', async () => {
    const { provider, jobId } = await fundedJob();
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { ok: 2 } })).statusCode).toBe(200);
    // Run the submit but hold the settlement, then put the DB back to ACCEPTED
    // as the pre-C3c loser of a concurrent completion (or a failed-but-mined
    // submit) did.
    await sim.drive(1);
    sim.settlements.clear();
    await m.db.job.update({ where: { id: jobId }, data: { status: 'ACCEPTED', onChainStatus: 'FUNDED' } });
    expect(onChain((await job(jobId)).onChainJobId).status).toBe(JobStatus.Submitted);

    const result = await m.svc.processSettlementJob(sim.deps, { data: { jobId, action: 'settle' } });
    expect(result).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
  });

  // ── Finding 1: identity lane ─────────────────────────────────────────────

  it('identity monitor lost (register): the re-poll unblocks the provider — both jobs bind, the deferred submit goes out', async () => {
    const requesterA = await sim.agent('requesterA');
    const requesterB = await sim.agent('requesterB');
    const provider = await sim.agent('provider');
    sim.lostMonitors.add('register');
    const jobA = await postJob(requesterA.id, provider.id);
    const jobB = await postJob(requesterB.id, provider.id);
    await sim.drive();
    expect(await job(jobA)).toMatchObject({ onChainStatus: 'FUNDED', providerAgentIdStatus: 'BINDING' });
    expect(await job(jobB)).toMatchObject({ onChainStatus: 'FUNDED', providerAgentIdStatus: 'BINDING' });
    expect((await patchJob(provider.id, jobA, { status: 'ACCEPTED' })).statusCode).toBe(200);
    expect((await patchJob(provider.id, jobA, { status: 'COMPLETED', result: { a: 1 } })).statusCode).toBe(200);
    await sim.drive();
    expect((await job(jobA)).deferredSubmitAt).not.toBeNull(); // stuck behind the lost register

    sim.lostMonitors.clear();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobA)).toMatchObject({ providerAgentIdStatus: 'BOUND', status: 'COMPLETED', deferredSubmitAt: null });
    expect(await job(jobB)).toMatchObject({ providerAgentIdStatus: 'BOUND' });
  });

  it('identity monitor lost (bindAgent): the next job of the provider is bound after the re-poll', async () => {
    const requesterA = await sim.agent('requesterA');
    const provider = await sim.agent('provider');
    // First job registers + binds normally.
    const first = await postJob(requesterA.id, provider.id);
    await sim.drive();
    expect(await job(first)).toMatchObject({ providerAgentIdStatus: 'BOUND' });

    sim.lostMonitors.add('bindAgent');
    const jobA = await postJob(requesterA.id, provider.id);
    const jobB = await postJob(requesterA.id, provider.id);
    await sim.drive();
    const waiting = [await job(jobA), await job(jobB)].filter((j) => j.providerAgentIdStatus === 'BINDING');
    expect(waiting.length).toBe(2); // one bind's monitor lost, the other job waits behind it

    sim.lostMonitors.clear();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobA)).toMatchObject({ providerAgentIdStatus: 'BOUND' });
    expect(await job(jobB)).toMatchObject({ providerAgentIdStatus: 'BOUND' });
  });

  // ── Finding 3: concurrent PATCH COMPLETED ────────────────────────────────

  it('two concurrent PATCH COMPLETED (10 runs): exactly one wins, one submit, the provider is paid, no refund to the requester', async () => {
    const pairs: Array<{ requester: { id: string; safeAddress: string }; provider: { id: string; safeAddress: string }; jobId: string }> = [];
    for (let i = 0; i < 10; i++) {
      const requester = await sim.agent(`requester${i}`);
      const provider = await sim.agent(`provider${i}`);
      pairs.push({ requester, provider, jobId: await postJob(requester.id, provider.id) });
    }
    await sim.drive(200);
    for (const { provider, jobId } of pairs) {
      expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    }

    for (const { requester, provider, jobId } of pairs) {
      const [a, b] = await Promise.all([
        patchJob(provider.id, jobId, { status: 'COMPLETED', result: { take: 'a' } }),
        patchJob(provider.id, jobId, { status: 'COMPLETED', result: { take: 'b' } }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(await stepRows(jobId, 'submit')).toHaveLength(1);
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING' });

      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
      // The requester cannot turn it into "result + refund".
      expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(400);
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - (BUDGET * 30n) / 10_000n);
    }
    expect(sim.chain.evaluatorCalls.filter((c) => c.functionName === 'reject')).toHaveLength(0);
  });

  it('a cancellation of a job that is Submitted on-chain is refused and alerted — never refunded for a cancellation', async () => {
    const { requester, provider, jobId } = await fundedJob();
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { ok: 3 } })).statusCode).toBe(200);
    await sim.drive(1);
    sim.settlements.clear();
    // The DB lags the chain (pre-C3c loser reset): ACCEPTED while Submitted.
    await m.db.job.update({ where: { id: jobId }, data: { status: 'ACCEPTED', onChainStatus: 'FUNDED' } });

    expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(200);
    await sim.drive();

    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'CANCELLED', onChainStatus: 'SUBMITTED' });
    expect(after.escrowError).toMatch(/Cancellation refused/);
    expect(onChain(after.onChainJobId).status).toBe(JobStatus.Submitted);
    expect(sim.chain.evaluatorCalls).toHaveLength(0);
    expect(sim.alerts.map((a) => a.kind)).toContain('cancellation-refused');
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);
  });

  // ── Finding 4: funding lane and broadcast lane ───────────────────────────

  it('one requester funding two jobs at once: approve/fund serialized per job, both FUNDED, nonces distinct and contiguous', async () => {
    const requester = await sim.agent('requester');
    const providerA = await sim.agent('providerA');
    const providerB = await sim.agent('providerB');
    const [jobA, jobB] = await Promise.all([postJob(requester.id, providerA.id, '5'), postJob(requester.id, providerB.id, '7')]);
    await sim.drive();

    expect(await job(jobA)).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED' });
    expect(await job(jobB)).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED' });
    expect(sim.chain.usdcOf(SIM_ESCROW)).toBe(parseUnits('12', 6));

    const mine = sim.chain.broadcasts.filter((b) => b.from.toLowerCase() === requester.safeAddress.toLowerCase());
    expect(mine.map((b) => b.nonce)).toEqual(mine.map((_, i) => i));
    // approve(X) is always followed by fund(X) before the next approve.
    const fundingSteps = mine.filter((b) => b.functionName === 'approve' || b.functionName === 'fund').map((b) => b.functionName);
    expect(fundingSteps).toEqual(['approve', 'fund', 'approve', 'fund']);
    expect(sim.chain.rejectedBroadcasts).toEqual([]);
    const reverted = (await m.db.transaction.findMany({ where: { agentId: requester.id, status: { in: ['REVERTED', 'FAILED'] } } })).length;
    expect(reverted).toBe(0);
  });

  it('an agent that is both requester and provider: its submit and its own funding steps broadcast concurrently without a nonce collision', async () => {
    const outsider = await sim.agent('requesterY');
    const both = await sim.agent('both');
    const third = await sim.agent('providerZ');
    // `both` provides job 1 …
    const job1 = await postJob(outsider.id, both.id);
    await sim.drive();
    expect((await patchJob(both.id, job1, { status: 'ACCEPTED' })).statusCode).toBe(200);
    // … and in the same instant completes it and posts job 2 as requester:
    // the submit and the createJob are in the same worker round.
    const [completed, job2] = await Promise.all([
      patchJob(both.id, job1, { status: 'COMPLETED', result: { both: true } }),
      postJob(both.id, third.id),
    ]);
    expect(completed.statusCode).toBe(200);
    expect(sim.txQueue.length).toBeGreaterThanOrEqual(2);
    await sim.drive();

    expect(await job(job1)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(await job(job2)).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED' });
    const fromBoth = sim.chain.broadcasts.filter((b) => b.from.toLowerCase() === both.safeAddress.toLowerCase());
    expect(fromBoth.map((b) => b.nonce)).toEqual(fromBoth.map((_, i) => i));
    expect(sim.chain.rejectedBroadcasts).toEqual([]);
  });

  // ── Finding 5: lost cancellation refunds ─────────────────────────────────

  it('a lost cancellation refund (queue outage) is re-enqueued by the recovery tick; the evaluator low on gas is alerted', async () => {
    const { requester, provider, jobId } = await fundedJob();
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    sim.settlementAddFails = (data) => data.action === 'reject';
    expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(200);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'CANCELLED', onChainStatus: 'FUNDED' });
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);

    sim.settlementAddFails = null;
    sim.chain.nativeBalances.set(SIM_EVALUATOR.toLowerCase(), 10n ** 12n); // below the 5e14 threshold
    await m.runPaymentRecoveryTick();
    await sim.drive();

    const after = await job(jobId);
    expect(after).toMatchObject({ status: 'CANCELLED', onChainStatus: 'REJECTED' });
    expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
    const reject = sim.chain.evaluatorCalls.find((c) => c.functionName === 'reject');
    expect(reject?.reason).toBe(m.svc.SETTLEMENT_REASONS.cancelled);
    expect(sim.alerts.filter((a) => a.kind === 'evaluator-balance-low')).toHaveLength(1);
  });

  it('the recovery tick leaves a healthy funded job alone (no reject, no unwind)', async () => {
    const { provider, jobId } = await fundedJob();
    expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'ACCEPTED', onChainStatus: 'FUNDED' });
    expect(sim.chain.evaluatorCalls).toHaveLength(0);
  });
});
