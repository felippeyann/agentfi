/**
 * C3g-A1 — the evaluator candidate ledger (`services/escrow/evaluator-ledger.ts`)
 * on REAL Postgres (migration 0026 applied with `prisma migrate deploy`).
 *
 * Covers: insert + job stamp in one transaction (and the rollback on a lost
 * conditional write), idempotent insert, two concurrent inserts for the same
 * job / the same nonce, R2-P3-3 re-check (live cancel / other decision),
 * nonce occupancy (R2-P2-3), the SCRIPT budget race under parallel calls,
 * replacement count and interval across "restarts" (fresh Prisma clients
 * reading the rows, plan row 38), incident / 24 h budget (row 39), monotonic
 * transitions, reorg revert (latest only), the partial unique open incident,
 * backfill idempotency and upgrade (row 20 / 32 data part), CHECK
 * constraints, ON DELETE RESTRICT and the cleanup order, the persisted chain
 * state (alert delivered after delivery, clocks, node failures, proof head).
 *
 * Skipped (with a warning) when the database is unreachable or not migrated
 * to 0026 locally; CI fails instead.
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

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import type { RecoveryCaps } from '../services/escrow/evaluator-candidates.js';
import {
  BudgetRefusedError,
  CandidateConflictError,
  SettlementSupersededError,
  backfillLegacyCandidate,
  candidatesAtNonce,
  closeIncident,
  getOpenIncident,
  insertCandidateWithJobStamp,
  liveCandidatesForJob,
  liveNonces,
  markAnswered,
  markBroadcast,
  markResolved,
  observeHeadClock,
  observeSafeHead,
  openIncident,
  readChainState,
  recordAlertDelivered,
  recordExternalCandidate,
  recordNodeRead,
  revertForReorg,
  writeChainState,
  type NewCandidate,
} from '../services/escrow/evaluator-ledger.js';
import { SettlementSupersededError as ServiceSupersededError } from '../services/job/escrow-erc8183.service.js';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "proofLevel" FROM "EvaluatorTransaction" LIMIT 1`;
    await probe.$queryRaw`SELECT "closedAt" FROM "EvaluatorRecoveryIncident" LIMIT 1`;
    await probe.$queryRaw`SELECT "rpcFailures" FROM "EvaluatorChainState" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}
const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('evaluator-ledger.db.test.ts needs Postgres migrated to 0026 at DATABASE_URL on CI');
  console.warn('[evaluator-ledger.db.test] DATABASE_URL is not a reachable database migrated to 0026 — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const TAG = randomBytes(4).toString('hex');
const CHAIN = 900_000 + (randomBytes(2).readUInt16BE(0) % 60_000);
const ESCROW = getAddress(`0x${'e5'.repeat(20)}`);

/** Plan P1–P16 (Base Sepolia column) — test fixture only. */
const CAPS: RecoveryCaps = {
  maxFeePerGasWei: GWEI,
  maxPriorityFeePerGasWei: GWEI / 10n,
  relativeBaseMultiplier: 20n,
  bumpBps: 1_250,
  multipliers: [3n, 6n, 12n],
  maxReplacementsPerNonce: 3,
  minIntervalMs: 60_000,
  maxCostPerTxWei: (8n * ETH) / 10_000n,
  maxCostPerIncidentWei: (15n * ETH) / 10_000n,
  maxCost24hWei: (2n * ETH) / 1_000n,
  reserveWei: ETH / 1_000n,
  l1MarginWei: ETH / 100_000n,
  maxNoncesPerPlan: 3,
  maxGasLimit: 1_000_000n,
  minPriorityFeePerGasWei: GWEI / 1_000n,
};
const RICH = 10n * ETH;

let db: PrismaClient;
let requesterId: string;
let providerId: string;
const extraClients: PrismaClient[] = [];

const newEvaluator = () => getAddress(`0x${randomBytes(20).toString('hex')}`);
const newHash = () => keccak256(toHex(`${TAG}-${randomBytes(16).toString('hex')}`));
const COMPLETE_DATA = (job: string): Hex => toHex(`complete:${job}`);

async function newJob(): Promise<string> {
  const j = await db.job.create({
    data: {
      requesterId, providerId, payload: { a1: TAG }, escrowKind: 'erc8183', escrowChainId: CHAIN, escrowContract: ESCROW,
      onChainJobId: `${Date.now()}${randomBytes(3).readUIntBE(0, 3)}`, onChainStatus: 'SETTLING', status: 'PAYMENT_PENDING',
    },
  });
  return j.id;
}

function original(evaluator: string, jobId: string | null, nonce: number, over: Partial<NewCandidate> = {}): NewCandidate {
  return {
    chainId: CHAIN, evaluator, nonce, jobId, kind: 'ORIGINAL', action: 'COMPLETE', decision: 'pay',
    toAddress: ESCROW, calldata: COMPLETE_DATA(jobId ?? 'none'), gasLimit: 740_300n,
    maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n, txHash: newHash(), rawTx: '0x02f8', origin: 'WORKER', ...over,
  };
}

function cancelOf(evaluator: string, jobId: string | null, nonce: number, replacesId: string | null, over: Partial<NewCandidate> = {}): NewCandidate {
  return {
    chainId: CHAIN, evaluator, nonce, jobId, kind: 'CANCEL', action: 'CANCEL_NOOP', toAddress: evaluator, calldata: '0x',
    gasLimit: 21_000n, maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 5_000_000n, txHash: newHash(), replacesId, origin: 'WORKER', ...over,
  };
}

async function stampOriginal(evaluator: string, jobId: string, nonce: number, at: Date, over: Partial<NewCandidate> = {}) {
  const c = original(evaluator, jobId, nonce, over);
  const r = await insertCandidateWithJobStamp(db, { candidate: c, job: { id: jobId, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true, expectedOnChainStatus: 'SETTLING' }, now: at });
  return { ...r, c };
}

async function cleanup(): Promise<void> {
  // ON DELETE RESTRICT: candidate rows first, then incidents, then jobs / agents.
  await db.evaluatorTransaction.deleteMany({ where: { chainId: CHAIN } });
  await db.evaluatorRecoveryIncident.deleteMany({ where: { chainId: CHAIN } });
  await db.evaluatorChainState.deleteMany({ where: { chainId: CHAIN } });
  await db.job.deleteMany({ where: { escrowChainId: CHAIN } });
}

const settled = async <T>(ps: Array<Promise<T>>) => Promise.allSettled(ps);

describeDb('evaluator ledger on Postgres (migration 0026)', () => {
  beforeAll(async () => {
    db = new PrismaClient();
    const mk = (n: string) => db.agent.create({
      data: { name: `a1-ledger-${n}-${TAG}`, apiKeyHash: `a1-${n}-${TAG}-${randomBytes(6).toString('hex')}`, apiKeyPrefix: 'a1', walletId: `w-${n}-${TAG}`, safeAddress: getAddress(`0x${randomBytes(20).toString('hex')}`), chainIds: [CHAIN] },
    });
    requesterId = (await mk('req')).id;
    providerId = (await mk('prov')).id;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.agent.deleteMany({ where: { id: { in: [requesterId, providerId] } } });
    await db.$disconnect();
    await Promise.all(extraClients.map((c) => c.$disconnect().catch(() => undefined)));
  });

  describe('insert + job stamp (spec §2.4-2)', () => {
    it('inserts SIGNED and writes the job in the same transaction; replay is idempotent', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const at = new Date('2026-10-22T10:00:00.000Z');
      const { id, inserted, c } = await stampOriginal(ev, job, 5, at);
      expect(inserted).toBe(true);
      const row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'SIGNED', nonce: 5, evaluator: ev, txHash: c.txHash, calldataHash: keccak256(c.calldata), gasLimit: '740300', proofLevel: null });
      expect(row.createdAt.toISOString()).toBe(at.toISOString());
      const j = await db.job.findUniqueOrThrow({ where: { id: job } });
      expect(j.settleTxHash).toBe(c.txHash);
      expect(j.settleAttemptAt?.toISOString()).toBe(at.toISOString());

      // same tx again (deterministic re-sign): no new row; the job write still decides
      const again = await insertCandidateWithJobStamp(db, { candidate: c, job: { id: job, expectedSettleTxHash: c.txHash, setSettleTxHash: true, stampAttempt: true } });
      expect(again).toEqual({ id, inserted: false });
      expect(await db.evaluatorTransaction.count({ where: { jobId: job } })).toBe(1);
      // the same hash with other fields is a conflict
      await expect(insertCandidateWithJobStamp(db, { candidate: { ...c, nonce: 6 }, job: { id: job, expectedSettleTxHash: c.txHash, setSettleTxHash: true, stampAttempt: true } }))
        .rejects.toMatchObject({ code: 'TX_HASH_REUSED' });
    });

    it('a lost conditional write rolls the insert back (SettlementSupersededError, the service class)', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const c = original(ev, job, 1);
      const err = await insertCandidateWithJobStamp(db, { candidate: c, job: { id: job, expectedSettleTxHash: newHash(), setSettleTxHash: true, stampAttempt: true } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettlementSupersededError);
      expect(err).toBeInstanceOf(ServiceSupersededError);
      expect(await db.evaluatorTransaction.count({ where: { txHash: c.txHash } })).toBe(0);
      // a claimed settlement no longer SETTLING
      const err2 = await insertCandidateWithJobStamp(db, { candidate: c, job: { id: job, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true, expectedOnChainStatus: 'SUBMITTED' } }).catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(SettlementSupersededError);
      // a missing job
      const err3 = await insertCandidateWithJobStamp(db, { candidate: { ...c, jobId: 'no-such-job' }, job: { id: 'no-such-job', expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true } }).catch((e: unknown) => e);
      expect(err3).toBeInstanceOf(SettlementSupersededError);
      expect(await db.evaluatorTransaction.count({ where: { evaluator: ev } })).toBe(0);
    });

    it('input rules: a cancel never moves settleTxHash; a job candidate always writes its job; cancel shape', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const { id } = await stampOriginal(ev, job, 3, new Date());
      await expect(insertCandidateWithJobStamp(db, { candidate: cancelOf(ev, job, 3, id), job: { id: job, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true } })).rejects.toThrow(TypeError);
      await expect(insertCandidateWithJobStamp(db, { candidate: original(ev, job, 4) })).rejects.toThrow(TypeError);
      await expect(insertCandidateWithJobStamp(db, { candidate: { ...cancelOf(ev, null, 9, null), gasLimit: 30_000n } })).rejects.toThrow(TypeError);
      await expect(insertCandidateWithJobStamp(db, { candidate: { ...original(ev, job, 4), calldataHash: newHash() }, job: { id: job, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true } })).rejects.toThrow(/calldataHash/);
    });
  });

  describe('concurrency (R2-P3-3, R2-P2-3)', () => {
    it('two concurrent inserts for the same job and nonce: exactly one row, the other refused, nothing half-written', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const a = original(ev, job, 11);
      const b = original(ev, job, 11, { maxFeePerGas: 8_000_000n });
      const stamp = { id: job, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true };
      const res = await settled([insertCandidateWithJobStamp(db, { candidate: a, job: stamp }), insertCandidateWithJobStamp(db, { candidate: b, job: stamp })]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason instanceof SettlementSupersededError || rejected.reason instanceof CandidateConflictError).toBe(true);
      const rows = await db.evaluatorTransaction.findMany({ where: { jobId: job } });
      expect(rows).toHaveLength(1);
      const j = await db.job.findUniqueOrThrow({ where: { id: job } });
      expect(j.settleTxHash).toBe(rows[0]!.txHash);
    });

    it('two jobs racing for the same nonce: one NONCE_OCCUPIED (no involuntary replacement of another job)', async () => {
      const ev = newEvaluator();
      const [x, y] = [await newJob(), await newJob()];
      const res = await settled([
        insertCandidateWithJobStamp(db, { candidate: original(ev, x, 20), job: { id: x, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true } }),
        insertCandidateWithJobStamp(db, { candidate: original(ev, y, 20), job: { id: y, expectedSettleTxHash: null, setSettleTxHash: true, stampAttempt: true } }),
      ]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'NONCE_OCCUPIED' });
      expect(await liveNonces(db, CHAIN, ev)).toEqual([20]);
      // the loser's job was not stamped
      const losers = await db.job.findMany({ where: { id: { in: [x, y] }, settleTxHash: null } });
      expect(losers).toHaveLength(1);
      expect(losers[0]!.settleAttemptAt).toBeNull();
    });

    it('R2-P3-3: a live CANCEL or a live candidate of another decision blocks a new decision candidate of the job', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const o = await stampOriginal(ev, job, 30, new Date('2026-10-22T09:00:00Z'));
      // another decision (other calldata) at a new nonce while the first is live
      await expect(insertCandidateWithJobStamp(db, {
        candidate: original(ev, job, 31, { calldata: toHex('reject:other'), action: 'REJECT', decision: 'refund' }),
        job: { id: job, expectedSettleTxHash: o.c.txHash, setSettleTxHash: true, stampAttempt: true },
      })).rejects.toMatchObject({ code: 'LIVE_OTHER_DECISION' });
      // a cancel of nonce 30 (stamps settleAttemptAt only)
      const cancel = cancelOf(ev, job, 30, o.id);
      await insertCandidateWithJobStamp(db, { candidate: cancel, job: { id: job, expectedSettleTxHash: o.c.txHash, setSettleTxHash: false, stampAttempt: true } });
      const j = await db.job.findUniqueOrThrow({ where: { id: job } });
      expect(j.settleTxHash).toBe(o.c.txHash); // never points to a cancel
      // the same decision re-signed at a new nonce while the cancel is live: refused
      await expect(insertCandidateWithJobStamp(db, {
        candidate: original(ev, job, 31),
        job: { id: job, expectedSettleTxHash: o.c.txHash, setSettleTxHash: true, stampAttempt: true },
      })).rejects.toMatchObject({ code: 'LIVE_CANCEL' });
      // cancel of a job without a candidate at that nonce
      const other = await newJob();
      await expect(insertCandidateWithJobStamp(db, { candidate: cancelOf(ev, other, 30, o.id), job: { id: other, expectedSettleTxHash: null, setSettleTxHash: false, stampAttempt: true } }))
        .rejects.toMatchObject({ code: 'BAD_REPLACEMENT' });
    });

    it('a replacement must name a live candidate of the nonce and outbid every live one on both fees', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const o = await stampOriginal(ev, job, 40, new Date('2026-10-22T09:00:00Z'));
      const stamp = { id: job, expectedSettleTxHash: o.c.txHash, setSettleTxHash: true, stampAttempt: true };
      const sp = (over: Partial<NewCandidate>) => ({ ...original(ev, job, 40), kind: 'SPEED_UP' as const, replacesId: o.id, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 5_000_000n, ...over });
      await expect(insertCandidateWithJobStamp(db, { candidate: sp({ maxPriorityFeePerGas: 1_000_000n }), job: stamp })).rejects.toMatchObject({ code: 'BAD_REPLACEMENT' });
      await expect(insertCandidateWithJobStamp(db, { candidate: sp({ calldata: toHex('other') }), job: stamp })).rejects.toMatchObject({ code: 'BAD_REPLACEMENT' });
      await expect(insertCandidateWithJobStamp(db, { candidate: sp({ gasLimit: 100_000n }), job: stamp })).rejects.toMatchObject({ code: 'BAD_REPLACEMENT' });
      await expect(insertCandidateWithJobStamp(db, { candidate: { ...cancelOf(ev, null, 40, null) } })).rejects.toMatchObject({ code: 'BAD_REPLACEMENT' });
      const ok = await insertCandidateWithJobStamp(db, { candidate: sp({}), job: stamp, now: new Date('2026-10-22T09:05:00Z') });
      expect(ok.inserted).toBe(true);
      expect((await candidatesAtNonce(db, CHAIN, ev.toLowerCase(), 40)).map((r) => r.kind)).toEqual(['ORIGINAL', 'SPEED_UP']);
    });
  });

  describe('SCRIPT limits — durable, derived from rows (plan §3, rows 38 / 39)', () => {
    async function setupIncident(ev: string, head: number) {
      const { incident } = await openIncident(db, { chainId: CHAIN, evaluator: ev, headNonce: head, openedBy: 'owner' });
      return incident.id;
    }
    const scriptSpeedUp = (ev: string, job: string, nonce: number, replacesId: string, incidentId: string, maxFee: bigint, over: Partial<NewCandidate> = {}): NewCandidate => ({
      ...original(ev, job, nonce), kind: 'SPEED_UP', origin: 'SCRIPT', operator: 'owner', note: 'test', incidentId, replacesId,
      gasLimit: 1_000_000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: 5_000_000n, ...over,
    });

    it('budget race: parallel speed-ups at 4 nonces under an incident cap that fits 2 → exactly 2 rows', async () => {
      const ev = newEvaluator();
      const t0 = new Date('2026-10-22T08:00:00Z');
      const now = new Date('2026-10-22T08:30:00Z');
      const jobs = await Promise.all([0, 1, 2, 3].map(() => newJob()));
      // originals with gas limit 1M so the speed-ups may keep it
      const origs: Array<Awaited<ReturnType<typeof stampOriginal>>> = [];
      for (let i = 0; i < 4; i++) origs.push(await stampOriginal(ev, jobs[i]!, 50 + i, t0, { gasLimit: 1_000_000n }));
      const incidentId = await setupIncident(ev, 50);
      // each costs 1M × 0.7 gwei = 7e14 ≤ P11 (8e14); incident cap 1.5e15 → two fit
      const res = await settled(origs.map((o, i) => insertCandidateWithJobStamp(db, {
        candidate: scriptSpeedUp(ev, jobs[i]!, 50 + i, o.id, incidentId, 700_000_000n),
        job: { id: jobs[i]!, expectedSettleTxHash: o.c.txHash, setSettleTxHash: true, stampAttempt: true },
        budget: { caps: CAPS, incidentId, balanceWei: RICH },
        now,
      })));
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      for (const r of res.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        expect(r.reason).toBeInstanceOf(BudgetRefusedError);
        expect(r.reason).toMatchObject({ reason: 'INCIDENT_BUDGET_EXCEEDED' });
      }
      expect(await db.evaluatorTransaction.count({ where: { incidentId } })).toBe(2);
      // the refused jobs were not stamped by a speed-up
      const moved = await db.job.count({ where: { id: { in: jobs }, settleTxHash: { notIn: origs.map((o) => o.c.txHash) } } });
      expect(moved).toBe(2);
    });

    it('parallel speed-ups of the SAME nonce: one row (interval / superseded), never two', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const o = await stampOriginal(ev, job, 60, new Date('2026-10-22T07:00:00Z'), { gasLimit: 1_000_000n });
      const incidentId = await setupIncident(ev, 60);
      const now = new Date('2026-10-22T07:30:00Z');
      const res = await settled([100_000_000n, 110_000_000n, 120_000_000n].map((fee) => insertCandidateWithJobStamp(db, {
        candidate: scriptSpeedUp(ev, job, 60, o.id, incidentId, fee),
        job: { id: job, expectedSettleTxHash: o.c.txHash, setSettleTxHash: true, stampAttempt: true },
        budget: { caps: CAPS, incidentId, balanceWei: RICH },
        now,
      })));
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.evaluatorTransaction.count({ where: { chainId: CHAIN, evaluator: ev, nonce: 60, kind: 'SPEED_UP' } })).toBe(1);
    });

    it('row 38: 4th replacement and < 60 s interval refused, read from the rows by fresh clients ("restart")', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const t0 = new Date('2026-10-22T06:00:00Z');
      const o = await stampOriginal(ev, job, 70, t0, { gasLimit: 1_000_000n });
      const incidentId = await setupIncident(ev, 70);
      let prev = { id: o.id, hash: o.c.txHash };
      const fees = [100_000_000n, 120_000_000n, 140_000_000n];
      for (let i = 0; i < 3; i++) {
        const client = new PrismaClient(); // a fresh process: nothing in memory
        extraClients.push(client);
        const at = new Date(t0.getTime() + (i + 1) * 61_000);
        if (i === 1) {
          // 30 s after the previous one: refused
          const early = new Date(t0.getTime() + 61_000 + 30_000);
          await expect(insertCandidateWithJobStamp(client, {
            candidate: scriptSpeedUp(ev, job, 70, prev.id, incidentId, fees[i]!, { maxPriorityFeePerGas: BigInt(6 + i) * 1_000_000n }),
            job: { id: job, expectedSettleTxHash: prev.hash, setSettleTxHash: true, stampAttempt: true },
            budget: { caps: CAPS, incidentId, balanceWei: RICH }, now: early,
          })).rejects.toMatchObject({ reason: 'INTERVAL' });
        }
        const cand = scriptSpeedUp(ev, job, 70, prev.id, incidentId, fees[i]!, { maxPriorityFeePerGas: BigInt(6 + i) * 1_000_000n });
        const r = await insertCandidateWithJobStamp(client, {
          candidate: cand,
          job: { id: job, expectedSettleTxHash: prev.hash, setSettleTxHash: true, stampAttempt: true },
          budget: { caps: CAPS, incidentId, balanceWei: RICH }, now: at,
        });
        await client.$disconnect();
        prev = { id: r.id, hash: cand.txHash };
      }
      const client = new PrismaClient();
      extraClients.push(client);
      const err = await insertCandidateWithJobStamp(client, {
        candidate: scriptSpeedUp(ev, job, 70, prev.id, incidentId, 160_000_000n, { maxPriorityFeePerGas: 9_000_000n }),
        job: { id: job, expectedSettleTxHash: prev.hash, setSettleTxHash: true, stampAttempt: true },
        budget: { caps: CAPS, incidentId, balanceWei: RICH }, now: new Date(t0.getTime() + 10 * 60_000),
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: 'MAX_REPLACEMENTS' });
      expect(await db.evaluatorTransaction.count({ where: { chainId: CHAIN, evaluator: ev, nonce: 70 } })).toBe(4);
    });

    it('row 39: 24 h budget across incidents (two operators in sequence), reserve, no caps, closed incident', async () => {
      const ev = newEvaluator();
      const t0 = new Date('2026-10-22T05:00:00Z');
      const jobs = await Promise.all([0, 1, 2].map(() => newJob()));
      const origs: Array<Awaited<ReturnType<typeof stampOriginal>>> = [];
      for (let i = 0; i < 3; i++) origs.push(await stampOriginal(ev, jobs[i]!, 80 + i, t0, { gasLimit: 1_000_000n }));
      const inc1 = await setupIncident(ev, 80);
      const go = (i: number, incidentId: string, at: Date, over: { caps?: RecoveryCaps | null; balanceWei?: bigint } = {}) => insertCandidateWithJobStamp(db, {
        candidate: scriptSpeedUp(ev, jobs[i]!, 80 + i, origs[i]!.id, incidentId, 750_000_000n, { operator: i === 0 ? 'owner' : 'second-operator' }),
        job: { id: jobs[i]!, expectedSettleTxHash: origs[i]!.c.txHash, setSettleTxHash: true, stampAttempt: true },
        budget: { caps: over.caps === undefined ? CAPS : over.caps, incidentId, balanceWei: over.balanceWei ?? RICH }, now: at,
      });
      // no caps / reserve breached: refused before anything is written
      await expect(go(0, inc1, new Date(t0.getTime() + 120_000), { caps: null })).rejects.toMatchObject({ reason: 'NO_CAPS' });
      await expect(go(0, inc1, new Date(t0.getTime() + 120_000), { balanceWei: CAPS.reserveWei + 7n * 10n ** 14n })).rejects.toMatchObject({ reason: 'RESERVE_BREACHED' });
      await go(0, inc1, new Date(t0.getTime() + 120_000));
      expect(await closeIncident(db, inc1, 'head mined')).toBe(true);
      await expect(go(1, inc1, new Date(t0.getTime() + 180_000))).rejects.toMatchObject({ reason: 'INCIDENT_NOT_OPEN' });
      const inc2 = await setupIncident(ev, 81);
      await go(1, inc2, new Date(t0.getTime() + 240_000)); // 24 h: 7.5e14 × 2 = 1.5e15 ≤ 2e15
      // third nonce: incident 2 holds 7.5e14 + 7.5e14 = 1.5e15 (fits P12), but 24 h = 2.25e15 > P13
      await expect(go(2, inc2, new Date(t0.getTime() + 300_000))).rejects.toMatchObject({ reason: 'DAILY_BUDGET_EXCEEDED' });
      // 24 h later the first incident's spend left the window
      await go(2, inc2, new Date(t0.getTime() + 24 * 3_600_000 + 130_000));
    });
  });

  describe('status transitions (spec §2.4-3/4, R2-P2-2)', () => {
    it('monotonic and conditional; reorg only from proof level latest', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const { id } = await stampOriginal(ev, job, 90, new Date());
      expect(await markBroadcast(db, id, new Date('2026-10-22T11:00:00Z'))).toBe(true);
      expect(await markBroadcast(db, id, new Date('2026-10-22T11:01:00Z'))).toBe(true);
      let row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });
      expect(row.broadcastAt?.toISOString()).toBe('2026-10-22T11:00:00.000Z');
      expect(row.lastBroadcastAt?.toISOString()).toBe('2026-10-22T11:01:00.000Z');

      expect(await markAnswered(db, id, 'UNCERTAIN', 'boom at https://user:pw@rpc.example/abc')).toBe(true);
      row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('SIGNED');
      expect(row.sendError).toBeTruthy();
      expect(await markAnswered(db, id, 'SEND_UNCONFIRMED', 'not found anywhere')).toBe(true);
      expect(await markAnswered(db, id, 'SEND_UNCONFIRMED')).toBe(false);
      expect(await markAnswered(db, id, 'SENT')).toBe(true);
      expect(await markAnswered(db, id, 'SEND_UNCONFIRMED')).toBe(false); // never backwards
      expect((await liveCandidatesForJob(db, job)).map((c) => c.id)).toEqual([id]);

      await expect(markResolved(db, id, 'MINED_SUCCESS', { level: 'latest' })).rejects.toThrow(TypeError);
      expect(await markResolved(db, id, 'MINED_SUCCESS', { level: 'latest', blockNumber: 100n, blockHash: `0x${'a'.repeat(64)}` })).toBe(true);
      expect(await markResolved(db, id, 'DEAD', { level: 'proof' })).toBe(false); // terminal → another terminal: no
      expect(await markAnswered(db, id, 'SENT')).toBe(false);
      expect(await liveCandidatesForJob(db, job)).toEqual([]);

      // reorg: back to SENT, block cleared
      expect(await revertForReorg(db, id)).toBe(true);
      row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'SENT', proofLevel: null, minedBlockHash: null, minedBlockNumber: null, resolvedAt: null });
      // mined again in another block, then upgraded to proof (same block only)
      expect(await markResolved(db, id, 'MINED_SUCCESS', { level: 'latest', blockNumber: 101n, blockHash: `0x${'b'.repeat(64)}` })).toBe(true);
      expect(await markResolved(db, id, 'MINED_SUCCESS', { level: 'proof', blockNumber: 101n, blockHash: `0x${'c'.repeat(64)}` })).toBe(false);
      expect(await markResolved(db, id, 'MINED_SUCCESS', { level: 'proof', blockNumber: 101n, blockHash: `0x${'b'.repeat(64)}` })).toBe(true);
      expect(await revertForReorg(db, id)).toBe(false); // proof never comes back
      expect((await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } })).proofLevel).toBe('proof');
    });

    it('DEAD with proof; a DEAD-at-latest row never sent comes back as SIGNED on reorg', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const { id } = await stampOriginal(ev, job, 91, new Date());
      expect(await markResolved(db, id, 'DEAD', { level: 'latest' })).toBe(true);
      expect(await revertForReorg(db, id)).toBe(true);
      expect((await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } })).status).toBe('SIGNED');
      expect(await markResolved(db, id, 'DEAD', { level: 'proof' })).toBe(true);
      expect(await markResolved(db, id, 'DEAD', { level: 'latest' })).toBe(false); // no downgrade
    });

    it('CHECK constraints refuse inconsistent rows written around the ledger', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const { id } = await stampOriginal(ev, job, 92, new Date());
      await expect(db.evaluatorTransaction.update({ where: { id }, data: { status: 'MINED_SUCCESS' } })).rejects.toThrow(); // no proof level / block
      await expect(db.evaluatorTransaction.update({ where: { id }, data: { status: 'GONE' } })).rejects.toThrow();
      await expect(db.evaluatorTransaction.update({ where: { id }, data: { nonce: null } })).rejects.toThrow(); // only LEGACY may lack it
      await expect(db.evaluatorTransaction.update({ where: { id }, data: { kind: 'CANCEL' } })).rejects.toThrow(); // cancel shape
      await expect(db.evaluatorTransaction.update({ where: { id }, data: { origin: 'SCRIPT' } })).rejects.toThrow(); // operator + incident
      await expect(db.evaluatorTransaction.update({ where: { id }, data: { gasLimit: '1e6' } })).rejects.toThrow();
    });
  });

  describe('incidents: at most one open per evaluator key', () => {
    it('concurrent opens converge on one; a second open row is impossible; after close a new one opens', async () => {
      const ev = newEvaluator();
      const res = await Promise.all([0, 1, 2, 3].map((i) => openIncident(db, { chainId: CHAIN, evaluator: ev, headNonce: 5, openedBy: `op${i}` })));
      expect(new Set(res.map((r) => r.incident.id)).size).toBe(1);
      expect(res.filter((r) => r.opened)).toHaveLength(1);
      await expect(db.$executeRaw`INSERT INTO "EvaluatorRecoveryIncident" ("id","chainId","evaluator","headNonce","openedBy") VALUES (${`dup-${TAG}`}, ${CHAIN}, ${ev}, 5, 'x')`).rejects.toThrow();
      const first = res[0]!.incident.id;
      expect((await getOpenIncident(db, CHAIN, ev.toLowerCase()))?.id).toBe(first);
      expect(await closeIncident(db, first, 'done')).toBe(true);
      expect(await closeIncident(db, first, 'again')).toBe(false);
      expect(await getOpenIncident(db, CHAIN, ev)).toBeNull();
      const next = await openIncident(db, { chainId: CHAIN, evaluator: ev, headNonce: 6, openedBy: 'op' });
      expect(next.opened).toBe(true);
      expect(next.incident.id).not.toBe(first);
    });
  });

  describe('backfill (§10-2, P3-1) and external rows (§4.3)', () => {
    it('idempotent; unknown → nonce NULL SEND_UNCONFIRMED; a later read with the tx upgrades it once', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const hash = newHash();
      const a = await backfillLegacyCandidate(db, { chainId: CHAIN, evaluator: ev, jobId: job, txHash: hash, action: 'COMPLETE', decision: 'pay', tx: null });
      const b = await backfillLegacyCandidate(db, { chainId: CHAIN, evaluator: ev, jobId: job, txHash: hash, action: 'COMPLETE', decision: 'pay', tx: null });
      expect(a).toMatchObject({ inserted: true, upgraded: false });
      expect(b).toEqual({ id: a.id, inserted: false, upgraded: false });
      let row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id: a.id } });
      expect(row).toMatchObject({ kind: 'LEGACY', origin: 'BACKFILL', status: 'SEND_UNCONFIRMED', nonce: null, calldata: null, gasLimit: null });
      expect(await liveNonces(db, CHAIN, ev)).toEqual([]); // no nonce: outside the nonce rules
      // the job is not written by the backfill
      expect((await db.job.findUniqueOrThrow({ where: { id: job } })).settleTxHash).toBeNull();
      const tx = { nonce: 12, toAddress: ESCROW, calldata: COMPLETE_DATA(job), gasLimit: 700_000n, maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n, valueWei: 0n };
      const c = await backfillLegacyCandidate(db, { chainId: CHAIN, evaluator: ev, jobId: job, txHash: hash, action: 'COMPLETE', decision: 'pay', tx });
      expect(c).toEqual({ id: a.id, inserted: false, upgraded: true });
      row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id: a.id } });
      expect(row).toMatchObject({ nonce: 12, status: 'SENT', gasLimit: '700000', calldataHash: keccak256(COMPLETE_DATA(job)) });
      const d = await backfillLegacyCandidate(db, { chainId: CHAIN, evaluator: ev, jobId: job, txHash: hash, action: 'COMPLETE', decision: 'pay', tx: { ...tx, nonce: 13 } });
      expect(d.upgraded).toBe(false); // a row with a nonce is never rewritten
      expect(await liveNonces(db, CHAIN, ev)).toEqual([12]);
      const other = await newJob();
      await expect(backfillLegacyCandidate(db, { chainId: CHAIN, evaluator: ev, jobId: other, txHash: hash, action: 'COMPLETE', tx: null })).rejects.toMatchObject({ code: 'TX_HASH_REUSED' });
    });

    it('a foreign transaction is recorded once as EXTERNAL / RECONCILE, already mined', async () => {
      const ev = newEvaluator();
      const input = {
        chainId: CHAIN, evaluator: ev, nonce: 4, toAddress: ev, valueWei: 0n, calldata: '0x' as Hex, gasLimit: 21_000n,
        maxFeePerGas: 9_000_000n, maxPriorityFeePerGas: 1_000_000n, txHash: newHash(), status: 'MINED_SUCCESS' as const,
        proofLevel: 'latest' as const, blockNumber: 77n, blockHash: `0x${'d'.repeat(64)}`,
      };
      const a = await recordExternalCandidate(db, input);
      const b = await recordExternalCandidate(db, input);
      expect(a.inserted).toBe(true);
      expect(b).toEqual({ id: a.id, inserted: false });
      expect((await candidatesAtNonce(db, CHAIN, ev, 4))[0]).toMatchObject({ kind: 'EXTERNAL', origin: 'RECONCILE', status: 'MINED_SUCCESS', jobId: null });
    });
  });

  describe('ON DELETE RESTRICT', () => {
    it('a job with a candidate cannot be deleted (nor through its agent); deleting the candidate first works', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      await stampOriginal(ev, job, 95, new Date());
      await expect(db.job.delete({ where: { id: job } })).rejects.toThrow();
      expect(await db.job.count({ where: { id: job } })).toBe(1);
      await db.evaluatorTransaction.deleteMany({ where: { jobId: job } });
      await db.job.delete({ where: { id: job } });
      expect(await db.job.count({ where: { id: job } })).toBe(0);
    });

    it('an incident with script rows cannot be deleted', async () => {
      const ev = newEvaluator();
      const job = await newJob();
      const o = await stampOriginal(ev, job, 96, new Date('2026-10-22T04:00:00Z'), { gasLimit: 1_000_000n });
      const { incident } = await openIncident(db, { chainId: CHAIN, evaluator: ev, headNonce: 96, openedBy: 'owner' });
      await insertCandidateWithJobStamp(db, {
        candidate: { ...original(ev, job, 96), kind: 'SPEED_UP', origin: 'SCRIPT', operator: 'owner', incidentId: incident.id, replacesId: o.id, gasLimit: 1_000_000n, maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 5_000_000n },
        job: { id: job, expectedSettleTxHash: o.c.txHash, setSettleTxHash: true, stampAttempt: true },
        budget: { caps: CAPS, incidentId: incident.id, balanceWei: RICH }, now: new Date('2026-10-22T04:10:00Z'),
      });
      await expect(db.evaluatorRecoveryIncident.delete({ where: { id: incident.id } })).rejects.toThrow();
    });
  });

  describe('chain state (R2-P1-3: persisted clocks, alertedAt after delivery)', () => {
    it('head clocks keep the first observation per nonce and survive a fresh client', async () => {
      const ev = newEvaluator();
      const t1 = new Date('2026-10-22T03:00:00Z');
      const t2 = new Date('2026-10-22T03:05:00Z');
      expect((await observeHeadClock(db, CHAIN, ev, 'stuck', 7, t1))?.toISOString()).toBe(t1.toISOString());
      const fresh = new PrismaClient();
      extraClients.push(fresh);
      expect((await observeHeadClock(fresh, CHAIN, ev, 'stuck', 7, t2))?.toISOString()).toBe(t1.toISOString());
      expect((await observeHeadClock(fresh, CHAIN, ev, 'stuck', 8, t2))?.toISOString()).toBe(t2.toISOString());
      expect(await observeHeadClock(db, CHAIN, ev, 'stuck', null, t2)).toBeNull();
      expect((await observeHeadClock(db, CHAIN, ev, 'sendLost', 9, t1))?.toISOString()).toBe(t1.toISOString());
      const s = await readChainState(fresh, CHAIN, ev);
      expect(s).toMatchObject({ stuckSince: null, stuckNonce: null, sendLostNonce: 9 });
      expect(s!.sendLostSince?.toISOString()).toBe(t1.toISOString());
      await writeChainState(db, CHAIN, ev, { sendLostSince: null, sendLostNonce: null });
      expect(await readChainState(db, CHAIN, ev)).toMatchObject({ sendLostSince: null, sendLostNonce: null });
    });

    it('recordAlertDelivered merges per kind; nothing else writes alert times', async () => {
      const ev = newEvaluator();
      expect(await readChainState(db, CHAIN, ev)).toBeNull();
      await recordAlertDelivered(db, CHAIN, ev, 'evaluator-stuck', new Date('2026-10-22T02:00:00Z'));
      await Promise.all([
        recordAlertDelivered(db, CHAIN, ev, 'evaluator-send-lost', new Date('2026-10-22T02:01:00Z')),
        recordAlertDelivered(db, CHAIN, ev, 'rpc-node-unhealthy', new Date('2026-10-22T02:02:00Z')),
      ]);
      await recordAlertDelivered(db, CHAIN, ev, 'evaluator-stuck', new Date('2026-10-22T03:00:00Z'));
      const s = await readChainState(db, CHAIN, ev);
      expect(Object.fromEntries(Object.entries(s!.lastAlertAt).map(([k, v]) => [k, v.toISOString()]))).toEqual({
        'evaluator-stuck': '2026-10-22T03:00:00.000Z',
        'evaluator-send-lost': '2026-10-22T02:01:00.000Z',
        'rpc-node-unhealthy': '2026-10-22T02:02:00.000Z',
      });
    });

    it('node failures count consecutive errors per node and reset on success (concurrency-safe)', async () => {
      const ev = newEvaluator();
      await Promise.all([0, 1, 2, 3, 4].map(() => recordNodeRead(db, CHAIN, ev, 'rpc-a', false)));
      expect(await recordNodeRead(db, CHAIN, ev, 'rpc-a', false)).toBe(6);
      expect(await recordNodeRead(db, CHAIN, ev, 'rpc-b', false)).toBe(1);
      expect(await recordNodeRead(db, CHAIN, ev, 'rpc-a', true)).toBe(0);
      expect((await readChainState(db, CHAIN, ev))!.rpcFailures).toEqual({ 'rpc-a': 0, 'rpc-b': 1 });
    });

    it('proof head: seenAt moves only when the block advances', async () => {
      const ev = newEvaluator();
      const t = (m: number) => new Date(Date.UTC(2026, 9, 22, 1, m));
      expect(await observeSafeHead(db, CHAIN, ev, 100n, t(0))).toEqual({ advanced: true, seenAt: t(0) });
      expect(await observeSafeHead(db, CHAIN, ev, 100n, t(5))).toEqual({ advanced: false, seenAt: t(0) });
      expect(await observeSafeHead(db, CHAIN, ev, 99n, t(6))).toEqual({ advanced: false, seenAt: t(0) });
      expect(await observeSafeHead(db, CHAIN, ev, 101n, t(7))).toEqual({ advanced: true, seenAt: t(7) });
      expect((await readChainState(db, CHAIN, ev))!.safeHeadBlock).toBe(101n);
    });
  });
});
