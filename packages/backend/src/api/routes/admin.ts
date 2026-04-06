/**
 * Admin routes — for the operator dashboard only.
 * Protected by ADMIN_SECRET header, not by agent API key.
 *
 * These routes expose aggregate data that no individual agent should see.
 */

import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { getAddress, parseUnits } from 'viem';
import { logger } from '../middleware/logger.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { ExecutorService } from '../../services/transaction/executor.service.js';
import { FeeService } from '../../services/policy/fee.service.js';
import { TransactionBuilder } from '../../services/transaction/builder.service.js';

const executor = new ExecutorService();
const feeService = new FeeService(db);
const builder = new TransactionBuilder();
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';
const ADMIN_ALLOW_REMOTE = process.env['ADMIN_ALLOW_REMOTE'] === 'true';

function isLoopbackIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function requireAdmin(request: any, reply: any): boolean {
  const secret = request.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }

  if (!ADMIN_ALLOW_REMOTE && !isLoopbackIp(request.ip ?? '')) {
    reply.code(403).send({ error: 'Admin routes are local-only. Set ADMIN_ALLOW_REMOTE=true to enable remote access.' });
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
   * POST /admin/transactions/:id/approve — manually approve a PENDING_APPROVAL transaction.
   */
  fastify.post<{ Params: { id: string } }>(
    '/admin/transactions/:id/approve',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const tx = await db.transaction.findUnique({
        where: { id: request.params.id },
        include: { agent: true },
      });

      if (!tx) return reply.code(404).send({ error: 'Transaction not found' });
      if (tx.status !== 'PENDING_APPROVAL') {
        return reply.code(400).send({ error: `Transaction is in ${tx.status} status, cannot approve.` });
      }

      // Reconstruct transaction data to enqueue
      let to: `0x${string}`;
      let data: `0x${string}`;
      let value: bigint;
      let routedViaExecutor = false;
      let feeAmountWei = 0n;

      if (tx.type === 'SWAP') {
        // Simple SWAP reconstruction (re-calculating quote is safer but more complex,
        // using the simulation data from the record for now as a baseline)
        const simData = tx.simulation as any;
        if (!simData || !simData.to || !simData.data) {
           return reply.code(400).send({ error: 'Simulation data missing, cannot reconstruct transaction.' });
        }
        to = getAddress(simData.to);
        data = simData.data;
        value = BigInt(simData.value || '0');
        routedViaExecutor = true; // Swaps are always routed via executor if deployed
        
        // Use the simulation's value (which includes fee if routed)
        const feeCalc = feeService.calculateFee({
          grossAmountWei: parseUnits(tx.amountIn || '0', 18), // fallback, should be precise
          tier: tx.agent.tier,
        });
        feeAmountWei = feeCalc.feeAmountWei;
      } else if (tx.type === 'TRANSFER') {
        const isEth = tx.fromToken?.toUpperCase() === 'ETH';
        const txData = isEth 
          ? builder.buildEthTransfer({ to: getAddress(tx.toToken!), amountEth: tx.amountIn! })
          : builder.buildTokenTransfer({
              tokenAddress: getAddress(tx.fromToken!),
              to: getAddress(tx.toToken!),
              amount: tx.amountIn!,
              decimals: 18, // should resolve decimals but using 18 for now
            });
        
        to = txData.to;
        data = txData.data;
        value = txData.value;
        const feeCalc = feeService.calculateFee({ grossAmountWei: value, tier: tx.agent.tier });
        feeAmountWei = feeCalc.feeAmountWei;
      } else {
        return reply.code(400).send({ error: `Approval for ${tx.type} not yet implemented.` });
      }

      await db.transaction.update({
        where: { id: tx.id },
        data: { status: 'QUEUED' },
      });

      await transactionQueue.add(tx.type.toLowerCase(), {
        transactionId: tx.id,
        chainId: tx.chainId,
        walletId: tx.agent.walletId,
        from: getAddress(tx.agent.safeAddress),
        to,
        data,
        value: value.toString(),
        agentId: tx.agentId,
        tier: tx.agent.tier,
        feeAmountWei: feeAmountWei.toString(),
        feeUsd: '0',
        feeBps: 30, // baseline
        routedViaExecutor,
      });

      logger.info({ transactionId: tx.id }, 'Admin approved transaction');
      return { status: 'QUEUED' };
    },
  );

  /**
   * POST /admin/transactions/:id/reject — manually reject a PENDING_APPROVAL transaction.
   */
  fastify.post<{ Params: { id: string } }>(
    '/admin/transactions/:id/reject',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const tx = await db.transaction.findUnique({ where: { id: request.params.id } });
      if (!tx) return reply.code(404).send({ error: 'Transaction not found' });
      if (tx.status !== 'PENDING_APPROVAL') {
        return reply.code(400).send({ error: 'Can only reject PENDING_APPROVAL transactions.' });
      }

      await db.transaction.update({
        where: { id: tx.id },
        data: { status: 'FAILED', error: 'Operator rejected transaction' },
      });

      logger.info({ transactionId: tx.id }, 'Admin rejected transaction');
      return { status: 'FAILED' };
    },
  );
    if (!requireAdmin(request, reply)) return;

    const days = 7;
    const rows = await db.dailyVolume.findMany({
      orderBy: { date: 'asc' },
      take: days,
    });

    // Fill missing days with zero
    const result: { date: string; volumeUsd: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const row = rows.find((r) => r.date === dateStr);
      result.push({ date: dateStr, volumeUsd: row ? parseFloat(row.volumeUsd) : 0 });
    }

    return { volume: result };
  });

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
