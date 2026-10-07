import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env } from './config/env.js';
import { describeLegacyContract, findLegacyContractConfig } from './config/contracts.js';
import { logger } from './api/middleware/logger.js';
import { authMiddleware } from './api/middleware/auth.js';
import { registerRateLimit } from './api/middleware/rateLimit.js';
import { registerJsonBodyParser } from './api/middleware/json-body.js';
import { registerErrorHandler } from './api/errors/handler.js';
import { agentRoutes } from './api/routes/agents.js';
import { transactionRoutes } from './api/routes/transactions.js';
import { walletRoutes } from './api/routes/wallets.js';
import { healthRoutes } from './api/routes/health.js';
import { billingRoutes } from './api/routes/billing.js';
import { adminRoutes } from './api/routes/admin.js';
import { mcpRoutes } from './api/routes/mcp.js';
import { jobRoutes } from './api/routes/jobs.js';
import { resourcePaymentRoutes } from './api/routes/resource-payments.js';
import { startTransactionWorker } from './queues/transaction.queue.js';
import { startReputationWorker, scheduleReputationUpdate } from './queues/reputation.queue.js';
import {
  startPaymentRecoveryWorker,
  schedulePaymentRecovery,
} from './queues/payment-recovery.queue.js';
import {
  startEscrowSettlementWorker,
  scheduleEscrowExpirySweep,
} from './queues/escrow-settlement.queue.js';
import { erc8183Deps } from './services/job/escrow-erc8183.runtime.js';
import { configuredEscrowChainIds, escrowEvaluatorAddress } from './config/env.js';

// Fastify v5 expects a logger CONFIG object (not a pino instance). We pass
// the same options that middleware/logger.ts uses for its standalone export,
// so request logs and code-imported logger calls produce identical output —
// just from two pino instances rather than one. The shared `logger` import
// is still used by route handlers that log directly.
const fastify = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'body.privateKey',
        'body.apiKey',
        '*.privateKey',
        '*.apiKey',
        '*.apiKeyHash',
      ],
      remove: true,
    },
    ...(env.NODE_ENV !== 'production'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  },
});

// Stripe webhook needs the raw request body for signature verification.
// Register the JSON parser BEFORE any other plugins so Fastify does not
// JSON-parse the /v1/billing/webhook payload.
registerJsonBodyParser(fastify);

// S5: one error handler for the whole app, installed before any route is
// registered (routes capture the handler of their context when added). An
// unexpected error answers { error: 'Internal error', code: 'INTERNAL_ERROR',
// traceId } and is logged in full under the same traceId — never its message.
registerErrorHandler(fastify);

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
  await fastify.register(resourcePaymentRoutes);

  // Well-known agent capability advertisement
  fastify.get('/.well-known/agent.json', async () => ({
    name: 'AgentFi',
    description: 'Crypto transaction infrastructure for AI agents',
    version: '1.0.0',
    capabilities: ['swap', 'transfer', 'lending', 'balance'],
    networks: [1, 8453, 42161, 137],
    authentication: 'api_key',
    mcp_endpoint: process.env['MCP_SSE_URL'] ?? 'https://agentfi-backend.fly.dev/mcp/sse',
    openapi: process.env['API_URL']
      ? `${process.env['API_URL']}/openapi.json`
      : 'https://agentfi-backend.fly.dev/openapi.json',
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

  // Payment recovery cron worker (#73). Tied to TRANSACTION_WORKER_ENABLED
  // because there's no point running recovery on a replica that doesn't also
  // process transactions — both feed off the same Job/Transaction tables and
  // the recovery logic is harmless to run on multiple replicas (idempotent),
  // but pointless on replicas where the transaction worker is disabled.
  let paymentRecoveryWorker:
    | ReturnType<typeof startPaymentRecoveryWorker>
    | undefined;
  if (env.TRANSACTION_WORKER_ENABLED === 'true') {
    try {
      paymentRecoveryWorker = startPaymentRecoveryWorker();
      await schedulePaymentRecovery();
    } catch (err) {
      logger.error({ err }, 'Payment recovery worker failed to start');
    }
  }

  // ERC-8183 escrow (C3): the evaluator signer settles jobs from the
  // settlement queue; the expiry sweep claims refunds for jobs past
  // `expiresAt`. Runs wherever the transaction worker runs, for the same
  // reason as payment recovery. Disabled (with a WARN) when an escrow address
  // is configured without ESCROW_EVALUATOR_PRIVATE_KEY in development.
  let escrowSettlementWorker: ReturnType<typeof startEscrowSettlementWorker> | undefined;
  if (configuredEscrowChainIds.length > 0) {
    if (escrowEvaluatorAddress) {
      logger.info(
        { escrowEvaluatorAddress, chainIds: configuredEscrowChainIds },
        'ERC-8183 escrow enabled — evaluator signer configured',
      );
      if (env.TRANSACTION_WORKER_ENABLED === 'true') {
        try {
          escrowSettlementWorker = startEscrowSettlementWorker(erc8183Deps);
          await scheduleEscrowExpirySweep();
        } catch (err) {
          logger.error({ err }, 'Escrow settlement worker failed to start');
        }
      }
    } else {
      logger.warn(
        { chainIds: configuredEscrowChainIds },
        'AGENT_JOB_ESCROW_ADDRESS_* is set but ESCROW_EVALUATOR_PRIVATE_KEY is not — ERC-8183 escrow DISABLED; paid jobs use the legacy flow',
      );
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (worker) await worker.close();
    if (reputationWorker) await reputationWorker.close();
    if (paymentRecoveryWorker) await paymentRecoveryWorker.close();
    if (escrowSettlementWorker) await escrowSettlementWorker.close();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ABI versioning guard (October 2026): AgentExecutor.Action gained a `token`
  // field. Contracts deployed from the old struct expose different selectors,
  // so every transaction routed through them reverts. `config/env.ts` already
  // refused to boot production/staging with a legacy executor; here (development)
  // warn loudly — `getContracts().executor` / ExecutorService treat the legacy
  // executor as not configured and send transactions directly instead.
  for (const legacy of findLegacyContractConfig()) {
    logger.warn(
      legacy,
      describeLegacyContract(legacy) +
        (legacy.contract === 'executor' ? ' Executor routing is DISABLED on this chain until then.' : ''),
    );
  }

  await fastify.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info(`AgentFi API running on port ${env.API_PORT}`);
}

start().catch((err) => {
  logger.error(err);
  process.exit(1);
});
