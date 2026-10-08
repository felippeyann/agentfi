/**
 * ERC-8183 orchestrator — real dependency wiring.
 *
 * `escrow-erc8183.service.ts` holds the logic with injected deps; this module
 * binds the process singletons (Prisma `db`, the transaction queue, the
 * settlement queue, viem public clients, the evaluator signer, env) and
 * exports the bound entry points the routes, the transaction processor, the
 * pre-submit guard and the recovery worker call. Tests mock THIS module.
 */

import type { Address, Hex } from 'viem';
import { db } from '../../db/client.js';
import { env, escrowEvaluatorAddress } from '../../config/env.js';
import { getContracts } from '../../config/contracts.js';
import { createChainPublicClient } from '../../config/chains.js';
import { logger } from '../../api/middleware/logger.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { addSettlementJob } from '../../queues/escrow-settlement.queue.js';
import { getEvaluatorSigner } from '../escrow/evaluator-signer.js';
import { releaseJobEscrow } from '../policy/escrow.service.js';
import { notificationService } from '../notification.service.js';
import { walletLaneLock } from '../transaction/wallet-lane.runtime.js';
import { finalizeA2APaymentJob } from './payment-finalizer.service.js';
import * as svc from './escrow-erc8183.service.js';
import type { Erc8183ChainConfig, Erc8183Config, Erc8183Deps, EscrowAlert } from './escrow-erc8183.service.js';

/**
 * C3c: the evaluator's native balance below which every settlement send
 * alerts the operator (`ESCROW_EVALUATOR_MIN_BALANCE_WEI`, default 0.0005 ETH
 * ≈ a few dozen settlements on Base; `0` disables the check).
 */
function evaluatorMinBalanceWei(): bigint | null {
  const raw = process.env['ESCROW_EVALUATOR_MIN_BALANCE_WEI'];
  try {
    const value = BigInt(raw && raw.trim() !== '' ? raw.trim() : '500000000000000');
    return value > 0n ? value : null;
  } catch {
    return 500_000_000_000_000n;
  }
}

/** Operator alerts from the orchestrator (cancellation refused, chain conflict, evaluator low on gas). */
async function sendEscrowAlert(alert: EscrowAlert): Promise<void> {
  await notificationService.notify({
    type: 'ESCROW_ALERT',
    agentId: alert.jobId ?? 'escrow',
    agentName: 'ERC-8183 escrow',
    message: alert.message,
    metadata: { kind: alert.kind, jobId: alert.jobId, chainId: alert.chainId, ...alert.details },
  });
}

export const erc8183Config: Erc8183Config = {
  evaluatorAddress: escrowEvaluatorAddress,
  jobTtlSeconds: env.ESCROW_JOB_TTL_SECONDS,
  evaluationDelaySeconds: env.ESCROW_EVALUATION_DELAY_SECONDS,
  backendPublicUrl: env.BACKEND_PUBLIC_URL.replace(/\/+$/, ''),
  chain(chainId: number): Erc8183ChainConfig | null {
    try {
      const contracts = getContracts(chainId);
      if (!contracts.agentJobEscrow) return null;
      return { chainId, escrow: contracts.agentJobEscrow, hook: contracts.reputationHook ?? null };
    } catch {
      return null;
    }
  },
  // R2: ERC-8004 Identity Registry (IDENTITY_REGISTRY_ADDRESS_<chainId> or the
  // official Base / Base Sepolia default, config/contracts.ts).
  identityRegistry(chainId: number): Address | null {
    try {
      return getContracts(chainId).identityRegistry ?? null;
    } catch {
      return null;
    }
  },
  mcpPublicUrl: env.MCP_PUBLIC_URL ?? null,
  evaluatorMinBalanceWei: evaluatorMinBalanceWei(),
};

const publicClients = new Map<number, ReturnType<typeof createChainPublicClient>>();

export function erc8183Deps(): Erc8183Deps {
  return {
    db,
    queue: transactionQueue,
    settlement: { add: addSettlementJob },
    publicClient(chainId) {
      let client = publicClients.get(chainId);
      if (!client) {
        client = createChainPublicClient(chainId);
        publicClients.set(chainId, client);
      }
      return client;
    },
    evaluatorSigner(chainId) {
      if (!env.ESCROW_EVALUATOR_PRIVATE_KEY) {
        throw new Error('ESCROW_EVALUATOR_PRIVATE_KEY is not configured — cannot sign ERC-8183 settlements');
      }
      return getEvaluatorSigner(chainId, env.ESCROW_EVALUATOR_PRIVATE_KEY as Hex);
    },
    config: erc8183Config,
    releaseJobEscrow,
    finalize: finalizeA2APaymentJob,
    logger,
    lanes: walletLaneLock,
    alert: sendEscrowAlert,
  };
}

/** True when `AGENT_JOB_ESCROW_ADDRESS_<chainId>` and the evaluator key are both configured. */
export const isErc8183Enabled = (chainId: number): boolean => svc.isErc8183EnabledWith(erc8183Config, chainId);

export const getEscrowToken = (chainId: number) => svc.getEscrowToken(erc8183Deps(), chainId);
export const startEscrow = (params: svc.StartEscrowParams) => svc.startEscrow(erc8183Deps(), params);
export const onEscrowTxOutcome = (outcome: svc.EscrowTxOutcome) => svc.onEscrowTxOutcome(erc8183Deps(), outcome);
export const enqueueSubmit = (params: { jobId: string; result: unknown }) => svc.enqueueSubmit(erc8183Deps(), params);
export const requestCancellationReject = (params: { jobId: string; reason: svc.CancellationReason }) =>
  svc.requestCancellationReject(erc8183Deps(), params);
export const recoverErc8183Job = (job: { id: string; onChainStatus: string | null }) =>
  svc.recoverErc8183Job(erc8183Deps(), job);
export const reconcileEscrowJobs = (opts: { staleBefore: Date; limit: number }) =>
  svc.reconcileEscrowJobs(erc8183Deps(), opts);
