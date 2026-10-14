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
 * C3d (decision D9, same harness; the fake chain models ReputationHook's
 * gates): a contest holds the job and the settlement worker leaves it alone;
 * the operator's verdict writes 0, "pay" writes 100, a plain refund writes
 * nothing; the contest/settle race is explicit (a contest after a settlement
 * that mined is refused, never dropped); payout-blocked unwind; a CANCELLED
 * job Submitted on-chain resolved by the operator; an unresolved contest
 * alerted before expiry and refunded at it; the escrow spending policy at
 * POST /v1/jobs (payee allowlist, USDC at 1.0 daily volume incl. x402 rows,
 * token allowlist, per-tx cap, cooldown) and the conditional reservation
 * release; the legacy reservation fails closed without a price.
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
    vetBindBeforeBroadcast: async (jobId: string) => {
      const identity = await vi.importActual<typeof import('../services/job/erc8004-identity.service.js')>('../services/job/erc8004-identity.service.js');
      return identity.vetBindBeforeBroadcast(reg.simDeps() as never, jobId);
    },
    contestJob: (p: Parameters<typeof svc.contestEscrowJob>[1]) => svc.contestEscrowJob(reg.simDeps(), p),
    resolveJob: (p: Parameters<typeof svc.resolveEscrowJob>[1]) => svc.resolveEscrowJob(reg.simDeps(), p),
    alertExpiringReviews: (o?: Parameters<typeof svc.alertExpiringReviews>[1]) => svc.alertExpiringReviews(reg.simDeps(), o),
  };
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseUnits, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { FakeEscrowChain, FakeWallets, JobStatus, SIM_ESCROW, SIM_USDC } from './helpers/fake-escrow-chain.js';
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
  /** Simulated epoch ms before which the job is not picked (a deferral, Q7). */
  notBefore?: number;
}
interface QueuedSettlement {
  data: EscrowSettlementJobData;
  attempts: number;
  /** Simulated epoch ms before which the job is not picked (the evaluation delay, a deferral). */
  notBefore?: number;
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
      async add(data, opts) {
        if (s.settlementAddFails?.(data)) throw new Error('settlement queue unavailable (Redis outage)');
        const key = `${data.action}-${data.jobId}`;
        // BullMQ dedupe: an entry already queued (delayed or not) is kept as is.
        if (!settlements.has(key)) {
          settlements.set(key, { data, attempts: 0, ...(opts?.delayMs ? { notBefore: s.now().getTime() + opts.delayMs } : {}) });
        }
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
        // A retry runs as soon as it is picked again (backoff elided).
        if (!settlements.has(key)) settlements.set(key, { ...q, notBefore: 0 });
        return;
      }
      await m.svc.handleFailedSettlementJob(deps, { data: q.data, attemptsMade: q.attempts, opts: { attempts: 3 } }, err as Error);
    }
  }

  /**
   * Runs worker rounds until the queues drain (or exactly `rounds` rounds when
   * given). Entries delayed past the simulated now (`notBefore`: an evaluation
   * delay, a Q7 deferral) stay queued and do not keep the loop going.
   */
  s.drive = async (rounds?: number) => {
    const limit = rounds ?? 200;
    for (let round = 0; round < limit; round++) {
      const nowMs = s.now().getTime();
      const due = <T extends { notBefore?: number }>(q: T) => (q.notBefore ?? 0) <= nowMs;
      const txBatch = txQueue.filter(due);
      const waitingTx = txQueue.filter((q) => !due(q));
      txQueue.splice(0, txQueue.length, ...waitingTx);
      const settleBatch = [...settlements.entries()].filter(([, q]) => due(q));
      for (const [key] of settleBatch) settlements.delete(key);
      if (txBatch.length === 0 && settleBatch.length === 0) return;
      // The worker processes a round concurrently (concurrency > 1).
      await Promise.all(txBatch.map(runTx));
      await Promise.all(monitors.splice(0));
      // One settlement at a time (the settlement worker's concurrency is 1).
      for (const [, q] of settleBatch) await runSettlement(q);
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

  // ── C3d: contest → operator review (decision D9) ─────────────────────────

  describe('C3d — contest → operator review, escrow policy', () => {
    async function contest(requesterId: string, jobId: string, reason = 'not what I asked for') {
      const app = await sim.app(requesterId);
      return app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/contest`, payload: { reason } });
    }

    /** A job whose deliverable is Submitted on-chain, with the settlement held (evaluation delay elapsed later). */
    async function submittedJob(): Promise<{ requester: { id: string; safeAddress: string }; provider: { id: string; safeAddress: string }; jobId: string }> {
      const { requester, provider, jobId } = await fundedJob();
      expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
      expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { answer: 42 } })).statusCode).toBe(200);
      await sim.drive(1); // the submit mines; the settlement is queued but not run yet
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
      return { requester, provider, jobId };
    }

    async function resolve(jobId: string, decision: 'pay' | 'refund' | 'quality-rejected' | 'payout-blocked') {
      return m.svc.resolveEscrowJob(sim.deps, { jobId, decision, note: `operator: ${decision}`, operator: 'ops@test' });
    }

    it('a contest holds the job: the queued settlement sends nothing, the recovery tick leaves it, the operator is alerted', async () => {
      const { requester, provider, jobId } = await submittedJob();
      const res = await contest(requester.id, jobId);
      expect(res.statusCode).toBe(200);
      expect(res.json().escrow).toMatchObject({ onChainStatus: 'CONTESTED', contestReason: 'not what I asked for', resolution: null });

      await sim.drive();
      await m.runPaymentRecoveryTick();
      await sim.drive();

      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED' });
      expect(onChain((await job(jobId)).onChainJobId).status).toBe(JobStatus.Submitted);
      expect(sim.chain.evaluatorCalls).toHaveLength(0);
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC);
      expect(sim.alerts.map((a) => a.kind)).toContain('contested');
      // A second contest is refused.
      expect((await contest(requester.id, jobId)).statusCode).toBe(409);
    });

    it('operator verdict (refund + quality-rejected): reject with REASON_QUALITY_REJECTED, the hook writes 0, the requester is refunded', async () => {
      const { requester, provider, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      expect(await resolve(jobId, 'quality-rejected')).toMatchObject({ outcome: 'scheduled', previousOnChainStatus: 'CONTESTED' });
      await sim.drive();

      const after = await job(jobId);
      expect(after).toMatchObject({
        status: 'PAYMENT_FAILED',
        onChainStatus: 'REJECTED',
        resolution: 'quality-rejected',
        resolvedBy: 'ops@test',
        feedbackStatus: 'written',
        reservationStatus: 'CANCELLED',
      });
      expect(after.resolvedAt).toBeInstanceOf(Date);
      expect(after.reviewLog).toEqual([expect.objectContaining({ decision: 'quality-rejected', by: 'ops@test', onChainStatus: 'CONTESTED' })]);
      const call = sim.chain.evaluatorCalls.find((c) => c.functionName === 'reject')!;
      expect(call.reason).toBe(m.svc.SETTLEMENT_REASONS.qualityRejected);
      expect(call.optParams).not.toBe('0x');
      expect(sim.chain.feedback).toEqual([expect.objectContaining({ value: 0, tag2: 'rejected', agentId: BigInt(after.ratedAgentId!) })]);
      expect(after.ratedAgentId).toBe(after.providerAgentId);
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC);

      // The committed file is public and immutable now.
      const app = await sim.app(requester.id);
      const file = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/feedback.json` });
      expect(file.statusCode).toBe(200);
      expect(file.headers['cache-control']).toContain('immutable');
      expect(JSON.parse(file.body)).toMatchObject({ outcome: 'rejected' });
    });

    it('operator "pay" after a contest: complete, the hook writes 100, the provider is paid', async () => {
      const { requester, provider, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      expect(await resolve(jobId, 'pay')).toMatchObject({ outcome: 'scheduled' });
      await sim.drive();

      expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', resolution: 'pay', feedbackStatus: 'written', reservationStatus: 'RELEASED' });
      expect(sim.chain.feedback).toEqual([expect.objectContaining({ value: 100, tag2: 'completed' })]);
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - (BUDGET * 30n) / 10_000n);
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC - BUDGET);
    });

    it('operator "refund" without verdict: reject(agentfi.contested, "0x"), nothing rated, no feedback file published', async () => {
      const { requester, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      await resolve(jobId, 'refund');
      await sim.drive();

      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_FAILED', onChainStatus: 'REJECTED', feedbackStatus: 'skipped:no-params', feedbackFile: null });
      const call = sim.chain.evaluatorCalls.find((c) => c.functionName === 'reject')!;
      expect(call).toMatchObject({ reason: m.svc.SETTLEMENT_REASONS.contested, optParams: '0x' });
      expect(sim.chain.feedback).toHaveLength(0);
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
      const app = await sim.app(requester.id);
      expect((await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/feedback.json` })).statusCode).toBe(404);
    });

    it('race (review P3): a complete that mined while the DB lost its receipt — the contest is refused, never accepted then dropped', async () => {
      const { requester, provider, jobId } = await submittedJob();
      // The settlement's receipt wait times out although the complete mined, and
      // its last attempt fails before a fresh chain read (RPC down): the failure
      // handler hands the job back to SUBMITTED with the settlement tx recorded.
      sim.chain.evaluatorReceiptTimeouts = 1;
      await sim.drive(1);
      sim.settlements.clear();
      await m.svc.handleFailedSettlementJob(sim.deps, { data: { jobId, action: 'settle' }, attemptsMade: 3, opts: { attempts: 3 } }, new Error('rpc down'));
      const stuck = await job(jobId);
      expect(stuck).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
      expect(stuck.settleTxHash).not.toBeNull();
      expect(onChain(stuck.onChainJobId).status).toBe(JobStatus.Completed);

      const res = await contest(requester.id, jobId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'CONTEST_NOT_ALLOWED' });
      expect((await job(jobId)).contestedAt).toBeNull();

      // The reconciliation mirrors the chain: COMPLETED, the provider was paid, nothing contradicts a contest.
      await m.runPaymentRecoveryTick();
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', contestedAt: null });
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBeGreaterThan(START_USDC);
      expect(sim.alerts.map((a) => a.kind)).not.toContain('review-overridden');
    });

    it('race: a contest after a settlement that only reverted is accepted (nothing can still mine) and stays held', async () => {
      const { requester, provider, jobId } = await submittedJob();
      sim.chain.blockedPayees.add(provider.safeAddress.toLowerCase()); // complete reverts in simulation
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
      expect(sim.alerts.map((a) => a.kind)).toContain('settlement-failed');

      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      await m.runPaymentRecoveryTick();
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ onChainStatus: 'CONTESTED' });
      expect(sim.chain.evaluatorCalls).toHaveLength(0);
    });

    it('payout blocked: complete keeps reverting → alert → the operator unwinds with REASON_PAYOUT_BLOCKED (no rating, full refund)', async () => {
      const { requester, provider, jobId } = await submittedJob();
      sim.chain.blockedPayees.add(provider.safeAddress.toLowerCase());
      await sim.drive();
      const alert = sim.alerts.find((a) => a.kind === 'settlement-failed')!;
      expect(alert.message).toMatch(/payout-blocked/);

      expect(await resolve(jobId, 'payout-blocked')).toMatchObject({ outcome: 'scheduled', previousStatus: 'PAYMENT_PENDING', previousOnChainStatus: 'SUBMITTED' });
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_FAILED', onChainStatus: 'REJECTED', resolution: 'payout-blocked', feedbackStatus: 'skipped:no-params' });
      expect(sim.chain.evaluatorCalls).toEqual([expect.objectContaining({ functionName: 'reject', reason: m.svc.SETTLEMENT_REASONS.payoutBlocked, optParams: '0x' })]);
      expect(sim.chain.feedback).toHaveLength(0);
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
    });

    it('a CANCELLED job Submitted on-chain (C3c alert) is resolved by the operator: "pay" → COMPLETED and paid', async () => {
      const { provider, requester, jobId } = await fundedJob();
      expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
      expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { ok: 4 } })).statusCode).toBe(200);
      await sim.drive(1);
      sim.settlements.clear();
      await m.db.job.update({ where: { id: jobId }, data: { status: 'ACCEPTED', onChainStatus: 'FUNDED' } });
      expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(200);
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'CANCELLED', onChainStatus: 'SUBMITTED' });

      expect(await resolve(jobId, 'pay')).toMatchObject({ outcome: 'scheduled', previousStatus: 'CANCELLED' });
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', resolution: 'pay' });
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBeGreaterThan(START_USDC);
    });

    it('an unresolved contest: alerted once before expiresAt, refunded by the expiry sweep at it, alerted again — no feedback', async () => {
      const { requester, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      const contested = await job(jobId);

      // Within the default 24 h lead time (the sim TTL is 1 h): one alert per tick, once.
      await m.runPaymentRecoveryTick();
      await m.runPaymentRecoveryTick();
      expect(sim.alerts.filter((a) => a.kind === 'review-expiring')).toHaveLength(1);
      expect((await job(jobId)).reviewAlertedAt).toBeInstanceOf(Date);

      setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
      sim.chain.time = onChain(contested.onChainJobId).expiredAt + 1n;
      await m.svc.processSettlementJob(sim.deps, { data: { jobId: '*', action: 'sweep' } });
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_FAILED', onChainStatus: 'EXPIRED' });
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
      expect(sim.chain.feedback).toHaveLength(0);
      expect(sim.alerts.map((a) => a.kind)).toContain('review-expired');
    });

    // ── Owner's checklist: concurrency, retries, reconciliation ─────────────

    it('race: contest vs the evaluator settlement (10 runs, both orders) — exactly one wins, the loser is a 409 or a no-op', async () => {
      const wins = { contest: 0, settle: 0 };
      for (let i = 0; i < 10; i++) {
        const { requester, provider, jobId } = await submittedJob();
        sim.settlements.clear();
        const settleRun = () => m.svc.processSettlementJob(sim.deps, { data: { jobId, action: 'settle' }, attemptsMade: 0, opts: { attempts: 3 } });
        const contestRun = () => contest(requester.id, jobId);
        const [contestRes, settleRes] =
          i % 2 === 0
            ? await Promise.all([contestRun(), settleRun()])
            : await Promise.all([settleRun(), contestRun()]).then(([s, c]) => [c, s] as const);
        const after = await job(jobId);
        const calls = sim.chain.evaluatorCalls.filter((c) => c.jobId === BigInt(after.onChainJobId!));
        if (contestRes.statusCode === 200) {
          wins.contest++;
          expect(settleRes).toMatchObject({ outcome: 'noop' });
          expect(after).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED' });
          expect(calls).toHaveLength(0);
          expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC);
        } else {
          wins.settle++;
          expect(contestRes.statusCode).toBe(409);
          expect(contestRes.json()).toMatchObject({ error: 'CONTEST_NOT_ALLOWED' });
          expect(settleRes).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
          expect(after).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', contestedAt: null });
          expect(calls).toHaveLength(1);
        }
      }
      expect(wins.contest + wins.settle).toBe(10);
    });

    it('two concurrent resolve calls: exactly one decision is recorded and executed, the other is refused', async () => {
      const { requester, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      sim.settlements.clear();
      const [a, b] = await Promise.all([resolve(jobId, 'pay'), resolve(jobId, 'quality-rejected')]);
      expect([a.outcome, b.outcome].sort()).toEqual(['refused', 'scheduled']);
      const winner = (a.outcome === 'scheduled' ? a : b) as { resolution: string };
      const loser = a.outcome === 'refused' ? a : b;
      expect(loser).toMatchObject({ code: 'SETTLEMENT_IN_PROGRESS' });
      await sim.drive();
      const after = await job(jobId);
      expect(after.resolution).toBe(winner.resolution);
      expect(after.reviewLog).toHaveLength(1);
      expect(sim.chain.evaluatorCalls).toHaveLength(1);
      expect(after.onChainStatus).toBe(winner.resolution === 'pay' ? 'COMPLETED' : 'REJECTED');
    });

    it('retry: a settlement attempt that failed before claiming, retried after a contest, does not settle', async () => {
      const { requester, jobId } = await submittedJob();
      sim.chain.failReads = 1; // the attempt's getJob fails → BullMQ retry
      await sim.drive(1);
      expect(sim.settlements.size).toBe(1);
      expect(await job(jobId)).toMatchObject({ onChainStatus: 'SUBMITTED' });

      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      await sim.drive(); // the retry runs
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED' });
      expect(sim.chain.evaluatorCalls).toHaveLength(0);
    });

    it('retry: an operator decision whose tx mined but whose receipt was lost is not sent twice — the retry reads the chain first', async () => {
      const { requester, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      sim.settlements.clear();
      await resolve(jobId, 'quality-rejected');
      sim.chain.evaluatorReceiptTimeouts = 1; // attempt 1: reject mined, receipt wait times out
      await sim.drive();

      expect(sim.chain.evaluatorCalls).toHaveLength(1);
      const after = await job(jobId);
      expect(after).toMatchObject({ status: 'PAYMENT_FAILED', onChainStatus: 'REJECTED', resolution: 'quality-rejected', feedbackStatus: 'written' });
      expect(after.ratedAgentId).toBe(after.providerAgentId);
      expect(sim.chain.feedback).toEqual([expect.objectContaining({ value: 0 })]);
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
      expect(sim.alerts.map((a) => a.kind)).not.toContain('review-overridden');
    });

    it('a contest survives the boot re-poll of SUBMITTED rows, the recovery tick and the reconciliation (never dropped or overwritten)', async () => {
      const { requester, provider, jobId } = await fundedJob();
      expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
      sim.lostMonitors.add('submit'); // the submit mines; its monitor dies, the row stays SUBMITTED
      expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { ok: 9 } })).statusCode).toBe(200);
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'FUNDED' });
      expect((await stepRows(jobId, 'submit'))[0]).toMatchObject({ status: 'SUBMITTED' });

      // The reconciliation follows the chain (Submitted) and queues the settlement …
      expect(await m.svc.reconcileEscrowJob(sim.deps, jobId)).toBe('advanced');
      expect(await job(jobId)).toMatchObject({ onChainStatus: 'SUBMITTED' });
      // … and the requester contests while that settlement is queued.
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);

      // The lost submit outcome is replayed by the boot re-poll, then every tick runs.
      sim.lostMonitors.clear();
      await m.repollSubmittedAtBoot();
      expect((await stepRows(jobId, 'submit'))[0]).toMatchObject({ status: 'CONFIRMED' });
      await m.runPaymentRecoveryTick();
      expect(await m.svc.reconcileEscrowJob(sim.deps, jobId)).toBe('heldForReview');
      expect(await m.svc.recoverErc8183Job(sim.deps, { id: jobId, onChainStatus: 'CONTESTED' })).toBe('heldForReview');
      await m.svc.processSettlementJob(sim.deps, { data: { jobId: '*', action: 'sweep' } }); // not expired yet
      await sim.drive();

      const after = await job(jobId);
      expect(after).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED', contestReason: 'not what I asked for', resolution: null });
      expect(after.contestedAt).toBeInstanceOf(Date);
      expect(sim.chain.evaluatorCalls).toHaveLength(0);
      expect(onChain(after.onChainJobId).status).toBe(JobStatus.Submitted);
    });

    // ── Review follow-ups: deterministic interleavings, held-job reconciliation ──

    /** `sim.deps` whose NEXT on-chain getJob read first runs `between` — a deterministic interleaving point. */
    function depsInterleaving(between: () => Promise<void>): Erc8183Deps {
      let pending: (() => Promise<void>) | null = between;
      return {
        ...sim.deps,
        publicClient: () => {
          const client = sim.chain.publicClient;
          return {
            ...client,
            readContract: async (params: Parameters<typeof client.readContract>[0]) => {
              if (params.functionName === 'getJob' && pending) {
                const run = pending;
                pending = null;
                await run();
              }
              return client.readContract(params);
            },
          } as never;
        },
      };
    }

    it('race, deterministic: the contest commits between the settlement\'s row snapshot and its claim — the claim fails, nothing is sent', async () => {
      const { requester, provider, jobId } = await submittedJob();
      sim.settlements.clear();
      let contestStatus = 0;
      // processSettlementJob loads the row (SUBMITTED), then reads the chain: the contest lands right there.
      const deps = depsInterleaving(async () => {
        contestStatus = (await contest(requester.id, jobId)).statusCode;
      });
      const result = await m.svc.processSettlementJob(deps, { data: { jobId, action: 'settle' }, attemptsMade: 0, opts: { attempts: 3 } });
      expect(contestStatus).toBe(200);
      expect(result).toMatchObject({ outcome: 'noop', reason: expect.stringContaining('cannot be settled') });
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED', resolution: null });
      expect(sim.chain.evaluatorCalls).toHaveLength(0);
      expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC);
    });

    it('race, deterministic: another decision is claimed between resolve\'s checks and its claim (claimed.count === 0) — refused, one decision, one log entry', async () => {
      const { requester, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      sim.settlements.clear();
      let inner: unknown;
      // The outer resolve has read the CONTESTED row; during its chain read a first operator decides "pay".
      const deps = depsInterleaving(async () => {
        inner = await resolve(jobId, 'pay');
      });
      const outer = await m.svc.resolveEscrowJob(deps, { jobId, decision: 'quality-rejected', note: 'second operator', operator: 'ops2@test' });
      expect(inner).toMatchObject({ outcome: 'scheduled', resolution: 'pay' });
      expect(outer).toMatchObject({ outcome: 'refused', code: 'SETTLEMENT_IN_PROGRESS', message: expect.stringMatching(/changed while the decision was processed/) });
      const recorded = await job(jobId);
      expect(recorded).toMatchObject({ onChainStatus: 'SETTLING', resolution: 'pay', resolvedBy: 'ops@test' });
      expect(recorded.reviewLog).toEqual([expect.objectContaining({ decision: 'pay', by: 'ops@test', onChainStatus: 'CONTESTED' })]);
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', resolution: 'pay' });
      expect(sim.chain.evaluatorCalls).toEqual([expect.objectContaining({ functionName: 'complete' })]);
    });

    it('review P3-1: the reconciliation checks undecided held jobs read-only — one settled by another hand is mirrored and alerted, one still Submitted only rotates', async () => {
      const a = await submittedJob();
      expect((await contest(a.requester.id, a.jobId)).statusCode).toBe(200);
      const b = await submittedJob();
      expect((await contest(b.requester.id, b.jobId)).statusCode).toBe(200);
      sim.settlements.clear();
      // The evaluator key is used outside the backend: job A is completed on-chain.
      const onChainA = BigInt((await job(a.jobId)).onChainJobId!);
      await sim.chain
        .evaluatorSigner(SIM_EVALUATOR)
        .writeContract({ address: SIM_ESCROW, abi: AGENT_JOB_ESCROW_ABI as never, functionName: 'complete', args: [onChainA, m.svc.SETTLEMENT_REASONS.completed, '0x'] });
      const bBefore = (await job(b.jobId)).updatedAt;

      const summary = await m.svc.reconcileEscrowJobs(sim.deps, { staleBefore: new Date(Date.now() + 60_000), limit: 50 });
      expect(summary.heldReviews).toBe(2);
      expect(summary.outcomes).toMatchObject({ reconciled: 1, heldForReview: 1 });
      expect(await job(a.jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', resolution: null });
      expect(sim.alerts.filter((x) => x.kind === 'review-overridden')).toEqual([expect.objectContaining({ jobId: a.jobId })]);
      const bAfter = await job(b.jobId);
      expect(bAfter).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED', resolution: null });
      expect(bAfter.updatedAt.getTime()).toBeGreaterThan(bBefore.getTime());
      expect(sim.settlements.size).toBe(0); // nothing enqueued: the hold is the operator's
      expect(sim.chain.evaluatorCalls).toHaveLength(1); // only the outside complete
    });

    it('review P3-2: a decision whose settlement kept failing until expiry ends EXPIRED and is alerted "review-overridden"', async () => {
      const { requester, provider, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      sim.chain.blockedPayees.add(provider.safeAddress.toLowerCase()); // "pay" (complete) reverts
      expect(await resolve(jobId, 'pay')).toMatchObject({ outcome: 'scheduled' });
      await sim.drive();
      const held = await job(jobId);
      expect(held).toMatchObject({ onChainStatus: 'CONTESTED', resolution: 'pay' });

      setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
      sim.chain.time = onChain(held.onChainJobId).expiredAt + 1n;
      await m.svc.processSettlementJob(sim.deps, { data: { jobId: '*', action: 'sweep' } });
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_FAILED', onChainStatus: 'EXPIRED', resolution: 'pay' });
      expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(START_USDC);
      expect(sim.alerts.filter((x) => x.kind === 'review-overridden')).toEqual([
        expect.objectContaining({ jobId, message: expect.stringMatching(/expired on-chain before the operator decision "pay" was executed.*NOT paid/) }),
      ]);
      expect(sim.alerts.map((x) => x.kind)).not.toContain('review-expired');
    });

    it('review P3-4: recovery inside the evaluation window restores the delayed settle with the REMAINING delay and rotates the job; after it, settles', async () => {
      const { jobId } = await submittedJob();
      sim.settlements.clear();
      const added: Array<{ data: EscrowSettlementJobData; delayMs: number | undefined }> = [];
      const deps: Erc8183Deps = {
        ...sim.deps,
        config: { ...simConfig, evaluationDelaySeconds: 600 },
        settlement: {
          add: async (data, opts) => {
            added.push({ data, delayMs: opts?.delayMs });
          },
        },
      };
      await m.db.$executeRaw`UPDATE "Job" SET "updatedAt" = now() - interval '10 minutes' WHERE "id" = ${jobId}`;
      const staleAt = (await job(jobId)).updatedAt;

      expect(await m.svc.recoverErc8183Job(deps, { id: jobId, onChainStatus: 'SUBMITTED' })).toBe('awaitingEvaluation');
      expect(added).toEqual([{ data: { jobId, action: 'settle' }, delayMs: expect.any(Number) }]);
      expect(added[0]!.delayMs!).toBeGreaterThan(500_000);
      expect(added[0]!.delayMs!).toBeLessThanOrEqual(600_000);
      expect((await job(jobId)).updatedAt.getTime()).toBeGreaterThan(staleAt.getTime());
      // Bumping updatedAt does not slide the window: it is anchored on the submit confirmation.
      expect(await m.svc.recoverErc8183Job(deps, { id: jobId, onChainStatus: 'SUBMITTED' })).toBe('awaitingEvaluation');
      expect(added[1]!.delayMs!).toBeLessThanOrEqual(added[0]!.delayMs!);

      setNowOffset(601_000);
      added.length = 0;
      expect(await m.svc.recoverErc8183Job(deps, { id: jobId, onChainStatus: 'SUBMITTED' })).toBe('resettled');
      expect(added).toEqual([{ data: { jobId, action: 'settle' }, delayMs: undefined }]);
    });

    // ── Q6 (owner, 2026-10-14): the 3600 s contest window of the validation configuration ──
    describe('Q6 — contest window 3600 s (validation config) vs job expiry and operator review', () => {
      const WINDOW_MS = 3_600_000;
      const MIN = 60_000;
      const saved = { evaluationDelaySeconds: simConfig.evaluationDelaySeconds, jobTtlSeconds: simConfig.jobTtlSeconds };

      beforeEach(() => {
        simConfig.evaluationDelaySeconds = 3600;
        simConfig.jobTtlSeconds = 604_800; // the production default (7 days)
      });
      afterEach(() => {
        simConfig.evaluationDelaySeconds = saved.evaluationDelaySeconds;
        simConfig.jobTtlSeconds = saved.jobTtlSeconds;
      });

      /** Delivered job: the submit mined, the settle sits in the queue with its evaluation delay. */
      async function deliveredInWindow() {
        const { requester, provider, jobId } = await fundedJob();
        expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
        expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { answer: 42 } })).statusCode).toBe(200);
        const before = sim.now().getTime();
        await sim.drive(); // drains: only the delayed settle is left
        expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
        const queued = sim.settlements.get(`settle-${jobId}`);
        expect(queued).toBeDefined();
        return { requester, provider, jobId, queued: queued!, submittedAt: before };
      }

      /** Money-relevant columns + the requester's DailyVolume rows: what "does nothing" must leave untouched. */
      async function ledger(jobId: string, requesterId: string) {
        const row = await job(jobId);
        const volume = await m.db.dailyVolume.findMany({ where: { agentId: requesterId }, orderBy: { date: 'asc' } });
        return {
          job: {
            status: row.status,
            onChainStatus: row.onChainStatus,
            reservationStatus: row.reservationStatus,
            settleTxHash: row.settleTxHash,
            feedbackStatus: row.feedbackStatus,
            resolution: row.resolution,
          },
          volume: volume.map((v) => ({ date: v.date, volumeUsd: v.volumeUsd })),
        };
      }

      it('TTL 7 days: the settle is scheduled the full 3600 s after the submit (not clamped); a contest at +30 min holds the job and the settle firing at +61 min sends nothing', async () => {
        const { requester, provider, jobId, queued, submittedAt } = await deliveredInWindow();
        const delay = queued.notBefore! - submittedAt;
        expect(delay).toBeGreaterThan(WINDOW_MS - 30_000);
        expect(delay).toBeLessThanOrEqual(WINDOW_MS + 5_000);
        expect(sim.chain.evaluatorCalls).toHaveLength(0);

        setNowOffset(30 * MIN);
        const app = await sim.app(requester.id);
        const res = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/contest`, payload: { reason: 'wrong answer' } });
        expect(res.statusCode).toBe(200);
        expect(res.json().escrow).toMatchObject({ onChainStatus: 'CONTESTED' });

        setNowOffset(61 * MIN);
        await sim.drive(); // the delayed settle fires
        await m.runPaymentRecoveryTick();
        await sim.drive();
        expect(sim.settlements.size).toBe(0);
        expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED', resolution: null });
        expect(onChain((await job(jobId)).onChainJobId).status).toBe(JobStatus.Submitted);
        expect(sim.chain.evaluatorCalls).toHaveLength(0);
        expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC);
      });

      it.each([
        ['pay', true],
        ['refund', true],
        ['quality-rejected', true],
        ['refund', false],
      ] as const)(
        'operator "%s" during the window (contested: %s) settles exactly once; the delayed settle that fires later changes nothing',
        async (decision, contested) => {
          const { requester, provider, jobId } = await deliveredInWindow();
          setNowOffset(10 * MIN);
          if (contested) {
            const app = await sim.app(requester.id);
            expect((await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/contest`, payload: { reason: 'q6' } })).statusCode).toBe(200);
          }
          setNowOffset(20 * MIN);
          const outcome = await m.svc.resolveEscrowJob(sim.deps, { jobId, decision, note: `q6 ${decision}`, operator: 'ops@test' });
          expect(outcome).toMatchObject({ outcome: 'scheduled', previousOnChainStatus: contested ? 'CONTESTED' : 'SUBMITTED' });
          await sim.drive(); // the resolve settlement has no delay: it runs now, inside the window

          const paid = decision === 'pay';
          expect(sim.chain.evaluatorCalls).toEqual([expect.objectContaining({ functionName: paid ? 'complete' : 'reject' })]);
          expect(await job(jobId)).toMatchObject(
            paid
              ? { status: 'COMPLETED', onChainStatus: 'COMPLETED', reservationStatus: 'RELEASED' }
              : { status: 'PAYMENT_FAILED', onChainStatus: 'REJECTED', reservationStatus: 'CANCELLED' },
          );
          expect(sim.settlements.has(`settle-${jobId}`)).toBe(true); // still delayed
          const afterDecision = await ledger(jobId, requester.id);
          const providerUsdc = sim.chain.usdcOf(provider.safeAddress as Hex);
          const requesterUsdc = sim.chain.usdcOf(requester.safeAddress as Hex);

          setNowOffset(61 * MIN);
          await sim.drive(); // the original delayed settle fires
          await m.runPaymentRecoveryTick();
          await sim.drive();

          expect(sim.settlements.size).toBe(0); // the delayed settle did run
          expect(sim.chain.evaluatorCalls).toHaveLength(1);
          expect(await ledger(jobId, requester.id)).toEqual(afterDecision);
          expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(providerUsdc);
          expect(sim.chain.usdcOf(requester.safeAddress as Hex)).toBe(requesterUsdc);
          expect(sim.alerts.map((a) => a.kind)).not.toContain('review-overridden');
        },
      );

      it('a window that would cross expiresAt is clamped: the settle runs before expiresAt − margin, then a contest is refused', async () => {
        simConfig.jobTtlSeconds = 3600; // expires one hour after createJob: shorter than window + margin
        const { requester, provider, jobId, queued, submittedAt } = await deliveredInWindow();
        const expiresAt = (await job(jobId)).expiresAt!.getTime();
        const margin = m.svc.expiryMarginMs(simConfig);
        expect(margin).toBe(120_000);
        expect(queued.notBefore! - submittedAt).toBeLessThan(WINDOW_MS - margin);
        expect(queued.notBefore!).toBeLessThanOrEqual(expiresAt - margin + 1_000);

        setNowOffset(queued.notBefore! - Date.now() + 1_000);
        expect(sim.now().getTime()).toBeLessThan(expiresAt);
        await sim.drive();
        expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
        expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - (BUDGET * 30n) / 10_000n);

        const app = await sim.app(requester.id);
        expect((await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/contest`, payload: {} })).statusCode).toBe(409);
      });

      it('accept / deliver inside the expiry margin is 409 ESCROW_EXPIRING with the window on; nothing is written or sent', async () => {
        const { provider, jobId } = await fundedJob();
        expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
        // The route reads the wall clock: move expiresAt instead of the simulated clock.
        await m.db.job.update({ where: { id: jobId }, data: { expiresAt: new Date(Date.now() + 60_000) } });
        const res = await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { late: true } });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: 'ESCROW_EXPIRING' });
        expect(await job(jobId)).toMatchObject({ status: 'ACCEPTED', onChainStatus: 'FUNDED', deliverableHash: null });
        expect(await stepRows(jobId, 'submit')).toHaveLength(0);
      });

      it('restart inside the window (the delayed settle is lost): the recovery tick restores it with the REMAINING time — no early settle, settles once after', async () => {
        const { requester, jobId, submittedAt } = await deliveredInWindow();
        sim.settlements.clear(); // Redis lost the delayed job (restart / flush)

        setNowOffset(20 * MIN);
        await m.runPaymentRecoveryTick();
        const restored = sim.settlements.get(`settle-${jobId}`);
        expect(restored?.notBefore).toBeDefined();
        const remaining = restored!.notBefore! - sim.now().getTime();
        expect(remaining).toBeGreaterThan(39 * MIN);
        expect(remaining).toBeLessThanOrEqual(40 * MIN + 5_000);
        expect(restored!.notBefore! - submittedAt).toBeLessThanOrEqual(WINDOW_MS + 5_000);
        await sim.drive();
        expect(sim.chain.evaluatorCalls).toHaveLength(0);

        // Still contestable inside the restored window.
        setNowOffset(50 * MIN);
        await m.runPaymentRecoveryTick(); // the job is still in its window: no immediate settle is added
        await sim.drive();
        expect(sim.chain.evaluatorCalls).toHaveLength(0);
        expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });

        setNowOffset(61 * MIN);
        await sim.drive();
        await m.runPaymentRecoveryTick();
        await sim.drive();
        expect(sim.chain.evaluatorCalls).toEqual([expect.objectContaining({ functionName: 'complete' })]);
        expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
        void requester;
      });
    });

    it('review P3-3: migration 0019 moves pre-C3d contested rows (SUBMITTED or SETTLING, no decision) to CONTESTED — and nothing else', async () => {
      const sql = readFileSync(fileURLToPath(new URL('../db/migrations/0019_c3d_contest_review/migration.sql', import.meta.url)), 'utf8');
      const update = sql.slice(sql.indexOf('UPDATE "Job"')).trim();
      expect(update).toMatch(/^UPDATE "Job"[\s\S]*;$/);
      const requester = await sim.agent('mig-req');
      const provider = await sim.agent('mig-prov');
      const row = (data: Record<string, unknown>) =>
        m.db.job.create({
          data: { requesterId: requester.id, providerId: provider.id, payload: {}, reward: {}, status: 'PAYMENT_PENDING', escrowKind: 'erc8183', onChainJobId: '1', ...data },
        });
      const at = new Date();
      const submitted = await row({ onChainStatus: 'SUBMITTED', contestedAt: at });
      const settling = await row({ onChainStatus: 'SETTLING', contestedAt: at });
      const decided = await row({ onChainStatus: 'SETTLING', contestedAt: at, resolution: 'pay' });
      const uncontested = await row({ onChainStatus: 'SETTLING' });
      const cancelled = await row({ onChainStatus: 'SUBMITTED', contestedAt: at, status: 'CANCELLED' });
      await m.db.$executeRawUnsafe(update);
      expect((await job(submitted.id)).onChainStatus).toBe('CONTESTED');
      expect((await job(settling.id)).onChainStatus).toBe('CONTESTED');
      expect((await job(decided.id)).onChainStatus).toBe('SETTLING');
      expect((await job(uncontested.id)).onChainStatus).toBe('SETTLING');
      expect((await job(cancelled.id)).onChainStatus).toBe('SUBMITTED');
    });

    it('the stale PAYMENT_PENDING scan skips an undecided contest (no starvation) but still picks legacy rows and a contest with a decision', async () => {
      const { requester, provider, jobId } = await submittedJob();
      expect((await contest(requester.id, jobId)).statusCode).toBe(200);
      sim.settlements.clear();
      // A legacy paid job stuck in PAYMENT_PENDING (onChainStatus NULL): it must still be scanned.
      const legacy = await m.db.job.create({
        data: { requesterId: requester.id, providerId: provider.id, payload: {}, reward: { amount: '1', token: 'ETH', chainId: 1 }, status: 'PAYMENT_PENDING' },
      });

      const first = await m.runPaymentRecoveryTick();
      expect(first).toMatchObject({ scanned: 1, refundedOrphan: 1, erc8183Recovered: 0 });
      expect((await job(legacy.id)).status).toBe('PAYMENT_FAILED');
      expect(sim.settlements.size).toBe(0);

      // A decision whose settlement failed went back to the hold: the scan retries it.
      await m.db.job.update({ where: { id: jobId }, data: { resolution: 'refund', resolvedBy: 'ops', resolvedAt: new Date() } });
      const second = await m.runPaymentRecoveryTick();
      expect(second).toMatchObject({ scanned: 1, erc8183Recovered: 1 });
      expect([...sim.settlements.values()].map((q) => q.data)).toEqual([{ jobId, action: 'resolve' }]);
    });

    it('H14 dry-run: a setProviderAgentId queued at FUNDED is not broadcast after the job was cancelled and refunded (SKIPPED, no revert)', async () => {
      // The provider already has an ERC-8004 identity (first job registered it).
      const { provider } = await fundedJob();
      const requester = await sim.agent('requester2');
      const jobId = await postJob(requester.id, provider.id);
      // Drive until the bind of the new job is queued (fund confirmed → bind enqueued), then hold it.
      for (let round = 0; round < 20; round++) {
        if (await m.db.transaction.findUnique({ where: { intentId: `erc8183:bindAgent:${jobId}` } })) break;
        await sim.drive(1);
      }
      expect(await job(jobId)).toMatchObject({ onChainStatus: 'FUNDED', providerAgentIdStatus: 'BINDING' });
      const heldBind = sim.txQueue.splice(0);
      expect(heldBind).toHaveLength(1);

      // The requester cancels; the evaluator's refund mines before the bind goes out.
      expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(200);
      await sim.drive();
      expect(await job(jobId)).toMatchObject({ status: 'CANCELLED', onChainStatus: 'REJECTED' });

      sim.txQueue.push(...heldBind);
      await sim.drive();
      const after = await job(jobId);
      expect(after).toMatchObject({ providerAgentIdStatus: 'SKIPPED' });
      expect(after.providerAgentIdError).toMatch(/checked before broadcast/);
      const [bind] = await stepRows(jobId, 'bindAgent');
      expect(bind).toMatchObject({ status: 'FAILED', txHash: null, error: expect.stringMatching(/^setProviderAgentId skipped before submission/) });
      const onChainJobId = BigInt(after.onChainJobId!);
      expect(sim.chain.broadcasts.filter((b) => b.functionName === 'setProviderAgentId' && b.from.toLowerCase() === provider.safeAddress.toLowerCase())).toHaveLength(1); // only the first job's
      expect(onChain(after.onChainJobId).providerAgentId).toBe(0n);
      expect(onChainJobId).toBeGreaterThan(0n);
      expect(await m.db.transaction.count({ where: { agentId: provider.id, status: 'REVERTED' } })).toBe(0);
    });

    // ── Escrow spending policy (POST /v1/jobs) ─────────────────────────────

    async function policy(agentId: string, data: Record<string, unknown>) {
      await m.db.agentPolicy.create({
        data: { agentId, maxValuePerTxUsd: '100', maxDailyVolumeUsd: '0', cooldownSeconds: 0, allowedContracts: [], allowedRecipients: [], allowedTokens: [], ...data },
      });
    }

    async function postRaw(requesterId: string, providerId: string, amount: string) {
      const app = await sim.app(requesterId);
      return app.inject({
        method: 'POST',
        url: '/v1/jobs',
        payload: { providerId, payload: { task: 'c3d policy' }, reward: { amount, token: 'USDC', chainId: CHAIN_ID } },
      });
    }

    it('allowedRecipients is the payee list (Q8): the provider wallet must be listed (the escrow contract alone is not enough)', async () => {
      const requester = await sim.agent('requester');
      const provider = await sim.agent('provider');
      // allowedContracts no longer restricts payees: listing the provider there does nothing for the escrow job.
      await policy(requester.id, { allowedRecipients: [SIM_ESCROW], allowedContracts: [provider.safeAddress] });
      const refused = await postRaw(requester.id, provider.id, '5');
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'allowedRecipients', payee: provider.safeAddress });
      expect(refused.json().error).toMatch(/allowed recipients whitelist/);
      expect(await m.db.job.count({ where: { requesterId: requester.id } })).toBe(0);

      await m.db.agentPolicy.update({ where: { agentId: requester.id }, data: { allowedRecipients: [provider.safeAddress.toLowerCase()], allowedContracts: [SIM_ESCROW] } });
      expect((await postRaw(requester.id, provider.id, '5')).statusCode).toBe(201);
    });

    it('allowedTokens must list the escrow USDC; the per-tx cap is maxValuePerTxUsd (Q8), never the ETH field', async () => {
      const requester = await sim.agent('requester');
      const provider = await sim.agent('provider');
      await policy(requester.id, { allowedTokens: ['0x4200000000000000000000000000000000000006'], maxValuePerTxUsd: '4', maxValuePerTxEth: '1000' });
      expect((await postRaw(requester.id, provider.id, '1')).json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'allowedTokens' });

      await m.db.agentPolicy.update({ where: { agentId: requester.id }, data: { allowedTokens: [SIM_USDC] } });
      const capped = await postRaw(requester.id, provider.id, '5');
      expect(capped.statusCode).toBe(403);
      expect(capped.json()).toMatchObject({ rule: 'maxValuePerTxUsd', limit: '4' });
      expect((await postRaw(requester.id, provider.id, '4')).statusCode).toBe(201);
    });

    it('daily volume: USDC at 1.00 (no oracle) incl. x402 rows, reserved atomically; a cancellation credits it back once', async () => {
      const requester = await sim.agent('requester');
      const provider = await sim.agent('provider');
      await policy(requester.id, { maxDailyVolumeUsd: '12' });

      const first = await postRaw(requester.id, provider.id, '5');
      expect(first.statusCode).toBe(201);
      const firstId = first.json().id as string;
      expect(await job(firstId)).toMatchObject({ reservedValueUsd: '5' });
      const today = new Date().toISOString().slice(0, 10);
      const volume = async () => Number((await m.db.dailyVolume.findUnique({ where: { agentId_date: { agentId: requester.id, date: today } } }))?.volumeUsd ?? '0');
      expect(await volume()).toBe(5);

      // 2 USDC of x402 spend today (P6 ledger) counts against the same limit.
      await m.db.resourcePayment.create({
        data: { jobId: firstId, agentId: requester.id, url: 'https://r.test/x', method: 'GET', network: 'eip155:84532', asset: SIM_USDC, amount: '2000000', payTo: provider.safeAddress, paymentId: `p-${RUN}`, status: 'settled' },
      });
      const refused = await postRaw(requester.id, provider.id, '6');
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ rule: 'maxDailyVolume', limit: '12', spentToday: '7' });
      expect(await volume()).toBe(5); // rolled back
      expect((await postRaw(requester.id, provider.id, '5')).statusCode).toBe(201);
      expect(await volume()).toBe(10);

      // Cancel the first job and race two releases (route + a step failure): credited once.
      await sim.drive();
      await Promise.all([m.releaseJobEscrow(firstId), m.releaseJobEscrow(firstId)]);
      expect(await volume()).toBe(5);
      expect(await job(firstId)).toMatchObject({ reservationStatus: 'CANCELLED' });
    });

    it('two parallel POST /v1/jobs near the daily limit (5 runs): exactly one job is created and reserved, the other is 403 maxDailyVolume', async () => {
      for (let i = 0; i < 5; i++) {
        const requester = await sim.agent(`twin-req${i}`);
        const provider = await sim.agent(`twin-prov${i}`);
        await policy(requester.id, { maxDailyVolumeUsd: '8' });
        const [a, b] = await Promise.all([postRaw(requester.id, provider.id, '5'), postRaw(requester.id, provider.id, '5')]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 403]);
        expect((a.statusCode === 403 ? a : b).json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'maxDailyVolume', spentToday: '5' });
        expect(await m.db.job.count({ where: { requesterId: requester.id } })).toBe(1);
        const today = new Date().toISOString().slice(0, 10);
        const row = await m.db.dailyVolume.findUnique({ where: { agentId_date: { agentId: requester.id, date: today } } });
        expect(Number(row?.volumeUsd)).toBe(5);
      }
    });

    it('cooldown: a job is refused while the agent\'s last transaction is younger than cooldownSeconds', async () => {
      const requester = await sim.agent('requester');
      const provider = await sim.agent('provider');
      await policy(requester.id, { cooldownSeconds: 3600 });
      expect((await postRaw(requester.id, provider.id, '1')).statusCode).toBe(201); // no transaction yet
      const second = await postRaw(requester.id, provider.id, '1'); // its createJob row is seconds old
      expect(second.statusCode).toBe(403);
      expect(second.json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'cooldown' });
    });

    it('legacy (non-escrow) reward: the daily limit fails closed when the reward cannot be priced; no limit → allowed', async () => {
      const requester = await sim.agent('requester');
      const provider = await sim.agent('provider');
      await m.db.agent.update({ where: { id: requester.id }, data: { chainIds: [CHAIN_ID, 1] } });
      const legacy = async () => {
        const app = await sim.app(requester.id);
        return app.inject({ method: 'POST', url: '/v1/jobs', payload: { providerId: provider.id, payload: {}, reward: { amount: '0.01', token: 'ETH', chainId: 1 } } });
      };
      await policy(requester.id, { maxDailyVolumeUsd: '100' });
      const refused = await legacy();
      expect(refused.statusCode).toBe(400);
      expect(refused.json().reason).toMatch(/could not be priced/);

      await m.db.agentPolicy.update({ where: { agentId: requester.id }, data: { maxDailyVolumeUsd: '0' } });
      const allowed = await legacy();
      expect(allowed.statusCode).toBe(201);
      expect(await job(allowed.json().id)).toMatchObject({ reservedValueUsd: '0', reservationStatus: 'PENDING' });
    });
  });
});
