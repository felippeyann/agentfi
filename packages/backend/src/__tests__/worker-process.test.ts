/**
 * Unit tests — the worker process (`worker.ts` → `worker-process.ts`), C3c.
 *
 * The documented deployment runs the API with TRANSACTION_WORKER_ENABLED=false
 * and a separate `npm run worker`. Before C3c `worker.ts` started the
 * transaction worker, the settlement worker and the expiry sweep but never
 * payment recovery, so nothing re-polled lost confirmations, re-settled stuck
 * escrow jobs or re-enqueued lost cancellation refunds. Every queue module is
 * mocked; the test asserts what the process starts, schedules and re-polls.
 */
import { vi } from 'vitest';

const { calls, envState, worker } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
  calls,
  worker: (name: string) => ({
    on: () => undefined,
    close: async () => {
      calls.push(`close:${name}`);
    },
  }),
  envState: {
    env: { TRANSACTION_WORKER_ENABLED: 'true' as 'true' | 'false' },
    configuredEscrowChainIds: [84532] as number[],
    escrowEvaluatorAddress: '0x000000000000000000000000000000000000EA1d' as string | null,
  },
  };
});

vi.mock('../config/env.js', () => ({
  get env() {
    return envState.env;
  },
  get configuredEscrowChainIds() {
    return envState.configuredEscrowChainIds;
  },
  get escrowEvaluatorAddress() {
    return envState.escrowEvaluatorAddress;
  },
}));
vi.mock('../api/middleware/logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock('../queues/transaction.queue.js', () => ({
  startTransactionWorker: () => {
    calls.push('startTransactionWorker');
    return worker('transactions');
  },
  repollSubmittedTransactionsNow: async (opts: unknown) => {
    calls.push(`repoll:${JSON.stringify(opts)}`);
    return { scanned: 0, confirmed: 0, reverted: 0, dropped: 0, pending: 0, errors: 0 };
  },
  drainTransactionMonitors: async (ms: number) => {
    calls.push(`drain:${ms}`);
    return 0;
  },
}));
vi.mock('../queues/payment-recovery.queue.js', () => ({
  startPaymentRecoveryWorker: () => {
    calls.push('startPaymentRecoveryWorker');
    return worker('payment-recovery');
  },
  schedulePaymentRecovery: async () => {
    calls.push('schedulePaymentRecovery');
  },
}));
vi.mock('../queues/escrow-settlement.queue.js', () => ({
  startEscrowSettlementWorker: () => {
    calls.push('startEscrowSettlementWorker');
    return worker('escrow-settlement');
  },
  scheduleEscrowExpirySweep: async () => {
    calls.push('scheduleEscrowExpirySweep');
  },
}));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ erc8183Deps: () => ({}) }));
vi.mock('../services/transaction/wallet-lane.runtime.js', () => ({
  closeWalletLanes: async () => {
    calls.push('closeWalletLanes');
  },
}));

import { beforeEach, describe, expect, it } from 'vitest';
import { SHUTDOWN_MONITOR_GRACE_MS, startWorkerProcess } from '../worker-process.js';

beforeEach(() => {
  calls.length = 0;
  envState.env.TRANSACTION_WORKER_ENABLED = 'true';
  envState.configuredEscrowChainIds = [84532];
  envState.escrowEvaluatorAddress = '0x000000000000000000000000000000000000EA1d';
});

describe('worker process (worker.ts)', () => {
  it('starts and schedules payment recovery next to the transaction worker, then re-polls every SUBMITTED row once', async () => {
    const running = await startWorkerProcess();

    expect(running).not.toBeNull();
    expect(calls).toContain('startTransactionWorker');
    expect(calls).toContain('startPaymentRecoveryWorker');
    expect(calls).toContain('schedulePaymentRecovery');
    expect(calls).toContain('startEscrowSettlementWorker');
    expect(calls).toContain('scheduleEscrowExpirySweep');
    // Boot re-poll: every SUBMITTED row, whatever its age (monitors died with the previous process).
    expect(calls).toContain('repoll:{"olderThanMs":0}');
    expect(calls.indexOf('repoll:{"olderThanMs":0}')).toBeGreaterThan(calls.indexOf('schedulePaymentRecovery'));
  });

  it('runs payment recovery even without an escrow chain (legacy A2A payments need it too)', async () => {
    envState.configuredEscrowChainIds = [];
    await startWorkerProcess();
    expect(calls).toContain('startPaymentRecoveryWorker');
    expect(calls).toContain('schedulePaymentRecovery');
    expect(calls).not.toContain('startEscrowSettlementWorker');
  });

  it('stop() closes every worker, drains in-flight monitors for a grace period and closes the lane client', async () => {
    const running = await startWorkerProcess();
    calls.length = 0;
    await running!.stop();
    expect(calls).toEqual([
      'close:transactions',
      'close:payment-recovery',
      'close:escrow-settlement',
      `drain:${SHUTDOWN_MONITOR_GRACE_MS}`,
      'closeWalletLanes',
    ]);
  });

  it('starts nothing when TRANSACTION_WORKER_ENABLED=false', async () => {
    envState.env.TRANSACTION_WORKER_ENABLED = 'false';
    expect(await startWorkerProcess()).toBeNull();
    expect(calls).toEqual([]);
  });
});
