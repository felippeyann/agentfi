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
import { isLocalOnlyRequest } from '../middleware/local-request.js';
import { publicErrorMessage } from '../errors/sanitize.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { transactionJobId } from '../../queues/transaction-job-id.js';
import { getContracts } from '../../config/contracts.js';
import {
  PolicyService,
  type OperatorResumeOutcome,
} from '../../services/policy/policy.service.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { moveReservationToDay, settleVolumeAfterFailure } from '../../services/policy/daily-volume.js';
import { PnLService } from '../../services/billing/pnl.service.js';
import { OperatorService } from '../../services/billing/operator.service.js';
import { PolicySyncService, type PolicySyncOutcome } from '../../services/policy/policy-sync.service.js';
import type { PolicyModuleReader } from '../../services/policy/policy-sync.js';
import { createChainPublicClient } from '../../config/chains.js';
import { getWalletService } from '../../services/wallet/index.js';

const policyService = new PolicyService(db);
const reputationService = new ReputationService();
const pnlService = new PnLService();
const operatorService = new OperatorService(db);

/** The configured `AgentPolicyModule` of a chain (undefined: none, or an unknown chain). */
function configuredPolicyModule(chainId: number): Address | undefined {
  try {
    return getContracts(chainId).policyModule;
  } catch {
    return undefined;
  }
}

/**
 * S8: the on-chain policy sync. Calls go from the agent's own wallet straight
 * to the module (msg.sender == safe, EOA mode), derived only from the stored
 * policy; never through the executor and never with caller calldata.
 */
const policySync = new PolicySyncService({
  db,
  enqueue: async (transactionId, data) => {
    await transactionQueue.add('policy-sync', data, { jobId: transactionJobId(transactionId) });
  },
  reader: (chainId) => {
    const client = createChainPublicClient(chainId);
    return ((params) => client.readContract(params as never)) as PolicyModuleReader;
  },
  walletAddress: (walletId) => getWalletService().getWalletAddress(walletId),
  policyModule: configuredPolicyModule,
  logger,
});

/** HTTP body of a sync outcome (`POST /admin/agents/:id/policy/sync`, `onChainSync` of the kill switch). */
function policySyncBody(outcome: Exclude<PolicySyncOutcome, { kind: 'not-found' }>) {
  switch (outcome.kind) {
    case 'queued':
      return {
        status: 'pending' as const,
        transactions: outcome.transactions,
        differences: outcome.differences,
        unknownExtras: outcome.unknownExtras,
        ...(outcome.enqueueError ? { enqueueError: outcome.enqueueError } : {}),
        notice:
          "Queued: signed by the agent's own wallet and sent straight to AgentPolicyModule (not via the executor). " +
          'GET /admin/agents/:id/policy/onchain shows the DB and on-chain policy until the receipts land.',
      };
    case 'in-sync':
      return { status: 'in-sync' as const, transactions: [], differences: [], view: outcome.view };
    case 'refused':
      return { status: 'refused' as const, code: outcome.code, error: outcome.error, view: outcome.view };
  }
}

/**
 * The kill switch's on-chain half (`syncOnChain: true`): the same sync, run
 * after the DB pause / resume. Null when the chain has no module (as before
 * S8); a refusal is reported in the body and never undoes the DB change.
 */
async function killSwitchSync(agentId: string, trigger: 'kill-switch-pause' | 'kill-switch-resume') {
  try {
    const outcome = await policySync.sync(agentId, trigger);
    if (outcome.kind === 'not-found') return null;
    if (outcome.kind === 'refused' && outcome.code === 'POLICY_MODULE_NOT_CONFIGURED') return null;
    return policySyncBody(outcome);
  } catch (err) {
    logger.error({ agentId, trigger, err: (err as Error)?.message ?? String(err) }, 'Kill switch on-chain sync failed');
    return { status: 'refused' as const, code: 'POLICY_SYNC_ERROR', error: publicErrorMessage(err) };
  }
}
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';
const ADMIN_ALLOW_REMOTE = process.env['ADMIN_ALLOW_REMOTE'] === 'true';

function requireAdmin(request: any, reply: any): boolean {
  const secret = request.headers['x-admin-secret'];
  if (!secret || !ADMIN_SECRET || Buffer.byteLength(secret) !== Buffer.byteLength(ADMIN_SECRET) || !timingSafeEqual(Buffer.from(secret), Buffer.from(ADMIN_SECRET))) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }

  // S6: never `request.ip` — with TRUST_PROXY on it comes from a
  // client-chosen X-Forwarded-For. The TCP peer and every forwarded hop must
  // be loopback (api/middleware/local-request.ts).
  if (!ADMIN_ALLOW_REMOTE && !isLocalOnlyRequest(request)) {
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
  // Required (G1 review): the batch is signed by this agent's wallet and runs
  // from its Safe. There is no fallback agent — an unnamed batch used to run
  // as whatever agent the database returned first.
  agentId: z.string().min(1),
});

const pauseAgentSchema = z.object({
  /**
   * When true, the kill switch also syncs the on-chain AgentPolicyModule (S8):
   * after the DB pause / resume, the stored policy is pushed by the same path
   * as POST /admin/agents/:id/policy/sync (the agent's own wallet, straight to
   * the module) and `onChainSync` reports what was queued or why it was not.
   */
  syncOnChain: z.boolean().default(false),
});

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
 * Shared by POST /admin/agents/:id/resume and the resume half of the pause
 * toggle. Idempotent: an agent that is already active is left alone
 * (`agentReactivated: false`), and the DB policy is re-activated only when the
 * operator pause deactivated it (`PolicyService.resumeByOperator`) — a policy
 * that was inactive for any other reason stays inactive and `policyNote` says
 * so. With `syncOnChain`, the stored policy is then synced on-chain (S8) —
 * whenever requested, even on a no-op, so the chain can be re-synced alone.
 */
async function resumeAgent(agent: KillSwitchAgent, syncOnChain: boolean) {
  const agentReactivated = !agent.active;
  if (agentReactivated) {
    await db.agent.update({ where: { id: agent.id }, data: { active: true } });
  }

  const policyOutcome = await policyService.resumeByOperator(agent.id);
  const onChainSync = syncOnChain ? await killSwitchSync(agent.id, 'kill-switch-resume') : null;

  logger.info(
    {
      agentId: agent.id,
      agentReactivated,
      policyOutcome,
      syncOnChain,
      onChainSync: onChainSync?.status ?? null,
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
   * POST /admin/transactions/batch — execute an admin-originated batch,
   * signed by the named agent's wallet and run through AgentExecutor.
   *
   * Not for the on-chain policy (S8): inside `executeBatch` the EXECUTOR is
   * `msg.sender`, and AgentPolicyModule accepts its admin calls only from its
   * operator or the safe itself — every module call reverts Unauthorized
   * (and `validateTransaction`, which has no caller check, would only restart
   * a wallet's on-chain cooldown). An action targeting the configured module
   * is refused (403 `POLICY_MODULE_TARGET`); use
   * POST /admin/agents/:id/policy/sync.
   */
  fastify.post('/admin/transactions/batch', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parsed = batchAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });
    }
    const body = parsed.data;

    // The batch runs AS this agent (its wallet signs, its Safe executes).
    const agent = await db.agent.findUnique({ where: { id: body.agentId } });
    if (!agent) return reply.code(404).send({ error: `Agent ${body.agentId} not found.` });

    const contracts = getContracts(body.chainId);
    const moduleIndex = contracts.policyModule
      ? body.actions.findIndex((a) => a.to.toLowerCase() === contracts.policyModule!.toLowerCase())
      : -1;
    if (moduleIndex >= 0) {
      return reply.code(403).send({
        error:
          `Action at index ${moduleIndex} targets the AgentPolicyModule. Through AgentExecutor the executor is msg.sender and the ` +
          'module answers Unauthorized; sync the stored policy with POST /admin/agents/:id/policy/sync instead.',
        code: 'POLICY_MODULE_TARGET',
        actionIndex: moduleIndex,
      });
    }
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
        metadata: {
          admin: true,
          actionCount: body.actions.length,
          // A6b: what the stranded-QUEUED sweep re-enqueues after a crash before the add.
          queuePayload: { to: contracts.executor, data: batchCalldata, value: '0', feeAmountWei: '0', feeBps: 0, routedViaExecutor: true },
        },
      },
    });

    await transactionQueue.add(
      'batch',
      {
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
      },
      { jobId: transactionJobId(tx.id) },
    );

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
          escrowKind: true,
          onChainStatus: true,
        },
      });
      if (!job) return reply.code(404).send({ error: 'Job not found' });

      // C3d: an ERC-8183 job whose budget may still be on-chain is settled by
      // the evaluator, not by a DB flip (a "force COMPLETED" job would still
      // be refunded at expiry, a "force FAILED" one keeps the USDC locked).
      if (
        job.escrowKind === 'erc8183' &&
        !['COMPLETED', 'REJECTED', 'EXPIRED', 'EXPIRED_UNFUNDED', 'FAILED'].includes(job.onChainStatus ?? '')
      ) {
        return reply.code(409).send({
          error: 'USE_RESOLVE',
          message:
            `ERC-8183 job with onChainStatus ${job.onChainStatus}: decide it with POST /admin/jobs/${job.id}/resolve ` +
            '(pay | refund | refund + quality-rejected | payout-blocked) so the evaluator settles it on-chain.',
        });
      }

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
   * POST /admin/jobs/:id/resolve — operator decision on an ERC-8183 job held
   * for review (C3d, decision D9): a contested job (`onChainStatus
   * CONTESTED`), a CANCELLED/FAILED job whose deliverable is Submitted
   * on-chain (C3c alert), or a PAYMENT_PENDING job whose settlement is stuck.
   *
   *   { decision: 'pay' }                                   complete + feedback (rating 100)
   *   { decision: 'refund' }                                reject, "0x" (no rating)
   *   { decision: 'refund', verdict: 'quality-rejected' }   reject REASON_QUALITY_REJECTED + feedback (rating 0)
   *   { decision: 'payout-blocked' }                        reject REASON_PAYOUT_BLOCKED, "0x" (no rating)
   *
   * `note` (required) and `operator` (the admin UI sends its signed-in user;
   * default "admin-api") are recorded on the job with the time
   * (`resolution`, `resolvedBy`, `resolvedAt`, `resolutionNote`, `reviewLog`).
   * The evaluator settles from the settlement queue; the response is 202.
   */
  const resolveSchema = z
    .object({
      decision: z.enum(['pay', 'refund', 'payout-blocked']),
      verdict: z.literal('quality-rejected').optional(),
      note: z.string().trim().min(3).max(1000),
      operator: z.string().trim().min(1).max(120).optional(),
    })
    .refine((body) => body.verdict === undefined || body.decision === 'refund', {
      message: 'verdict "quality-rejected" is only valid with decision "refund"',
      path: ['verdict'],
    });

  fastify.post<{ Params: { id: string } }>('/admin/jobs/:id/resolve', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parsed = resolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten().fieldErrors });
    }
    const { decision, verdict, note, operator } = parsed.data;
    const resolution = decision === 'refund' && verdict === 'quality-rejected' ? 'quality-rejected' : decision;

    // Imported lazily like the reconcile route's escrow service: the runtime
    // binds BullMQ queues and RPC clients that the other admin routes never need.
    const { resolveJob } = await import('../../services/job/escrow-erc8183.runtime.js');
    const outcome = await resolveJob({ jobId: request.params.id, decision: resolution, note, operator: operator ?? 'admin-api' });

    if (outcome.outcome === 'unverifiable') {
      return reply.code(503).send({ error: 'CHAIN_UNREADABLE', message: outcome.message });
    }
    if (outcome.outcome === 'refused') {
      const status = outcome.code === 'NOT_FOUND' ? 404 : 409;
      return reply.code(status).send({
        error: outcome.code,
        message: outcome.message,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.onChainStatus !== undefined ? { onChainStatus: outcome.onChainStatus } : {}),
      });
    }
    return reply.code(202).send({
      jobId: request.params.id,
      resolution: outcome.resolution,
      previousStatus: outcome.previousStatus,
      previousOnChainStatus: outcome.previousOnChainStatus,
      queued: outcome.queued,
    });
  });

  /**
   * GET /admin/escrow/verification — Q7: this API process's verification
   * state of each ERC-8183 chain, with the reason when new escrow operations
   * are blocked (`/health/ready` shows the same without reasons). The worker
   * verifies on its own; its state is in its logs and ESCROW_ALERT notifications.
   */
  fastify.get('/admin/escrow/verification', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { escrowVerificationSnapshot, escrowVerificationSettings } = await import('../../config/escrow-verification.runtime.js');
    return { process: 'api', ...escrowVerificationSettings(), chains: escrowVerificationSnapshot({ withReason: true }) };
  });

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
   * On-chain effect (S8): only with `{ "syncOnChain": true }`. After the DB
   * change the stored policy is synced exactly as by
   * POST /admin/agents/:id/policy/sync — calls signed by the agent's own
   * wallet and sent straight to AgentPolicyModule (msg.sender == safe in EOA
   * mode), never via the executor, where the module answers Unauthorized. The
   * pre-submit guard signs them although the agent is paused. `onChainSync`
   * is `{ status: 'pending' | 'in-sync' | 'refused', … }`, or null when the
   * agent's chain has no policyModule configured or `syncOnChain` was not
   * requested. A refusal (Safe mode, unreadable chain…) never undoes the DB
   * pause.
   *
   * Response: `{ active: false, onChainSync }` when pausing;
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

      // Pause the DB policy so policy checks fail closed, stamping it so
      // resume can undo exactly this flip. The on-chain policy follows only
      // with syncOnChain (below).
      const policyPaused = await policyService.pauseByOperator(agent.id);

      const onChainSync = syncOnChain ? await killSwitchSync(agent.id, 'kill-switch-pause') : null;

      logger.info(
        {
          agentId: agent.id,
          nowActive: false,
          policyPaused,
          syncOnChain,
          onChainSync: onChainSync?.status ?? null,
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
   * the pause route: the stored policy is synced on-chain afterwards (S8).
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
   * GET /admin/agents/:id/policy/onchain — the stored policy and what the
   * agent chain's AgentPolicyModule holds, side by side (S8).
   *
   * `status`: in-sync | pending (sync transactions queued or awaiting a
   * receipt) | failed (differs, and the latest sync attempt failed or
   * reverted) | out-of-sync (differs, never synced or the DB changed since) |
   * not-configured | no-db-policy | not-representable | unreadable | mismatch.
   * `db` is the stored policy as the module would hold it, `onChain` what it
   * holds (null when unreadable), `differences` the human-readable diff,
   * `pending` / `lastFailure` the sync transactions. Read-only.
   */
  fastify.get<{ Params: { id: string } }>('/admin/agents/:id/policy/onchain', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const view = await policySync.view(request.params.id);
    if (!view) return reply.code(404).send({ error: 'Not found' });
    return view;
  });

  /**
   * POST /admin/agents/:id/policy/sync — push the STORED policy to the agent
   * chain's AgentPolicyModule (S8). No body: nothing caller-supplied is signed.
   *
   * The calls (`setPolicy`, or only `emergencyPause` / `resume` when only the
   * active flag differs; `updateContractWhitelist` / `updateTokenWhitelist`
   * adding AND removing entries) are derived from the DB policy and the
   * module's current state, queued as transactions signed by the agent's own
   * wallet and sent straight to the module — `msg.sender == safe` for an
   * agent whose `safeAddress` is its EOA. Never through AgentExecutor (the
   * executor is not the safe or the operator). Identical calls already in
   * flight are reused.
   *
   * 202 `{ status: 'pending', transactions }` · 200 `{ status: 'in-sync' }` ·
   * 409 POLICY_MODULE_NOT_CONFIGURED / NO_DB_POLICY / POLICY_SYNC_WALLET_MODE
   * (Safe mode: the agent key is not the safe) / POLICY_MODULE_MISMATCH /
   * POLICY_SYNC_UNKNOWN_ENTRIES · 422 POLICY_NOT_REPRESENTABLE ·
   * 503 ONCHAIN_POLICY_UNREADABLE. Each refusal carries the `view`.
   */
  fastify.post<{ Params: { id: string } }>('/admin/agents/:id/policy/sync', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const outcome = await policySync.sync(request.params.id, 'admin-sync');
    if (outcome.kind === 'not-found') return reply.code(404).send({ error: 'Not found' });
    if (outcome.kind === 'refused') return reply.code(outcome.httpStatus).send(policySyncBody(outcome));
    if (outcome.kind === 'in-sync') return reply.code(200).send(policySyncBody(outcome));
    return reply.code(outcome.enqueueError ? 503 : 202).send(policySyncBody(outcome));
  });

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

      // Conditional (A6): of two concurrent approvals only one moves the row
      // out of PENDING_APPROVAL and enqueues it.
      const approved = await db.transaction.updateMany({
        where: { id: tx.id, status: 'PENDING_APPROVAL' },
        data: { status: 'QUEUED' },
      });
      if (approved.count === 0) {
        return reply.code(409).send({ error: 'Transaction is no longer PENDING_APPROVAL.' });
      }

      // A6b: it executes today, so its reservation counts today — not on the
      // (earlier) day it was requested. Not refused by today's limit: the
      // operator approved it. A failure keeps the creation day (as before).
      await moveReservationToDay(db, tx.id).catch((err: unknown) =>
        logger.error({ transactionId: tx.id, err: (err as Error)?.message ?? String(err) }, 'Approved transaction: reservation left on its creation day'),
      );

      // A6b: the row's own job id — a crash between the QUEUED write above and
      // this add leaves a QUEUED row the stranded-QUEUED sweep re-enqueues
      // (the operator cannot approve it again), never twice.
      try {
        await transactionQueue.add(
          tx.type.toLowerCase(),
          {
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
          },
          { jobId: transactionJobId(tx.id) },
        );
      } catch (err) {
        // Not enqueued: back to PENDING_APPROVAL (still holding its daily-volume
        // reservation) so the operator can approve again, instead of a QUEUED
        // row no worker will ever run (A6 review). A6b: unless the add did
        // reach Redis (a timeout after the write) and a worker already stamped
        // a broadcast attempt — that row is in flight and stays QUEUED.
        const reverted = await db.transaction.updateMany({
          where: { id: tx.id, status: 'QUEUED', txHash: null, broadcastAttemptedAt: null },
          data: { status: 'PENDING_APPROVAL' },
        });
        logger.error({ transactionId: tx.id, err: (err as Error)?.message ?? String(err) }, 'Admin approval could not enqueue the transaction');
        if (reverted.count === 0) {
          // The job did reach the queue: the approval stands.
          return { status: 'QUEUED' };
        }
        return reply.code(503).send({ error: 'Could not enqueue the transaction; it is still PENDING_APPROVAL. Retry the approval.' });
      }

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

      const rejected = await db.transaction.updateMany({
        where: { id: tx.id, status: 'PENDING_APPROVAL' },
        data: { status: 'FAILED', error: 'Operator rejected transaction' },
      });
      if (rejected.count === 0) {
        return reply.code(409).send({ error: 'Transaction is no longer PENDING_APPROVAL.' });
      }
      // Never broadcast: its DailyVolume reservation is given back (A6). The
      // rejection stands even if this fails; the recovery sweep settles it.
      await settleVolumeAfterFailure(db, tx.id).catch((err: unknown) =>
        logger.error({ transactionId: tx.id, err: (err as Error)?.message ?? String(err) }, 'Rejected transaction: volume settlement left for the sweep'),
      );

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
          return reply.code(404).send({ error: publicErrorMessage(err) });
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
