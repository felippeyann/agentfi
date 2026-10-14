/**
 * Unit tests — payment-recovery scan vs ERC-8183 jobs (C3).
 *
 * A stale PAYMENT_PENDING job whose budget is escrowed on-chain must never be
 * "recovered" by the FAILED finalizer (that would release the DB reservation
 * while the USDC is still locked). The scan hands such jobs to the escrow
 * orchestrator and keeps the legacy behaviour for everything else.
 *
 * BullMQ is mocked so the worker body can be invoked directly.
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

const { mockDb, finalizeMock, recoverMock, reconcileMock, repollMock, reviewAlertsMock, sweepMock, strandedMock, captured } = vi.hoisted(() => ({
  mockDb: {
    job: { findMany: vi.fn() },
    transaction: { findUnique: vi.fn() },
  } as any,
  finalizeMock: vi.fn(),
  recoverMock: vi.fn(),
  reconcileMock: vi.fn(),
  repollMock: vi.fn(),
  reviewAlertsMock: vi.fn(),
  sweepMock: vi.fn(),
  strandedMock: vi.fn(),
  captured: { processor: null as null | (() => Promise<unknown>) },
}));
// A6 volume sweep: exercised on Postgres in daily-volume.db.test.ts; here only its place in the tick.
vi.mock('../services/policy/daily-volume.js', () => ({ sweepUnsettledVolume: sweepMock }));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation((_name: string, processor: () => Promise<unknown>) => {
    captured.processor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));
vi.mock('../db/client.js', () => ({ db: mockDb }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: finalizeMock }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  recoverErc8183Job: recoverMock,
  reconcileEscrowJobs: reconcileMock,
  alertExpiringReviews: reviewAlertsMock,
}));
vi.mock('../queues/transaction.queue.js', () => ({ repollSubmittedTransactionsNow: repollMock, transactionQueue: {} }));
// A6b stranded-QUEUED sweep: exercised on Postgres in broadcast-outcome.db.test.ts; here only its place in the tick.
vi.mock('../services/transaction/stranded-queued.js', () => ({ recoverStrandedQueuedTransactions: strandedMock }));

import { beforeEach, describe, expect, it } from 'vitest';

const OLD = new Date('2026-10-06T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  finalizeMock.mockResolvedValue(undefined);
  recoverMock.mockResolvedValue('resettled');
  repollMock.mockResolvedValue({ scanned: 0, confirmed: 0, reverted: 0, dropped: 0, pending: 0, errors: 0 });
  reconcileMock.mockResolvedValue({ stalledFunding: 0, lostRejects: 0, unsubmittedDeliverables: 0, stalledBindings: 0, outcomes: {} });
  reviewAlertsMock.mockResolvedValue(0);
  sweepMock.mockResolvedValue({ scanned: 0, committed: 0, released: 0, held: 0, errors: 0 });
  strandedMock.mockResolvedValue({ scanned: 0, live: 0, requeued: 0, settled: 0, leftAlone: 0, errors: 0 });
});

async function runScan() {
  const { startPaymentRecoveryWorker } = await import('../queues/payment-recovery.queue.js');
  startPaymentRecoveryWorker();
  expect(captured.processor).toBeTypeOf('function');
  return captured.processor!() as Promise<Record<string, number>>;
}

describe('payment recovery scan — ERC-8183 jobs', () => {
  it('hands escrow jobs to the orchestrator and never calls the FAILED finalizer for them', async () => {
    mockDb.job.findMany.mockResolvedValue([
      { id: 'escrow-submitted', updatedAt: OLD, escrowKind: 'erc8183', onChainStatus: 'SUBMITTED' },
      { id: 'escrow-funded', updatedAt: OLD, escrowKind: 'erc8183', onChainStatus: 'FUNDED' },
      { id: 'legacy-orphan', updatedAt: OLD, escrowKind: null, onChainStatus: null },
    ]);
    mockDb.transaction.findUnique.mockResolvedValue(null); // the legacy job has no Transaction → orphan refund

    const summary = await runScan();

    expect(recoverMock).toHaveBeenCalledTimes(2);
    expect(recoverMock).toHaveBeenCalledWith({ id: 'escrow-submitted', onChainStatus: 'SUBMITTED' });
    expect(recoverMock).toHaveBeenCalledWith({ id: 'escrow-funded', onChainStatus: 'FUNDED' });
    // The legacy orphan still gets today's treatment.
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'legacy-orphan', outcome: 'FAILED' }));
    expect(finalizeMock).not.toHaveBeenCalledWith(expect.objectContaining({ jobId: 'escrow-submitted' }));
    expect(finalizeMock).not.toHaveBeenCalledWith(expect.objectContaining({ jobId: 'escrow-funded' }));
    expect(summary).toMatchObject({ scanned: 3, erc8183Recovered: 2, refundedOrphan: 1 });
    // The escrow columns are part of the scan's select so the branch can decide.
    expect(mockDb.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ escrowKind: true, onChainStatus: true }) }),
    );
  });

  it('never looks up the legacy a2a-payment intent for an escrow job', async () => {
    mockDb.job.findMany.mockResolvedValue([{ id: 'escrow-1', updatedAt: OLD, escrowKind: 'erc8183', onChainStatus: 'SETTLING' }]);
    await runScan();
    expect(mockDb.transaction.findUnique).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});

describe('payment recovery tick — C3c passes', () => {
  it('re-polls stale SUBMITTED transactions first and reconciles escrow jobs last, with a stale cutoff', async () => {
    mockDb.job.findMany.mockResolvedValue([]);
    const order: string[] = [];
    repollMock.mockImplementation(async () => {
      order.push('repoll');
      return { scanned: 1, confirmed: 1, reverted: 0, dropped: 0, pending: 0, errors: 0 };
    });
    mockDb.job.findMany.mockImplementation(async () => {
      order.push('paymentPending');
      return [];
    });
    reconcileMock.mockImplementation(async () => {
      order.push('reconcile');
      return { stalledFunding: 2, lostRejects: 1, unsubmittedDeliverables: 0, stalledBindings: 0, outcomes: { advanced: 2, rejectScheduled: 1 } };
    });
    reviewAlertsMock.mockImplementation(async () => {
      order.push('reviewAlerts');
      return 1;
    });
    sweepMock.mockImplementation(async () => {
      order.push('volumeSweep');
      return { scanned: 1, committed: 1, released: 0, held: 0, errors: 0 };
    });
    strandedMock.mockImplementation(async () => {
      order.push('strandedQueued');
      return { scanned: 1, live: 0, requeued: 1, settled: 0, leftAlone: 0, errors: 0 };
    });

    const summary = await runScan();

    // C3d: the review expiry alerts, then the A6 volume sweep, then the A6b stranded-QUEUED sweep run last.
    expect(order).toEqual(['repoll', 'paymentPending', 'reconcile', 'reviewAlerts', 'volumeSweep', 'strandedQueued']);
    const [strandedDeps, strandedOpts] = strandedMock.mock.calls[0] as [{ queue: unknown }, { olderThan: Date; limit: number }];
    expect(strandedDeps.queue).toBeDefined();
    expect(strandedOpts.olderThan.getTime()).toBeLessThan(Date.now());
    expect(summary).toMatchObject({ strandedQueued: { requeued: 1 } });
    const [, sweepOpts] = sweepMock.mock.calls[0] as [unknown, { olderThan: Date; limit: number }];
    expect(sweepOpts.olderThan.getTime()).toBeLessThan(Date.now());
    expect(reviewAlertsMock).toHaveBeenCalledWith({ limit: expect.any(Number) });
    expect(repollMock).toHaveBeenCalledWith();
    const [opts] = reconcileMock.mock.calls[0] as [{ staleBefore: Date; limit: number }];
    expect(opts.staleBefore).toBeInstanceOf(Date);
    expect(opts.staleBefore.getTime()).toBeLessThan(Date.now());
    expect(opts.limit).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      repoll: { confirmed: 1 },
      escrowReconcile: { stalledFunding: 2, lostRejects: 1 },
      reviewAlerts: 1,
    });
  });

  it('a failing pass never skips the others', async () => {
    mockDb.job.findMany.mockResolvedValue([]);
    repollMock.mockRejectedValue(new Error('rpc down'));
    const summary = await runScan();
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ repoll: null, scanned: 0 });

    reconcileMock.mockRejectedValue(new Error('db hiccup'));
    repollMock.mockResolvedValue({ scanned: 0, confirmed: 0, reverted: 0, dropped: 0, pending: 0, errors: 0 });
    reviewAlertsMock.mockRejectedValue(new Error('db hiccup'));
    const second = await runScan();
    expect(second).toMatchObject({ escrowReconcile: null, repoll: { scanned: 0 }, reviewAlerts: null });
  });

  it('A6 re-review: a PAYMENT_PENDING scan that throws (a poison job) does not cost the later passes their tick', async () => {
    mockDb.job.findMany.mockRejectedValue(new Error('finalizer keeps throwing'));
    const summary = await runScan();
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reviewAlertsMock).toHaveBeenCalledTimes(1);
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ scanned: 0, volumeSweep: { committed: 0 } });

    sweepMock.mockRejectedValue(new Error('db hiccup'));
    strandedMock.mockRejectedValue(new Error('redis down'));
    mockDb.job.findMany.mockResolvedValue([]);
    expect(await runScan()).toMatchObject({ volumeSweep: null, strandedQueued: null });
  });
});

describe('payment recovery scan — A2A payment FAILED after a broadcast attempt (A6b)', () => {
  it('a FAILED payment stamped for broadcast without a recorded hash is not refunded; a dropped one (with its hash) and a never-broadcast one are', async () => {
    mockDb.job.findMany.mockResolvedValue([
      { id: 'stamped-no-hash', updatedAt: OLD, escrowKind: null, onChainStatus: null },
      { id: 'dropped', updatedAt: OLD, escrowKind: null, onChainStatus: null },
      { id: 'never-broadcast', updatedAt: OLD, escrowKind: null, onChainStatus: null },
    ]);
    mockDb.transaction.findUnique.mockImplementation(async ({ where }: { where: { intentId: string } }) => {
      if (where.intentId === 'a2a-payment:stamped-no-hash') {
        return { id: 'tx-1', status: 'FAILED', error: 'both RPCs timed out', txHash: null, broadcastAttemptedAt: OLD };
      }
      if (where.intentId === 'a2a-payment:dropped') {
        return { id: 'tx-2', status: 'FAILED', error: 'Dropped', txHash: '0xabc', broadcastAttemptedAt: OLD };
      }
      return { id: 'tx-3', status: 'FAILED', error: 'estimateGas reverted', txHash: null, broadcastAttemptedAt: null };
    });

    const summary = await runScan();

    expect(finalizeMock).not.toHaveBeenCalledWith(expect.objectContaining({ jobId: 'stamped-no-hash' }));
    expect(finalizeMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'dropped', outcome: 'FAILED' }));
    expect(finalizeMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'never-broadcast', outcome: 'FAILED' }));
    expect(summary).toMatchObject({ uncertain: 1, finalizedFailed: 2 });
  });
});
