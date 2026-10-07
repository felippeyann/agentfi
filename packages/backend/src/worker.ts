import { configuredEscrowChainIds, env, escrowEvaluatorAddress } from './config/env.js';
import { logger } from './api/middleware/logger.js';
import { startTransactionWorker } from './queues/transaction.queue.js';
import {
  startEscrowSettlementWorker,
  scheduleEscrowExpirySweep,
} from './queues/escrow-settlement.queue.js';
import { erc8183Deps } from './services/job/escrow-erc8183.runtime.js';

async function start() {
  if (env.TRANSACTION_WORKER_ENABLED !== 'true') {
    logger.warn('Worker process started with TRANSACTION_WORKER_ENABLED=false; exiting');
    process.exit(0);
  }

  const worker = startTransactionWorker();

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Transaction job failed');
  });

  // ERC-8183 escrow (C3): evaluator-signed settlements + expiry sweep run
  // next to the transaction worker (same reasoning as in index.ts).
  let escrowSettlementWorker: ReturnType<typeof startEscrowSettlementWorker> | undefined;
  if (configuredEscrowChainIds.length > 0 && escrowEvaluatorAddress) {
    logger.info({ escrowEvaluatorAddress, chainIds: configuredEscrowChainIds }, 'ERC-8183 escrow enabled — evaluator signer configured');
    escrowSettlementWorker = startEscrowSettlementWorker(erc8183Deps);
    await scheduleEscrowExpirySweep();
  }

  const shutdown = async () => {
    logger.info('Shutting down transaction worker...');
    await worker.close();
    if (escrowSettlementWorker) await escrowSettlementWorker.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Transaction worker process is running');
}

start().catch((err) => {
  logger.error(err);
  process.exit(1);
});
