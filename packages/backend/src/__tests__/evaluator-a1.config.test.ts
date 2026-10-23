/**
 * C3g-A1 configuration: recovery caps (no defaults), proof tag, and the A1 review P2-2 guard
 * (the implicit `safe` / `finalized` proof tag is refused on an Anvil node).
 */
import { describe, expect, it } from 'vitest';
import { parseProofTag, parseRecoveryCaps, proofTagNodeProblem } from '../config/evaluator-a1.js';

const FULL: Record<string, string> = {
  EVALUATOR_RECOVERY_MAX_GAS_LIMIT_84532: '1000000',
  EVALUATOR_RECOVERY_MAX_FEE_PER_GAS_WEI_84532: '1000000000',
  EVALUATOR_RECOVERY_MAX_PRIORITY_FEE_PER_GAS_WEI_84532: '100000000',
  EVALUATOR_RECOVERY_MIN_PRIORITY_FEE_PER_GAS_WEI_84532: '1000000',
  EVALUATOR_RECOVERY_MAX_COST_WEI_84532: '800000000000000',
  EVALUATOR_RECOVERY_MAX_INCIDENT_COST_WEI_84532: '1500000000000000',
  EVALUATOR_RECOVERY_MAX_DAILY_COST_WEI_84532: '2000000000000000',
  EVALUATOR_RECOVERY_RESERVE_WEI_84532: '1000000000000000',
  EVALUATOR_RECOVERY_L1_MARGIN_WEI_84532: '10000000000000',
  EVALUATOR_RECOVERY_BASE_FEE_MULTIPLIERS: '3,6,12',
  EVALUATOR_RECOVERY_MAX_BASE_FEE_MULTIPLE: '20',
  EVALUATOR_RECOVERY_REPLACEMENT_BUMP_BPS: '1250',
  EVALUATOR_RECOVERY_MAX_REPLACEMENTS_PER_NONCE: '3',
  EVALUATOR_RECOVERY_MIN_INTERVAL_SECONDS: '60',
  EVALUATOR_RECOVERY_MAX_RANGE_NONCES: '3',
};

describe('recovery caps (spec §8.5): no defaults, fail closed', () => {
  it('nothing configured → absent (null caps: execution refused); the globals alone authorise nothing', () => {
    expect(parseRecoveryCaps({}, 84532)).toEqual({ kind: 'absent' });
    expect(parseRecoveryCaps({ EVALUATOR_RECOVERY_MAX_BASE_FEE_MULTIPLE: '20' }, 84532)).toEqual({ kind: 'absent' });
  });
  it('every value → caps; another chain is still absent', () => {
    const ok = parseRecoveryCaps(FULL, 84532);
    expect(ok).toMatchObject({ kind: 'ok', caps: { maxFeePerGasWei: 1_000_000_000n, multipliers: [3n, 6n, 12n], minIntervalMs: 60_000, maxNoncesPerPlan: 3 } });
    expect(parseRecoveryCaps(FULL, 8453)).toEqual({ kind: 'absent' });
  });
  it('one value missing → incomplete (no caps); a malformed value → invalid (boot refuses)', () => {
    const { EVALUATOR_RECOVERY_RESERVE_WEI_84532: _gone, ...partial } = FULL;
    expect(parseRecoveryCaps(partial, 84532)).toEqual({ kind: 'incomplete', missing: ['EVALUATOR_RECOVERY_RESERVE_WEI_84532'] });
    expect(parseRecoveryCaps({ ...FULL, EVALUATOR_RECOVERY_MAX_COST_WEI_84532: '0.0008' }, 84532)).toMatchObject({ kind: 'invalid' });
    expect(parseRecoveryCaps({ ...FULL, EVALUATOR_RECOVERY_BASE_FEE_MULTIPLIERS: '3,x' }, 84532)).toMatchObject({ kind: 'invalid' });
  });
});

describe('proof tag', () => {
  it('parses latest | safe | finalized | latest-K', () => {
    expect(parseProofTag('safe')).toBe('safe');
    expect(parseProofTag('LATEST')).toBe('latest');
    expect(parseProofTag('latest-12')).toBe(12n);
    expect(parseProofTag('earliest')).toBeNull();
  });

  it('A1 review P2-2: the implicit safe / finalized default is refused on an Anvil node; an explicit tag or a real chain passes', () => {
    const anvil = 'anvil/v1.4.3';
    expect(proofTagNodeProblem({ chainId: 84532, proofTag: 'safe', explicit: false, clientVersion: anvil })).toMatch(/EVALUATOR_PROOF_TAG=latest/);
    expect(proofTagNodeProblem({ chainId: 84532, proofTag: 'finalized', explicit: false, clientVersion: anvil })).toMatch(/Anvil/);
    expect(proofTagNodeProblem({ chainId: 84532, proofTag: 'safe', explicit: true, clientVersion: anvil })).toBeNull();
    expect(proofTagNodeProblem({ chainId: 84532, proofTag: 'latest', explicit: false, clientVersion: anvil })).toBeNull();
    expect(proofTagNodeProblem({ chainId: 84532, proofTag: 'safe', explicit: false, clientVersion: 'Geth/v1.101411.0-op-geth' })).toBeNull();
    expect(proofTagNodeProblem({ chainId: 84532, proofTag: 'safe', explicit: false, clientVersion: null })).toBeNull();
  });
});
