/**
 * Production wiring of the x402 automatic reconciliation (the pass the
 * payment-recovery tick runs): the shared DB, the chain's primary RPC (one
 * endpoint — never the provider fallback), the X402_RECONCILE_* config, and
 * operator alerts on escalation (`logger.error`, same channel as the other
 * recovery passes).
 */
import { logger } from '../../api/middleware/logger.js';
import { getPrimaryRpcUrl } from '../../config/chains.js';
import { db } from '../../db/client.js';
import { autoReconcileConfigFromEnv, runAutoReconcileCycle, type AutoReconcileOutcome } from './resource-payment-auto-reconcile.js';

let reportedProblems = false;

export interface X402AutoReconcileSummary {
  examined: number;
  proven: number;
  expired: number;
  released: number;
  waiting: number;
  transientFailures: number;
  escalated: number;
}

export async function runX402AutoReconcilePass(): Promise<X402AutoReconcileSummary | null> {
  const { config, enabled, problems } = autoReconcileConfigFromEnv();
  if (problems.length > 0 && !reportedProblems) {
    reportedProblems = true;
    logger.warn({ problems }, 'x402 auto-reconciliation: configuration values ignored');
  }
  if (!enabled) return null;
  const outcomes = await runAutoReconcileCycle({
    db,
    rpcFor: (chainId) => getPrimaryRpcUrl(chainId),
    // Independent node used only to confirm `expired` (a release without a transfer to point at).
    secondRpcFor: (chainId) => process.env[`X402_RECONCILE_SECOND_RPC_URL_${chainId}`]?.trim() || undefined,
    config,
    onEscalate: (o: AutoReconcileOutcome) =>
      logger.error(
        { jobId: o.jobId, paymentId: o.paymentId, resourcePaymentId: o.resourcePaymentId, status: o.statusBefore, note: o.note },
        o.stopped
          ? 'x402 auto-reconciliation STOPPED for a payment (operator needed): it stays counted; run `x402:ops status`, then `x402:ops reconcile --apply` or `x402:ops resolve`'
          : 'x402 auto-reconciliation ALERT: evidence still unavailable after repeated attempts; the payment stays counted and retries continue — check the RPC (`x402:ops status`)',
      ),
  });
  const summary: X402AutoReconcileSummary = {
    examined: outcomes.length,
    proven: outcomes.filter((o) => o.applied && o.verdict === 'confirmed').length,
    expired: outcomes.filter((o) => o.applied && o.verdict === 'expired').length,
    released: outcomes.filter((o) => o.applied && o.verdict === 'release-unsigned').length,
    waiting: outcomes.filter((o) => o.verdict === 'wait').length,
    transientFailures: outcomes.filter((o) => o.transient).length,
    escalated: outcomes.filter((o) => o.escalated).length,
  };
  if (summary.proven + summary.expired + summary.released + summary.escalated + summary.transientFailures > 0) {
    logger.warn(summary, 'x402 auto-reconciliation pass');
  }
  return summary;
}
