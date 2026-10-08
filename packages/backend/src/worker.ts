import { logger } from './api/middleware/logger.js';
import { startWorkerProcess } from './worker-process.js';

async function start() {
  const running = await startWorkerProcess();
  if (!running) process.exit(0);

  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error(err);
  process.exit(1);
});
