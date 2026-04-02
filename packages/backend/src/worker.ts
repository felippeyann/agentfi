import { env } from './config/env.js';
import { logger } from './api/middleware/logger.js';
import { startTransactionWorker } from './queues/transaction.queue.js';

async function start() {
  if (env.TRANSACTION_WORKER_ENABLED !== 'true') {
    logger.warn('Worker process started with TRANSACTION_WORKER_ENABLED=false; exiting');
    process.exit(0);
  }

  const worker = startTransactionWorker();

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Transaction job failed');
  });

  const shutdown = async () => {
    logger.info('Shutting down transaction worker...');
    await worker.close();
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
