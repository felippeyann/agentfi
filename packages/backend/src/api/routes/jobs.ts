import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Job, JobStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { logger } from '../middleware/logger.js';
import { publicErrorMessage, sanitizeStoredError } from '../errors/sanitize.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { executeA2APayment } from './transactions.js';
import {
  reserveJobEscrow,
  reserveEscrowJobSpend,
  releaseJobEscrow,
  markEscrowReleased,
  queueOnChainEscrowLock,
} from '../../services/policy/escrow.service.js';
import { finalizeA2APaymentJob } from '../../services/job/payment-finalizer.service.js';
import { escrowConfigGate } from '../../config/escrow-verification.runtime.js';
import {
  contestJob,
  enqueueSubmit,
  erc8183Config,
  getEscrowToken,
  isErc8183Enabled,
  requestCancellationReject,
  startEscrow,
} from '../../services/job/escrow-erc8183.runtime.js';
import {
  ESCROW_KIND,
  FINAL_ON_CHAIN_STATUSES,
  expiryMarginMs,
  isEscrowTokenReward,
  isFeedbackFileCommitted,
  serializeFeedbackFile,
  toJobResponse,
} from '../../services/job/escrow-erc8183.service.js';
const reputationService = new ReputationService();

/**
 * A paid job names its chain and its token (X3a). The schema used to default
 * a reward to `chainId: 1, token: 'ETH'`, so a client that left them out —
 * MCP `post_job` did — silently created an Ethereum-mainnet ETH job on the
 * legacy direct-payment path instead of an escrowed USDC job (D8). Both are
 * now required: a missing one is a 400 VALIDATION_FAILED whose `details`
 * say what to set.
 */
export const REWARD_CHAIN_ID_REQUIRED =
  'reward.chainId is required for a paid job: set it to the chain the reward is paid on (e.g. 84532 for Base Sepolia, 8453 for Base). There is no default chain.';
export const REWARD_TOKEN_REQUIRED =
  'reward.token is required for a paid job: name the reward token ("USDC"; escrow-enabled chains accept only USDC, decision D8). There is no default token.';

const createJobSchema = z.object({
  providerId: z.string().cuid(),
  payload: z.record(z.any()),
  reward: z.object({
    amount: z.string(),
    token: z.string({ required_error: REWARD_TOKEN_REQUIRED }).min(1, REWARD_TOKEN_REQUIRED),
    chainId: z
      .number({
        required_error: REWARD_CHAIN_ID_REQUIRED,
        invalid_type_error: 'reward.chainId must be a number (an EVM chain id such as 84532)',
      })
      .int()
      .positive(),
  }).optional(),
  signature: z.string().optional(),
});

const updateJobSchema = z.object({
  status: z.enum(['ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED']),
  result: z.record(z.any()).optional(),
  error: z.string().optional(),
});

const contestJobSchema = z.object({
  reason: z.string().max(500).optional(),
});

/** Valid status transitions for jobs */
const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING:  ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['COMPLETED', 'FAILED', 'CANCELLED'],
};

/**
 * Full error text — for logs and the DB columns operators read. A response
 * carries `publicErrorMessage(err)` instead (S5): a viem error's message
 * holds the RPC URL with the provider key in its path.
 */
function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/**
 * Q7: a request that would start a new escrow money movement on `chainId`
 * (escrow job creation → create/fund; delivery → submit → settlement;
 * cancellation / provider failure → evaluator reject) is refused with
 * `503 ESCROW_CONFIG_UNVERIFIED` + `Retry-After` while this process has not
 * verified the chain's on-chain configuration — before anything is reserved
 * or written. Returns the reply sent, or null to go on.
 */
function refuseUnverifiedEscrow(reply: FastifyReply, chainId: number) {
  const gate = escrowConfigGate(chainId);
  if (gate.allowed) return null;
  logger.warn({ chainId, block: gate.block, reason: gate.reason }, 'Escrow request refused — on-chain configuration not verified');
  return reply
    .code(503)
    .header('Retry-After', String(gate.retryAfterSeconds))
    .send({
      error: 'ESCROW_CONFIG_UNVERIFIED',
      message:
        `The ERC-8183 escrow configuration of chain ${chainId} is not verified right now (${gate.block}); new escrow ` +
        'operations wait until it is. Nothing was reserved or changed — retry after the indicated delay.',
      chainId,
      state: gate.block,
      retryAfterSeconds: gate.retryAfterSeconds,
    });
}

export async function jobRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/jobs — create a new service request (job) for another agent.
   *
   * A paid job (`reward`) must name `reward.chainId` and `reward.token`
   * (X3a: no mainnet/ETH default). On a chain where the ERC-8183 escrow is
   * configured (C3), a paid job is USDC-only (decision D8) and its budget is
   * escrowed on-chain through `AgentJobEscrow`: the requester's wallet runs
   * createJob → setBudget → approve → fund from the transaction queue, and
   * the Job reports progress in `escrow.onChainStatus`. Everywhere else the
   * legacy (DB reservation + optional EscrowModule lock) path is unchanged.
   */
  fastify.post('/v1/jobs', async (request, reply) => {
    const body = createJobSchema.parse(request.body);

    // Logic Sentinel: Verify provider exists and is active
    const provider = await db.agent.findUnique({
      where: { id: body.providerId, active: true },
    });
    if (!provider) return reply.code(404).send({ error: 'Provider agent not found or inactive' });

    // Only read for a paid job (`reward.amount` set), where the schema
    // guarantees both values; a free job never touches them.
    const rewardChainId = body.reward?.chainId ?? 0;
    const rewardToken = body.reward?.token ?? '';
    const useErc8183 = Boolean(body.reward?.amount) && isErc8183Enabled(rewardChainId);

    let requester: { id: string; walletId: string; safeAddress: string } | null = null;
    let escrowToken: string | null = null;
    if (useErc8183) {
      // ERC-8183: the contract rejects provider == client and provider == evaluator.
      if (provider.id === request.agentId) {
        return reply.code(400).send({
          error: 'ERC8183_PROVIDER_IS_REQUESTER',
          message: 'An escrowed job cannot name its requester as the provider',
        });
      }
      if (
        erc8183Config.evaluatorAddress &&
        provider.safeAddress.toLowerCase() === erc8183Config.evaluatorAddress.toLowerCase()
      ) {
        return reply.code(400).send({
          error: 'ERC8183_PROVIDER_IS_EVALUATOR',
          message: 'An escrowed job cannot name the evaluator signer as the provider',
        });
      }

      // Q7: no new escrow while the chain's on-chain configuration is unverified (nothing reserved yet).
      const unverified = refuseUnverifiedEscrow(reply, rewardChainId);
      if (unverified) return unverified;

      // Decision D8: USDC only on escrow chains.
      try {
        escrowToken = await getEscrowToken(rewardChainId);
      } catch (err) {
        logger.error({ chainId: rewardChainId, err: errorMessage(err) }, 'ERC-8183 escrow token unavailable');
        return reply.code(503).send({ error: 'ERC8183_UNAVAILABLE', message: publicErrorMessage(err) });
      }
      if (!isEscrowTokenReward(rewardToken, escrowToken)) {
        return reply.code(400).send({
          error: 'ERC8183_USDC_ONLY',
          message: `Jobs on chain ${rewardChainId} are escrowed in USDC; set reward.token to "USDC" or ${escrowToken}`,
          chainId: rewardChainId,
          escrowToken,
        });
      }

      requester = await db.agent.findUnique({
        where: { id: request.agentId },
        select: { id: true, walletId: true, safeAddress: true },
      });
      if (!requester) return reply.code(404).send({ error: 'Requester agent not found' });
    }

    // v2 Escrow: if reward is specified, reserve funds before creating the job.
    // This prevents requesters from creating paid jobs they can't honor.
    const jobData = (
      reservation: { at: Date; reservedValueUsd: string | null; reservedValueSource: string | null } | null,
    ): Prisma.JobUncheckedCreateInput => ({
      requesterId: request.agentId,
      providerId: body.providerId,
      payload: body.payload,
      reward: body.reward ?? {},
      signature: body.signature ?? null,
      status: 'PENDING',
      ...(body.reward?.amount && reservation
        ? {
            reservedAmount: body.reward.amount,
            reservedToken: rewardToken,
            reservedChainId: rewardChainId,
            reservedAt: reservation.at,
            reservationStatus: 'PENDING',
            reservedValueUsd: reservation.reservedValueUsd,
            reservedValueSource: reservation.reservedValueSource,
          }
        : {}),
    });

    let job: Job;
    if (body.reward?.amount && useErc8183 && escrowToken) {
      // C3d: the requester's policy applies to an escrow job like to any
      // spend — allowlists (payee = provider wallet), per-tx cap and daily
      // volume with USDC at 1.00 USD (no oracle), cooldown. The check, the
      // DailyVolume increment and the Job row commit in ONE transaction under
      // the requester's Agent row lock: a refusal or a failed insert leaves
      // no reserved volume behind.
      const at = new Date();
      const spend = await reserveEscrowJobSpend(
        {
          requesterId: request.agentId,
          chainId: rewardChainId,
          amount: body.reward.amount,
          token: escrowToken,
          payee: provider.safeAddress,
          now: at,
        },
        (tx, reservation) =>
          tx.job.create({
            data: jobData({ at, reservedValueUsd: reservation.reservedValueUsd, reservedValueSource: reservation.reservedValueSource }),
          }),
      );
      if (!spend.success) {
        if (spend.code === 'RESERVATION_FAILED') {
          return reply.code(400).send({ error: 'Escrow reservation failed', reason: spend.reason });
        }
        return reply.code(spend.httpStatus).send({
          error: spend.reason,
          code: spend.code,
          ...(spend.rule ? { rule: spend.rule } : {}),
          ...(spend.limit !== undefined ? { limit: spend.limit } : {}),
          ...(spend.spentToday !== undefined ? { spentToday: spend.spentToday } : {}),
          amount: body.reward.amount,
          payee: provider.safeAddress,
        });
      }
      job = spend.created;
    } else if (body.reward?.amount) {
      const reservation = await reserveJobEscrow({
        requesterId: request.agentId,
        reward: {
          amount: body.reward.amount,
          token: rewardToken,
          chainId: rewardChainId,
        },
      });
      if (!reservation.success) {
        // Q9: a reward with no trusted price while a daily limit applies is
        // 503 PRICE_UNAVAILABLE (the job is not created), like the
        // transaction routes; every other refusal stays 400.
        if (reservation.code === 'PRICE_UNAVAILABLE') {
          return reply.code(503).send({
            error: 'Escrow reservation failed',
            code: 'PRICE_UNAVAILABLE',
            reason: reservation.reason,
            ...(reservation.rule ? { rule: reservation.rule } : {}),
          });
        }
        // §5-6: the reward, paid later as an ordinary outflow, cannot pass
        // maxOutflowPerTxUsd (not configured, or above it): 403, no job.
        if (reservation.code === 'USD_CAP_NOT_CONFIGURED' || reservation.code === 'POLICY_VIOLATION') {
          return reply.code(403).send({
            error: reservation.reason,
            code: reservation.code,
            ...(reservation.rule ? { rule: reservation.rule } : {}),
            ...(reservation.limit !== undefined ? { limit: reservation.limit } : {}),
          });
        }
        return reply.code(400).send({
          error: 'Escrow reservation failed',
          reason: reservation.reason,
        });
      }
      job = await db.job.create({
        data: jobData({
          at: new Date(),
          reservedValueUsd: reservation.reservedValueUsd ?? null,
          reservedValueSource: reservation.reservedValueSource ?? null,
        }),
      });
    } else {
      job = await db.job.create({ data: jobData(null) });
    }

    if (useErc8183 && requester && body.reward?.amount) {
      try {
        await startEscrow({
          job: { id: job.id },
          requester,
          provider: { safeAddress: provider.safeAddress },
          amount: body.reward.amount,
          chainId: rewardChainId,
        });
      } catch (err) {
        // Nothing reached the chain: fail the job, give the reservation back
        // and tell the caller — a PENDING job that can never be funded is a trap.
        const reason = `startEscrow failed: ${errorMessage(err)}`;
        await db.job.update({
          where: { id: job.id },
          data: { status: 'FAILED', onChainStatus: 'FAILED', escrowError: reason },
        });
        await releaseJobEscrow(job.id).catch((releaseErr) =>
          logger.error({ jobId: job.id, err: errorMessage(releaseErr) }, 'ERC-8183 start failed AND reservation release failed'),
        );
        logger.error({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 escrow could not be started');
        return reply.code(503).send({ error: 'ERC8183_START_FAILED', jobId: job.id, reason: publicErrorMessage(err) });
      }
    } else if (body.reward?.amount) {
      // Escrow v3: queue on-chain lock if EscrowModule is deployed on the target chain.
      // Fire-and-forget — the DB reservation is already committed above.
      queueOnChainEscrowLock({
        jobId: job.id,
        requesterId: request.agentId,
        providerAddress: provider.safeAddress as `0x${string}`,
        amount: body.reward.amount,
        token: rewardToken,
        chainId: rewardChainId,
      }).catch((err) =>
        logger.warn(
          { jobId: job.id, err: errorMessage(err) },
          'On-chain escrow lock failed (non-fatal, DB reservation still holds)',
        ),
      );
    }

    logger.info(
      {
        jobId: job.id,
        requesterId: request.agentId,
        providerId: body.providerId,
        escrowed: Boolean(body.reward?.amount),
        erc8183: useErc8183,
      },
      'A2A Job Created',
    );
    const created = useErc8183 ? await db.job.findUnique({ where: { id: job.id } }) : null;
    return reply.code(201).send(toJobResponse(created ?? job));
  });

  /**
   * GET /v1/jobs/inbox — fetch jobs assigned to the current agent.
   */
  fastify.get('/v1/jobs/inbox', async (request) => {
    const jobs = await db.job.findMany({
      where: { providerId: request.agentId },
      include: { requester: { select: { id: true, name: true, safeAddress: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { jobs: jobs.map(toJobResponse) };
  });

  /**
   * GET /v1/jobs/outbox — fetch jobs created by the current agent.
   */
  fastify.get('/v1/jobs/outbox', async (request) => {
    const jobs = await db.job.findMany({
      where: { requesterId: request.agentId },
      include: { provider: { select: { id: true, name: true, safeAddress: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { jobs: jobs.map(toJobResponse) };
  });

  /**
   * PATCH /v1/jobs/:id — update job status (Accept, Complete, Fail).
   */
  fastify.patch<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const body = updateJobSchema.parse(request.body);

    const job = await db.job.findUnique({
      where: { id: request.params.id }
    });

    if (!job) return reply.code(404).send({ error: 'Job not found' });

    // Logic Sentinel: Only the provider can accept/complete; only requester/provider can cancel.
    const isProvider = job.providerId === request.agentId;
    const isRequester = job.requesterId === request.agentId;

    if (!isProvider && !isRequester) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    if (body.status === 'ACCEPTED' || body.status === 'COMPLETED' || body.status === 'FAILED') {
      if (!isProvider) return reply.code(403).send({ error: 'Only provider can update this status' });
    }

    // Logic Sentinel: Validate status transition
    const allowed = VALID_TRANSITIONS[job.status as string];
    if (!allowed || !allowed.includes(body.status)) {
      return reply.code(400).send({
        error: `Invalid status transition from ${job.status} to ${body.status}`,
      });
    }

    const isErc8183 = job.escrowKind === ESCROW_KIND;

    // C3: a provider may only accept an escrowed job once the budget is
    // locked on-chain — otherwise it would work for a job nobody funded.
    if (body.status === 'ACCEPTED' && isErc8183 && job.onChainStatus !== 'FUNDED') {
      return reply.code(409).send({
        error: 'ESCROW_NOT_FUNDED',
        message: `Job is not funded on-chain yet (onChainStatus=${job.onChainStatus ?? 'unknown'})`,
        onChainStatus: job.onChainStatus,
        escrowError: sanitizeStoredError(job.escrowError),
      });
    }

    // C3d: too close to (or past) `expiresAt`, an accept or a delivery would
    // race the permissionless `claimRefund`: the requester would get the
    // deliverable AND the refund. Refused; the provider keeps its result.
    if (
      isErc8183 &&
      (body.status === 'ACCEPTED' || body.status === 'COMPLETED') &&
      job.expiresAt &&
      job.expiresAt.getTime() - Date.now() < expiryMarginMs(erc8183Config)
    ) {
      return reply.code(409).send({
        error: 'ESCROW_EXPIRING',
        message: `The escrow expires at ${job.expiresAt.toISOString()}: too late to ${body.status === 'ACCEPTED' ? 'accept' : 'deliver'} (it could not be settled before the requester can claim the refund)`,
        expiresAt: job.expiresAt,
        onChainStatus: job.onChainStatus,
      });
    }

    // Q7: delivering (→ submit, then the evaluator's settlement) or cancelling /
    // failing (→ the evaluator's refund) an escrow job that may still move
    // money on-chain starts an escrow signature: refused while the chain's
    // configuration is unverified, before the transition is written. Accepting
    // only changes the DB and stays allowed.
    if (
      isErc8183 &&
      body.status !== 'ACCEPTED' &&
      job.escrowChainId !== null &&
      !(FINAL_ON_CHAIN_STATUSES as readonly string[]).includes(job.onChainStatus ?? '')
    ) {
      const unverified = refuseUnverifiedEscrow(reply, job.escrowChainId);
      if (unverified) return unverified;
    }

    // Issue #71 — A2A revenue integrity (see docs/project/issue-71-a2a-revenue-integrity.md).
    // For paid completions we no longer flip straight to COMPLETED. We move to
    // PAYMENT_PENDING, fire the on-chain transfer, and only finalize as COMPLETED
    // (with reputation + escrow release) when the transfer confirms. This keeps
    // ghost completions out of the PnL dashboard.
    const reward =
      job.reward as { amount?: string; token?: string; chainId?: number } | null;
    const isPaidCompletion = body.status === 'COMPLETED' && Boolean(reward?.amount);

    const persistedStatus: JobStatus = isPaidCompletion ? 'PAYMENT_PENDING' : body.status;

    // C3c: the transition is conditional on the status this request validated
    // (and, for an escrow ACCEPT, on the budget still being FUNDED). Two
    // concurrent requests — e.g. two PATCH COMPLETED — can no longer both
    // pass the check above: exactly one moves the row, the other gets 409
    // and none of its side effects (a second submit, a reservation release,
    // a refund) run.
    const transitioned = await db.job.updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(body.status === 'ACCEPTED' && isErc8183 ? { onChainStatus: 'FUNDED' } : {}),
      },
      data: {
        status: persistedStatus,
        ...(body.result !== undefined ? { result: body.result } : {}),
      },
    });
    if (transitioned.count === 0) {
      const current = await db.job.findUnique({ where: { id: job.id }, select: { status: true, onChainStatus: true } });
      return reply.code(409).send({
        error: 'JOB_STATUS_CONFLICT',
        message: `Job changed while this request was processed (now ${current?.status ?? 'unknown'}); re-read it and retry if still valid`,
        status: current?.status ?? null,
        onChainStatus: current?.onChainStatus ?? null,
      });
    }
    const updatedJob =
      (await db.job.findUnique({ where: { id: job.id } })) ??
      { ...job, status: persistedStatus, ...(body.result !== undefined ? { result: body.result } : {}) };

    if (isPaidCompletion && isErc8183) {
      // C3: the provider's wallet calls `submit(jobId, keccak256(result))`;
      // the evaluator settles from the settlement queue once it confirms.
      // A synchronous failure here leaves the Job ACCEPTED (retryable):
      // enqueueSubmit hands it back itself, and only when no submit of the
      // job is live (C3c).
      try {
        await enqueueSubmit({ jobId: job.id, result: body.result });
      } catch (err) {
        logger.error({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 submit enqueue failed — job returned to ACCEPTED');
        return reply.code(503).send({ error: 'ESCROW_SUBMIT_FAILED', reason: publicErrorMessage(err) });
      }
    } else if (isPaidCompletion) {
      // Issue #81 (Phase 1.5 of #71): the Job lifecycle is finalized by the
      // Transaction worker once the on-chain outcome is known — see
      // queues/transaction.queue.ts and services/job/payment-finalizer.service.ts.
      // Here we only need to (a) verify the provider exists, (b) hand off to
      // executeA2APayment, and (c) handle synchronous failures (auth, policy,
      // simulation, db) that prevent the tx from ever being queued.
      const provider = await db.agent.findUnique({
        where: { id: job.providerId },
        select: { safeAddress: true },
      });
      if (!provider) {
        // Defensive: provider record vanished between job creation and completion.
        // Refund the requester and bail without firing payment.
        await db.job.update({
          where: { id: job.id },
          data: { status: 'PAYMENT_FAILED' },
        });
        if (job.reservationStatus === 'PENDING') {
          await releaseJobEscrow(job.id);
        }
        logger.error(
          { jobId: job.id, providerId: job.providerId },
          'A2A payment skipped — provider record missing; job marked PAYMENT_FAILED',
        );
        return reply.code(409).send({ error: 'Provider record missing; payment aborted' });
      }

      // Capture reward fields locally; reward is non-null here (isPaidCompletion).
      const amount = reward!.amount as string;
      const token = reward!.token ?? 'ETH';
      const chainId = reward!.chainId ?? 1;

      executeA2APayment({
        requesterId: job.requesterId,
        providerSafeAddress: provider.safeAddress,
        amount,
        token,
        chainId,
        jobId: job.id,
        // Issue #74: deterministic key keyed on jobId. The recovery worker
        // (#73) re-invokes with the same key after a crash and gets back
        // the original tx instead of double-spending.
        intentId: `a2a-payment:${job.id}`,
      })
        .then((result) => {
          // Tx queued (or PENDING_APPROVAL) — the worker now owns the Job
          // lifecycle. Do NOT update Job state here: this resolves at queue
          // time, not on-chain confirmation (#81 root cause).
          logger.info(
            { jobId: job.id, paymentTxId: result.transactionId, status: result.status },
            'A2A payment dispatched; awaiting worker finalization',
          );
        })
        .catch((err) => {
          // Synchronous pre-queue failure (auth, policy denied, simulation
          // failed, db error). No Transaction row may exist; the worker will
          // never run for this job. Finalize as PAYMENT_FAILED inline.
          finalizeA2APaymentJob({
            jobId: job.id,
            transactionId: null,
            outcome: 'FAILED',
            reason: err?.message ?? String(err),
          }).catch((finalizeErr) =>
            logger.error(
              {
                jobId: job.id,
                paymentErr: err?.message ?? String(err),
                finalizeErr:
                  (finalizeErr as Error)?.message ?? String(finalizeErr),
              },
              'A2A payment failed AND finalizer failed — manual reconciliation required',
            ),
          );
        });
    } else if (body.status === 'COMPLETED') {
      // Free job (no reward) — completes synchronously, same as before.
      await reputationService.recordJobOutcome(job.providerId, true);
      if (job.reservationStatus === 'PENDING') {
        await markEscrowReleased(job.id);
      }
    } else if (body.status === 'FAILED' || body.status === 'CANCELLED') {
      // v2 Escrow: release reservation, return daily volume credit to requester
      if (job.reservationStatus === 'PENDING') {
        await releaseJobEscrow(job.id);
      }
      if (body.status === 'FAILED') {
        await reputationService.recordJobOutcome(job.providerId, false);
      }
      if (isErc8183) {
        // C3: unwind a budget that is already locked on-chain through the
        // evaluator (`reject` → full refund). Before FUNDED the step chain
        // stops by itself; a `fund` that confirms later schedules the reject.
        await requestCancellationReject({
          jobId: job.id,
          reason: body.status === 'CANCELLED' ? 'cancelled' : 'provider-failed',
        }).catch((err) =>
          logger.error(
            { jobId: job.id, err: errorMessage(err) },
            'ERC-8183 cancellation reject could not be scheduled — expiry sweep will refund after expiresAt',
          ),
        );
      }
    }

    logger.info({ jobId: job.id, status: persistedStatus }, 'A2A Job Updated');
    if (isErc8183) {
      const fresh = await db.job.findUnique({ where: { id: job.id } });
      return toJobResponse(fresh ?? updatedJob);
    }
    return toJobResponse(updatedJob);
  });

  /**
   * POST /v1/jobs/:id/contest — requester disputes a submitted deliverable
   * before the evaluator settles (C3; C3d / decision D9). Allowed while the
   * job is PAYMENT_PENDING, the deliverable is SUBMITTED on-chain, no
   * settlement has been claimed and no evaluator settlement of it can still
   * mine. A contest does NOT refund by itself: the job is held for operator
   * review (`escrow.onChainStatus = CONTESTED`) and the operator decides —
   * pay the provider, refund the requester, or refund with a quality verdict
   * (the only case that writes a negative ERC-8004 rating). Unresolved at
   * `expiresAt`, anyone can claim the refund: full refund, no rating.
   */
  fastify.post<{ Params: { id: string } }>('/v1/jobs/:id/contest', async (request, reply) => {
    const body = contestJobSchema.parse(request.body ?? {});
    const job = await db.job.findUnique({
      where: { id: request.params.id },
      select: { id: true, requesterId: true, escrowKind: true, status: true, onChainStatus: true, contestedAt: true },
    });
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.requesterId !== request.agentId) {
      return reply.code(403).send({ error: 'Only the requester can contest a job' });
    }
    if (job.escrowKind !== ESCROW_KIND) {
      return reply.code(409).send({ error: 'NOT_ESCROW_JOB', message: 'Only ERC-8183 escrowed jobs can be contested' });
    }

    // C3d race rule (escrow-erc8183.service.ts `contestEscrowJob`): the hold
    // is a conditional write from the same SUBMITTED row the settlement
    // claims, and is refused once a settlement transaction may still mine.
    const outcome = await contestJob({ jobId: job.id, reason: body.reason ?? null });
    if (outcome.outcome !== 'held') {
      const current = await db.job.findUnique({
        where: { id: job.id },
        select: { status: true, onChainStatus: true, contestedAt: true },
      });
      return reply.code(outcome.outcome === 'unverifiable' ? 503 : 409).send({
        error: outcome.outcome === 'unverifiable' ? 'CONTEST_UNVERIFIABLE' : 'CONTEST_NOT_ALLOWED',
        message: outcome.reason,
        status: current?.status ?? job.status,
        onChainStatus: current?.onChainStatus ?? job.onChainStatus,
        contestedAt: current?.contestedAt ?? job.contestedAt,
      });
    }

    logger.warn({ jobId: job.id, requesterId: request.agentId, reason: body.reason }, 'ERC-8183 job contested by requester — held for operator review');
    const fresh = await db.job.findUnique({ where: { id: job.id } });
    return toJobResponse(fresh!);
  });

  /**
   * GET /v1/jobs/:id/feedback.json — public ERC-8004 feedback file (C3/R3).
   * Served byte-for-byte as it was hashed into the `complete`/`reject`
   * `optParams` (`keccak256(body) == feedbackHash` emitted by the hook).
   * 404 until the settlement worker has generated it. C3d: `immutable` only
   * once the settlement that committed its hash is mined; before that the
   * file can still be rebuilt (another operator decision) and is `no-store`.
   */
  fastify.get<{ Params: { id: string } }>('/v1/jobs/:id/feedback.json', async (request, reply) => {
    const job = await db.job.findUnique({
      where: { id: request.params.id },
      select: { feedbackFile: true, onChainStatus: true },
    });
    if (!job || !job.feedbackFile) {
      return reply.code(404).send({ error: 'Feedback file not available for this job' });
    }
    return reply
      .code(200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', isFeedbackFileCommitted(job) ? 'public, max-age=31536000, immutable' : 'no-store')
      .send(serializeFeedbackFile(job.feedbackFile as Record<string, unknown>));
  });

  /**
   * GET /v1/jobs/:id — fetch single job details.
   */
  fastify.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const job = await db.job.findUnique({
      where: { id: request.params.id },
      include: {
        requester: { select: { id: true, name: true, safeAddress: true } },
        provider: { select: { id: true, name: true, safeAddress: true } }
      }
    });

    if (!job) return reply.code(404).send({ error: 'Job not found' });

    if (job.requesterId !== request.agentId && job.providerId !== request.agentId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    return toJobResponse(job);
  });
}
