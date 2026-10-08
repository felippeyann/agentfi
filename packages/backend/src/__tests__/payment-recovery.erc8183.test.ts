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

const { mockDb, finalizeMock, recoverMock, reconcileMock, repollMock, captured } = vi.hoisted(() => ({
  mockDb: {
    job: { findMany: vi.fn() },
    transaction: { findUnique: vi.fn() },
  } as any,
  finalizeMock: vi.fn(),
  recoverMock: vi.fn(),
  reconcileMock: vi.fn(),
  repollMock: vi.fn(),
  captured: { processor: null as null | (() => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation((_name: string, processor: () => Promise<unknown>) => {
    captured.processor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));
vi.mock('../db/client.js', () => ({ db: mockDb }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: finalizeMock }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ recoverErc8183Job: recoverMock, reconcileEscrowJobs: reconcileMock }));
vi.mock('../queues/transaction.queue.js', () => ({ repollSubmittedTransactionsNow: repollMock }));

import { beforeEach, describe, expect, it } from 'vitest';

const OLD = new Date('2026-10-06T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  finalizeMock.mockResolvedValue(undefined);
  recoverMock.mockResolvedValue('resettled');
  repollMock.mockResolvedValue({ scanned: 0, confirmed: 0, reverted: 0, dropped: 0, pending: 0, errors: 0 });
  reconcileMock.mockResolvedValue({ stalledFunding: 0, lostRejects: 0, unsubmittedDeliverables: 0, stalledBindings: 0, outcomes: {} });
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

    const summary = await runScan();

    expect(order).toEqual(['repoll', 'paymentPending', 'reconcile']);
    expect(repollMock).toHaveBeenCalledWith();
    const [opts] = reconcileMock.mock.calls[0] as [{ staleBefore: Date; limit: number }];
    expect(opts.staleBefore).toBeInstanceOf(Date);
    expect(opts.staleBefore.getTime()).toBeLessThan(Date.now());
    expect(opts.limit).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      repoll: { confirmed: 1 },
      escrowReconcile: { stalledFunding: 2, lostRejects: 1 },
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
    const second = await runScan();
    expect(second).toMatchObject({ escrowReconcile: null, repoll: { scanned: 0 } });
  });
});
