import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { TurnkeyService } from '../../services/wallet/turnkey.service.js';
import { env } from '../../config/env.js';
import { RPC_URLS } from '../../config/chains.js';

const db = new PrismaClient();
const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
const turnkey = new TurnkeyService();

async function checkDatabase(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

async function checkRpc(): Promise<boolean> {
  try {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(RPC_URLS[1] ?? ''),
    });
    await client.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

async function checkTurnkey(): Promise<boolean> {
  return turnkey.healthCheck();
}

export async function healthRoutes(fastify: FastifyInstance) {
  /**
   * GET /health — basic liveness check (no dependencies).
   */
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  /**
   * GET /health/ready — readiness check (all dependencies must be healthy).
   */
  fastify.get('/health/ready', async (_request, reply) => {
    const [dbOk, redisOk, rpcOk, turnkeyOk] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkRpc(),
      checkTurnkey(),
    ]);

    const checks = {
      database: dbOk,
      redis: redisOk,
      rpc: rpcOk,
      turnkey: turnkeyOk,
    };

    const allHealthy = Object.values(checks).every(Boolean);
    return reply.code(allHealthy ? 200 : 503).send({
      status: allHealthy ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
