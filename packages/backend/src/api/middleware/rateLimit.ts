import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

// Lazy Redis connection — don't crash the server if Redis is temporarily unavailable
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  enableOfflineQueue: true,
});

// Rate limits by tier (requests per minute) — configurable via env vars
export const RATE_LIMITS: Record<string, number> = {
  FREE: env.RATE_LIMIT_FREE,
  PRO: env.RATE_LIMIT_PRO,
  ENTERPRISE: env.RATE_LIMIT_ENTERPRISE,
};

export async function registerRateLimit(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    global: true,
    redis,
    max: (request, _key) => {
      const tier = request.agentTier ?? 'FREE';
      return RATE_LIMITS[tier] ?? RATE_LIMITS['FREE']!;
    },
    keyGenerator: (request) => request.agentId || request.ip,
    allowList: (request) => {
      const url = request.routeOptions?.url ?? '';
      return url.startsWith('/health') || url.startsWith('/.well-known');
    },
    errorResponseBuilder: (_request, context) => ({
      error: `Rate limit exceeded. Retry after ${context.after}.`,
      tier: 'Upgrade your plan for higher limits.',
    }),
  });
}
