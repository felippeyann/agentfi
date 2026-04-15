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
import { mcpRoutes } from './api/routes/mcp.js';
import { jobRoutes } from './api/routes/jobs.js';
import { startTransactionWorker } from './queues/transaction.queue.js';
import { startReputationWorker, scheduleReputationUpdate } from './queues/reputation.queue.js';

const fastify = Fastify({ logger: logger as any });

// Stripe webhook needs the raw request body for signature verification.
// Register a raw content-type parser BEFORE any other plugins so Fastify
// does not JSON-parse the /v1/billing/webhook payload.
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    if (req.routeOptions?.url === '/v1/billing/webhook') {
      // Keep as Buffer — passed directly to stripe.webhooks.constructEvent
      done(null, body);
    } else {
      try {
        done(null, JSON.parse(body.toString()));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  },
);

async function start() {
  // Security middleware
  // CORS_ORIGIN: comma-separated list of allowed origins in production.
  // Default allows the admin frontend on the same Railway project.
  const allowedOrigins = (process.env['CORS_ORIGIN'] ?? 'https://admin.agentfi.cc')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await fastify.register(cors, {
    origin: env.NODE_ENV === 'production' ? allowedOrigins : true,
    credentials: true,
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
  await fastify.register(mcpRoutes);
  await fastify.register(jobRoutes);

  // Well-known agent capability advertisement
  fastify.get('/.well-known/agent.json', async () => ({
    name: 'AgentFi',
    description: 'Crypto transaction infrastructure for AI agents',
    version: '1.0.0',
    capabilities: ['swap', 'transfer', 'lending', 'balance'],
    networks: [1, 8453, 42161, 137],
    authentication: 'api_key',
    mcp_endpoint: process.env['MCP_SSE_URL'] ?? 'https://mcp.agentfi.cc/mcp/sse',
    openapi: process.env['API_URL']
      ? `${process.env['API_URL']}/openapi.json`
      : 'https://api.agentfi.cc/openapi.json',
  }));

  // Start BullMQ worker — non-fatal if Redis is temporarily unavailable
  let worker: ReturnType<typeof startTransactionWorker> | undefined;
  if (env.TRANSACTION_WORKER_ENABLED === 'true') {
    try {
      worker = startTransactionWorker();
      worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.id, err }, 'Transaction job failed');
      });
    } catch (err) {
      logger.error({ err }, 'BullMQ worker failed to start — transactions will be queued when Redis recovers');
    }
  } else {
    logger.warn('Transaction worker disabled for this process (TRANSACTION_WORKER_ENABLED=false)');
  }

  // Reputation daily cron worker (BullMQ repeatable job).
  // Non-fatal if Redis is temporarily unavailable � retries on reconnect.
  let reputationWorker: ReturnType<typeof startReputationWorker> | undefined;
  try {
    reputationWorker = startReputationWorker();
    await scheduleReputationUpdate();
  } catch (err) {
    logger.error({ err }, 'Reputation worker failed to start');
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (worker) await worker.close();
    if (reputationWorker) await reputationWorker.close();
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
