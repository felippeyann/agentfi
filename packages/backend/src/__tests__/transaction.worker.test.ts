/**
 * Unit tests — transaction worker processor (`queues/transaction.processor.ts`).
 *
 * Runs `processTransactionJob` / `handleFailedTransactionJob` against a
 * mocked Prisma client, submitter and monitor — no BullMQ, no Redis.
 *
 * Pins the A3 regression fix: a broadcast failure must leave the transaction
 * QUEUED (so BullMQ retries and, after the last attempt, the failed handler
 * marks it FAILED and finalizes an A2A payment). The old ordering wrote
 * SUBMITTED *before* broadcasting, every retry was skipped by the guard, and
 * the transaction — and its A2A payment — were stuck forever.
 *
 *  - submitter throws → error propagates, status stays QUEUED, no txHash
 *  - retry proceeds → ONE update `{ status: 'SUBMITTED', txHash }`
 *  - third delivery → skipped, no second broadcast
 *  - paused agent → FAILED, no submit, returns without throwing
 *  - failed handler, last attempt, A2A payment → FAILED + DLQ + finalize
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Hex } from 'viem';

const { finalizeMock, weiToUsdMock, escrowOutcomeMock } = vi.hoisted(() => ({
  finalizeMock: vi.fn(),
  weiToUsdMock: vi.fn(),
  escrowOutcomeMock: vi.fn(),
}));

// The finalizer pulls in the real `db` singleton, the logger/env chain and the
// escrow service (which instantiates BullMQ queues). Stub the module.
vi.mock('../services/job/payment-finalizer.service.js', () => ({
  finalizeA2APaymentJob: finalizeMock,
}));
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: weiToUsdMock,
}));
// The ERC-8183 runtime binds the real db / queues / signer. Stub the module.
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: escrowOutcomeMock,
}));

import {
  handleFailedTransactionJob,
  isLastAttempt,
  processTransactionJob,
  type TransactionJobData,
  type TransactionJobLike,
  type TransactionProcessorDeps,
} from '../queues/transaction.processor.js';
import { PAUSED_BEFORE_SUBMISSION } from '../services/transaction/pre-submit-guard.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const TX_ID = 'tx-1';
const TX_HASH = '0xabc0000000000000000000000000000000000000000000000000000000000001' as Hex;

const JOB_DATA: TransactionJobData = {
  transactionId: TX_ID,
  chainId: 8453,
  walletId: 'wallet-1',
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  data: '0x',
  value: '1000',
  agentId: 'agent-1',
  tier: 'FREE',
  feeAmountWei: '0',
  feeUsd: '0',
  feeBps: 30,
};

type TxRow = {
  id: string;
  status: 'QUEUED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  txHash: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  agent: { active: boolean; policy: { active: boolean; expiresAt: Date | null } | null };
};

function txRow(overrides: Partial<TxRow> = {}): TxRow {
  return {
    id: TX_ID,
    status: 'QUEUED',
    txHash: null,
    error: null,
    metadata: null,
    agent: { active: true, policy: { active: true, expiresAt: null } },
    ...overrides,
  };
}

/** In-memory stand-in for the Transaction table: `update` mutates the row `findUnique` returns. */
function makeDb(row: TxRow) {
  const findUnique = vi.fn(async () => row);
  const update = vi.fn(async ({ data }: { data: Partial<TxRow> }) => {
    Object.assign(row, data);
    return row;
  });
  const db = {
    transaction: { findUnique, update },
    $executeRaw: vi.fn().mockResolvedValue(1),
  } as unknown as PrismaClient;
  return { db, findUnique, update, row };
}

function makeDeps(row: TxRow) {
  const store = makeDb(row);
  const submitter = { submit: vi.fn().mockResolvedValue({ txHash: TX_HASH, nonce: 1 }) };
  const monitor = { waitForConfirmation: vi.fn(() => new Promise<void>(() => {})) }; // never settles
  const feeService = { incrementTxUsage: vi.fn(), recordFeeEvent: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deadLetterQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const deps: TransactionProcessorDeps = {
    db: store.db,
    submitter,
    monitor,
    feeService,
    logger,
  };
  return { ...store, deps, submitter, monitor, feeService, logger, deadLetterQueue };
}

function job(overrides: Partial<TransactionJobLike> = {}): TransactionJobLike {
  return { data: JOB_DATA, attemptsMade: 1, opts: { attempts: 3 }, ...overrides };
}

/** Every update that sets SUBMITTED must carry the txHash in the same write. */
function expectSubmittedAlwaysWithHash(update: { mock: { calls: unknown[][] } }) {
  for (const [call] of update.mock.calls as Array<[{ data: Partial<TxRow> }]>) {
    if (call.data.status === 'SUBMITTED') {
      expect(call.data.txHash).toBe(TX_HASH);
    }
  }
}

beforeEach(() => {
  finalizeMock.mockReset().mockResolvedValue(undefined);
  weiToUsdMock.mockReset().mockResolvedValue('0');
  escrowOutcomeMock.mockReset().mockResolvedValue(undefined);
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe('processTransactionJob — successful broadcast', () => {
  it('submits, then writes SUBMITTED + txHash in ONE update and starts the monitor', async () => {
    const { deps, submitter, monitor, update, row } = makeDeps(txRow());

    const result = await processTransactionJob(job(), deps);

    expect(result).toEqual({ txHash: TX_HASH });
    expect(submitter.submit).toHaveBeenCalledTimes(1);
    expect(submitter.submit).toHaveBeenCalledWith({
      chainId: JOB_DATA.chainId,
      walletId: JOB_DATA.walletId,
      from: JOB_DATA.from,
      to: JOB_DATA.to,
      data: JOB_DATA.data,
      value: 1000n,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'SUBMITTED', txHash: TX_HASH },
    });
    expect(row).toMatchObject({ status: 'SUBMITTED', txHash: TX_HASH });
    expect(monitor.waitForConfirmation).toHaveBeenCalledWith({
      txHash: TX_HASH,
      chainId: JOB_DATA.chainId,
      transactionId: TX_ID,
    });
  });

  it('submit happens BEFORE any status write (the tx is QUEUED while broadcasting)', async () => {
    const { deps, submitter, update, row } = makeDeps(txRow());
    let statusDuringBroadcast: TxRow['status'] | undefined;
    submitter.submit.mockImplementation(async () => {
      statusDuringBroadcast = row.status;
      return { txHash: TX_HASH, nonce: 1 };
    });

    await processTransactionJob(job(), deps);

    expect(statusDuringBroadcast).toBe('QUEUED');
    expect(update.mock.invocationCallOrder[0]).toBeGreaterThan(
      submitter.submit.mock.invocationCallOrder[0]!,
    );
  });
});

// ── A3 regression: broadcast failure ───────────────────────────────────────

describe('processTransactionJob — broadcast failure', () => {
  it('propagates the error (so BullMQ retries) and leaves the tx QUEUED with no txHash', async () => {
    const { deps, submitter, update, row, monitor } = makeDeps(txRow());
    submitter.submit.mockRejectedValue(new Error('rpc down'));

    await expect(processTransactionJob(job(), deps)).rejects.toThrow('rpc down');

    expect(update).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'QUEUED', txHash: null });
    expect(monitor.waitForConfirmation).not.toHaveBeenCalled();
  });

  it('retry after a failure proceeds: broadcasts again and writes SUBMITTED + txHash once', async () => {
    const { deps, submitter, update, row } = makeDeps(txRow());
    submitter.submit
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce({ txHash: TX_HASH, nonce: 1 });

    await expect(processTransactionJob(job({ attemptsMade: 1 }), deps)).rejects.toThrow('rpc down');
    const second = await processTransactionJob(job({ attemptsMade: 2 }), deps);

    expect(second).toEqual({ txHash: TX_HASH });
    expect(submitter.submit).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'SUBMITTED', txHash: TX_HASH },
    });
    expect(row).toMatchObject({ status: 'SUBMITTED', txHash: TX_HASH });
    expectSubmittedAlwaysWithHash(update);
  });

  it('a third delivery after SUBMITTED is skipped — no second broadcast, no write', async () => {
    const { deps, submitter, update, logger } = makeDeps(txRow());
    submitter.submit
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce({ txHash: TX_HASH, nonce: 1 });

    await expect(processTransactionJob(job({ attemptsMade: 1 }), deps)).rejects.toThrow();
    await processTransactionJob(job({ attemptsMade: 2 }), deps);
    const third = await processTransactionJob(job({ attemptsMade: 3 }), deps);

    expect(third).toEqual({
      txHash: null,
      outcome: 'skipped',
      reason: expect.stringMatching(new RegExp(`SUBMITTED.*${TX_HASH}`)),
    });
    expect(submitter.submit).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: TX_ID }),
      expect.stringContaining('skipped'),
    );
  });

  it('every retry of a persistently failing broadcast throws — none is silently skipped', async () => {
    // This is the regression: with SUBMITTED written first, attempts 2 and 3
    // returned "skipped" (success for BullMQ), the failed handler never fired
    // and the tx sat in SUBMITTED forever.
    const { deps, submitter, row, update } = makeDeps(txRow());
    submitter.submit.mockRejectedValue(new Error('rpc down'));

    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(processTransactionJob(job({ attemptsMade: attempt }), deps)).rejects.toThrow(
        'rpc down',
      );
    }

    expect(submitter.submit).toHaveBeenCalledTimes(3);
    expect(update).not.toHaveBeenCalled();
    expect(row.status).toBe('QUEUED');
  });
});

// ── Guard outcomes ─────────────────────────────────────────────────────────

describe('processTransactionJob — pre-submit guard', () => {
  it('paused agent → marked FAILED, no submit, returns `blocked` without throwing', async () => {
    const { deps, submitter, update, row } = makeDeps(
      txRow({ agent: { active: false, policy: { active: true, expiresAt: null } } }),
    );

    const result = await processTransactionJob(job(), deps);

    expect(result).toEqual({ txHash: null, outcome: 'blocked', reason: PAUSED_BEFORE_SUBMISSION });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: PAUSED_BEFORE_SUBMISSION },
    });
    expect(row.status).toBe('FAILED');
  });

  it('already SUBMITTED with a hash → skipped, nothing written', async () => {
    const { deps, submitter, update } = makeDeps(txRow({ status: 'SUBMITTED', txHash: TX_HASH }));

    const result = await processTransactionJob(job(), deps);

    expect(result).toMatchObject({ txHash: null, outcome: 'skipped' });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

// ── Permanent failure handler ──────────────────────────────────────────────

describe('handleFailedTransactionJob', () => {
  const err = new Error('rpc down');

  it('is a no-op before the last attempt', async () => {
    const { db, update, deadLetterQueue, logger } = makeDeps(txRow());

    await handleFailedTransactionJob(job({ attemptsMade: 1, opts: { attempts: 3 } }), err, {
      db,
      deadLetterQueue,
      logger,
    });

    expect(update).not.toHaveBeenCalled();
    expect(deadLetterQueue.add).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an undefined job', async () => {
    const { db, update, deadLetterQueue, logger } = makeDeps(txRow());
    await handleFailedTransactionJob(undefined, err, { db, deadLetterQueue, logger });
    expect(update).not.toHaveBeenCalled();
  });

  it('last attempt + A2A payment → FAILED, dead-lettered, Job finalized as FAILED', async () => {
    const { db, update, row, deadLetterQueue, logger } = makeDeps(
      txRow({ metadata: { a2aPayment: true, jobId: 'job-42' } }),
    );

    await handleFailedTransactionJob(job({ attemptsMade: 3, opts: { attempts: 3 } }), err, {
      db,
      deadLetterQueue,
      logger,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: 'rpc down' },
    });
    expect(row).toMatchObject({ status: 'FAILED', error: 'rpc down' });
    expect(deadLetterQueue.add).toHaveBeenCalledWith(
      'dlq',
      expect.objectContaining({ transactionId: TX_ID, error: 'rpc down', attempts: 3 }),
    );
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledWith({
      jobId: 'job-42',
      transactionId: TX_ID,
      outcome: 'FAILED',
      reason: 'rpc down',
    });
  });

  it('last attempt, ordinary tx → FAILED + DLQ, finalizer untouched', async () => {
    const { db, row, deadLetterQueue, logger } = makeDeps(txRow());

    await handleFailedTransactionJob(job({ attemptsMade: 3, opts: { attempts: 3 } }), err, {
      db,
      deadLetterQueue,
      logger,
    });

    expect(row.status).toBe('FAILED');
    expect(deadLetterQueue.add).toHaveBeenCalledTimes(1);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('end to end: A2A broadcast fails on every attempt → the handler path is reachable and finalizes', async () => {
    const { deps, submitter, row, deadLetterQueue, logger } = makeDeps(
      txRow({ metadata: { a2aPayment: true, jobId: 'job-42' } }),
    );
    submitter.submit.mockRejectedValue(err);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(processTransactionJob(job({ attemptsMade: attempt }), deps)).rejects.toThrow();
    }
    await handleFailedTransactionJob(job({ attemptsMade: 3, opts: { attempts: 3 } }), err, {
      db: deps.db,
      deadLetterQueue,
      logger,
    });

    expect(row.status).toBe('FAILED');
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-42', outcome: 'FAILED' }),
    );
  });

  it('DLQ / DB / finalizer failures are logged, never thrown', async () => {
    const { db, deadLetterQueue, logger } = makeDeps(
      txRow({ metadata: { a2aPayment: true, jobId: 'job-42' } }),
    );
    deadLetterQueue.add.mockRejectedValue(new Error('redis gone'));
    finalizeMock.mockRejectedValue(new Error('job table unavailable'));

    await expect(
      handleFailedTransactionJob(job({ attemptsMade: 3, opts: { attempts: 3 } }), err, {
        db,
        deadLetterQueue,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: TX_ID }),
      'Failed to enqueue to dead-letter queue',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: TX_ID }),
      'Failed to finalize A2A payment job after permanent broadcast failure',
    );
  });
});

// ── ERC-8183 escrow steps (C3) ─────────────────────────────────────────────

describe('ERC-8183 escrow steps route to the orchestrator, not the A2A finalizer', () => {
  const ESCROW_META = { erc8183: true, jobId: 'job-7', escrowStep: 'fund' };

  it('post-confirmation: CONFIRMED step → onEscrowTxOutcome(CONFIRMED)', async () => {
    const { deps, monitor, row } = makeDeps(txRow({ metadata: ESCROW_META }));
    monitor.waitForConfirmation.mockImplementation(async () => {
      row.status = 'CONFIRMED';
    });

    await processTransactionJob(job(), deps);
    await vi.waitFor(() => expect(escrowOutcomeMock).toHaveBeenCalledTimes(1));

    expect(escrowOutcomeMock).toHaveBeenCalledWith({ transactionId: TX_ID, status: 'CONFIRMED', error: null });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('post-confirmation: timed-out step → onEscrowTxOutcome(FAILED) with the recorded error', async () => {
    const { deps, monitor, row } = makeDeps(txRow({ metadata: ESCROW_META }));
    monitor.waitForConfirmation.mockImplementation(async () => {
      row.status = 'FAILED';
      row.error = 'Confirmation timeout after max polling attempts';
    });

    await processTransactionJob(job(), deps);
    await vi.waitFor(() => expect(escrowOutcomeMock).toHaveBeenCalledTimes(1));

    expect(escrowOutcomeMock).toHaveBeenCalledWith({
      transactionId: TX_ID,
      status: 'FAILED',
      error: 'Confirmation timeout after max polling attempts',
    });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('failed handler, last attempt → FAILED + DLQ + onEscrowTxOutcome(FAILED); finalizer untouched', async () => {
    const { db, row, deadLetterQueue, logger } = makeDeps(txRow({ metadata: ESCROW_META }));

    await handleFailedTransactionJob(job({ attemptsMade: 3, opts: { attempts: 3 } }), new Error('rpc down'), {
      db,
      deadLetterQueue,
      logger,
    });

    expect(row.status).toBe('FAILED');
    expect(deadLetterQueue.add).toHaveBeenCalledTimes(1);
    expect(escrowOutcomeMock).toHaveBeenCalledWith({ transactionId: TX_ID, status: 'FAILED', error: 'rpc down' });
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});

describe('isLastAttempt', () => {
  it('compares attemptsMade against opts.attempts (default 1)', () => {
    expect(isLastAttempt(job({ attemptsMade: 1, opts: { attempts: 3 } }))).toBe(false);
    expect(isLastAttempt(job({ attemptsMade: 3, opts: { attempts: 3 } }))).toBe(true);
    expect(isLastAttempt(job({ attemptsMade: 1, opts: {} }))).toBe(true);
    expect(isLastAttempt({ data: JOB_DATA })).toBe(false);
  });
});
