/**
 * What each backend process enables, and silent configuration drift between
 * the API and the worker (task C3d, second adversarial review 2026-10-08).
 *
 * The documented deployment runs the API (`index.ts`, usually with
 * TRANSACTION_WORKER_ENABLED=false) and a separate worker (`worker.ts`). They
 * read their environment independently. A worker started without
 * `AGENT_JOB_ESCROW_ADDRESS_<id>` (or without the evaluator key) while the API
 * has it creates ERC-8183 jobs that nothing ever settles: no settlement
 * worker, no expiry sweep, and its transaction processor sees no hook. Nothing
 * said so.
 *
 * Each process now logs at boot what it enables (`describeCapabilities`), and
 * publishes it to Redis; the one that boots second compares itself with the
 * other role (`capabilityDrift`) and logs every difference as an error. Pure
 * functions here; the Redis exchange is in `escrow-boot.runtime.ts`.
 */

export type ProcessRole = 'api' | 'worker';

export interface EscrowChainCapability {
  chainId: number;
  escrow: string;
  hook: string | null;
}

export interface ProcessCapabilities {
  role: ProcessRole;
  nodeEnv: string;
  /** Agent-signed transactions (incl. the ERC-8183 requester/provider steps). */
  transactionWorker: boolean;
  /** Stale PAYMENT_PENDING scan, SUBMITTED re-poll, ERC-8183 reconciliation, review expiry alerts. */
  paymentRecovery: boolean;
  /** Evaluator settlements (complete / reject / claimRefund) and the expiry sweep. */
  settlementWorker: boolean;
  /** Chains with AGENT_JOB_ESCROW_ADDRESS_<id> configured. */
  escrowChains: EscrowChainCapability[];
  /** Address of ESCROW_EVALUATOR_PRIVATE_KEY, or null. */
  evaluator: string | null;
  /** ISO time the process booted. */
  bootedAt: string;
}

/** One log line's worth of what this process enables. */
export function describeCapabilities(caps: ProcessCapabilities): string {
  const escrow =
    caps.escrowChains.length === 0
      ? 'ERC-8183 escrow: none configured'
      : `ERC-8183 escrow on ${caps.escrowChains.map((c) => `${c.chainId} (escrow ${c.escrow}, hook ${c.hook ?? 'none'})`).join(', ')}` +
        `, evaluator ${caps.evaluator ?? 'MISSING (escrow disabled)'}`;
  return (
    `${caps.role} process: transaction worker ${caps.transactionWorker ? 'ON' : 'off'}, payment recovery ${caps.paymentRecovery ? 'ON' : 'off'}, ` +
    `settlement worker ${caps.settlementWorker ? 'ON' : 'off'}; ${escrow}`
  );
}

function chainKey(chain: EscrowChainCapability): string {
  return `${chain.chainId}:${chain.escrow.toLowerCase()}:${(chain.hook ?? '').toLowerCase()}`;
}

/**
 * Differences between this process and the other role that would make jobs
 * one of them creates unsettleable or settle against other contracts. Empty
 * when consistent. Pure.
 */
export function capabilityDrift(mine: ProcessCapabilities, peer: ProcessCapabilities): string[] {
  if (mine.role === peer.role) return [];
  const drift: string[] = [];
  const mineChains = new Map(mine.escrowChains.map((c) => [c.chainId, c]));
  const peerChains = new Map(peer.escrowChains.map((c) => [c.chainId, c]));

  for (const [chainId, chain] of mineChains) {
    const other = peerChains.get(chainId);
    if (!other) {
      drift.push(`chain ${chainId}: the ${mine.role} has AGENT_JOB_ESCROW_ADDRESS_${chainId}=${chain.escrow}, the ${peer.role} has none`);
    } else if (chainKey(chain) !== chainKey(other)) {
      drift.push(
        `chain ${chainId}: escrow/hook differ — ${mine.role} ${chain.escrow} / ${chain.hook ?? 'none'}, ${peer.role} ${other.escrow} / ${other.hook ?? 'none'}`,
      );
    }
  }
  for (const [chainId, chain] of peerChains) {
    if (!mineChains.has(chainId)) {
      drift.push(`chain ${chainId}: the ${peer.role} has AGENT_JOB_ESCROW_ADDRESS_${chainId}=${chain.escrow}, the ${mine.role} has none`);
    }
  }
  if ((mine.evaluator ?? '').toLowerCase() !== (peer.evaluator ?? '').toLowerCase() && (mine.escrowChains.length > 0 || peer.escrowChains.length > 0)) {
    drift.push(`evaluator differs — ${mine.role} ${mine.evaluator ?? 'none'}, ${peer.role} ${peer.evaluator ?? 'none'} (ESCROW_EVALUATOR_PRIVATE_KEY)`);
  }

  // Escrow jobs the API creates are settled by whichever process runs the settlement worker.
  const api = mine.role === 'api' ? mine : peer;
  const worker = mine.role === 'worker' ? mine : peer;
  if (api.escrowChains.length > 0 && api.evaluator && !api.settlementWorker && !worker.settlementWorker) {
    drift.push(
      'the API creates ERC-8183 escrow jobs but neither process runs the settlement worker: nothing will complete, refund or ' +
        'claim them (set the escrow addresses and ESCROW_EVALUATOR_PRIVATE_KEY on the worker too)',
    );
  }
  if (!api.transactionWorker && !worker.paymentRecovery) {
    drift.push('neither process runs payment recovery (stale payments, lost confirmations and escrow reconciliation are never retried)');
  }
  return drift;
}
