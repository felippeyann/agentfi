/**
 * Admin routes — for the operator dashboard only.
 * Protected by ADMIN_SECRET header, not by agent API key.
 *
 * These routes expose aggregate data that no individual agent should see.
 */

import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { logger } from '../middleware/logger.js';

const db = new PrismaClient();
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';

function requireAdmin(request: any, reply: any): boolean {
  const secret = request.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function adminRoutes(fastify: FastifyInstance) {
  /**
   * GET /admin/stats — dashboard overview.
   */
  fastify.get('/admin/stats', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const todayStr = todayDate.toISOString().slice(0, 10);

    const [
      activeAgents,
      totalTransactions,
      confirmedToday,
      failedToday,
      feeEvents,
      dailyVolumes,
    ] = await Promise.all([
      db.agent.count({ where: { active: true } }),
      db.transaction.count(),
      db.transaction.count({
        where: { status: 'CONFIRMED', confirmedAt: { gte: todayDate } },
      }),
      db.transaction.count({
        where: {
          status: { in: ['FAILED', 'REVERTED'] },
          createdAt: { gte: todayDate },
        },
      }),
      db.feeEvent.findMany({ select: { feeUsd: true } }),
      db.dailyVolume.findMany({
        where: { date: todayStr },
        select: { volumeUsd: true },
      }),
    ]);

    const totalFeesUsd = feeEvents
      .reduce((acc, e) => acc + parseFloat(e.feeUsd), 0)
      .toFixed(2);

    const volumeToday = dailyVolumes
      .reduce((acc, v) => acc + parseFloat(v.volumeUsd), 0)
      .toFixed(2);

    return {
      activeAgents,
      totalTransactions,
      confirmedToday,
      failedToday,
      volumeToday,
      totalFeesUsd,
    };
  });

  /**
   * GET /admin/agents — list all agents with billing info.
   */
  fastify.get('/admin/agents', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const agents = await db.agent.findMany({
      include: { billing: true },
      orderBy: { createdAt: 'desc' },
    });

    return { agents };
  });

  /**
   * GET /admin/agents/:id — single agent detail.
   */
  fastify.get<{ Params: { id: string } }>('/admin/agents/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const agent = await db.agent.findUnique({
      where: { id: request.params.id },
      include: { policy: true, billing: true },
    });

    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return agent;
  });

  /**
   * GET /admin/agents/:id/transactions — agent transaction history.
   */
  fastify.get<{ Params: { id: string } }>(
    '/admin/agents/:id/transactions',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const query = request.query as { limit?: string };
      const limit = Math.min(parseInt(query.limit ?? '50'), 200);

      const transactions = await db.transaction.findMany({
        where: { agentId: request.params.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return { transactions };
    },
  );

  /**
   * GET /admin/transactions — global transaction log.
   */
  fastify.get('/admin/transactions', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(parseInt(query.limit ?? '50'), 200);

    const transactions = await db.transaction.findMany({
      ...(query.status ? { where: { status: query.status as any } } : {}),
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { agent: { select: { name: true } } },
    });

    return { transactions };
  });

  /**
   * POST /admin/agents/:id/pause — emergency kill switch.
   */
  fastify.post<{ Params: { id: string } }>(
    '/admin/agents/:id/pause',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const agent = await db.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) return reply.code(404).send({ error: 'Not found' });

      const nowActive = !agent.active;
      await db.agent.update({
        where: { id: request.params.id },
        data: { active: nowActive },
      });

      if (!nowActive && agent) {
        // Also pause the on-chain policy
        await db.agentPolicy.updateMany({
          where: { agentId: request.params.id },
          data: { active: false },
        });
      }

      logger.info({ agentId: request.params.id, nowActive }, 'Admin toggled agent status');
      return { active: nowActive };
    },
  );

  /**
   * GET /admin/revenue — revenue breakdown for accounting.
   */
  fastify.get('/admin/revenue', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const feeEvents = await db.feeEvent.findMany({
      orderBy: { collectedAt: 'desc' },
      take: 1000,
      include: {
        billing: { select: { agentId: true } },
      },
    });

    const totalUsd = feeEvents.reduce((acc, e) => acc + parseFloat(e.feeUsd), 0);
    const byBps: Record<number, number> = {};

    for (const e of feeEvents) {
      byBps[e.feeBps] = (byBps[e.feeBps] ?? 0) + parseFloat(e.feeUsd);
    }

    return {
      totalFeesUsd: totalUsd.toFixed(2),
      feeEventCount: feeEvents.length,
      byFeeTier: Object.entries(byBps).map(([bps, usd]) => ({
        feeBps: parseInt(bps),
        tierName: parseInt(bps) === 30 ? 'FREE' : parseInt(bps) === 15 ? 'PRO' : 'ENTERPRISE',
        totalUsd: usd.toFixed(2),
      })),
      recentEvents: feeEvents.slice(0, 20),
    };
  });
}
