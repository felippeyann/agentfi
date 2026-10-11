/**
 * Unit tests — transaction worker pre-submit guard.
 *
 * The transaction processor (`queues/transaction.processor.ts`) calls
 * `preSubmitGuard(db, transactionId)` before `submitter.submit(...)`; the tx
 * stays QUEUED while broadcasting and `{ status: 'SUBMITTED', txHash }` is
 * written in one update afterwards (see `transaction.worker.test.ts` for the
 * full processor). These tests exercise the guard against a mocked Prisma
 * client and a mocked submitter, without BullMQ or Redis:
 *
 *  - QUEUED + active agent + active policy → proceed (submitter called)
 *  - agent inactive                        → FAILED, submitter not called
 *  - policy inactive                       → FAILED, submitter not called
 *  - policy expired                        → FAILED, submitter not called
 *  - already SUBMITTED / has txHash        → skipped, submitter not called
 *  - A2A payment blocked                   → Job finalized as FAILED
 *  - C3d: a setProviderAgentId whose job is no longer live + Funded → not broadcast
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { finalizeMock, escrowOutcomeMock, vetBindMock, settleVolumeMock } = vi.hoisted(() => ({
  finalizeMock: vi.fn(),
  escrowOutcomeMock: vi.fn(),
  vetBindMock: vi.fn(),
  settleVolumeMock: vi.fn(),
}));

// The DailyVolume settlement (A6) runs on Postgres in daily-volume.db.test.ts;
// here only the call is checked.
vi.mock('../services/policy/daily-volume.js', () => ({
  settleVolumeAfterFailure: settleVolumeMock,
}));

// The finalizer pulls in the real `db` singleton, the logger/env chain and the
// escrow service (which instantiates BullMQ queues). Stub the module.
vi.mock('../services/job/payment-finalizer.service.js', () => ({
  finalizeA2APaymentJob: finalizeMock,
}));
// The ERC-8183 runtime binds the real db / queues / signer. Stub the module.
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: escrowOutcomeMock,
  vetBindBeforeBroadcast: vetBindMock,
}));

import {
  preSubmitGuard,
  BIND_SKIPPED_BEFORE_SUBMISSION,
  PAUSED_BEFORE_SUBMISSION,
  POLICY_EXPIRED_BEFORE_SUBMISSION,
} from '../services/transaction/pre-submit-guard.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const TX_ID = 'tx-1';
const TX_HASH = '0xabc0000000000000000000000000000000000000000000000000000000000001';

type TxSnapshot = {
  status: 'QUEUED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REVERTED' | 'PENDING_APPROVAL';
  txHash: string | null;
  metadata: Record<string, unknown> | null;
  agent: {
    active: boolean;
    policy: { active: boolean; expiresAt: Date | null } | null;
  };
};

function snapshot(overrides: Partial<TxSnapshot> = {}): TxSnapshot {
  return {
    status: 'QUEUED',
    txHash: null,
    metadata: null,
    agent: { active: true, policy: { active: true, expiresAt: null } },
    ...overrides,
  };
}

function makeMockDb(tx: TxSnapshot | null) {
  const findUnique = vi.fn().mockResolvedValue(tx);
  const update = vi.fn().mockResolvedValue({});
  const db = { transaction: { findUnique, update } } as unknown as PrismaClient;
  return { db, findUnique, update };
}

function makeSubmitter() {
  return { submit: vi.fn().mockResolvedValue({ txHash: TX_HASH, nonce: 1 }) };
}

/**
 * Mirrors the processor's contract around the guard: only a `proceed`
 * decision reaches the submitter, and SUBMITTED is written together with the
 * txHash once the broadcast resolved. Anything else returns without touching
 * the submitter.
 */
async function runWorkerStep(db: PrismaClient, submitter: ReturnType<typeof makeSubmitter>) {
  const decision = await preSubmitGuard(db, TX_ID);
  if (decision.action === 'proceed') {
    const { txHash } = await submitter.submit();
    await db.transaction.update({ where: { id: TX_ID }, data: { status: 'SUBMITTED', txHash } });
  }
  return decision;
}

beforeEach(() => {
  finalizeMock.mockReset().mockResolvedValue(undefined);
  escrowOutcomeMock.mockReset().mockResolvedValue(undefined);
  vetBindMock.mockReset().mockResolvedValue(null);
  settleVolumeMock.mockReset().mockResolvedValue('released');
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe('preSubmitGuard — proceeds', () => {
  it('QUEUED + active agent + active policy → proceed and submit', async () => {
    const { db, findUnique, update } = makeMockDb(snapshot());
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision).toEqual({ action: 'proceed' });
    expect(submitter.submit).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'SUBMITTED', txHash: TX_HASH },
    });
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    // Single Prisma round-trip: tx + agent + policy in one nested select.
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TX_ID },
        select: expect.objectContaining({
          status: true,
          txHash: true,
          agent: expect.objectContaining({
            select: expect.objectContaining({
              active: true,
              policy: { select: { active: true, expiresAt: true } },
            }),
          }),
        }),
      }),
    );
  });

  it('QUEUED + active agent + no policy row → proceed', async () => {
    const { db } = makeMockDb(snapshot({ agent: { active: true, policy: null } }));
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision.action).toBe('proceed');
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it('policy with a future expiresAt → proceed', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const { db } = makeMockDb(
      snapshot({ agent: { active: true, policy: { active: true, expiresAt: future } } }),
    );
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision.action).toBe('proceed');
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });
});

// ── Kill switch / policy blocks ────────────────────────────────────────────

describe('preSubmitGuard — blocks and marks FAILED', () => {
  it('agent inactive → FAILED with "paused" error, submitter not called', async () => {
    const { db, update } = makeMockDb(
      snapshot({ agent: { active: false, policy: { active: true, expiresAt: null } } }),
    );
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision).toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: PAUSED_BEFORE_SUBMISSION },
    });
    expect(finalizeMock).not.toHaveBeenCalled();
    // A6: the blocked transaction's DailyVolume reservation is settled
    // (released, or held when an earlier attempt reached the broadcast).
    expect(settleVolumeMock).toHaveBeenCalledWith(db, TX_ID);
  });

  it('policy inactive (agent still active) → FAILED, submitter not called', async () => {
    const { db, update } = makeMockDb(
      snapshot({ agent: { active: true, policy: { active: false, expiresAt: null } } }),
    );
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision).toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: PAUSED_BEFORE_SUBMISSION },
    });
  });

  it('policy expired → FAILED with "expired" error, submitter not called', async () => {
    const past = new Date(Date.now() - 1000);
    const { db, update } = makeMockDb(
      snapshot({ agent: { active: true, policy: { active: true, expiresAt: past } } }),
    );
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision).toEqual({ action: 'fail', reason: POLICY_EXPIRED_BEFORE_SUBMISSION });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: POLICY_EXPIRED_BEFORE_SUBMISSION },
    });
  });

  it('never throws on a block, so BullMQ does not retry a paused tx', async () => {
    const { db } = makeMockDb(snapshot({ agent: { active: false, policy: null } }));

    await expect(preSubmitGuard(db, TX_ID)).resolves.toMatchObject({ action: 'fail' });
  });
});

// ── Idempotency guard ──────────────────────────────────────────────────────

describe('preSubmitGuard — skips already-processed transactions', () => {
  it('status SUBMITTED (always written with its txHash) → skipped, no DB write, submitter not called', async () => {
    // The processor writes SUBMITTED and txHash in one update after the
    // broadcast resolved, so a SUBMITTED row always carries a hash.
    const { db, update } = makeMockDb(snapshot({ status: 'SUBMITTED', txHash: TX_HASH }));
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision.action).toBe('skip');
    expect(decision).toMatchObject({
      reason: expect.stringMatching(new RegExp(`SUBMITTED.*${TX_HASH}`)),
    });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(settleVolumeMock).not.toHaveBeenCalled();
  });

  it('QUEUED but already has a txHash → skipped, submitter not called', async () => {
    const { db, update } = makeMockDb(snapshot({ status: 'QUEUED', txHash: TX_HASH }));
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision.action).toBe('skip');
    expect(decision).toMatchObject({ reason: expect.stringContaining(TX_HASH) });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('status CONFIRMED → skipped even if the agent is now paused (no FAILED overwrite)', async () => {
    const { db, update } = makeMockDb(
      snapshot({
        status: 'CONFIRMED',
        txHash: TX_HASH,
        agent: { active: false, policy: { active: false, expiresAt: null } },
      }),
    );
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision.action).toBe('skip');
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('transaction row missing → skipped, submitter not called', async () => {
    const { db, update } = makeMockDb(null);
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision).toEqual({ action: 'skip', reason: 'Transaction not found' });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

// ── A2A payment integration ────────────────────────────────────────────────

describe('preSubmitGuard — A2A payment jobs', () => {
  it('blocked A2A payment → Job finalized as FAILED (escrow refund path)', async () => {
    const { db } = makeMockDb(
      snapshot({
        metadata: { a2aPayment: true, jobId: 'job-42' },
        agent: { active: false, policy: { active: true, expiresAt: null } },
      }),
    );

    const decision = await preSubmitGuard(db, TX_ID);

    expect(decision).toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledWith({
      jobId: 'job-42',
      transactionId: TX_ID,
      outcome: 'FAILED',
      reason: PAUSED_BEFORE_SUBMISSION,
    });
  });

  it('blocked non-A2A tx → finalizer untouched', async () => {
    const { db } = makeMockDb(
      snapshot({
        metadata: { queuePayload: { to: '0x0' } },
        agent: { active: false, policy: null },
      }),
    );

    await preSubmitGuard(db, TX_ID);

    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('finalizer failure is reported, not thrown (tx stays FAILED, no retry)', async () => {
    finalizeMock.mockRejectedValueOnce(new Error('job table unavailable'));
    const { db, update } = makeMockDb(
      snapshot({
        metadata: { a2aPayment: true, jobId: 'job-42' },
        agent: { active: false, policy: null },
      }),
    );

    const decision = await preSubmitGuard(db, TX_ID);

    expect(decision).toEqual({
      action: 'fail',
      reason: PAUSED_BEFORE_SUBMISSION,
      finalizerError: 'job table unavailable',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: PAUSED_BEFORE_SUBMISSION },
    });
  });
});

// ── ERC-8183 escrow steps (C3) ─────────────────────────────────────────────

describe('preSubmitGuard — ERC-8183 escrow steps', () => {
  it('blocked escrow step → orchestrator told FAILED with the block reason; A2A finalizer untouched', async () => {
    const { db } = makeMockDb(
      snapshot({
        metadata: { erc8183: true, jobId: 'job-7', escrowStep: 'approve' },
        agent: { active: false, policy: { active: true, expiresAt: null } },
      }),
    );
    const submitter = makeSubmitter();

    const decision = await runWorkerStep(db, submitter);

    expect(decision).toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(escrowOutcomeMock).toHaveBeenCalledTimes(1);
    expect(escrowOutcomeMock).toHaveBeenCalledWith({
      transactionId: TX_ID,
      status: 'FAILED',
      error: PAUSED_BEFORE_SUBMISSION,
    });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('orchestrator failure is reported as finalizerError, not thrown (tx already FAILED)', async () => {
    escrowOutcomeMock.mockRejectedValueOnce(new Error('job table unavailable'));
    const { db, update } = makeMockDb(
      snapshot({
        metadata: { erc8183: true, jobId: 'job-7', escrowStep: 'fund' },
        agent: { active: false, policy: { active: true, expiresAt: null } },
      }),
    );

    const decision = await preSubmitGuard(db, TX_ID);

    expect(decision).toEqual({
      action: 'fail',
      reason: PAUSED_BEFORE_SUBMISSION,
      finalizerError: 'job table unavailable',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: TX_ID },
      data: { status: 'FAILED', error: PAUSED_BEFORE_SUBMISSION },
    });
  });
});

// ── C3d (H14 dry-run): ERC-8004 bind re-checked before broadcast ───────────

describe('preSubmitGuard — setProviderAgentId (bindAgent) of a job no longer Funded', () => {
  const bindMeta = { jobId: 'job-1', erc8183: true, erc8004: true, escrowStep: 'bindAgent' };

  it('the job is still live and Funded → proceed (the check ran)', async () => {
    vetBindMock.mockResolvedValue(null);
    const { db } = makeMockDb(snapshot({ metadata: bindMeta }));
    const submitter = makeSubmitter();
    expect(await runWorkerStep(db, submitter)).toEqual({ action: 'proceed' });
    expect(vetBindMock).toHaveBeenCalledWith('job-1');
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it('cancelled meanwhile → not broadcast: tx FAILED with the reason, the identity lane moves on (no revert, no gas)', async () => {
    vetBindMock.mockResolvedValue('job is CANCELLED / FUNDED — setProviderAgentId is only valid while the job is live and Funded');
    const { db, update } = makeMockDb(snapshot({ metadata: bindMeta }));
    const submitter = makeSubmitter();
    const decision = await runWorkerStep(db, submitter);
    expect(decision).toMatchObject({ action: 'fail', reason: expect.stringContaining(BIND_SKIPPED_BEFORE_SUBMISSION) });
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: TX_ID }, data: { status: 'FAILED', error: expect.stringContaining('job is CANCELLED') } });
    expect(escrowOutcomeMock).toHaveBeenCalledWith({ transactionId: TX_ID, status: 'FAILED', error: expect.stringContaining(BIND_SKIPPED_BEFORE_SUBMISSION) });
  });

  it('other escrow steps are not re-checked here', async () => {
    const { db } = makeMockDb(snapshot({ metadata: { jobId: 'job-1', erc8183: true, escrowStep: 'submit' } }));
    expect(await runWorkerStep(db, makeSubmitter())).toEqual({ action: 'proceed' });
    expect(vetBindMock).not.toHaveBeenCalled();
  });
});
