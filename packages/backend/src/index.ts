import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env } from './config/env.js';
import { logger } from './api/middleware/logger.js';
import { authMiddleware } from './api/middleware/auth.js';
import { registerRateLimit } from './api/middleware/rateLimit.js';
import { agentRoutes } from './api/routes/agents.js';
import { transactionRoutes } from './api/routes/transactions.js';
import { walletRoutes } from './api/routes/wallets.js';
import { healthRoutes } from './api/routes/health.js';
import { billingRoutes } from './api/routes/billing.js';
import { adminRoutes } from './api/routes/admin.js';
import { startTransactionWorker } from './queues/transaction.queue.js';

const fastify = Fastify({ logger: logger as any });

async function start() {
  // Security middleware
  await fastify.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
  });
  await fastify.register(helmet);

  // Auth + rate limiting
  await fastify.register(authMiddleware);
  await registerRateLimit(fastify);

  // Routes
  await fastify.register(healthRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(transactionRoutes);
  await fastify.register(walletRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(adminRoutes);

  // Well-known agent capability advertisement
  fastify.get('/.well-known/agent.json', async () => ({
    name: 'AgentFi',
    description: 'Crypto transaction infrastructure for AI agents',
    version: '1.0.0',
    capabilities: ['swap', 'transfer', 'lending', 'balance'],
    networks: [1, 8453, 42161, 137],
    authentication: 'api_key',
    mcp_endpoint: process.env['MCP_SSE_URL'] ?? 'https://mcp.agentfi.xyz/sse',
    openapi: process.env['API_URL']
      ? `${process.env['API_URL']}/openapi.json`
      : 'https://api.agentfi.xyz/openapi.json',
  }));

  // Start BullMQ worker
  const worker = startTransactionWorker();
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Transaction job failed');
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await worker.close();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await fastify.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info(`AgentFi API running on port ${env.API_PORT}`);
}

start().catch((err) => {
  logger.error(err);
  process.exit(1);
});
