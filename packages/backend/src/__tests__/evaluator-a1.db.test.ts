/**
 * A1 (C3g) adversarial suite — Postgres + the multi-node fake chain (`helpers/fake-evaluator-chain.ts`).
 *
 * Rows of the matrix (spec 2026-10-21-spec-c3g-a1.md §11 + R2-§11, plan 2026-10-21-plano-a1-parametros.md
 * §10.1) at layer DB; map: agentfi-notas/2026-10-22-a1-matriz.md. Each test name starts with its row.
 *
 * Harness: the C3c one of `escrow-chain-truth.db.test.ts` (real routes, orchestrator, transaction
 * processor, finalizer, recovery tick; BullMQ and the chain faked), with the evaluator served by
 * `FakeEvaluatorChain` (raw transactions, nonces per node, blocks, reorg, replacement receipts).
 *
 * Three blocks:
 *  1. `fake-evaluator-chain self-check` — always runs (no DB): the fake obeys the node rules the rows rely on.
 *  1b. `harness smoke` — runs whenever Postgres answers (`describe.runIf`).
 *  2. `A1 core` — runs when the table exists AND the service exports `reconcileEvaluatorCandidates`
 *     (A1 is integrated). Outside CI it is skipped with a warning when they are missing; on CI that throws.
 *  3. `A1 recovery script` — the recovery CLI (`runEvaluatorRecovery(argv, deps)`), same gate as block 2.
 *     Row 9 (script + worker at once, Redis real) stays a todo here: a separate multi-process test covers it.
 *
 * Integration points (assumed names, ONE place to fix): the section "A1 integration points" below.
 * Cleanup order: EvaluatorTransaction → incidents/state → Job (ON DELETE RESTRICT, R2-P3-8).
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
  process.env['PAYMENT_RECOVERY_STALE_THRESHOLD_SEC'] = '-60';
  process.env['ESCROW_RECONCILE_STALE_SEC'] = '-60';
});

const DB_CLOCK_ALLOWANCE_MS = 60_000;

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
vi.mock('../config/escrow-verification.runtime.js', async () => {
  const reg = await vi.importActual<typeof import('./helpers/escrow-sim-registry.js')>('./helpers/escrow-sim-registry.js');
  return { escrowConfigGate: (chainId: number) => reg.simGate(chainId), escrowVerificationSnapshot: () => [] };
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

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, parseUnits, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { JobStatus, SIM_ESCROW, FakeWallets } from './helpers/fake-escrow-chain.js';
import {
  bumped,
  candidateInput,
  CANCEL_GAS,
  FakeEvaluatorChain,
  FakeLeaseLock,
  planCapsFixture,
  type PreparedEvaluatorTx,
} from './helpers/fake-evaluator-chain.js';
import { setSimConfigUnverified, setSimDeps, setSimRepoll, simConfig, simGate, SIM_EVALUATOR } from './helpers/escrow-sim-registry.js';
import { InMemoryNonceStore } from '../services/transaction/wallet-lane.js';
import * as ledger from '../services/escrow/evaluator-ledger.js';
import type { Erc8183Deps, EscrowAlert, EscrowSettlementJobData } from '../services/job/escrow-erc8183.service.js';
import type { TransactionJobData } from '../queues/transaction.processor.js';

// ── Availability ─────────────────────────────────────────────────────────────

async function probe(): Promise<{ db: boolean; table: boolean }> {
  const client = new PrismaClient();
  try {
    await client.$queryRaw`SELECT "onChainStatus", "settleAttemptAt" FROM "Job" LIMIT 1`;
  } catch {
    await client.$disconnect().catch(() => undefined);
    return { db: false, table: false };
  }
  try {
    await client.$queryRaw`SELECT "txHash", "proofLevel" FROM "EvaluatorTransaction" LIMIT 1`;
    return { db: true, table: true };
  } catch {
    return { db: true, table: false };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

const AVAIL = await probe();
const SVC_PROBE = (await import('../services/job/escrow-erc8183.service.js')) as unknown as Record<string, unknown>;
const A1_READY = AVAIL.db && AVAIL.table && typeof SVC_PROBE['reconcileEvaluatorCandidates'] === 'function';
if (!AVAIL.db && process.env['CI']) throw new Error('evaluator-a1.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
if (!A1_READY) {
  console.warn(
    `[evaluator-a1.db.test] A1 core suite skipped — db=${AVAIL.db} table=${AVAIL.table} reconcileEvaluatorCandidates=${typeof SVC_PROBE['reconcileEvaluatorCandidates']}`,
  );
}
// CI migrates the database: a missing A1 table / export there must fail, not skip the A1 rows silently.
if (!A1_READY && process.env['CI']) throw new Error('evaluator-a1.db.test.ts: the A1 rows cannot run on CI (EvaluatorTransaction table or reconcileEvaluatorCandidates missing)');
const describeA1 = A1_READY ? describe : describe.skip;

// ── A1 integration points (ASSUMED names; the orchestrator fixes them HERE) ─────────────────────
//
// A-svc  `reconcileEvaluatorCandidates(deps, chainId)` (the contract writes `(chainId)`; every service
//        entry takes `deps` first).
// A-deps the new dependencies the service reads. Wired by `wireA1Deps` under several plausible names;
//        delete the ones the integration does not use.
// A-db   Prisma delegates `evaluatorTransaction`, `evaluatorRecoveryIncident`, `evaluatorChainState`.

interface A1Service {
  reconcileEvaluatorCandidates(deps: Erc8183Deps, chainId: number): Promise<unknown>;
}
interface CandidateRowDb {
  id: string;
  chainId: number;
  evaluator: string;
  nonce: number | null;
  jobId: string | null;
  kind: string;
  action: string;
  decision: string | null;
  calldataHash: string;
  txHash: string;
  rawTx: string | null;
  origin: string;
  status: string;
  proofLevel: string | null;
  replacesId: string | null;
  broadcastAt: Date | null;
  lastBroadcastAt: Date | null;
  answeredAt: Date | null;
  resolvedAt: Date | null;
  minedBlockHash: string | null;
  minedBlockNumber: string | null;
  sendError: string | null;
  createdAt: Date;
}
type Delegate = {
  findMany(args?: unknown): Promise<CandidateRowDb[]>;
  findFirst(args?: unknown): Promise<CandidateRowDb | null>;
  create(args: unknown): Promise<CandidateRowDb>;
  deleteMany(args?: unknown): Promise<{ count: number }>;
  update(args: unknown): Promise<CandidateRowDb>;
};
const LIVE = ['SIGNED', 'SENT', 'SEND_UNCONFIRMED'];

function a1(): A1Service {
  return m.svc as unknown as A1Service;
}
function table(name: 'evaluatorTransaction' | 'evaluatorRecoveryIncident' | 'evaluatorChainState'): Delegate {
  return (m.db as unknown as Record<string, Delegate>)[name]!;
}

/** Wires the A1 dependencies of the service to the fake chain (A-deps). */
function wireA1Deps(deps: Erc8183Deps, chain: FakeEvaluatorChain, lanes: FakeLeaseLock, opts: { proofTag?: 'latest' | 'safe' | bigint } = {}): void {
  // Final names (2026-10-22-a1-integracao.md): the runtime binds the proof tag into readNodeViews.
  const proofTag = opts.proofTag ?? 'safe';
  deps.readNodeViews = (chainId, evaluator, hashes) => chain.readNodeViews(chainId, evaluator, hashes, { proofTag });
  deps.evaluatorLanes = lanes;
  deps.lanes = lanes; // also the funding lane (LaneLock.run)
  deps.proofTag = proofTag;
  deps.recoveryCaps = () => null; // the worker never reads caps; null = none configured
  deps.isKnownTransaction = (chainId, hash) => chain.isKnown(chainId, hash);
}

// ── Modules under test ──────────────────────────────────────────────────────

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
};
let m: Modules;

const NAME_PREFIX = 'a1-f3-sim';
const CHAIN_ID = 84532;
const BUDGET = parseUnits('5', 6);
const START_USDC = parseUnits('1000', 6);
const FEE = (BUDGET * 30n) / 10_000n;
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  const jobs = await m.db.job.findMany({ where: { OR: [{ requester: agents }, { provider: agents }] }, select: { id: true } });
  const ids = jobs.map((j) => j.id);
  if (AVAIL.table) {
    // F1 order: candidates → incidents → chain state → Job (ON DELETE RESTRICT). This database is F3's own.
    await table('evaluatorTransaction').deleteMany({ where: { chainId: CHAIN_ID } });
    await table('evaluatorRecoveryIncident').deleteMany({ where: { chainId: CHAIN_ID } });
    await table('evaluatorChainState').deleteMany({ where: { chainId: CHAIN_ID } });
  }
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  await m.db.job.deleteMany({ where: { id: { in: ids } } });
  await m.db.agentIdentity.deleteMany({ where: { agent: agents } });
  const agentIds = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (agentIds.length) await m.db.dailyVolume.deleteMany({ where: { agentId: { in: agentIds } } });
  await m.db.agent.deleteMany({ where: agents });
}

// ── Harness (the C3c one, evaluator on FakeEvaluatorChain) ─────────────────────

interface QueuedTx {
  data: TransactionJobData;
  attempts: number;
  notBefore?: number;
}
interface QueuedSettlement {
  data: EscrowSettlementJobData;
  attempts: number;
  notBefore?: number;
}
interface Sim {
  chain: FakeEvaluatorChain;
  wallets: FakeWallets;
  deps: Erc8183Deps;
  lanes: FakeLeaseLock;
  alerts: EscrowAlert[];
  /** When set, `deps.alert` throws (a channel that refuses delivery). */
  alertFails: boolean;
  settlements: Map<string, QueuedSettlement>;
  now: () => Date;
  setNowOffset(ms: number): void;
  drive(maxRounds?: number): Promise<void>;
  agent(label: string): Promise<{ id: string; walletId: string; safeAddress: string }>;
  app(agentId: string): Promise<FastifyInstance>;
  /** A fresh deps object over the same DB/chain (a process restart: no in-memory state carried). */
  restart(): void;
}

let sim: Sim;
let seq = 0;
const RUN = Date.now().toString(36);

function makeSim(): Sim {
  const chain = new FakeEvaluatorChain({ evaluator: SIM_EVALUATOR, chainId: CHAIN_ID });
  const wallets = new FakeWallets();
  const alerts: EscrowAlert[] = [];
  const txQueue: QueuedTx[] = [];
  const settlements = new Map<string, QueuedSettlement>();
  const monitors: Promise<void>[] = [];
  let nowOffsetMs = 0;
  const lanes = new FakeLeaseLock({ now: () => Date.now() + nowOffsetMs });

  const s = {
    chain,
    wallets,
    alerts,
    alertFails: false,
    lanes,
    settlements,
    now: () => new Date(Date.now() + nowOffsetMs),
    setNowOffset: (ms: number) => {
      nowOffsetMs = ms;
    },
  } as unknown as Sim;

  const buildDeps = (): Erc8183Deps => {
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
          const key = `${data.action}-${data.jobId}`;
          if (!settlements.has(key)) settlements.set(key, { data, attempts: 0, ...(opts?.delayMs ? { notBefore: s.now().getTime() + opts.delayMs } : {}) });
        },
      },
      publicClient: () => chain.publicClient as never,
      evaluatorSigner: () => chain.signer() as never,
      config: simConfig,
      releaseJobEscrow: (jobId) => m.releaseJobEscrow(jobId),
      finalize: (params) => m.finalizeA2APaymentJob(params),
      logger: quietLogger,
      now: () => s.now(),
      alert: (alert) => {
        if (s.alertFails) throw new Error('alert channel refused the delivery');
        alerts.push(alert);
      },
      configGate: (chainId) => simGate(chainId),
    };
    wireA1Deps(deps, chain, lanes);
    return deps;
  };
  s.deps = buildDeps();
  s.restart = () => {
    (m.svc as { __resetEvaluatorBacklogForTests?: () => void }).__resetEvaluatorBacklogForTests?.();
    (m.svc as { __resetUnconfirmedSendsForTests?: () => void }).__resetUnconfirmedSendsForTests?.();
    s.deps = buildDeps();
    setSimDeps(s.deps);
  };

  const feeService = { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined };
  const submitter = new m.SubmitterService({
    wallet: wallets,
    lane: { run: (_k: string, fn: () => Promise<unknown>) => fn() } as never,
    nonces: new InMemoryNonceStore(),
    client: () => chain.rpcClient as never,
  });
  const realMonitor = new m.MonitorService(m.db, {
    getReceipt: async (_chainId, hash) => chain.getReceipt(hash),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const processorDeps = {
    db: m.db,
    submitter,
    monitor: { waitForConfirmation: (p: { txHash: Hex; chainId: number; transactionId: string }) => realMonitor.waitForConfirmation(p) },
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
      { olderThanMs: (o?.olderThanMs ?? 0) - DB_CLOCK_ALLOWANCE_MS, dropAfterMs: o?.dropAfterMs ?? 30 * 60_000, limit: 100 },
    ),
  );

  async function runTx(q: QueuedTx): Promise<void> {
    q.attempts++;
    const deferJob = async (delayMs: number) => {
      txQueue.push({ data: q.data, attempts: q.attempts - 1, notBefore: s.now().getTime() + delayMs });
    };
    try {
      await m.processor.processTransactionJob({ data: q.data, attemptsMade: q.attempts - 1, opts: { attempts: 3 } }, { ...processorDeps, deferJob });
    } catch (err) {
      if (q.attempts < 3) {
        txQueue.push(q);
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
    const key = `${q.data.action}-${q.data.jobId}`;
    try {
      await m.svc.processSettlementJob(s.deps, { data: q.data, attemptsMade: q.attempts - 1, opts: { attempts: 3 } });
    } catch (err) {
      if (err instanceof m.svc.EscrowConfigUnverifiedError) {
        if (!settlements.has(key)) settlements.set(key, { ...q, attempts: q.attempts - 1, notBefore: s.now().getTime() + err.retryAfterMs });
        return;
      }
      if (q.attempts < 3) {
        if (!settlements.has(key)) settlements.set(key, { ...q, notBefore: 0 });
        return;
      }
      await m.svc.handleFailedSettlementJob(s.deps, { data: q.data, attemptsMade: q.attempts, opts: { attempts: 3 } }, err as Error);
    }
  }

  s.drive = async (rounds?: number) => {
    const limit = rounds ?? 200;
    for (let round = 0; round < limit; round++) {
      const nowMs = s.now().getTime();
      const due = <T extends { notBefore?: number }>(q: T) => (q.notBefore ?? 0) <= nowMs;
      const txBatch = txQueue.filter(due);
      txQueue.splice(0, txQueue.length, ...txQueue.filter((q) => !due(q)));
      const settleBatch = [...settlements.entries()].filter(([, q]) => due(q));
      for (const [key] of settleBatch) settlements.delete(key);
      if (txBatch.length === 0 && settleBatch.length === 0) return;
      await Promise.all(txBatch.map(runTx));
      await Promise.all(monitors.splice(0));
      for (const [, q] of settleBatch) await runSettlement(q);
    }
    if (rounds === undefined) throw new Error('drive(): queues did not drain');
  };

  s.agent = async (label) => {
    const walletId = `${NAME_PREFIX}-${RUN}-${label}-${++seq}`;
    const safeAddress = wallets.create(walletId);
    chain.mintUsdc(safeAddress as Hex, START_USDC);
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

  setSimDeps(s.deps);
  return s;
}

// ── Scenario builders ───────────────────────────────────────────────────────

async function job(jobId: string) {
  return m.db.job.findUniqueOrThrow({ where: { id: jobId } });
}
function onChain(onChainJobId: string | null | undefined) {
  return sim.chain.jobs.get(BigInt(onChainJobId!))!;
}
async function postJob(requesterId: string, providerId: string): Promise<string> {
  const app = await sim.app(requesterId);
  const res = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { providerId, payload: { task: 'a1' }, reward: { amount: '5', token: 'USDC', chainId: CHAIN_ID } } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
async function patchJob(agentId: string, jobId: string, payload: Record<string, unknown>) {
  return (await sim.app(agentId)).inject({ method: 'PATCH', url: `/v1/jobs/${jobId}`, payload });
}
/** Requester + provider, funded and bound, delivered: PAYMENT_PENDING + SUBMITTED, the settle queued, not run. */
async function delivered() {
  const requester = await sim.agent('requester');
  const provider = await sim.agent('provider');
  const jobId = await postJob(requester.id, provider.id);
  await sim.drive();
  expect((await patchJob(provider.id, jobId, { status: 'ACCEPTED' })).statusCode).toBe(200);
  expect((await patchJob(provider.id, jobId, { status: 'COMPLETED', result: { answer: 42 } })).statusCode).toBe(200);
  await sim.drive(1);
  expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
  return { requester, provider, jobId };
}
const contestAs = async (requesterId: string, jobId: string) =>
  (await sim.app(requesterId)).inject({ method: 'POST', url: `/v1/jobs/${jobId}/contest`, payload: { reason: 'a1' } });
const decide = (jobId: string, decision: 'pay' | 'refund' | 'quality-rejected' | 'payout-blocked') =>
  m.svc.resolveEscrowJob(sim.deps, { jobId, decision, note: `a1 ${decision}`, operator: 'ops@test' });
const settleOnce = (jobId: string, attemptsMade = 0) =>
  m.svc.processSettlementJob(sim.deps, { data: { jobId, action: 'settle' }, attemptsMade, opts: { attempts: 3 } });
const sweep = () => m.svc.processSettlementJob(sim.deps, { data: { jobId: '*', action: 'sweep' }, attemptsMade: 0, opts: { attempts: 3 } });
const reconcile = () => a1().reconcileEvaluatorCandidates(sim.deps, CHAIN_ID);
const alertsOf = (kind: string, jobId?: string) => sim.alerts.filter((a) => a.kind === (kind as EscrowAlert['kind']) && (jobId === undefined || a.jobId === jobId));
const sameHash = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

async function candidates(jobId: string): Promise<CandidateRowDb[]> {
  return table('evaluatorTransaction').findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } });
}
async function atNonce(nonce: number): Promise<CandidateRowDb[]> {
  return table('evaluatorTransaction').findMany({ where: { chainId: CHAIN_ID, nonce }, orderBy: { createdAt: 'asc' } });
}
function byHash(rows: CandidateRowDb[], hash: string): CandidateRowDb {
  const row = rows.find((r) => sameHash(r.txHash, hash));
  if (!row) throw new Error(`no candidate ${hash} among ${rows.map((r) => r.txHash).join(', ')}`);
  return row;
}

/** The job's settle sent and kept pending (stuck by price: base fee raised above its maxFeePerGas). */
async function stuckHead(): Promise<{ requester: { id: string; safeAddress: string }; provider: { id: string; safeAddress: string }; jobId: string; head: PreparedEvaluatorTx }> {
  const d = await delivered();
  const before = sim.chain.signed.size;
  sim.chain.holdEvaluatorTx = () => true;
  await sim.drive(); // 3 attempts: the first sends, the next two see a live candidate and sign nothing; handed back
  const head = [...sim.chain.signed.values()].slice(before).find((t) => t.functionName === 'complete')!;
  expect(head).toBeDefined();
  // From here the head is stuck by price, as in production: the hold is replaced by a base fee above its cap.
  sim.chain.holdEvaluatorTx = null;
  sim.chain.baseFee = head.maxFeePerGas + 1n;
  const prepared: PreparedEvaluatorTx = { ...head, value: head.value, chainId: CHAIN_ID, from: getAddress(SIM_EVALUATOR) } as PreparedEvaluatorTx;
  return { ...d, head: prepared };
}

/**
 * What the recovery script does in its critical section (§8.4), without the CLI: sign the speed-up
 * (same calldata, bumped fees) or the cancel, insert the candidate (SCRIPT) with the job stamp through
 * F1's ledger, then send the raw bytes. Used until `runEvaluatorRecovery` exists (TODO(A1-CLI)).
 */
/** Opens (or reuses) the recovery incident and inserts a SCRIPT candidate with the job stamp through F1's ledger (plan caps as TEST values). */
async function scriptInsert(
  tx: PreparedEvaluatorTx,
  jobId: string,
  meta: { kind: 'SPEED_UP' | 'CANCEL'; action: 'COMPLETE' | 'REJECT' | 'CLAIM_REFUND' | 'CANCEL_NOOP'; decision: string | null; replacesId: string; setSettleTxHash: boolean },
): Promise<{ id: string; inserted: boolean }> {
  const { incident } = await ledger.openIncident(m.db, { chainId: CHAIN_ID, evaluator: getAddress(SIM_EVALUATOR), headNonce: tx.nonce, openedBy: 'f3-test' });
  return ledger.insertCandidateWithJobStamp(m.db, {
    candidate: candidateInput(tx, { jobId, kind: meta.kind, action: meta.action, origin: 'SCRIPT', decision: meta.decision, replacesId: meta.replacesId, operator: 'f3-test', note: `row test ${meta.kind}`, incidentId: incident.id }),
    job: { id: jobId, expectedSettleTxHash: (await job(jobId)).settleTxHash, setSettleTxHash: meta.setSettleTxHash, stampAttempt: true },
    budget: { caps: planCapsFixture(), incidentId: incident.id, balanceWei: 10n ** 18n },
    // P9 counts every row of the nonce (the worker's original too): act past the 60-s interval. Row 38 itself is F1's ledger test.
    now: new Date(Date.now() + 61_000),
  });
}

async function scriptReplace(head: PreparedEvaluatorTx, op: 'speed-up' | 'cancel', jobId: string): Promise<PreparedEvaluatorTx> {
  const fees = bumped(head);
  const tx =
    op === 'speed-up'
      ? await sim.chain.signFields({ to: head.to, data: head.data, nonce: head.nonce, gas: head.gas, ...fees })
      : await sim.chain.signFields({ to: getAddress(SIM_EVALUATOR), data: '0x', nonce: head.nonce, gas: CANCEL_GAS, ...fees });
  const prev = byHash(await candidates(jobId), head.hash);
  const { id } = await scriptInsert(tx, jobId, {
    kind: op === 'speed-up' ? 'SPEED_UP' : 'CANCEL',
    action: op === 'speed-up' ? (prev.action as 'COMPLETE') : 'CANCEL_NOOP',
    decision: op === 'speed-up' ? prev.decision : 'cancelled',
    replacesId: prev.id,
    setSettleTxHash: op === 'speed-up',
  });
  // The script sends; nothing mines until the test mines a block (automine would decide the race for it).
  const auto = sim.chain.evaluatorAutoMine;
  sim.chain.evaluatorAutoMine = false;
  try {
    await sim.chain.acceptRaw(tx.raw);
  } finally {
    sim.chain.evaluatorAutoMine = auto;
  }
  // §8.4-3.7 / §2.4-2: the answer is recorded and the attempt stamp cleared (the table is the gate now).
  await ledger.markAnswered(m.db, id, 'SENT');
  await m.db.job.updateMany({ where: { id: jobId, settleAttemptAt: { not: null } }, data: { settleAttemptAt: null } });
  return tx;
}

async function loadModules(): Promise<void> {
  if (m) return;
  const [dbMod, jobsMod, handlerMod, svc, processor, submitterMod, monitorMod, escrowMod, finalizerMod, recoveryMod] = await Promise.all([
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
  };
}

// ══ 1. self-check of the fake (always runs) ═════════════════════════════════

describe('fake-evaluator-chain self-check (no DB)', () => {
  const ESCROW_DATA = '0x' as Hex;
  function fresh() {
    const c = new FakeEvaluatorChain({ evaluator: SIM_EVALUATOR, chainId: CHAIN_ID, nodes: ['a', 'b', 'c'] });
    c.evaluatorAutoMine = false;
    return c;
  }

  it('signing is deterministic; an identical rebroadcast is "already known"; a +10 % replacement is accepted, less is underpriced', async () => {
    const c = fresh();
    const base = { to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n };
    const a = await c.signFields(base);
    const again = await c.signFields(base);
    expect(again.hash).toBe(a.hash);
    expect(again.raw).toBe(a.raw);
    await c.acceptRaw(a.raw);
    await expect(c.acceptRaw(a.raw)).rejects.toThrow('already known');
    const weak = await c.signFields({ ...base, maxFeePerGas: 10_500_000n, maxPriorityFeePerGas: 1_050_000n });
    await expect(c.acceptRaw(weak.raw)).rejects.toThrow('replacement transaction underpriced');
    const strong = await c.signFields({ ...base, ...bumped(base) });
    await c.acceptRaw(strong.raw);
    expect(c.isPending(a.hash)).toBe(false);
    expect(c.isPending(strong.hash)).toBe(true);
    c.mineBlock();
    expect(c.minedInNonce(0)).toBe(strong.hash);
    await expect(c.acceptRaw(a.raw)).rejects.toThrow(/nonce too low/);
  });

  it('a transaction priced below the base fee stays pending while blocks are produced (geth); pending > latest', async () => {
    const c = fresh();
    const tx = await c.signFields({ to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 6_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await c.acceptRaw(tx.raw);
    c.baseFee = 7_000_000n;
    c.mineBlocks(5);
    expect(c.isPending(tx.hash)).toBe(true);
    expect(c.nonceAt('latest')).toBe(0);
    expect(c.nonceAt('pending')).toBe(1);
    c.baseFee = 5_000_000n;
    c.mineBlock();
    expect(c.minedInNonce(0)).toBe(tx.hash);
  });

  it('per-node views: an erroring node is ok:false, a lagging node sees an older latest, an unpropagated hash is unknown to one node', async () => {
    const c = fresh();
    c.propagation = () => ['b'];
    const tx = await c.signFields({ to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await c.acceptRaw(tx.raw);
    c.node('c').error = 'HTTP 503';
    let views = await c.readNodeViews(CHAIN_ID, SIM_EVALUATOR, [tx.hash], { proofTag: 'latest' });
    expect(views.map((v) => [v.node, v.ok, v.known?.[tx.hash.toLowerCase() as Hex]])).toEqual([
      ['a', true, true],
      ['b', true, false],
      ['c', false, undefined],
    ]);
    await expect(c.isKnown(CHAIN_ID, tx.hash)).resolves.toBe(true);
    c.node('a').unknown.add(tx.hash);
    await expect(c.isKnown(CHAIN_ID, tx.hash)).rejects.toThrow(); // none knows it and one errored: cannot tell
    c.node('c').error = null;
    c.node('c').latestLag = 1;
    c.mineBlock();
    views = await c.readNodeViews(CHAIN_ID, SIM_EVALUATOR, [tx.hash], { proofTag: 'latest' });
    expect(views.map((v) => v.nonceLatest)).toEqual([1, 1, 0]);
    expect(views[2]!.receipts?.[tx.hash.toLowerCase() as Hex]).toBeNull();
    expect(views[0]!.receipts?.[tx.hash.toLowerCase() as Hex]).toMatchObject({ status: 'success', logs: [] });
    const f1 = await c.nodeViews([tx.hash], { proofTag: 'latest' });
    expect(f1[0]!.receipts?.[tx.hash.toLowerCase()]).toMatchObject({ status: 'success', logsForJob: { completed: false, rejected: false, expired: false } });
    expect(f1[0]!.nonceProof).toBe(f1[0]!.nonceAtTag);
  });

  it('proof tag: safe trails latest by proofDepth or sits where safeHead is set (stall)', async () => {
    const c = fresh();
    c.proofDepth = 3;
    const tx = await c.signFields({ to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await c.acceptRaw(tx.raw);
    c.mineBlock();
    expect([c.nonceAt('latest'), c.nonceAt('safe')]).toEqual([1, 0]);
    c.mineBlocks(3);
    expect(c.nonceAt('safe')).toBe(1);
    c.safeHead = c.head - 10n; // stalled
    c.mineBlocks(20);
    expect(c.nonceAt('safe')).toBe(0);
  });

  it('reorg: the mined transaction loses its receipt, comes back pending, re-mines with a NEW block hash', async () => {
    const c = fresh();
    const tx = await c.signFields({ to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await c.acceptRaw(tx.raw);
    c.mineBlock();
    const first = c.minedInfo(tx.hash)!;
    c.reorg(1);
    expect(c.minedInfo(tx.hash)).toBeNull();
    expect(c.isPending(tx.hash)).toBe(true);
    expect(c.nonceAt('latest')).toBe(0);
    c.mineBlock();
    expect(c.minedInfo(tx.hash)!.blockHash).not.toBe(first.blockHash);
  });

  it('waitForOwnReceipt follows a same-nonce replacement like viem (replacedReason), never as the own receipt', async () => {
    const c = fresh();
    const base = { to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n };
    const a = await c.signFields(base);
    await c.acceptRaw(a.raw);
    const b = await c.signFields({ ...base, ...bumped(base) });
    await c.acceptRaw(b.raw);
    c.mineBlock();
    const receipt = await c.signer().waitForTransactionReceipt(a.hash);
    expect(receipt.transactionHash).toBe(b.hash);
    expect(receipt.replacedReason).toBe('cancelled');
  });

  it('a lagging-pending node gives the signer a nonce already taken; chooseNonce raises it (R2-P2-3 shape)', async () => {
    const c = fresh();
    const first = await c.signFields({ to: getAddress(SIM_EVALUATOR), data: ESCROW_DATA, nonce: 0, gas: CANCEL_GAS, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await c.acceptRaw(first.raw);
    c.node('a').blindPending = true;
    expect(c.nonceAt('pending', c.node('a'))).toBe(0);
    expect(c.nonceAt('pending', c.node('b'))).toBe(1);
  });

  it('lease: assertHeld fails once stolen or below the margin', async () => {
    let now = 0;
    const lock = new FakeLeaseLock({ ttlMs: 120_000, now: () => now });
    const lease = await lock.acquire('k');
    await lease.assertHeld(30_000);
    now = 95_000;
    await expect(lease.assertHeld(30_000)).rejects.toMatchObject({ name: 'LeaseLostError', reason: 'margin' });
    now = 0;
    lock.steal('k');
    await expect(lease.assertHeld(0)).rejects.toMatchObject({ name: 'LeaseLostError', reason: 'not-held' });
  });

  it('caps fixture carries every plan parameter as a TEST value (never a code default)', () => {
    expect(Object.keys(planCapsFixture()).sort()).toEqual(
      [
        'bumpBps',
        'l1MarginWei',
        'maxCost24hWei',
        'maxCostPerIncidentWei',
        'maxCostPerTxWei',
        'maxFeePerGasWei',
        'maxGasLimit',
        'maxNoncesPerPlan',
        'maxPriorityFeePerGasWei',
        'maxReplacementsPerNonce',
        'minIntervalMs',
        'minPriorityFeePerGasWei',
        'multipliers',
        'relativeBaseMultiplier',
        'reserveWei',
      ].sort(),
    );
  });
});

// ══ 1b. harness smoke (Postgres up; runs on the pre-A1 code too) ═══════════════════

describe.runIf(AVAIL.db)('harness smoke — the C3c harness on FakeEvaluatorChain (Postgres)', () => {
  beforeAll(async () => {
    await loadModules();
    await wipe();
  });
  beforeEach(async () => {
    await wipe();
    m.svc.__resetEscrowTokenCacheForTests();
    setSimConfigUnverified(null);
    sim = makeSim();
  });
  afterAll(async () => {
    if (!m) return;
    await wipe();
    setSimDeps(null);
    setSimRepoll(null);
  });

  it('baseline: delivered → the settle signs a raw complete, it mines, the provider is paid once', async () => {
    const { provider, jobId } = await delivered();
    await sim.drive();
    const done = await job(jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', reservationStatus: 'RELEASED', feedbackStatus: 'written', platformFeeAmount: FEE.toString() });
    expect(sim.chain.minedInNonce(0)).toBe(done.settleTxHash);
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  it('C3h D2 on this fake: a cancel mined during the receipt wait is not read as the outcome (evaluator-replaced); the retry pays', async () => {
    const { provider, jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.onReceiptWait = async (hash) => {
      const own = sim.chain.signed.get(hash)!;
      const cancel = await sim.chain.signFields({ to: getAddress(SIM_EVALUATOR), data: '0x', nonce: own.nonce, gas: CANCEL_GAS, ...bumped(own) });
      await sim.chain.acceptRaw(cancel.raw);
      sim.chain.mineBlock();
      sim.chain.evaluatorAutoMine = true;
    };
    await sim.drive();
    expect(alertsOf('evaluator-replaced', jobId)).toHaveLength(1);
    const done = await job(jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.minedInNonce(1)).toBe(done.settleTxHash);
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });
});

// ══ 2. A1 core (worker, reconciliation, gate, lane) ══════════════════════════

describeA1('A1 core — candidates, reconciliation, gate, lane (Postgres + fake multi-node chain)', () => {
  beforeAll(async () => {
    await loadModules();
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    m.svc.__resetEscrowTokenCacheForTests();
    (m.svc as { __resetEvaluatorBacklogForTests?: () => void }).__resetEvaluatorBacklogForTests?.();
    setSimConfigUnverified(null);
    sim = makeSim();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    setSimDeps(null);
    setSimRepoll(null);
    await m.db.$disconnect();
  });

  // ── persistence (spec §2.4) ────────────────────────────────────────────────

  it('§2.4: the worker records its candidate SIGNED before the first byte is sent, in the job-stamp transaction; SENT after the answer; MINED_SUCCESS after reconciliation', async () => {
    const { provider, jobId } = await delivered();
    let seenAtSend: CandidateRowDb[] = [];
    sim.chain.beforeSend = async () => {
      seenAtSend = await candidates(jobId);
    };
    await sim.drive();
    expect(seenAtSend).toHaveLength(1);
    expect(seenAtSend[0]).toMatchObject({ status: 'SIGNED', kind: 'ORIGINAL', action: 'COMPLETE', origin: 'WORKER', nonce: 0 }); // broadcastAt is stamped in the hook (markBroadcast), right before the send
    expect(seenAtSend[0]!.rawTx).toMatch(/^0x/);
    await reconcile();
    const [row] = await candidates(jobId);
    expect(row).toMatchObject({ status: 'MINED_SUCCESS' });
    expect(row!.answeredAt).not.toBeNull();
    expect(sameHash((await job(jobId)).settleTxHash, row!.txHash)).toBe(true);
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  // ── rows 1–3 (DB side; the script itself: block 3) ─────────────────────────

  it('row 1: speed-up of the stuck head mines (N+1 behind it): original DEAD with proof, speed-up MINED_SUCCESS; the job follows the speed-up (settleTxHash, fee, feedback); paid once, reservation released once', async () => {
    const a = await stuckHead();
    const b = await delivered();
    await sim.drive(); // B queues behind A in nonce 1
    const speed = await scriptReplace(a.head, 'speed-up', a.jobId);
    sim.chain.mineBlock();
    sim.chain.mineBlock();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();

    const rows = await atNonce(0);
    expect(byHash(rows, a.head.hash)).toMatchObject({ status: 'DEAD' });
    expect(byHash(rows, speed.hash)).toMatchObject({ status: 'MINED_SUCCESS', kind: 'SPEED_UP', origin: 'SCRIPT' });
    expect(byHash(rows, speed.hash).calldataHash).toBe(byHash(rows, a.head.hash).calldataHash);
    const done = await job(a.jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', reservationStatus: 'RELEASED', feedbackStatus: 'written', platformFeeAmount: FEE.toString() });
    expect(sameHash(done.settleTxHash, speed.hash)).toBe(true);
    expect(sim.chain.usdcOf(a.provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
    expect(await job(b.jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.evaluatorCalls.filter((c) => c.functionName === 'complete' && c.jobId === BigInt(done.onChainJobId!))).toHaveLength(1);
  });

  it('row 2: the original mines after the speed-up was signed and recorded: the speed-up send fails "nonce too low" and is DEAD with the original\'s receipt as proof; the DB follows the original', async () => {
    const a = await stuckHead();
    const fees = bumped(a.head);
    const speed = await sim.chain.signFields({ to: a.head.to, data: a.head.data, nonce: a.head.nonce, gas: a.head.gas, ...fees });
    // The original mines first (base fee back down), then the recorded speed-up reaches the node.
    sim.chain.baseFee = a.head.maxFeePerGas;
    sim.chain.mineBlock();
    const prev = byHash(await candidates(a.jobId), a.head.hash);
    await scriptInsert(speed, a.jobId, { kind: 'SPEED_UP', action: 'COMPLETE', decision: prev.decision, replacesId: prev.id, setSettleTxHash: true });
    await expect(sim.chain.acceptRaw(speed.raw)).rejects.toThrow(/nonce too low/);
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();
    const rows = await atNonce(0);
    expect(byHash(rows, a.head.hash)).toMatchObject({ status: 'MINED_SUCCESS' });
    expect(byHash(rows, speed.hash)).toMatchObject({ status: 'DEAD' });
    const done = await job(a.jobId);
    expect(sameHash(done.settleTxHash, a.head.hash)).toBe(true);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
  });

  it('row 3: a cancel of the head mines — the job stays Submitted; candidates DEAD only after proof; the gate reopens; the recovery re-signs the SAME decision in a new nonce; one payment', async () => {
    const a = await stuckHead();
    const cancel = await scriptReplace(a.head, 'cancel', a.jobId);
    // Before any block: both alive, the gate refuses.
    expect((await contestAs(a.requester.id, a.jobId)).statusCode).toBe(409);
    sim.chain.mineBlock();
    expect(onChain((await job(a.jobId)).onChainJobId).status).toBe(JobStatus.Submitted);
    // latest proves the cancel for "re-sign the same decision"; contest waits for the proof tag (safe).
    sim.chain.proofDepth = 5;
    await reconcile();
    const rows = await atNonce(0);
    expect(byHash(rows, cancel.hash)).toMatchObject({ status: 'MINED_SUCCESS', kind: 'CANCEL' });
    expect(byHash(rows, a.head.hash).status).toBe('DEAD');
    expect(byHash(rows, a.head.hash).proofLevel).toBe('latest');
    expect((await contestAs(a.requester.id, a.jobId)).statusCode).toBe(409); // not yet at the proof tag
    sim.chain.mineBlocks(5);
    await reconcile();
    expect(byHash(await atNonce(0), a.head.hash).proofLevel).toBe('proof');
    // The recovery re-signs the recorded decision (pay) in nonce 1; no second payment.
    sim.chain.baseFee = 5_000_000n;
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();
    const resigned = (await candidates(a.jobId)).filter((r) => r.nonce === 1);
    expect(resigned).toHaveLength(1);
    expect(resigned[0]).toMatchObject({ kind: 'ORIGINAL', action: 'COMPLETE', status: 'MINED_SUCCESS' });
    expect(resigned[0]!.calldataHash).toBe(byHash(rows, a.head.hash).calldataHash);
    expect(await job(a.jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(a.provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  // ── row 4 ────────────────────────────────────────────────────────────────────

  it('row 4: an external transaction (same key, outside the backend) consumes N: candidates of N DEAD, EXTERNAL recorded by RECONCILE (binary search), one evaluator-nonce-foreign alert', async () => {
    const a = await stuckHead();
    const foreign = await sim.chain.signFields({ to: getAddress(SIM_EVALUATOR), data: '0x', nonce: 0, gas: CANCEL_GAS, ...bumped(a.head) });
    await sim.chain.acceptRaw(foreign.raw);
    sim.chain.mineBlocks(3);
    await reconcile();
    const rows = await atNonce(0);
    expect(byHash(rows, a.head.hash).status).toBe('DEAD');
    expect(byHash(rows, foreign.hash)).toMatchObject({ kind: 'EXTERNAL', origin: 'RECONCILE', jobId: null });
    expect(alertsOf('evaluator-nonce-foreign')).toHaveLength(1);
    expect(JSON.stringify(alertsOf('evaluator-nonce-foreign')[0])).toContain(foreign.hash.toLowerCase().slice(0, 10));
    await reconcile();
    expect(alertsOf('evaluator-nonce-foreign')).toHaveLength(1); // not repeated per tick
    expect((await atNonce(0)).filter((r) => r.kind === 'EXTERNAL')).toHaveLength(1); // idempotent
  });

  // ── rows 5–7: crash / restart / lost answers ──────────────────────────────

  it('row 5: crash after the SIGNED insert and before the send — SIGNED stays alive; contest 409, resolve refused, no second decision; the identical rebroadcast (or the next tx) consumes N', async () => {
    const { requester, provider, jobId } = await delivered();
    sim.chain.beforeSend = async () => {
      throw new Error('worker process killed (after the insert, before the send)');
    };
    await sim.drive(1);
    sim.settlements.clear(); // the process died: its BullMQ job is stalled
    sim.restart();
    const [row] = await candidates(jobId);
    // A11: the service cannot tell this crash from a failed send; either live status is acceptable, never SENT.
    expect(['SIGNED', 'SEND_UNCONFIRMED']).toContain(row!.status);
    expect(sim.chain.evaluatorSends).toHaveLength(0);
    expect((await contestAs(requester.id, jobId)).statusCode).toBe(409);
    expect(await decide(jobId, 'refund')).toMatchObject({ outcome: 'refused', code: 'SETTLEMENT_IN_PROGRESS' });
    await expect(settleOnce(jobId)).rejects.toThrow(); // SettlementStillPendingError: nothing signed
    expect(sim.chain.signed.size).toBe(1);
    // The restart pass: head, unique live candidate, unknown to every node, simulation ok → identical rebroadcast.
    await reconcile();
    const accepted = sim.chain.evaluatorSends.filter((s) => s.outcome === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(sameHash(accepted[0]!.hash, row!.txHash)).toBe(true); // the same bytes, no new signature
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  it('row 6: crash after the send and before the answer — the restart pass finds it on a node → SENT; it mines; reconciled with that receipt\'s fee', async () => {
    const { provider, jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.afterAccept = async () => {
      throw new Error('worker process killed (after the send, before the answer)');
    };
    await sim.drive(1);
    sim.settlements.clear();
    sim.restart();
    const [row] = await candidates(jobId);
    // resolveFailedSend already asked the nodes (one knows it) → SENT before the restart; either way never DEAD.
    expect(['SIGNED', 'SENT']).toContain(row!.status);
    await reconcile();
    expect((await candidates(jobId))[0]).toMatchObject({ status: 'SENT' });
    sim.chain.mineBlock();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    const done = await job(jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString(), feedbackStatus: 'written' });
    expect(sameHash(done.settleTxHash, row!.txHash)).toBe(true);
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  it('row 7: lost answer + a false "not found", restart in between — the re-ask after restart reads the table (SEND_UNCONFIRMED) and re-adopts; no second complete', async () => {
    const { provider, jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.loseAnswer = () => true;
    sim.chain.propagation = () => sim.chain.nodes.map((n) => n.name); // nobody has it YET
    await sim.drive(1);
    sim.chain.loseAnswer = null;
    const [row] = await candidates(jobId);
    expect(row!.status).toBe('SEND_UNCONFIRMED');
    sim.restart(); // the in-memory `unconfirmedSends` of C3f is gone
    for (const n of sim.chain.nodes) n.unknown.clear(); // propagated now
    await sim.drive();
    expect(sim.chain.signed.size).toBe(1); // no second complete signed
    sim.chain.mineBlock();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  /**
   * Spec §7.3 (R1) expected a second decision at N+1 here (the proposal-C residual). Under R2-P1-3 a
   * live SEND_UNCONFIRMED candidate of the job blocks any re-signature of it, so the residual cannot
   * arise from the job's own retries: the identical rebroadcast answers "already known" → SENT.
   * Matrix note, ambiguity A6: if the orchestrator keeps the R1 reading, flip the two marked asserts.
   */
  it('row 7 (variant): "not found" twice while the node\'s pending already counts it (N+1) — under R2 no second decision is signed; the rebroadcast is "already known" → SENT; one payment, no revert', async () => {
    const { requester, provider, jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.loseAnswer = () => true;
    sim.chain.propagation = () => sim.chain.nodes.map((n) => n.name); // every node: false "not found", pending counts it
    await sim.drive(1);
    sim.chain.loseAnswer = null;
    expect((await candidates(jobId))[0]!.status).toBe('SEND_UNCONFIRMED');
    sim.restart();
    await sim.drive(); // the retries: refused by the live candidate (A6: R1 reading → a second row at nonce 1)
    expect(await candidates(jobId)).toHaveLength(1); // A6
    expect(sim.chain.signed.size).toBe(1); // A6
    expect((await contestAs(requester.id, jobId)).statusCode).toBe(409);
    await reconcile(); // rebroadcast of the same bytes → "already known" → SENT
    expect(sim.chain.evaluatorSends.filter((s) => s.outcome === 'already-known')).toHaveLength(1);
    expect((await candidates(jobId))[0]!.status).toBe('SENT');
    sim.chain.mineBlock();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    const done = await job(jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString(), feedbackStatus: 'written' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
    expect((await candidates(jobId)).filter((r) => r.status === 'MINED_REVERTED')).toHaveLength(0);
  });

  // ── row 9 (worker side), row 30 ────────────────────────────────────────────

  it('row 9: the worker retries during a recovery — job X: SettlementStillPendingError, nothing signed; job Y signs at the next nonce inside the lane, no collision', async () => {
    const x = await stuckHead();
    const before = sim.chain.signed.size;
    await expect(settleOnce(x.jobId)).rejects.toThrow();
    expect(sim.chain.signed.size).toBe(before);
    const y = await delivered();
    await sim.drive(1);
    const yRows = await candidates(y.jobId);
    expect(yRows).toHaveLength(1);
    expect(yRows[0]!.nonce).toBe(1);
    expect(sim.lanes.acquired.filter((k) => k.toLowerCase().includes(SIM_EVALUATOR.toLowerCase())).length).toBeGreaterThan(0);
    expect(sim.chain.leaseChecks.length).toBeGreaterThan(0); // assertHeld right before each send
  });

  it('row 30: two workers, a node lagging on pending — the nonce is max(live)+1; no candidate of another job is replaced', async () => {
    const x = await stuckHead();
    const y = await delivered();
    sim.chain.node('node-a').blindPending = true; // the signer's node says pending = latest = 0 (X's nonce)
    // Two settlement workers (API + worker) take Y and a retry at once.
    await Promise.allSettled([settleOnce(y.jobId), settleOnce(y.jobId, 1)]);
    const yRows = await candidates(y.jobId);
    expect(yRows.length).toBeGreaterThanOrEqual(1);
    expect(yRows.every((r) => r.nonce === 1)).toBe(true);
    expect(new Set(yRows.map((r) => r.calldataHash)).size).toBe(1);
    expect(sim.chain.isPending(x.head.hash)).toBe(true); // X's candidate not replaced
    expect(sim.chain.rejectedBroadcasts.filter((r) => r.includes('underpriced'))).toHaveLength(0);
  });

  // ── row 10 ─────────────────────────────────────────────────────────────────

  it('row 10: contest and resolve during the uncertainty → 409 / SETTLEMENT_IN_PROGRESS; unreadable node → 503 / unverifiable; after the proof → contest 200', async () => {
    const { requester, jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.refuseSend = () => 'replacement transaction underpriced'; // refused at send…
    sim.chain.propagation = null;
    // All attempts: the first is refused, the next ones see the live candidate; the failed handler hands the job back (SUBMITTED).
    await sim.drive();
    sim.chain.refuseSend = null;
    expect(await job(jobId)).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
    // …the P3-3 interval: every node says "not found" → SEND_UNCONFIRMED, still a live candidate.
    expect((await candidates(jobId))[0]!.status).toBe('SEND_UNCONFIRMED');
    const res = await contestAs(requester.id, jobId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'CONTEST_NOT_ALLOWED' });
    expect(await decide(jobId, 'refund')).toMatchObject({ outcome: 'refused' });
    sim.chain.node('node-b').error = 'HTTP 502';
    expect((await contestAs(requester.id, jobId)).statusCode).toBe(503);
    sim.chain.node('node-b').error = null;
    // The worker's identical rebroadcast (row 28) mines it: the decision happens, the DB follows.
    await reconcile();
    sim.chain.mineBlock();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(alertsOf('review-overridden', jobId)).toHaveLength(0); // no contest was accepted that the chain overrode
  });

  it('row 10 (P3-3 flips): the contest in the interval of a send nobody knows gets 409 "may still mine"; after the nonce is consumed by a cancel at the proof tag, the contest is 200', async () => {
    const a = await stuckHead();
    sim.settlements.clear();
    const res = await contestAs(a.requester.id, a.jobId);
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toMatch(/may still mine|nonce/i);
    await scriptReplace(a.head, 'cancel', a.jobId);
    sim.chain.mineBlock();
    await reconcile();
    sim.settlements.clear();
    expect((await contestAs(a.requester.id, a.jobId)).statusCode).toBe(200);
  });

  // ── row 11 / 22–24: expiry while stuck, "pay" holds ───────────────────────

  it('row 11: expiresAt passes while stuck — the sweep holds the delivery (no claimRefund of its own); the speed-up still settles (complete on Submitted after expiredAt)', async () => {
    const a = await stuckHead();
    const j = await job(a.jobId);
    sim.setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
    sim.chain.time = onChain(j.onChainJobId).expiredAt + 1n;
    await sweep();
    await sim.drive();
    expect(sim.chain.evaluatorCalls.filter((c) => c.functionName === 'claimRefund')).toHaveLength(0);
    expect([...sim.chain.signed.values()].filter((t) => t.functionName === 'claimRefund')).toHaveLength(0);
    await scriptReplace(a.head, 'speed-up', a.jobId);
    sim.chain.mineBlock();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(a.jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
  });

  it('row 22: contest → resolve "pay" → key stuck → past expiry → sweep: no claimRefund signed by the evaluator; delivery-held (R2-a: the review-expiring alert may have pre-empted it)', async () => {
    const { requester, jobId } = await delivered();
    sim.settlements.clear();
    expect((await contestAs(requester.id, jobId)).statusCode).toBe(200);
    sim.chain.holdEvaluatorTx = () => true;
    expect(await decide(jobId, 'pay')).toMatchObject({ outcome: 'scheduled' });
    await sim.drive();
    sim.setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
    sim.chain.time = onChain((await job(jobId)).onChainJobId).expiredAt + 1n;
    await sweep();
    await sim.drive();
    await sweep();
    expect([...sim.chain.signed.values()].filter((t) => t.functionName === 'claimRefund')).toHaveLength(0);
    expect(await job(jobId)).toMatchObject({ resolution: 'pay' });
    expect(alertsOf('delivery-held', jobId).length + alertsOf('review-expiring', jobId).length).toBeGreaterThanOrEqual(1);
    expect(alertsOf('delivery-held', jobId).length).toBeLessThanOrEqual(1);
  });

  it('row 23: as row 22 with the "pay" candidate DEAD by a cancel — no backend claimRefund; the "pay" is re-signed in a new nonce; alerted', async () => {
    const { requester, provider, jobId } = await delivered();
    sim.settlements.clear();
    expect((await contestAs(requester.id, jobId)).statusCode).toBe(200);
    sim.chain.holdEvaluatorTx = () => true;
    await decide(jobId, 'pay');
    await sim.drive();
    const head = [...sim.chain.signed.values()].find((t) => t.functionName === 'complete')!;
    sim.chain.holdEvaluatorTx = null;
    sim.chain.baseFee = head.maxFeePerGas + 1n;
    await scriptReplace({ ...head, chainId: CHAIN_ID, from: getAddress(SIM_EVALUATOR) }, 'cancel', jobId);
    sim.chain.mineBlocks(2);
    await reconcile();
    sim.setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
    sim.chain.time = onChain((await job(jobId)).onChainJobId).expiredAt + 1n;
    sim.chain.baseFee = 5_000_000n;
    await sweep();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();
    expect([...sim.chain.signed.values()].filter((t) => t.functionName === 'claimRefund')).toHaveLength(0);
    const completes = (await candidates(jobId)).filter((r) => r.action === 'COMPLETE');
    expect(completes.map((r) => r.nonce)).toEqual([0, 1]);
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  it('row 24: a CANCELLED job Submitted on-chain with "pay" recorded, past expiry — no claimRefund by the backend (D1 preserved under A1)', async () => {
    const { requester, provider, jobId } = await delivered();
    sim.settlements.clear();
    await m.db.job.update({ where: { id: jobId }, data: { status: 'ACCEPTED', onChainStatus: 'FUNDED' } });
    expect((await patchJob(requester.id, jobId, { status: 'CANCELLED' })).statusCode).toBe(200);
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'CANCELLED', onChainStatus: 'SUBMITTED' });
    sim.chain.blockedPayees.add(provider.safeAddress.toLowerCase());
    await decide(jobId, 'pay');
    await sim.drive();
    sim.setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
    sim.chain.time = onChain((await job(jobId)).onChainJobId).expiredAt + 1n;
    await sweep();
    await sim.drive();
    expect([...sim.chain.signed.values()].filter((t) => t.functionName === 'claimRefund')).toHaveLength(0);
    expect(onChain((await job(jobId)).onChainJobId).status).toBe(JobStatus.Submitted);
  });

  // ── row 13 / 14 ────────────────────────────────────────────────────────────

  it('row 13: nodes disagree (one knows, one "not found", one errors; nonce counts differ) — nothing DEAD without consensus; the gate stays closed', async () => {
    const a = await stuckHead();
    sim.chain.nodes.push({ name: 'node-c', error: null, latestLag: 0, blindPending: false, unknown: new Set() });
    const cancel = await scriptReplace(a.head, 'cancel', a.jobId);
    sim.chain.mineBlock();
    sim.chain.node('node-b').latestLag = 1; // still sees nonce 0 unconsumed
    sim.chain.node('node-c').error = 'HTTP 500';
    await reconcile();
    let rows = await atNonce(0);
    expect(rows.filter((r) => r.status === 'DEAD')).toHaveLength(0);
    sim.settlements.clear();
    expect([409, 503]).toContain((await contestAs(a.requester.id, a.jobId)).statusCode);
    sim.chain.node('node-b').latestLag = 0;
    sim.chain.node('node-c').error = null;
    await reconcile();
    rows = await atNonce(0);
    expect(byHash(rows, a.head.hash).status).toBe('DEAD');
    expect(byHash(rows, cancel.hash).status).toBe('MINED_SUCCESS');
  });

  it('row 14: a reorg of a latest-level MINED_SUCCESS — the candidate is alive again, the gate refuses, evaluator-reorg alerted; a proof-level row never moves back', async () => {
    const { requester, jobId } = await delivered();
    sim.chain.proofDepth = 3;
    await sim.drive();
    await reconcile();
    let [row] = await candidates(jobId);
    expect(row).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'latest' });
    sim.chain.reorg(1); // back in the pool
    await reconcile();
    [row] = await candidates(jobId);
    expect(LIVE).toContain(row!.status);
    expect(alertsOf('evaluator-reorg')).toHaveLength(1);
    sim.settlements.clear();
    expect((await contestAs(requester.id, jobId)).statusCode).toBe(409);
    sim.chain.mineBlock();
    sim.chain.mineBlocks(3);
    await reconcile();
    [row] = await candidates(jobId);
    expect(row).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'proof' });
    const pinned = row!.minedBlockHash;
    sim.chain.reorg(1); // a shallow reorg below the proof depth does not touch it
    await reconcile();
    [row] = await candidates(jobId);
    expect(row).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'proof', minedBlockHash: pinned });
  });

  // ── row 19, 20 ─────────────────────────────────────────────────────────────

  it('row 19: with a live candidate the feedback file is never rebuilt — every retry keeps the same calldataHash', async () => {
    const a = await stuckHead();
    const fileBefore = (await job(a.jobId)).feedbackFile;
    await expect(settleOnce(a.jobId, 1)).rejects.toThrow();
    await expect(settleOnce(a.jobId, 2)).rejects.toThrow();
    expect((await job(a.jobId)).feedbackFile).toEqual(fileBefore);
    expect(new Set((await candidates(a.jobId)).map((r) => r.calldataHash)).size).toBe(1);
  });

  it('row 20: backfill of legacy rows — a known hash → LEGACY with nonce/fees/calldata; an unknown hash → nonce NULL SEND_UNCONFIRMED; a stamp without hash keeps refusing; a rerun does not duplicate', async () => {
    const known = await stuckHead();
    const unknown = await delivered();
    sim.chain.holdEvaluatorTx = () => true;
    await sim.drive(1);
    sim.settlements.clear(); // pre-A1 deploy, worker stopped: no retry may re-sign under today's rule before the backfill
    const unknownHash = (await job(unknown.jobId)).settleTxHash as Hex;
    sim.chain.holdEvaluatorTx = null;
    sim.chain.dropEvaluatorTx(unknownHash); // evicted: no node has it
    // Make them legacy: no candidate rows (pre-A1 deploy); the unknown one evicted from every node.
    await table('evaluatorTransaction').deleteMany({ where: { jobId: { in: [known.jobId, unknown.jobId] } } });
    for (const n of sim.chain.nodes) n.unknown.add(unknownHash);
    const stamped = await delivered();
    sim.settlements.clear();
    await m.db.job.update({ where: { id: stamped.jobId }, data: { settleAttemptAt: new Date(), onChainStatus: 'SETTLING' } });
    await reconcile();
    await reconcile();
    const k = await candidates(known.jobId);
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ kind: 'LEGACY', origin: 'BACKFILL', nonce: 0 });
    const u = await candidates(unknown.jobId);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ kind: 'LEGACY', origin: 'BACKFILL', nonce: null, status: 'SEND_UNCONFIRMED' });
    expect(await candidates(stamped.jobId)).toHaveLength(0);
    expect((await contestAs(stamped.requester.id, stamped.jobId)).statusCode).toBe(409);
  });

  // ── rows 25–27: replacements during the receipt wait (C3h D2 under A1) ─────

  it('row 25: a cancel mined while the worker waits — the replacement receipt is not interpreted; job Submitted, alive; nothing finalized; the cancel recorded', async () => {
    const { provider, jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.onReceiptWait = async (hash) => {
      const own = sim.chain.signed.get(hash)!;
      const cancel = await sim.chain.signFields({ to: getAddress(SIM_EVALUATOR), data: '0x', nonce: own.nonce, gas: CANCEL_GAS, ...bumped(own) });
      await sim.chain.acceptRaw(cancel.raw);
      sim.chain.mineBlock();
    };
    await sim.drive(1);
    const j = await job(jobId);
    expect(j.onChainStatus).not.toBe('REJECTED');
    expect(j.reservationStatus).toBe('PENDING');
    expect(onChain(j.onChainJobId).status).toBe(JobStatus.Submitted);
    expect(alertsOf('evaluator-replaced', jobId)).toHaveLength(1);
    await reconcile();
    const rows = await atNonce(0);
    expect(rows.find((r) => r.kind === 'EXTERNAL' || r.kind === 'CANCEL')).toBeDefined();
    expect(rows.find((r) => r.jobId === jobId)!.status).toBe('DEAD');
    sim.chain.evaluatorAutoMine = true;
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  it('row 26: a speed-up mined while the worker waits for the original — outcome from this jobId\'s event; settleTxHash = the speed-up; its fee and feedback', async () => {
    const { jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    let speedHash: Hex | null = null;
    sim.chain.onReceiptWait = async (hash) => {
      const own = sim.chain.signed.get(hash)!;
      const speed = await sim.chain.signFields({ to: own.to, data: own.data, nonce: own.nonce, gas: own.gas, ...bumped(own) });
      speedHash = speed.hash;
      await sim.chain.acceptRaw(speed.raw);
      sim.chain.mineBlock();
    };
    await sim.drive();
    await reconcile();
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();
    const done = await job(jobId);
    expect(done).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString(), feedbackStatus: 'written' });
    expect(sameHash(done.settleTxHash, speedHash)).toBe(true);
    expect(byHash(await atNonce(0), speedHash!).status).toBe('MINED_SUCCESS');
  });

  it('row 27: another job\'s complete mines in this job\'s nonce during the wait — X not paid nor rejected; Y\'s JobCompleted ignored for X; X stays Submitted', async () => {
    const x = await delivered();
    // Keep X's settle out of Y's setup drive (it would pay X before the scenario), then put it back.
    const xSettle = sim.settlements.get(`settle-${x.jobId}`)!;
    sim.settlements.delete(`settle-${x.jobId}`);
    const y = await delivered();
    sim.settlements.delete(`settle-${y.jobId}`);
    sim.settlements.set(`settle-${x.jobId}`, xSettle);
    sim.chain.evaluatorAutoMine = false;
    sim.chain.onReceiptWait = async (hash) => {
      const own = sim.chain.signed.get(hash)!;
      const yJob = await job(y.jobId);
      const data = (await import('./helpers/fake-evaluator-chain.js')).escrowCalldata('complete', [BigInt(yJob.onChainJobId!), keccak256('0x01'), '0x']);
      const other = await sim.chain.signFields({ to: SIM_ESCROW, data, nonce: own.nonce, gas: own.gas, ...bumped(own) });
      await sim.chain.acceptRaw(other.raw);
      sim.chain.mineBlock();
    };
    await sim.drive(1);
    const xJob = await job(x.jobId);
    expect(xJob.onChainStatus).not.toBe('COMPLETED');
    expect(xJob.platformFeeAmount).toBeNull();
    expect(onChain(xJob.onChainJobId).status).toBe(JobStatus.Submitted);
    await reconcile();
    expect((await candidates(x.jobId)).find((r) => r.nonce === 0)!.status).toBe('DEAD');
  });

  // ── rows 28, 29, 31: lost sends, alerts, persisted clock ──────────────────

  it('row 28: single job, every node "not found" after the send, no other traffic — the worker\'s identical rebroadcast → SENT → mines; without a possible rebroadcast (simulation reverts) → evaluator-send-lost', async () => {
    const { jobId } = await delivered();
    sim.chain.evaluatorAutoMine = false;
    sim.chain.refuseSend = () => 'fetch failed (the request never reached the node)';
    await sim.drive(1);
    sim.chain.refuseSend = null;
    sim.settlements.clear();
    const [row] = await candidates(jobId);
    expect(row!.status).toBe('SEND_UNCONFIRMED');
    await reconcile();
    expect(sim.chain.evaluatorSends.filter((s) => s.outcome === 'accepted' && sameHash(s.hash, row!.txHash))).toHaveLength(1);
    expect((await candidates(jobId))[0]!.status).toBe('SENT');
    expect((await candidates(jobId))[0]!.lastBroadcastAt).not.toBeNull();
    sim.chain.mineBlock();
    await reconcile();
    expect((await candidates(jobId))[0]!.status).toBe('MINED_SUCCESS');

    // Variant: the same situation but the call now reverts in simulation → no rebroadcast, alert.
    const other = await delivered();
    sim.chain.refuseSend = () => 'fetch failed (the request never reached the node)';
    await sim.drive(1);
    sim.chain.refuseSend = null;
    sim.settlements.clear();
    const otherOnChainId = BigInt((await job(other.jobId)).onChainJobId!);
    sim.chain.simulationReverts = ({ onChainJobId }) => (onChainJobId === otherOnChainId ? 'provider blocked (TransferFailed)' : null);
    sim.setNowOffset(11 * 60_000);
    await reconcile();
    expect(sim.chain.evaluatorSends.filter((s) => s.outcome === 'accepted' && s.functionName === 'complete')).toHaveLength(1);
    expect(alertsOf('evaluator-send-lost', other.jobId)).toHaveLength(1);
  });

  it('row 29: two live candidates in the same nonce, both unknown to every node — no automatic rebroadcast; alerted', async () => {
    const a = await stuckHead();
    const speed = await scriptReplace(a.head, 'speed-up', a.jobId);
    for (const n of sim.chain.nodes) {
      n.unknown.add(a.head.hash);
      n.unknown.add(speed.hash);
    }
    const sends = sim.chain.evaluatorSends.length;
    sim.setNowOffset(11 * 60_000);
    await reconcile();
    expect(sim.chain.evaluatorSends.length).toBe(sends);
    expect(alertsOf('evaluator-send-lost').length + alertsOf('evaluator-stuck').length).toBeGreaterThanOrEqual(1);
  });

  it('row 31: alert after a restart — the clock comes from the table; the alert leaves on time after the restart; alertedAt is written only after delivery', async () => {
    // simConfig's TTL is 1 h < T (24 h): the early alert of R2-P2-5 applies from the first observation.
    const a = await stuckHead();
    sim.alertFails = true; // the channel refuses: nothing may be recorded as alerted
    await sweep();
    expect(alertsOf('evaluator-stuck')).toHaveLength(0);
    sim.restart(); // the in-memory backlog map of C3f is gone; the clock is in EvaluatorChainState / the table
    sim.alertFails = false;
    sim.setNowOffset(11 * 60_000);
    await sweep(); // delivered at the next tick after the restart — not an hour later, not after a new 10-min window
    expect(alertsOf('evaluator-stuck')).toHaveLength(1);
    expect(alertsOf('evaluator-stuck')[0]).toMatchObject({ jobId: a.jobId });
    await sweep();
    expect(alertsOf('evaluator-stuck')).toHaveLength(1);
  });

  // ── rows 32, 33, 34, 44 ────────────────────────────────────────────────────

  // A1-DEFECT D-A (row 32, R2-P3-1) — FIXED in feat/a1-fix-core (it.fails → it). Was: the worker's gate `assertNoPendingSettlement` runs at depth `proof` and lowers
  // to `latest` only for rows with the SAME calldataHash; a LEGACY row without a nonce has no calldata (''), so it is
  // judged at `proof`, where a nonce-less row clears only with a reverted receipt. An evicted legacy send (every node
  // "not found") therefore blocks the job's settlement forever ("... is pending (no receipt yet) — not signing
  // another one"), instead of today's rule (`legacyResignAllowed`). Remove `.fails` once fixed.
  it('row 32: a legacy row with nonce NULL follows today\'s rule and leaves through a new worker attempt (every node "not found") — no permanent deadlock', async () => {
    const { provider, jobId } = await delivered();
    sim.chain.holdEvaluatorTx = () => true;
    await sim.drive(1);
    const hash = (await job(jobId)).settleTxHash as Hex;
    await table('evaluatorTransaction').deleteMany({ where: { jobId } });
    for (const n of sim.chain.nodes) n.unknown.add(hash);
    sim.chain.dropEvaluatorTx(hash); // evicted for real: it can never mine
    sim.chain.holdEvaluatorTx = null;
    await reconcile(); // backfill: nonce NULL, SEND_UNCONFIRMED
    expect((await candidates(jobId))[0]).toMatchObject({ nonce: null, status: 'SEND_UNCONFIRMED' });
    // The evicted tx really is gone; the next attempt is allowed by today's rule and settles.
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();
    expect(await job(jobId)).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  // A1-DEFECT D-B (row 33, R2-P2-2 item 1) — FIXED in feat/a1-fix-core (it.fails → it). Was: after a CANCEL mined at `latest` consumed the head, re-signing the SAME
  // decision must only need `latest`. The worker's gate lowers the depth only for rows with the same calldataHash; the
  // job's own MINED_SUCCESS CANCEL row (it never settles anything) is judged at `proof` and blocks ("candidate tx
  // <cancel> at nonce 0 may still mine (its outcome is not yet at the proof depth)") until `safe` passes it — with
  // `safe` stalled, never. Remove `.fails` once fixed.
  it('row 33: the proof tag lags near expiry — the same decision is re-signed on latest; contest and a decision change wait for the proof; evaluator-proof-stalled when safe stops', async () => {
    const a = await stuckHead();
    sim.chain.safeHead = sim.chain.head; // safe stalls here
    await scriptReplace(a.head, 'cancel', a.jobId);
    sim.chain.mineBlocks(3);
    sim.chain.baseFee = 5_000_000n;
    await reconcile();
    expect(byHash(await atNonce(0), a.head.hash)).toMatchObject({ status: 'DEAD', proofLevel: 'latest' });
    // Contest (a change of what happens to the job): waits for the proof tag.
    sim.settlements.clear();
    expect((await contestAs(a.requester.id, a.jobId)).statusCode).toBe(409);
    // Same decision: re-signed with latest.
    await m.runPaymentRecoveryTick();
    await sim.drive();
    expect((await candidates(a.jobId)).filter((r) => r.nonce === 1 && r.action === 'COMPLETE')).toHaveLength(1);
    sim.setNowOffset(60 * 60_000);
    sim.chain.mineBlocks(30);
    await reconcile();
    await sweep();
    expect(alertsOf('evaluator-proof-stalled')).toHaveLength(1);
  });

  it('row 34 (C3h D3 preserved): a third party\'s claimRefund on a delivered job without contest/decision → provider-unpaid once', async () => {
    const { requester, jobId } = await delivered();
    sim.settlements.clear();
    sim.setNowOffset(simConfig.jobTtlSeconds * 1000 + 60_000);
    sim.chain.time = onChain((await job(jobId)).onChainJobId).expiredAt + 1n;
    const refund = sim.chain.thirdPartyCall(requester.safeAddress as Address, 'claimRefund', [BigInt((await job(jobId)).onChainJobId!)]);
    expect(refund.status).toBe('success');
    await m.runPaymentRecoveryTick();
    await sim.drive();
    await reconcile();
    expect(await job(jobId)).toMatchObject({ onChainStatus: 'EXPIRED' });
    expect(alertsOf('provider-unpaid', jobId)).toHaveLength(1);
  });

  it('row 44 (worker side): the lease is lost between the insert and the send — the send is aborted; no SENT row; nothing broadcast', async () => {
    const { jobId } = await delivered();
    sim.chain.beforeSend = async () => {
      sim.lanes.steal(sim.lanes.acquired.at(-1)!);
    };
    await sim.drive(1);
    const [row] = await candidates(jobId);
    expect(row!.status).not.toBe('SENT');
    expect(sim.chain.evaluatorSends.filter((s) => s.outcome === 'accepted')).toHaveLength(0);
  });
});

// ══ 3. recovery script (src/scripts/evaluator-recovery.ts — enabled with the CLI) ═════════════════════

/**
 * Entry: `runEvaluatorRecovery(argv, deps)` → `{ exitCode, output }` (0 done / dry-run, 2 refused, 3 aborted in
 * the critical section). Deps here: the sim's orchestrator deps (fake multi-node chain, FakeLeaseLock lane),
 * the fake chain's signer (signExplicit / sendRaw), an in-memory recovery lock, the plan caps FIXTURE (test
 * values only), a scripted TTY (types the phrase it is asked for, unless told otherwise).
 */
const recoveryLocks = new Set<number>();
function memRecoveryLock(chainId: number) {
  if (recoveryLocks.has(chainId)) throw new Error(`agentfi:evaluator-recovery:${chainId} is held by another operator`);
  recoveryLocks.add(chainId);
  return { release: async () => recoveryLocks.delete(chainId) };
}

type Cli = typeof import('../scripts/evaluator-recovery.js');
let cliMod: Cli;

function recoveryDeps(o: {
  caps?: ReturnType<typeof planCapsFixture> | null;
  tty?: boolean;
  answer?: (prompt: string) => string | Promise<string>;
  verify?: { ok: true } | { ok: false; reason: string };
  rpcChainId?: number;
  balance?: bigint;
  lock?: (chainId: number, owner: string) => Promise<{ release(): Promise<unknown>; assertHeld?(): Promise<void> }>;
  prompts?: string[];
} = {}) {
  sim.deps.recoveryCaps = () => (o.caps === undefined ? planCapsFixture() : o.caps);
  return {
    erc8183: sim.deps,
    signer: sim.chain.signer() as never,
    acquireRecoveryLock: o.lock ?? (async (chainId: number) => memRecoveryLock(chainId)),
    verifyConfig: async () => o.verify ?? ({ ok: true } as const),
    ...(o.rpcChainId !== undefined ? { rpcChainId: async () => o.rpcChainId! } : {}),
    ...(o.balance !== undefined ? { balance: async () => o.balance! } : {}),
    thresholds: { actWithinMs: 24 * 3_600_000, urgentWithinMs: 6 * 3_600_000, handToOwnerWithinMs: 3_600_000 },
    tty: {
      isTTY: o.tty ?? true,
      ask: async (prompt: string) => {
        o.prompts?.push(prompt);
        if (o.answer) return o.answer(prompt);
        return /Type exactly: (.*)\n/.exec(prompt)?.[1] ?? '';
      },
    },
    now: () => sim.now(),
    receiptWaitMs: 20,
  };
}

const run = (argv: string[], o: Parameters<typeof recoveryDeps>[0] = {}) => cliMod.runEvaluatorRecovery(['--chain', String(CHAIN_ID), ...argv], recoveryDeps(o));
const EXEC = (op: string, nonce: number | string) => ['--execute', op, ...(typeof nonce === 'string' ? ['--nonces', nonce] : ['--nonce', String(nonce)]), '--operator', 'ops@test', '--note', 'stuck head, C5'];

describeA1('A1 recovery script (CLI) — Postgres + fake multi-node chain', () => {
  beforeAll(async () => {
    await loadModules();
    cliMod = await import('../scripts/evaluator-recovery.js');
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    recoveryLocks.clear();
    m.svc.__resetEscrowTokenCacheForTests();
    setSimConfigUnverified(null);
    sim = makeSim();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    setSimDeps(null);
    setSimRepoll(null);
  });

  it('dry-run (default): nonces latest / pending / proof, the queue with every candidate and "known by" per node, jobs, fees, proposals, cost, balance, head class, the claimRefund sentence, the cancel text, fingerprints — nothing signed', async () => {
    const a = await stuckHead();
    const before = (await candidates(a.jobId)).length;
    const r = await run([]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/DRY-RUN \(nothing signed\)/);
    expect(r.output).toMatch(/nonces: latest 0 · pending 1 · proof tag/);
    expect(r.output).toMatch(/nonce 0 \(HEAD\):/);
    expect(r.output).toContain(a.head.hash.toLowerCase());
    expect(r.output).toMatch(/not found|known/);
    expect(r.output).toMatch(/head classification: price-stuck → speed-up/);
    expect(r.output).toMatch(/speed-up: allowed · fees maxFeePerGas \d+ wei/);
    expect(r.output).toMatch(/cancel: +refused: SPEED_UP_POSSIBLE/);
    expect(r.output).toMatch(/max cost \d+ wei/);
    expect(r.output).toMatch(/fingerprint speed-up 0x[0-9a-f]{64}/);
    expect(r.output).toMatch(/Affected jobs \(delivered, waiting on the key\): 1/);
    expect(r.output).toMatch(/Earliest delivered expiresAt: .* posture/);
    expect(r.output).toContain('After expiresAt anyone can call claimRefund on a Funded or Submitted job and refund the requester in full');
    expect(r.output).toContain('CANCEL does not settle the job.');
    expect((await candidates(a.jobId)).length).toBe(before);
  });

  it('no caps configured → the dry-run says so; --execute refused (fail closed), nothing signed', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    const r = await run(EXEC('speed-up', 0), { caps: null });
    expect(r.output).toMatch(/caps: NONE CONFIGURED/);
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/REFUSED: no recovery caps configured/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('no TTY (stdin redirected) → refused, nothing signed', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    const r = await run(EXEC('speed-up', 0), { tty: false });
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/REFUSED: no TTY/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('row 1 (script): --execute speed-up with the typed phrase "SPEED-UP <chainId> NONCE <N> COMPLETE <jobId>" → SPEED_UP row SCRIPT with operator + note, Job.escrowError line; mined → original DEAD, job paid once', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    sim.chain.baseFee = 5_000_000n; // the network calms down: the bumped fees clear the base fee
    const prompts: string[] = [];
    const r = await run(EXEC('speed-up', 0), { prompts });
    expect(r.exitCode, r.output).toBe(0);
    expect(prompts[0]).toContain(`SPEED-UP ${CHAIN_ID} NONCE 0 COMPLETE ${a.jobId}`);
    const rows = await atNonce(0);
    const speed = rows.find((c) => c.kind === 'SPEED_UP')!;
    expect(speed).toMatchObject({ origin: 'SCRIPT', operator: 'ops@test', note: 'stuck head, C5', action: 'COMPLETE' });
    expect(speed.calldataHash).toBe(byHash(rows, a.head.hash).calldataHash);
    // F-P3-3: the API-visible line is neutral; the operator and the note live only in the ledger row (D-i).
    expect((await job(a.jobId)).escrowError).toBe('evaluator recovery: speed-up sent at nonce 0');
    await reconcile();
    expect(byHash(await atNonce(0), a.head.hash)).toMatchObject({ status: 'DEAD' });
    expect(byHash(await atNonce(0), speed.txHash)).toMatchObject({ status: 'MINED_SUCCESS' });
    await sim.drive();
    expect(await job(a.jobId)).toMatchObject({ onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(a.provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
    expect(await table('evaluatorRecoveryIncident').findMany({ where: { evaluator: getAddress(SIM_EVALUATOR) } })).toHaveLength(1);
  });

  it('row 3 (script): cancel refused while a speed-up is possible (R2-P2-1, no override) — with the cancel text; nothing signed', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    const r = await run(EXEC('cancel', 0));
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/REFUSED: cancel refused at nonce 0: a speed-up is possible \(R2-P2-1, no override\)\. CANCEL does not settle the job/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('row 3 (script): cancel admitted once the simulation reverts (blocked payee), with "CANCEL <chainId> NONCE <N> DOES NOT SETTLE" — the job stays Submitted, its decision is kept', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    sim.chain.blockedPayees.add(a.provider.safeAddress.toLowerCase()); // complete would revert
    sim.chain.baseFee = 5_000_000n;
    const prompts: string[] = [];
    const r = await run(EXEC('cancel', 0), { prompts });
    expect(r.exitCode, r.output).toBe(0);
    expect(prompts[0]).toContain(`CANCEL ${CHAIN_ID} NONCE 0 DOES NOT SETTLE`);
    expect((await atNonce(0)).find((c) => c.kind === 'CANCEL')).toMatchObject({ origin: 'SCRIPT', action: 'CANCEL_NOOP' });
    expect(onChain((await job(a.jobId)).onChainJobId).status).toBe(JobStatus.Submitted);
  });

  it('row 4 (script): an unacknowledged EXTERNAL blocks every --execute; --acknowledge-foreign <hash> unlocks it (and only it)', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    const ext = `0x${'ab'.repeat(32)}`;
    await ledger.recordExternalCandidate(m.db, {
      chainId: CHAIN_ID, evaluator: getAddress(SIM_EVALUATOR), nonce: 90, toAddress: getAddress(SIM_EVALUATOR), valueWei: 0n, calldata: '0x',
      gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, txHash: ext, status: 'MINED_SUCCESS', proofLevel: 'proof', blockNumber: 1n, blockHash: `0x${'cd'.repeat(32)}`,
    });
    const refused = await run(EXEC('speed-up', 0));
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toMatch(/EXTERNAL transaction\(s\) of this key not acknowledged: 0xabab/);
    sim.chain.baseFee = 5_000_000n;
    const ok = await run([...EXEC('speed-up', 0), '--acknowledge-foreign', ext]);
    expect(ok.exitCode, ok.output).toBe(0);
    expect((await ledger.unacknowledgedExternal(m.db, CHAIN_ID, SIM_EVALUATOR))).toHaveLength(0);
    expect((await candidates(a.jobId)).filter((c) => c.kind === 'SPEED_UP')).toHaveLength(1);
  });

  it('row 8: two operators — the second stops at the recovery lock; with the lock out of the way, a plan changed inside the lane (fingerprint) aborts: nothing sent', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    recoveryLocks.add(CHAIN_ID); // operator 1 holds agentfi:evaluator-recovery:<chainId>
    const second = await run(EXEC('speed-up', 0));
    expect(second.exitCode).toBe(2);
    expect(second.output).toMatch(/another recovery holds the lock/);
    recoveryLocks.clear();
    // The job's on-chain state moves between the confirmation and the lane: the confirmed plan is no longer the one in force.
    const moved = await run(EXEC('speed-up', 0), {
      answer: async (prompt) => {
        onChain((await job(a.jobId)).onChainJobId).status = JobStatus.Completed;
        return /Type exactly: (.*)\n/.exec(prompt)![1]!;
      },
    });
    expect(moved.exitCode).toBe(3);
    expect(moved.output).toMatch(/plan of nonce 0 changed since the confirmation \(fingerprint\)/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('row 16: wrong chain id, Q7 unverified, key ≠ Job.evaluator → refused before any signature', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    expect((await run(EXEC('speed-up', 0), { rpcChainId: 1 })).output).toMatch(/REFUSED: wrong chain: the RPC answers eth_chainId 1/);
    expect((await run(EXEC('speed-up', 0), { verify: { ok: false, reason: 'hook.trustedEvaluator mismatch' } })).output).toMatch(/REFUSED: the on-chain configuration could not be verified \(Q7\): hook.trustedEvaluator mismatch/);
    await m.db.job.update({ where: { id: a.jobId }, data: { evaluator: getAddress(`0x${'12'.repeat(20)}`) } });
    expect((await run(EXEC('speed-up', 0))).output).toMatch(/REFUSED: the signer key is not the Job.evaluator of the live jobs/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('row 18: a speed-up for a nonce that is not the head → refused (always the head first)', async () => {
    await stuckHead();
    const b = await delivered();
    sim.chain.holdEvaluatorTx = () => true;
    await sim.drive(1); // B queues at nonce 1 behind the stuck head
    sim.chain.holdEvaluatorTx = null;
    sim.setNowOffset(61_000);
    const r = await run(EXEC('speed-up', 1));
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/nonce 1 is not the head \(NOT_HEAD/);
    expect((await candidates(b.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('row 38: a second replacement within 60 s (P9) and a 4th replacement (P8) are refused — read from the table, alerted evaluator-recovery-refused', async () => {
    const a = await stuckHead();
    sim.chain.evaluatorAutoMine = false; // the replacements stay pending (still stuck)
    sim.setNowOffset(61_000);
    expect((await run(EXEC('speed-up', 0))).exitCode).toBe(0);
    const tooSoon = await run(EXEC('speed-up', 0));
    expect(tooSoon.exitCode).toBe(2);
    expect(tooSoon.output).toMatch(/replacement limit: INTERVAL/);
    sim.setNowOffset(2 * 61_000);
    expect((await run(EXEC('speed-up', 0))).exitCode).toBe(0);
    sim.setNowOffset(3 * 61_000);
    expect((await run(EXEC('speed-up', 0))).exitCode).toBe(0);
    sim.setNowOffset(4 * 61_000);
    const fourth = await run(EXEC('speed-up', 0));
    expect(fourth.exitCode).toBe(2);
    expect(fourth.output).toMatch(/MAX_REPLACEMENTS/);
    expect(alertsOf('evaluator-recovery-refused').length).toBeGreaterThanOrEqual(2);
    expect((await atNonce(0)).filter((c) => c.kind === 'SPEED_UP')).toHaveLength(3);
    void a;
  });

  it('row 39 / 37 / 15-40: incident budget, effective fee cap and the reserve — refused with the value that would be needed, alerted, nothing signed', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    const tight = { ...planCapsFixture(), maxCostPerIncidentWei: 1n };
    const budget = await run(EXEC('speed-up', 0), { caps: tight });
    expect(budget.exitCode).toBe(2);
    expect(budget.output).toMatch(/budget: (TX_COST_ABOVE_CAP|INCIDENT_BUDGET_EXCEEDED) — would need \d+ wei/);
    sim.chain.baseFee = 900_000_000n; // a fee spike: the P7 proposal exceeds min(P2, P5 × base + P3)
    const fee = await run(EXEC('speed-up', 0));
    expect(fee.exitCode).toBe(2);
    expect(fee.output).toMatch(/fees: (FEE_ABOVE_CAP|PRIORITY_ABOVE_CAP) — would need \d+ wei, cap \d+ wei/);
    sim.chain.baseFee = 5_000_000n;
    const reserve = await run(EXEC('speed-up', 0), { balance: 10n ** 14n });
    expect(reserve.exitCode).toBe(2);
    expect(reserve.output).toMatch(/budget: RESERVE_BREACHED/);
    expect(alertsOf('evaluator-recovery-refused').length).toBeGreaterThanOrEqual(3);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('row 35 (range): --nonces 0..1 speeds up the head and the next one, head first, one fingerprint each, one confirmation "SPEED-UP <chainId> NONCES 0-1 2 TXS"', async () => {
    const a = await stuckHead();
    const b = await delivered();
    sim.chain.holdEvaluatorTx = () => true;
    await sim.drive(1);
    sim.chain.holdEvaluatorTx = null;
    sim.setNowOffset(61_000);
    sim.chain.evaluatorAutoMine = false;
    const prompts: string[] = [];
    const r = await run(EXEC('speed-up', '0..1'), { prompts });
    expect(r.exitCode, r.output).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`SPEED-UP ${CHAIN_ID} NONCES 0-1 2 TXS`);
    expect((await candidates(a.jobId)).filter((c) => c.kind === 'SPEED_UP')).toHaveLength(1);
    expect((await candidates(b.jobId)).filter((c) => c.kind === 'SPEED_UP')).toHaveLength(1);
    expect(r.output.indexOf('nonce 0: speed-up')).toBeLessThan(r.output.indexOf('nonce 1: speed-up'));
  });

  it('row 43 (DB): head classification in the dry-run — price-stuck vs lost-send (no node knows the head) → the suggested action; rebroadcast of a lost head through the script', async () => {
    await stuckHead();
    expect((await run([])).output).toMatch(/head classification: price-stuck → speed-up/);
    await wipe();
    sim = makeSim();
    const d = await delivered();
    sim.chain.holdEvaluatorTx = () => true;
    await sim.drive(1);
    sim.chain.holdEvaluatorTx = null;
    sim.settlements.clear();
    const hash = (await job(d.jobId)).settleTxHash as Hex;
    sim.chain.dropEvaluatorTx(hash);
    for (const n of sim.chain.nodes) n.unknown.add(hash);
    // the reconciliation pass at the start of the run would rebroadcast it (R2-P1-3); a reverting simulation keeps it lost
    sim.chain.simulationReverts = () => 'payee blocked (test)';
    const dry = await run([]);
    expect(dry.output).toMatch(/head classification: lost-send → identical rebroadcast/);
    expect(dry.output).toMatch(/rebroadcast: refused: SIMULATION_REVERTS/);
  });

  it('row 28 (script): --execute rebroadcast of a lost head sends the IDENTICAL recorded bytes (no new row, no new nonce), "REBROADCAST <chainId> NONCE <N> COMPLETE <jobId>"; the job settles once', async () => {
    const d = await delivered();
    sim.chain.holdEvaluatorTx = () => true;
    await sim.drive(1);
    sim.chain.holdEvaluatorTx = null;
    sim.settlements.clear();
    const hash = (await job(d.jobId)).settleTxHash as Hex;
    sim.chain.dropEvaluatorTx(hash);
    for (const n of sim.chain.nodes) n.unknown.add(hash);
    // this process's worker signer cannot rebroadcast (the pass refuses): the operator's script does it
    const workerSigner = sim.chain.signer() as Record<string, unknown>;
    delete workerSigner['sendRaw'];
    sim.deps.evaluatorSigner = () => workerSigner as never;
    const prompts: string[] = [];
    const r = await run(EXEC('rebroadcast', 0), { prompts });
    expect(r.exitCode, r.output).toBe(0);
    expect(prompts[0]).toContain(`REBROADCAST ${CHAIN_ID} NONCE 0 COMPLETE ${d.jobId}`);
    const rows = await candidates(d.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: hash.toLowerCase(), status: 'MINED_SUCCESS' });
    await sim.drive();
    expect(await job(d.jobId)).toMatchObject({ onChainStatus: 'COMPLETED' });
    expect(sim.chain.usdcOf(d.provider.safeAddress as Hex)).toBe(START_USDC + BUDGET - FEE);
  });

  it('row 44 (script): the lane lost / PTTL below the margin right before the send → aborted, nothing SENT (the SCRIPT row stays SIGNED, live)', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    sim.chain.baseFee = 5_000_000n;
    sim.deps.evaluatorLanes = new FakeLeaseLock({ ttlMs: 10_000 }); // a TTL below the 30-s margin (P17)
    const r = await run(EXEC('speed-up', 0));
    expect(r.exitCode).toBe(3);
    expect(r.output).toMatch(/evaluator lane was lost before the send/);
    const script = (await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT');
    expect(script).toHaveLength(1);
    expect(script[0]).toMatchObject({ status: 'SIGNED' });
    expect(sim.chain.minedInNonce(0)).toBeNull();
    // D-R9-1: nothing was broadcast, so the API-visible line never claims a recovery send.
    expect((await job(a.jobId)).escrowError ?? '').not.toMatch(/evaluator recovery: .* (sent|attempted) at nonce/);
  });

  it('row 42 (DB): past the earliest delivered expiresAt (block time) the speed-up needs "… AFTER EXPIRY"', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    sim.chain.baseFee = 5_000_000n;
    await m.db.job.update({ where: { id: a.jobId }, data: { expiresAt: new Date(Number(sim.chain.time) * 1000 - 60_000) } });
    const prompts: string[] = [];
    const r = await run(EXEC('speed-up', 0), { prompts });
    expect(r.output).toMatch(/ALREADY PASSED · posture EXPIRED/);
    expect(prompts[0]).toMatch(/SPEED-UP .* AFTER EXPIRY/);
    expect(r.exitCode, r.output).toBe(0);
  });

  it('F-P2-1: the base fee moves between the confirmation and the lane — the speed-up is still sent, signed with EXACTLY the confirmed fees', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    sim.chain.baseFee = 5_000_000n;
    let confirmedLine = '';
    const r = await run(EXEC('speed-up', 0), {
      answer: (prompt) => {
        sim.chain.baseFee = sim.chain.baseFee + 1n; // the next block
        return /Type exactly: (.*)\n/.exec(prompt)![1]!;
      },
    });
    expect(r.exitCode, r.output).toBe(0);
    confirmedLine = r.output.split('\n').find((l) => l.startsWith('Plan: speed-up'))!;
    const m = /maxFeePerGas (\d+) wei, priority (\d+) wei — signed with exactly these fees/.exec(confirmedLine)!;
    const speed = (await atNonce(0)).find((c) => c.kind === 'SPEED_UP')!;
    expect(BigInt((speed as unknown as { maxFeePerGas: string }).maxFeePerGas)).toBe(BigInt(m[1]!));
    expect(BigInt((speed as unknown as { maxPriorityFeePerGas: string }).maxPriorityFeePerGas)).toBe(BigInt(m[2]!));
    void a;
  });

  it('F-P2-1: the base fee rises above the confirmed maxFeePerGas before the lane → aborted (exit 3), nothing signed', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    sim.chain.baseFee = 5_000_000n;
    const r = await run(EXEC('speed-up', 0), {
      answer: (prompt) => {
        sim.chain.baseFee = 10n ** 9n; // a spike: the confirmed fees no longer cover the base fee
        return /Type exactly: (.*)\n/.exec(prompt)![1]!;
      },
    });
    expect(r.exitCode).toBe(3);
    expect(r.output).toMatch(/below the current base fee .* aborted, nothing sent/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('F-P3-1: the recovery lock no longer ours before a nonce → stopped, nothing sent', async () => {
    const a = await stuckHead();
    sim.setNowOffset(61_000);
    const r = await run(EXEC('speed-up', 0), {
      lock: async () => ({
        release: async () => true,
        assertHeld: async () => {
          throw new Error('agentfi:evaluator-recovery:84532 is held by another owner');
        },
      }),
    });
    expect(r.exitCode).toBe(3);
    expect(r.output).toMatch(/recovery lock of chain 84532 is no longer ours/);
    expect((await candidates(a.jobId)).filter((c) => c.origin === 'SCRIPT')).toHaveLength(0);
  });

  it('F-P3-2: --acknowledge-foreign is written only after the typed phrase (a wrong phrase acknowledges nothing)', async () => {
    await stuckHead();
    sim.setNowOffset(61_000);
    const ext = `0x${'ef'.repeat(32)}`;
    await ledger.recordExternalCandidate(m.db, {
      chainId: CHAIN_ID, evaluator: getAddress(SIM_EVALUATOR), nonce: 91, toAddress: getAddress(SIM_EVALUATOR), valueWei: 0n, calldata: '0x',
      gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, txHash: ext, status: 'MINED_SUCCESS', proofLevel: 'proof', blockNumber: 1n, blockHash: `0x${'cd'.repeat(32)}`,
    });
    const r = await run([...EXEC('speed-up', 0), '--acknowledge-foreign', ext], { answer: () => 'no' });
    expect(r.output).toMatch(/confirmation phrase does not match/);
    expect(await ledger.unacknowledgedExternal(m.db, CHAIN_ID, SIM_EVALUATOR)).toHaveLength(1);
  });

  // Row 9 (script + worker at once, Redis real): the worker signs Y at pending+1 while the script holds the lane
  // for N, no nonce collision. The worker side alone is the `row 9` test above; the concurrent run is covered by
  // evaluator-concurrency.anvil.ts (two OS processes, real contracts, Redis lane): scenario 1 (W first),
  // scenario 2 (S first, lagging pending), scenarios 3a/3b (lease lost before the broadcast), scenarios 4a/4b
  // (state changes between prompt and execution) and scenario 5 (ledger / chain audit).
});
