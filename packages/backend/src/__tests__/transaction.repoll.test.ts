/**
 * Unit tests — confirmation exactly once, and the re-poll of SUBMITTED rows (C3c).
 *
 *  - MonitorService: out of polling attempts it no longer marks the row
 *    FAILED (a transaction without a receipt is unknown, not failed); a
 *    receipt is recorded with a conditional SUBMITTED → CONFIRMED/REVERTED
 *    write and `recorded` says whether this caller made it.
 *  - processTransactionJob: the post-confirmation outcome runs only for the
 *    observer that recorded the receipt (not on TIMEOUT, not twice).
 *  - repollSubmittedTransactions: replays a receipt nobody recorded through
 *    the same outcome path (exactly once with a concurrent observer), leaves
 *    a transaction alone while a node knows it, declares one dropped only
 *    after the grace period, and rebuilds the accounting input from
 *    `metadata.queuePayload`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Hex, TransactionReceipt } from 'viem';

const { finalizeMock, weiToUsdMock, escrowOutcomeMock } = vi.hoisted(() => ({
  finalizeMock: vi.fn(),
  weiToUsdMock: vi.fn(),
  escrowOutcomeMock: vi.fn(),
}));

vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: finalizeMock }));
vi.mock('../services/transaction/price.service.js', () => ({ weiToUsd: weiToUsdMock }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ onEscrowTxOutcome: escrowOutcomeMock }));
vi.mock('../api/middleware/logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));
vi.mock('../config/chains.js', () => ({ getChain: () => ({}), withFallbackRpc: vi.fn() }));

import { processTransactionJob, repollSubmittedTransactions, type TransactionJobData } from '../queues/transaction.processor.js';
import { MonitorService, recordReceiptOnce } from '../services/transaction/monitor.service.js';

type Row = {
  id: string;
  status: string;
  txHash: string | null;
  chainId: number;
  agentId: string;
  error: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
  agent?: { active: boolean; policy: null };
};

const NOW = new Date('2026-10-08T12:00:00.000Z');
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;

function makeDb(rows: Row[]) {
  const table = new Map(rows.map((r) => [r.id, r]));
  const db = {
    transaction: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => table.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(table.get(where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Partial<Row> }) => {
        const row = table.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findMany: vi.fn(async ({ where, take }: { where: { status: string; updatedAt: { lte: Date } }; take: number }) =>
        [...table.values()].filter((r) => r.status === where.status && r.txHash && r.updatedAt <= where.updatedAt.lte).slice(0, take),
      ),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  return { db: db as unknown as PrismaClient, table, mock: db };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'tx-1',
    status: 'SUBMITTED',
    txHash: HASH,
    chainId: 84532,
    agentId: 'agent-1',
    error: null,
    metadata: { erc8183: true, jobId: 'job-1', escrowStep: 'fund', queuePayload: { value: '0', feeAmountWei: '0', feeBps: 0, routedViaExecutor: false } },
    updatedAt: new Date(NOW.getTime() - 60 * 60_000),
    ...overrides,
  };
}

const receipt = (status: 'success' | 'reverted') => ({ status, gasUsed: 21_000n, effectiveGasPrice: 1n, logs: [] }) as unknown as TransactionReceipt;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const feeService = { incrementTxUsage: vi.fn(), recordFeeEvent: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  finalizeMock.mockResolvedValue(undefined);
  weiToUsdMock.mockResolvedValue('0');
  escrowOutcomeMock.mockResolvedValue(undefined);
});

describe('MonitorService', () => {
  it('out of attempts: TIMEOUT, the row stays SUBMITTED (never FAILED from a missing receipt)', async () => {
    const { db, table } = makeDb([row()]);
    const monitor = new MonitorService(db, {
      getReceipt: async () => Promise.reject(new Error('receipt not found')),
      sleep: async () => undefined,
    });
    const outcome = await monitor.waitForConfirmation({ txHash: HASH, chainId: 84532, transactionId: 'tx-1', maxAttempts: 3 });
    expect(outcome).toEqual({ status: 'TIMEOUT', recorded: false });
    expect(table.get('tx-1')).toMatchObject({ status: 'SUBMITTED', error: null });
  });

  it('records a receipt once: the second observer gets recorded=false', async () => {
    const { db, table } = makeDb([row()]);
    expect(await recordReceiptOnce(db, 'tx-1', receipt('success'))).toEqual({ status: 'CONFIRMED', recorded: true });
    expect(await recordReceiptOnce(db, 'tx-1', receipt('success'))).toEqual({ status: 'CONFIRMED', recorded: false });
    expect(table.get('tx-1')).toMatchObject({ status: 'CONFIRMED' });
  });
});

describe('processTransactionJob — outcome only for the observer that recorded the receipt', () => {
  const data: TransactionJobData = {
    transactionId: 'tx-1',
    chainId: 84532,
    walletId: 'w',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    data: '0x',
    value: '0',
    agentId: 'agent-1',
    tier: 'FREE',
    feeAmountWei: '0',
    feeUsd: '0',
    feeBps: 0,
  };

  async function run(outcome: { status: 'CONFIRMED' | 'REVERTED' | 'TIMEOUT'; recorded: boolean }) {
    const { db, table } = makeDb([row({ status: 'QUEUED', txHash: null, agent: { active: true, policy: null } })]);
    let monitoring: Promise<void> = Promise.resolve();
    await processTransactionJob(
      { data, attemptsMade: 0, opts: { attempts: 3 } },
      {
        db,
        submitter: { submit: async () => ({ txHash: HASH, nonce: 0 }) },
        monitor: {
          waitForConfirmation: async () => {
            if (outcome.recorded) table.get('tx-1')!.status = outcome.status;
            return outcome as never;
          },
        },
        feeService,
        logger,
        trackMonitor: (p) => {
          monitoring = p;
        },
      },
    );
    await monitoring;
  }

  it('TIMEOUT → nothing (left SUBMITTED for the re-poll)', async () => {
    await run({ status: 'TIMEOUT', recorded: false });
    expect(escrowOutcomeMock).not.toHaveBeenCalled();
    expect(feeService.incrementTxUsage).not.toHaveBeenCalled();
  });

  it('receipt recorded by another observer → nothing here', async () => {
    await run({ status: 'CONFIRMED', recorded: false });
    expect(escrowOutcomeMock).not.toHaveBeenCalled();
  });

  it('receipt recorded here → the escrow outcome runs once', async () => {
    await run({ status: 'CONFIRMED', recorded: true });
    expect(escrowOutcomeMock).toHaveBeenCalledTimes(1);
    expect(escrowOutcomeMock).toHaveBeenCalledWith({ transactionId: 'tx-1', status: 'CONFIRMED', error: null });
  });
});

describe('repollSubmittedTransactions', () => {
  const deps = (db: PrismaClient, opts: { receipt?: TransactionReceipt | null; known?: boolean }) => ({
    db,
    feeService,
    logger,
    getReceipt: vi.fn(async () => opts.receipt ?? null),
    isKnownTransaction: vi.fn(async () => opts.known ?? false),
    now: () => NOW,
  });

  it('replays a receipt nobody recorded through the outcome path, exactly once', async () => {
    const { db, table } = makeDb([row()]);
    const d = deps(db, { receipt: receipt('success') });
    const summary = await repollSubmittedTransactions(d, { olderThanMs: 0, dropAfterMs: 30 * 60_000, limit: 10 });
    expect(summary).toMatchObject({ scanned: 1, confirmed: 1 });
    expect(table.get('tx-1')!.status).toBe('CONFIRMED');
    expect(escrowOutcomeMock).toHaveBeenCalledWith({ transactionId: 'tx-1', status: 'CONFIRMED', error: null });
    expect(feeService.incrementTxUsage).toHaveBeenCalledWith('agent-1');

    // A second pass (another process at boot) finds nothing left to do.
    const again = await repollSubmittedTransactions(d, { olderThanMs: 0, dropAfterMs: 30 * 60_000, limit: 10 });
    expect(again.scanned).toBe(0);
    expect(escrowOutcomeMock).toHaveBeenCalledTimes(1);
  });

  it('a reverted receipt is replayed as REVERTED (the orchestrator then reads the chain)', async () => {
    const { db } = makeDb([row()]);
    await repollSubmittedTransactions(deps(db, { receipt: receipt('reverted') }), { olderThanMs: 0, dropAfterMs: 0, limit: 10 });
    expect(escrowOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'tx-1', status: 'REVERTED' }));
  });

  it('no receipt: left alone while a node knows it, and before the drop grace even when none does', async () => {
    const { db, table } = makeDb([row()]);
    const known = await repollSubmittedTransactions(deps(db, { known: true }), { olderThanMs: 0, dropAfterMs: 0, limit: 10 });
    expect(known.pending).toBe(1);
    const young = await repollSubmittedTransactions(deps(db, { known: false }), { olderThanMs: 0, dropAfterMs: 2 * 60 * 60_000, limit: 10 });
    expect(young.pending).toBe(1);
    expect(table.get('tx-1')!.status).toBe('SUBMITTED');
    expect(escrowOutcomeMock).not.toHaveBeenCalled();
  });

  it('no receipt and unknown past the grace → FAILED (dropped) and the outcome runs once', async () => {
    const { db, table } = makeDb([row()]);
    const summary = await repollSubmittedTransactions(deps(db, { known: false }), { olderThanMs: 0, dropAfterMs: 30 * 60_000, limit: 10 });
    expect(summary.dropped).toBe(1);
    expect(table.get('tx-1')).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/^Dropped: no receipt and unknown to the RPC/) });
    expect(escrowOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'tx-1', status: 'FAILED' }));
  });

  it('an RPC error leaves the row for the next tick', async () => {
    const { db, table } = makeDb([row()]);
    const d = { ...deps(db, {}), getReceipt: vi.fn(async () => Promise.reject(new Error('rpc down'))) };
    const summary = await repollSubmittedTransactions(d, { olderThanMs: 0, dropAfterMs: 0, limit: 10 });
    expect(summary.errors).toBe(1);
    expect(table.get('tx-1')!.status).toBe('SUBMITTED');
  });

  it('an A2A payment replay finalizes the job and accounts the fee from metadata.queuePayload', async () => {
    const { db } = makeDb([
      row({ metadata: { a2aPayment: true, jobId: 'job-9', queuePayload: { value: '1000', feeAmountWei: '50', feeBps: 30, routedViaExecutor: true } } }),
    ]);
    weiToUsdMock.mockResolvedValue('1.5');
    await repollSubmittedTransactions(deps(db, { receipt: receipt('success') }), { olderThanMs: 0, dropAfterMs: 0, limit: 10 });
    expect(finalizeMock).toHaveBeenCalledWith({ jobId: 'job-9', transactionId: 'tx-1', outcome: 'CONFIRMED' });
    expect(feeService.recordFeeEvent).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'tx-1', feeAmountWei: 50n, feeBps: 30 }));
  });
});
