/**
 * The worker process (`npm run worker`, `src/worker.ts`): everything that
 * moves money after the API has queued it.
 *
 *  - transaction worker (agent-signed transactions, incl. the ERC-8183
 *    requester/provider steps and the ERC-8004 identity steps);
 *  - payment recovery (C3c: it used to start only in `index.ts`, and every
 *    deploy guide tells operators to disable the worker on the API, so in the
 *    documented API + worker topology it never ran): the stale
 *    PAYMENT_PENDING scan, the re-poll of SUBMITTED transactions whose monitor
 *    is gone, and the ERC-8183 reconciliation. Its repeatable job id dedupes
 *    the schedule across processes;
 *  - ERC-8183 settlement worker + expiry sweep (when an escrow chain and the
 *    evaluator key are configured).
 *
 * At boot every SUBMITTED transaction is re-polled once: monitors are
 * in-process promises, so a restart (or a crash) left their rows SUBMITTED.
 * On shutdown the workers close, running monitors get a short grace period,
 * and whatever is still unconfirmed is picked up by that boot re-poll.
 *
 * Split from `worker.ts` so tests can start it with mocked queues.
 */

import { configuredEscrowChainIds, env, escrowEvaluatorAddress } from './config/env.js';
import { logger } from './api/middleware/logger.js';
import {
  drainTransactionMonitors,
  repollSubmittedTransactionsNow,
  startTransactionWorker,
} from './queues/transaction.queue.js';
import {
  startEscrowSettlementWorker,
  scheduleEscrowExpirySweep,
} from './queues/escrow-settlement.queue.js';
import {
  schedulePaymentRecovery,
  startPaymentRecoveryWorker,
} from './queues/payment-recovery.queue.js';
import { erc8183Deps } from './services/job/escrow-erc8183.runtime.js';
import { closeWalletLanes } from './services/transaction/wallet-lane.runtime.js';

/** How long a shutdown waits for in-flight confirmation monitors before exiting. */
export const SHUTDOWN_MONITOR_GRACE_MS = 10_000;

export interface WorkerProcess {
  /** Closes the workers, drains monitors for a short grace period. Does not exit the process. */
  stop(): Promise<void>;
}

/**
 * Re-polls every SUBMITTED transaction once (boot). Non-fatal: a failure is
 * logged and the payment-recovery tick re-polls stale rows anyway.
 */
export async function repollSubmittedAtBoot(): Promise<void> {
  try {
    const summary = await repollSubmittedTransactionsNow({ olderThanMs: 0 });
    logger.info(summary, 'Boot re-poll of SUBMITTED transactions done');
  } catch (err) {
    logger.error({ err: (err as Error)?.message ?? String(err) }, 'Boot re-poll of SUBMITTED transactions failed — the recovery tick will retry');
  }
}

export async function startWorkerProcess(): Promise<WorkerProcess | null> {
  if (env.TRANSACTION_WORKER_ENABLED !== 'true') {
    logger.warn('Worker process started with TRANSACTION_WORKER_ENABLED=false; exiting');
    return null;
  }

  const worker = startTransactionWorker();
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Transaction job failed');
  });

  // C3c: payment recovery belongs to the worker process (see header).
  const paymentRecoveryWorker = startPaymentRecoveryWorker();
  await schedulePaymentRecovery();

  // ERC-8183 escrow (C3): evaluator-signed settlements + expiry sweep run
  // next to the transaction worker (same reasoning as in index.ts).
  let escrowSettlementWorker: ReturnType<typeof startEscrowSettlementWorker> | undefined;
  if (configuredEscrowChainIds.length > 0 && escrowEvaluatorAddress) {
    logger.info({ escrowEvaluatorAddress, chainIds: configuredEscrowChainIds }, 'ERC-8183 escrow enabled — evaluator signer configured');
    escrowSettlementWorker = startEscrowSettlementWorker(erc8183Deps);
    await scheduleEscrowExpirySweep();
  }

  await repollSubmittedAtBoot();

  logger.info('Transaction worker process is running');
  return {
    async stop() {
      logger.info('Shutting down transaction worker...');
      await worker.close();
      await paymentRecoveryWorker.close();
      if (escrowSettlementWorker) await escrowSettlementWorker.close();
      await drainTransactionMonitors(SHUTDOWN_MONITOR_GRACE_MS);
      await closeWalletLanes();
    },
  };
}
