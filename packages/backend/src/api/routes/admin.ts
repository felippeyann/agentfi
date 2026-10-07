/**
 * Admin routes — for the operator dashboard only.
 * Protected by ADMIN_SECRET header, not by agent API key.
 *
 * These routes expose aggregate data that no individual agent should see.
 */

import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getAddress, type Address } from 'viem';
import { AGENT_EXECUTOR_ABI } from '../../abi/AgentExecutor.abi.js';
import { logger } from '../middleware/logger.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { getContracts } from '../../config/contracts.js';
import {
  PolicyService,
  type OperatorResumeOutcome,
} from '../../services/policy/policy.service.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { PnLService } from '../../services/billing/pnl.service.js';
import { OperatorService } from '../../services/billing/operator.service.js';

const policyService = new PolicyService(db);
const reputationService = new ReputationService();
const pnlService = new PnLService();
const operatorService = new OperatorService(db);
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';
const ADMIN_ALLOW_REMOTE = process.env['ADMIN_ALLOW_REMOTE'] === 'true';

function isLoopbackIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

function requireAdmin(request: any, reply: any): boolean {
  const secret = request.headers['x-admin-secret'];
  if (!secret || !ADMIN_SECRET || Buffer.byteLength(secret) !== Buffer.byteLength(ADMIN_SECRET) || !timingSafeEqual(Buffer.from(secret), Buffer.from(ADMIN_SECRET))) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }

  if (!ADMIN_ALLOW_REMOTE && !isLoopbackIp(request.ip ?? '')) {
    reply.code(403).send({ error: 'Admin routes are local-only. Set ADMIN_ALLOW_REMOTE=true to enable remote access.' });
    return false;
  }

  return true;
}

const batchAdminSchema = z.object({
  chainId: z.number().default(1),
  actions: z.array(z.object({
    to:    z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
    value: z.string().default('0'),
    data:  z.string().regex(/^0x[0-9a-fA-F]*$/).default('0x'),
  })).min(1).max(20),
  agentId: z.string().optional(), // If provided, executes AS this agent
});

const pauseAgentSchema = z.object({
  /**
   * When true, the response carries AgentPolicyModule calldata
   * (`emergencyPause(safe)` when pausing, `resume(safe)` when resuming) for
   * the operator to broadcast. The backend never broadcasts it itself.
   */
  syncOnChain: z.boolean().default(false),
});

/** Shape shared with PATCH /v1/agents/:id/policy — calldata the operator broadcasts. */
interface OnChainSync {
  to: string;
  chainId: number;
  actions: { to: string; value: string; data: string }[];
  notice: string;
}

/** The slice of an `Agent` row the kill-switch handlers need. */
interface KillSwitchAgent {
  id: string;
  active: boolean;
  safeAddress: string;
  chainIds: number[];
}

/**
 * `policyNote` of the admin resume response, keyed by what
 * `PolicyService.resumeByOperator` did. Exported for tests.
 */
export const RESUME_POLICY_NOTES: Record<OperatorResumeOutcome, string> = {
  reactivated: 'Policy re-activated: the operator pause had deactivated it.',
  already_active: 'Policy already active; nothing to re-activate.',
  left_inactive:
    'Policy left inactive: it was not deactivated by the operator pause (agent soft-delete, ' +
    'PATCH active=false, or a pause that predates resume tracking). ' +
    'Re-activate it with PATCH /v1/agents/:id/policy.',
  no_policy: 'Agent has no policy row; nothing to re-activate.',
};

/** Parses the optional `{ syncOnChain }` body of the kill-switch routes; replies 400 and returns null when invalid. */
function parseKillSwitchBody(request: any, reply: any): { syncOnChain: boolean } | null {
  const parsed = pauseAgentSchema.safeParse(request.body ?? {});
  if (parsed.success) return parsed.data;
  reply.code(400).send({
    error: 'Invalid request body',
    details: parsed.error.flatten().fieldErrors,
  });
  return null;
}

/**
 * Builds the on-chain kill-switch calldata for an agent's primary chain, or
 * null when that chain has no AgentPolicyModule configured. Encode-only.
 */
async function buildKillSwitchOnChainSync(
  agent: { id: string; safeAddress: string; chainIds: number[] },
  pause: boolean,
): Promise<OnChainSync | null> {
  const chainId = agent.chainIds[0] ?? 1;

  let policyModule: Address | undefined;
  try {
    policyModule = getContracts(chainId).policyModule;
  } catch (err) {
    logger.warn(
      { agentId: agent.id, chainId, err: (err as Error)?.message ?? String(err) },
      'Cannot build on-chain kill-switch calldata: chain has no contract config',
    );
    return null;
  }
  if (!policyModule) return null;

  const safeAddress = getAddress(agent.safeAddress);
  const data = pause
    ? await policyService.onChain.buildEmergencyPauseCalldata({ safeAddress })
    : await policyService.onChain.buildResumeCalldata({ safeAddress });

  return {
    to: policyModule,
    chainId,
    actions: [{ to: policyModule, value: '0', data }],
    notice: `Broadcast via POST /admin/transactions/batch to ${pause ? 'pause' : 'resume'} the on-chain policy. The backend has NOT broadcast this.`,
  };
}

/**
 * Shared by POST /admin/agents/:id/resume and the resume half of the pause
 * toggle. Idempotent: an agent that is already active is left alone
 * (`agentReactivated: false`), and the DB policy is re-activated only when the
 * operator pause deactivated it (`PolicyService.resumeByOperator`) — a policy
 * that was inactive for any other reason stays inactive and `policyNote` says
 * so. `onChainSync` (`AgentPolicyModule.resume(safe)` calldata) is built
 * whenever requested, even on a no-op, so the chain can be re-synced alone.
 */
async function resumeAgent(agent: KillSwitchAgent, syncOnChain: boolean) {
  const agentReactivated = !agent.active;
  if (agentReactivated) {
    await db.agent.update({ where: { id: agent.id }, data: { active: true } });
  }

  const policyOutcome = await policyService.resumeByOperator(agent.id);
  const onChainSync = syncOnChain ? await buildKillSwitchOnChainSync(agent, false) : null;

  logger.info(
    {
      agentId: agent.id,
      agentReactivated,
      policyOutcome,
      syncOnChain,
      onChainSyncPrepared: onChainSync !== null,
    },
    'Admin resumed agent',
  );

  return {
    active: true as const,
    agentReactivated,
    policyReactivated: policyOutcome === 'reactivated',
    policyNote: RESUME_POLICY_NOTES[policyOutcome],
    onChainSync,
  };
}

export async function adminRoutes(fastify: FastifyInstance) {
  /**
   * POST /admin/transactions/batch — execute an admin-originated batch.
   * Used for policy synchronization and other maintenance.
   */
  fastify.post('/admin/transactions/batch', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const body = batchAdminSchema.parse(request.body);
    
    // Find agent context (policy sync is per-agent)
    const agent = body.agentId 
      ? await db.agent.findUnique({ where: { id: body.agentId } })
      : await db.agent.findFirst(); // Fallback to first agent for global maintenance if needed

    if (!agent) return reply.code(404).send({ error: 'Agent not found for context.' });

    const { getContracts } = await import('../../config/contracts.js');
    const contracts = getContracts(body.chainId);
    if (!contracts.executor) {
      return reply.code(400).send({ error: `Executor not deployed on chain ${body.chainId}` });
    }

    const { encodeFunctionData } = await import('viem');

    // Matches AgentExecutor.Action (target, value, token, data) — ABI generated
    // from the Solidity source (`npm run abi:executor`).
    const onChainActions = body.actions.map(a => ({
      target: getAddress(a.to) as `0x${string}`,
      value: BigInt(a.value),
      token: '0x0000000000000000000000000000000000000000' as `0x${string}`, // ETH context
      data: a.data as `0x${string}`,
    }));

    const batchCalldata = encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [onChainActions],
    });

    const tx = await db.transaction.create({
      data: {
        agentId: agent.id,
        chainId: body.chainId,
        status: 'QUEUED',
        type: 'BATCH',
        amountIn: '0',
        metadata: { admin: true, actionCount: body.actions.length },
      },
    });

    await transactionQueue.add('batch', {
      transactionId: tx.id,
      chainId: body.chainId,
      walletId: agent.walletId,
      from: getAddress(agent.safeAddress),
      to: contracts.executor,
      data: batchCalldata,
      value: '0',
      agentId: agent.id,
      tier: agent.tier,
      feeAmountWei: '0', // Admin txs are free
      feeUsd: '0',
      feeBps: 0,
      routedViaExecutor: true,
    });

    return { transactionId: tx.id, status: 'QUEUED' };
  });

  /**
   * GET /admin/stats — dashboard overview.
   */
  fastify.get('/admin/stats', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const todayStr = todayDate.toISOString().slice(0, 10);

    // Stale PAYMENT_PENDING threshold mirrors the recovery worker's default
    // (5 min). Anything sitting in PAYMENT_PENDING longer than that is a
    // candidate for the recovery scan and worth surfacing on the dashboard
    // as an at-a-glance health signal — see #73 / #75.
    const stalePaymentPendingCutoff = new Date(Date.now() - 5 * 60 * 1000);

    const [
      activeAgents,
      totalTransactions,
      confirmedToday,
      failedToday,
      feeEvents,
      dailyVolumes,
      paymentPending,
      paymentFailed,
      stalePaymentPending,
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
      db.job.count({ where: { status: 'PAYMENT_PENDING' } }),
      db.job.count({ where: { status: 'PAYMENT_FAILED' } }),
      db.job.count({
        where: {
          status: 'PAYMENT_PENDING',
          updatedAt: { lt: stalePaymentPendingCutoff },
        },
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
      paymentPending,
      paymentFailed,
      stalePaymentPending,
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
   * GET /admin/jobs — global Job log with optional status filter.
   * Issue #75: surfaces PAYMENT_PENDING / PAYMENT_FAILED queues operators
   * previously had to query the DB directly to find.
   */
  fastify.get('/admin/jobs', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(parseInt(query.limit ?? '50'), 200);

    const jobs = await db.job.findMany({
      ...(query.status ? { where: { status: query.status as any } } : {}),
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        requester: { select: { id: true, name: true } },
        provider: { select: { id: true, name: true } },
      },
    });

    return { jobs };
  });

  /**
   * POST /admin/jobs/:id/reconcile — manual reconciliation for stuck/failed jobs.
   * Issue #75: gives operators the "Force COMPLETED" / "Force FAILED + Refund"
   * escape hatches for cases the recovery worker can't resolve automatically
   * (operator manually verified payment off-system, etc.).
   *
   * Action semantics:
   *   - force_completed: Job → COMPLETED, escrow marked RELEASED, reputation
   *     awarded. Use when payment has been verified through other means.
   *   - force_failed:    Job → PAYMENT_FAILED, escrow refunded to requester.
   *     Use when a stuck PAYMENT_PENDING is confirmed never to settle.
   *
   * Audit trail lands in the structured logger output (operator-facing log
   * shipping captures it). For now we don't persist a separate JobAuditLog
   * table — the structured logs are the audit trail.
   */
  const reconcileSchema = z.object({
    action: z.enum(['force_completed', 'force_failed']),
    reason: z.string().min(3).max(500),
  });

  fastify.post<{ Params: { id: string } }>(
    '/admin/jobs/:id/reconcile',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const parsed = reconcileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { action, reason } = parsed.data;

      const job = await db.job.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          status: true,
          providerId: true,
          requesterId: true,
          reservationStatus: true,
          reward: true,
        },
      });
      if (!job) return reply.code(404).send({ error: 'Job not found' });

      // Only allow reconcile on payment-state jobs to avoid accidental
      // overrides on healthy lifecycle states (PENDING/ACCEPTED/COMPLETED/etc).
      if (job.status !== 'PAYMENT_PENDING' && job.status !== 'PAYMENT_FAILED') {
        return reply.code(409).send({
          error: `Job is in ${job.status} status; reconcile only valid for PAYMENT_PENDING / PAYMENT_FAILED.`,
        });
      }

      // Refund-then-flip ordering, mirroring the finalizer (#85 lesson) so
      // any concurrent observer sees a consistent state.
      try {
        if (action === 'force_completed') {
          if (job.reservationStatus === 'PENDING') {
            // Mark as RELEASED (consumed by payment), don't refund — operator
            // claims payment happened off-system.
            await db.job.update({
              where: { id: job.id },
              data: { reservationStatus: 'RELEASED' },
            });
          }
          await reputationService.recordJobOutcome(job.providerId, true);
          await db.job.update({
            where: { id: job.id },
            data: { status: 'COMPLETED' },
          });
        } else {
          // force_failed
          if (job.reservationStatus === 'PENDING') {
            // Refund: same path as releaseJobEscrow used by the automated
            // finalizer. We use the existing helper so DailyVolume is
            // adjusted consistently.
            const { releaseJobEscrow } = await import(
              '../../services/policy/escrow.service.js'
            );
            await releaseJobEscrow(job.id);
          }
          await db.job.update({
            where: { id: job.id },
            data: { status: 'PAYMENT_FAILED' },
          });
        }
      } catch (err) {
        logger.error(
          {
            jobId: job.id,
            action,
            reason,
            err: (err as Error)?.message ?? String(err),
          },
          'Admin reconcile failed mid-write — manual DB inspection required',
        );
        return reply.code(500).send({
          error: 'Reconcile failed mid-write; check server logs.',
        });
      }

      logger.warn(
        {
          adminAction: 'job_reconcile',
          jobId: job.id,
          action,
          reason,
          previousStatus: job.status,
          providerId: job.providerId,
          requesterId: job.requesterId,
          // request.ip captures origin IP but operator identity beyond
          // ADMIN_SECRET-holder isn't tracked yet (no per-operator auth).
          remoteIp: request.ip,
        },
        'Admin manually reconciled a payment job',
      );

      return {
        jobId: job.id,
        previousStatus: job.status,
        newStatus: action === 'force_completed' ? 'COMPLETED' : 'PAYMENT_FAILED',
        reservationStatus: action === 'force_completed' ? 'RELEASED' : 'CANCELLED',
      };
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
   * POST /admin/agents/:id/pause — emergency kill switch (toggle).
   *
   * Off-chain effect (always): flips `agent.active`. When pausing, also sets
   * `agentPolicy.active = false` (stamping `pausedByOperatorAt`) so
   * `PolicyService.validateTransaction` fails closed. Transactions that were
   * already QUEUED when the pause landed are rejected by the worker's
   * pre-submit guard (`services/transaction/pre-submit-guard.ts`) and marked
   * FAILED. When the toggle resumes, it behaves exactly like
   * POST /admin/agents/:id/resume (see `resumeAgent`): the DB policy is
   * re-activated only if the pause deactivated it, and the response says so.
   *
   * On-chain effect: NONE is performed by the backend. Send
   * `{ "syncOnChain": true }` to receive `onChainSync` — the
   * `AgentPolicyModule.emergencyPause(safe)` (or `resume(safe)`) calldata —
   * to broadcast via POST /admin/transactions/batch, exactly like
   * PATCH /v1/agents/:id/policy. `onChainSync` is null when the agent's chain
   * has no policyModule configured or `syncOnChain` was not requested.
   *
   * Response: `{ active: false, onChainSync }` when pausing (unchanged);
   * the resume response shape when resuming.
   */
  fastify.post<{ Params: { id: string }; Body: { syncOnChain?: boolean } | undefined }>(
    '/admin/agents/:id/pause',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const body = parseKillSwitchBody(request, reply);
      if (!body) return;
      const { syncOnChain } = body;

      const agent = await db.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) return reply.code(404).send({ error: 'Not found' });

      if (!agent.active) {
        return resumeAgent(agent, syncOnChain);
      }

      await db.agent.update({
        where: { id: agent.id },
        data: { active: false },
      });

      // Off-chain kill switch only: pause the DB policy so policy checks fail
      // closed, stamping it so resume can undo exactly this flip. The on-chain
      // policy is NOT touched here.
      const policyPaused = await policyService.pauseByOperator(agent.id);

      const onChainSync = syncOnChain ? await buildKillSwitchOnChainSync(agent, true) : null;

      logger.info(
        {
          agentId: agent.id,
          nowActive: false,
          policyPaused,
          syncOnChain,
          onChainSyncPrepared: onChainSync !== null,
        },
        'Admin toggled agent status',
      );
      return { active: false, onChainSync };
    },
  );

  /**
   * POST /admin/agents/:id/resume — explicit, idempotent counterpart of the
   * pause toggle. Never pauses. Sets `agent.active = true` and re-activates
   * the DB policy only if the operator pause deactivated it; otherwise the
   * policy is left as is and `policyNote` explains (use
   * PATCH /v1/agents/:id/policy). Same `{ "syncOnChain": true }` contract as
   * the pause route, returning `AgentPolicyModule.resume(safe)` calldata.
   */
  fastify.post<{ Params: { id: string }; Body: { syncOnChain?: boolean } | undefined }>(
    '/admin/agents/:id/resume',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const body = parseKillSwitchBody(request, reply);
      if (!body) return;

      const agent = await db.agent.findUnique({ where: { id: request.params.id } });
      if (!agent) return reply.code(404).send({ error: 'Not found' });

      return resumeAgent(agent, body.syncOnChain);
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

      // Read the pre-built queue payload stored at transaction creation time.
      // Avoids unsafe reconstruction (wrong decimals, stale quotes, etc.).
      const queuePayload = (tx.metadata as any)?.queuePayload as {
        to: string;
        data: string;
        value: string;
        feeAmountWei: string;
        feeBps: number;
        routedViaExecutor: boolean;
      } | undefined;

      if (!queuePayload?.to || !queuePayload?.data) {
        return reply.code(400).send({
          error: 'Transaction payload missing — this record was created before approval support was added and cannot be re-enacted.',
        });
      }

      const to = getAddress(queuePayload.to) as `0x${string}`;
      const data = queuePayload.data as `0x${string}`;
      const value = BigInt(queuePayload.value || '0');
      const routedViaExecutor = queuePayload.routedViaExecutor ?? false;
      const feeAmountWei = BigInt(queuePayload.feeAmountWei || '0');
      const feeBps = queuePayload.feeBps ?? 30;

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
        feeBps,
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

  /**
   * GET /admin/volume — daily volume chart data (last 7 days).
   */
  fastify.get('/admin/volume', async (request, reply) => {
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

  /**
   * POST /admin/reputation/recompute
   * Recomputes reputation scores for all active agents (or a single agent).
   * Intended for daily cron or manual admin triggers.
   */
  fastify.post('/admin/reputation/recompute', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const schema = z.object({ agentId: z.string().cuid().optional() });
    const { agentId } = schema.parse(request.body ?? {});

    try {
      if (agentId) {
        const score = await reputationService.refreshReputation(agentId);
        return { agentId, reputationScore: score };
      }
      const result = await reputationService.updateAllReputationScores();
      return result;
    } catch (err) {
      logger.error({ err }, 'Reputation recompute failed');
      return reply.code(500).send({ error: 'Failed to recompute reputation' });
    }
  });

  /**
   * GET /admin/reputation/:agentId
   * Returns the current reputation score and the raw metrics used to compute it.
   */
  fastify.get<{ Params: { agentId: string } }>(
    '/admin/reputation/:agentId',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const agent = await db.agent.findUnique({
        where: { id: request.params.agentId },
        select: {
          id: true,
          name: true,
          reputationScore: true,
          a2aTxCount: true,
          lastActiveAt: true,
        },
      });

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const freshScore = await reputationService.computeReputationScore(agent.id);

      return {
        ...agent,
        computedScore: freshScore,
        persistedScore: agent.reputationScore,
        drift: freshScore - agent.reputationScore,
      };
    },
  );

  /**
   * GET /admin/agents/:id/pnl
   * Profit & loss breakdown for any agent (admin auth).
   * Query param: since (optional ISO8601, defaults to agent.createdAt)
   */
  fastify.get<{ Params: { id: string } }>(
    '/admin/agents/:id/pnl',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const query = request.query as { since?: string };
      const since = query.since ? new Date(query.since) : undefined;
      if (since && Number.isNaN(since.getTime())) {
        return reply.code(400).send({ error: 'Invalid `since` parameter (must be ISO8601)' });
      }

      try {
        return await pnlService.computeAgentPnL({
          agentId: request.params.id,
          ...(since ? { since } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg });
        }
        logger.error({ err, agentId: request.params.id }, 'P&L compute failed');
        return reply.code(500).send({ error: 'Failed to compute P&L' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Operator management & revenue sharing
  // ---------------------------------------------------------------------------

  const createOperatorSchema = z.object({
    name: z.string().min(1),
    walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    contactEmail: z.string().email().optional(),
    revShareBps: z.number().min(0).max(5000).optional(),
  });

  fastify.post('/admin/operators', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = createOperatorSchema.parse(request.body);
    const operator = await operatorService.createOperator({
      name: body.name,
      walletAddress: body.walletAddress,
      contactEmail: body.contactEmail ?? null,
      revShareBps: body.revShareBps ?? null,
    });
    return reply.code(201).send(operator);
  });

  fastify.get('/admin/operators', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return operatorService.listOperators();
  });

  fastify.get<{ Params: { id: string } }>('/admin/operators/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const stats = await operatorService.getOperatorStats(request.params.id);
    if (!stats.operator) return reply.code(404).send({ error: 'Operator not found' });
    return stats;
  });

  const assignAgentSchema = z.object({ operatorId: z.string() });

  fastify.post<{ Params: { id: string } }>(
    '/admin/agents/:id/operator',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = assignAgentSchema.parse(request.body);
      const agent = await operatorService.assignAgentToOperator(
        request.params.id,
        body.operatorId,
      );
      return agent;
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/admin/agents/:id/operator',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const agent = await operatorService.removeAgentFromOperator(request.params.id);
      return agent;
    },
  );

  const createSettlementSchema = z.object({
    operatorId: z.string(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    chainId: z.number().optional(),
  });

  fastify.post('/admin/settlements', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = createSettlementSchema.parse(request.body);
    const settlement = await operatorService.createSettlement({
      operatorId: body.operatorId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      chainId: body.chainId ?? null,
    });
    if (!settlement) {
      return reply.code(404).send({ error: 'No pending revenue for this period' });
    }
    return reply.code(201).send(settlement);
  });

  fastify.get('/admin/settlements', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const settlements = await db.operatorSettlement.findMany({
      include: { operator: { select: { name: true, walletAddress: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { settlements };
  });

  const settleSchema = z.object({ txHash: z.string() });

  fastify.patch<{ Params: { id: string } }>(
    '/admin/settlements/:id/complete',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const body = settleSchema.parse(request.body);
      const settlement = await operatorService.markSettlementComplete(
        request.params.id,
        body.txHash,
      );
      return settlement;
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/admin/settlements/:id/fail',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      await operatorService.markSettlementFailed(request.params.id);
      return { ok: true };
    },
  );
}
