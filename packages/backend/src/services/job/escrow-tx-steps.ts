/**
 * Agent-signed steps of the job-escrow orchestrator, as Transaction rows on
 * the ordinary transaction queue.
 *
 * Shared by the ERC-8183 orchestrator (`escrow-erc8183.service.ts`: the
 * requester's create/setBudget/approve/fund and the provider's submit) and the
 * ERC-8004 identity flow (`erc8004-identity.service.ts`: the provider's
 * register and setProviderAgentId). Every row carries `metadata.erc8183 =
 * true`, which is what routes its outcome — from the worker's post-confirmation
 * hook, the permanent-failure handler and the pre-submit guard's fail path —
 * back to `onEscrowTxOutcome`, and `metadata.escrowStep` says which step it is.
 *
 * Kept free of runtime imports from either service so neither depends on the
 * other through this module (no import cycle).
 */

import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { getAddress, type Address, type Hex } from 'viem';
import type { ProcessorLogger, TransactionJobData } from '../../queues/transaction.processor.js';

/** Statuses in which a step counts as done-or-in-flight: never enqueue the same intent again. */
export const IN_FLIGHT_TX = new Set(['QUEUED', 'SUBMITTED', 'PENDING_APPROVAL', 'CONFIRMED']);

/** Statuses of a transaction that has not reached a terminal outcome yet. */
export const PENDING_TX_STATUSES = ['QUEUED', 'SUBMITTED', 'PENDING_APPROVAL'] as const;
export const PENDING_TX = new Set<string>(PENDING_TX_STATUSES);

export interface SigningAgent {
  id: string;
  walletId: string;
  safeAddress: string;
}

export type AgentStepTxType = 'ESCROW_LOCK' | 'ESCROW_SUBMIT' | 'ERC8004_IDENTITY';

export interface StepDeps {
  db: PrismaClient;
  queue: Pick<Queue<TransactionJobData>, 'add'>;
  logger: ProcessorLogger;
  now?: () => Date;
}

export interface AgentStepParams {
  /** Deterministic idempotency key (`Transaction.intentId`). */
  intentId: string;
  /**
   * Always create a new row with a suffixed intentId, even when a row with
   * `intentId` is still live or CONFIRMED (a deliberate retry of a step whose
   * earlier attempt is known to be useless, e.g. a new ERC-8004 mint after a
   * failed one).
   */
  freshIntent?: boolean;
  jobId: string;
  chainId: number;
  /** `metadata.escrowStep`, also the BullMQ job name suffix. */
  step: string;
  signer: SigningAgent;
  to: Address;
  data: Hex;
  type: AgentStepTxType;
  extraMetadata?: Record<string, unknown>;
}

/**
 * Creates the Transaction row and enqueues it for the agent's wallet. A step
 * whose `intentId` already exists in a live (or CONFIRMED) state is returned
 * as-is (idempotent); a terminal-failed one — or any one when `freshIntent` —
 * gets a suffixed `intentId` (`<intentId>#<epoch ms>`) so it can be retried.
 */
export async function enqueueAgentStep(deps: StepDeps, params: AgentStepParams): Promise<string> {
  let intentId = params.intentId;
  const existing = await deps.db.transaction.findUnique({
    where: { intentId: params.intentId },
    select: { id: true, status: true },
  });
  if (existing) {
    if (!params.freshIntent && IN_FLIGHT_TX.has(existing.status)) {
      deps.logger.info(
        { jobId: params.jobId, step: params.step, transactionId: existing.id, status: existing.status },
        'Escrow step already in flight — not re-enqueued',
      );
      return existing.id;
    }
    intentId = `${params.intentId}#${(deps.now?.() ?? new Date()).getTime()}`;
  }

  const tx = await deps.db.transaction.create({
    data: {
      agentId: params.signer.id,
      type: params.type,
      chainId: params.chainId,
      status: 'QUEUED',
      intentId,
      metadata: {
        jobId: params.jobId,
        erc8183: true,
        escrowStep: params.step,
        ...(params.extraMetadata ?? {}),
        queuePayload: { to: params.to, data: params.data, value: '0' },
      },
    },
    select: { id: true },
  });

  await deps.queue.add(`erc8183-${params.step}`, {
    transactionId: tx.id,
    chainId: params.chainId,
    walletId: params.signer.walletId,
    from: getAddress(params.signer.safeAddress),
    to: params.to,
    data: params.data,
    value: '0',
    agentId: params.signer.id,
    tier: 'FREE',
    feeAmountWei: '0',
    feeUsd: '0',
    feeBps: 0,
  });

  deps.logger.info(
    { jobId: params.jobId, step: params.step, transactionId: tx.id, intentId, from: params.signer.safeAddress },
    'Escrow step enqueued',
  );
  return tx.id;
}
