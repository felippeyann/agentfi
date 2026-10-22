/**
 * A1 final review (71bb40e) — reviewer's proof of F-P2-1, green since the fix (fees out of the fingerprint).
 * F-P2-1: the plan fingerprint includes the PROPOSED fees, recomputed inside the lane from a fresh
 * eth_feeHistory. When the head is price-stuck, maxFeePerGas = baseFee × m + prio, so ANY base-fee move
 * between the dry-run / typed confirmation and the lane changes the fingerprint and aborts the speed-up.
 * On a congested chain the base fee moves every block (2 s on Base): the speed-up cannot pass.
 */
import { describe, expect, it } from 'vitest';
import { planFingerprint, proposeReplacementFees, type RecoveryCaps } from '../services/escrow/evaluator-candidates.js';

const caps: RecoveryCaps = {
  maxFeePerGasWei: 1_000_000_000n, maxPriorityFeePerGasWei: 100_000_000n, relativeBaseMultiplier: 20n, bumpBps: 1250,
  multipliers: [3n, 6n, 12n], maxReplacementsPerNonce: 3, minIntervalMs: 60_000, maxCostPerTxWei: 800_000_000_000_000n,
  maxCostPerIncidentWei: 1_500_000_000_000_000n, maxCost24hWei: 2_000_000_000_000_000n, reserveWei: 1_000_000_000_000_000n,
  l1MarginWei: 10_000_000_000_000n, maxNoncesPerPlan: 3, maxGasLimit: 1_000_000n, minPriorityFeePerGasWei: 1_000_000n,
};

function fp(baseFee: bigint): string {
  // price-stuck head: the original priced at 10 mwei, base fee now above it
  const p = proposeReplacementFees({ prevMaxFee: 10_000_000n, prevPrio: 1_000_000n, baseFee, prioP90: 2_000_000n, attempt: 1, caps });
  if (!p.ok) throw new Error(p.reason);
  return planFingerprint({
    chainId: 84532, evaluator: '0x000000000000000000000000000000000000EA1d', nonce: 7,
    candidates: [{ txHash: `0x${'11'.repeat(32)}`, status: 'SENT' }], jobOnChainStatus: 'Submitted', operation: 'speed-up',
    proposedFees: { maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas },
  });
}

describe('A1 final review F-P2-1 — confirmed speed-up survives a one-block base-fee move', () => {
  it('the fingerprint confirmed at the dry-run still matches after the base fee moved by 1 wei (next block)', () => {
    expect(fp(20_000_001n)).toBe(fp(20_000_000n));
  });
});
