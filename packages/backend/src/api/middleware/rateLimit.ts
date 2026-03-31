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

// Rate limits by tier (requests per minute)
export const RATE_LIMITS = {
  FREE: 30,
  PRO: 300,
  ENTERPRISE: 3000,
} as const;

export async function registerRateLimit(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    global: true,
    redis,
    max: async (request) => {
      const tier = request.agentTier ?? 'FREE';
      return RATE_LIMITS[tier] ?? RATE_LIMITS.FREE;
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
