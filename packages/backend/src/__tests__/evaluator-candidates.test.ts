/**
 * C3g-A1 — pure candidate rules (`services/escrow/evaluator-candidates.ts`).
 *
 * Matrix rows (spec §11 + R2-§11, plan §10.1) covered here at the U layer:
 * 13 (nodes disagree), 14 (reorg, rules), 15 (balance / reserve), 17 (no caps,
 * cap exceeded), 18 (not the head), 33 (latest vs proof depth), 35 (range plan,
 * one fingerprint per nonce) and plan rows 36 (fee per step), 37 (effective
 * cap), 38 (replacement count / interval, rule), 39 (incident / 24 h budget,
 * rule), 40 (reserve + L1 margin), 41 (gas limit cap), 42 (expiry thresholds
 * by block time), 43 (head classification).
 *
 * The numbers below are TEST FIXTURES (plan P1–P16, Base Sepolia column);
 * the code under test has no default caps.
 */
import { describe, expect, it } from 'vitest';
import {
  admissibleOperations,
  budgetCheck,
  bumped,
  capsProblem,
  chooseNonce,
  classifyHead,
  effectiveFeeCap,
  expiryPosture,
  headCheck,
  legacyResignAllowed,
  mayStillMine,
  nonceConsumed,
  planFingerprint,
  proposeReplacementFees,
  rangePlanCheck,
  rebroadcastAllowed,
  replacementLimitCheck,
  resolveNonceDecision,
  type CandidateRow,
  type HeadSituation,
  type NodeView,
  type ReceiptView,
  type RecoveryCaps,
} from '../services/escrow/evaluator-candidates.js';

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const EVALUATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const BLOCK_A = `0x${'a'.repeat(64)}`;
const BLOCK_B = `0x${'b'.repeat(64)}`;

/** Plan P1–P16, Base Sepolia column (fixture only). */
const CAPS: RecoveryCaps = {
  maxFeePerGasWei: 1n * GWEI,              // P2
  maxPriorityFeePerGasWei: GWEI / 10n,     // P3
  relativeBaseMultiplier: 20n,             // P5
  bumpBps: 1_250,                          // P6
  multipliers: [3n, 6n, 12n],              // P4
  maxReplacementsPerNonce: 3,              // P8
  minIntervalMs: 60_000,                   // P9
  maxCostPerTxWei: (8n * ETH) / 10_000n,   // P11 0.0008 ETH
  maxCostPerIncidentWei: (15n * ETH) / 10_000n, // P12 0.0015 ETH
  maxCost24hWei: (2n * ETH) / 1_000n,      // P13 0.002 ETH
  reserveWei: ETH / 1_000n,                // P14 0.001 ETH
  l1MarginWei: ETH / 100_000n,             // P15 1e-5 ETH
  maxNoncesPerPlan: 3,                     // P16
  maxGasLimit: 1_000_000n,                 // P1
  minPriorityFeePerGasWei: GWEI / 1_000n,  // P7 floor 0.001 gwei
};
const BASE_FLOOR = 5_000_000n; // 0.005 gwei

let seq = 0;
function cand(over: Partial<CandidateRow> = {}): CandidateRow {
  seq += 1;
  return {
    id: `c${seq}`,
    chainId: 84532,
    evaluator: EVALUATOR,
    nonce: 7,
    jobId: 'job-x',
    kind: 'ORIGINAL',
    action: 'COMPLETE',
    decision: 'pay',
    calldataHash: H(1),
    gasLimit: 740_300n,
    maxFeePerGas: 7_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    txHash: H(1000 + seq),
    status: 'SENT',
    proofLevel: null,
    createdAt: new Date('2026-10-22T10:00:00Z'),
    broadcastAt: null,
    lastBroadcastAt: null,
    origin: 'WORKER',
    incidentId: null,
    minedBlockHash: null,
    ...over,
  };
}

function receipt(txHash: string, blockHash = BLOCK_A, status: 'success' | 'reverted' = 'success'): ReceiptView {
  return { txHash, status, blockNumber: 100n, blockHash, logsForJob: { completed: status === 'success', rejected: false, expired: false } };
}

function view(node: string, o: Partial<NodeView> = {}): NodeView {
  return { node, ok: true, nonceLatest: 7, nonceProof: 7, known: {}, receipts: {}, ...o };
}

describe('nonce consumed / mayStillMine (§6.1, rows 13 and 33)', () => {
  it('consumed only when every responding node agrees; any node error is uncertain', () => {
    const c = cand({ nonce: 7 });
    expect(mayStillMine(c, [view('a', { nonceLatest: 8 }), view('b', { nonceLatest: 8 })], 'latest')).toBe('no');
    expect(mayStillMine(c, [view('a', { nonceLatest: 8 }), view('b', { nonceLatest: 7 })], 'latest')).toBe('yes');
    expect(mayStillMine(c, [view('a', { nonceLatest: 8 }), { node: 'b', ok: false }], 'latest')).toBe('uncertain');
    expect(mayStillMine(c, [], 'latest')).toBe('uncertain');
    expect(mayStillMine(c, [{ node: 'a', ok: true, nonceLatest: 8 }], 'proof')).toBe('uncertain');
  });

  it('row 33: consumed at latest but not at proof depth → done for a re-sign, still "may mine" for a decision change', () => {
    const c = cand({ nonce: 7 });
    const views = [view('a', { nonceLatest: 8, nonceProof: 7 }), view('b', { nonceLatest: 8, nonceProof: 7 })];
    expect(mayStillMine(c, views, 'latest')).toBe('no');
    expect(mayStillMine(c, views, 'proof')).toBe('yes');
    expect(nonceConsumed(views, 7, 'proof')).toBe(false);
  });

  it('a terminal row never mines; a node that knows the tx does not by itself prove anything', () => {
    expect(mayStillMine(cand({ status: 'DEAD', proofLevel: 'proof' }), [{ node: 'a', ok: false }], 'proof')).toBe('no');
    const c = cand({ nonce: 7 });
    expect(mayStillMine(c, [view('a', { known: { [c.txHash]: true } }), view('b', { known: { [c.txHash]: false } })], 'latest')).toBe('yes');
  });

  it('P3-1: a LEGACY row without nonce keeps today\'s rules', () => {
    const c = cand({ nonce: null, kind: 'LEGACY', origin: 'BACKFILL', status: 'SEND_UNCONFIRMED' });
    const none = [view('a', { known: { [c.txHash]: false }, receipts: { [c.txHash]: null } }), view('b', { known: { [c.txHash]: false }, receipts: { [c.txHash]: null } })];
    expect(mayStillMine(c, none, 'proof')).toBe('yes'); // contest gate: no receipt → may mine
    expect(legacyResignAllowed(c, none)).toBe(true); // worker: every node "not found" → new attempt allowed
    const oneKnows = [view('a', { known: { [c.txHash]: true }, receipts: { [c.txHash]: null } }), none[1]!];
    expect(legacyResignAllowed(c, oneKnows)).toBe(false);
    expect(legacyResignAllowed(c, [none[0]!, { node: 'b', ok: false }])).toBe(false);
    expect(mayStillMine(c, [view('a', { receipts: { [c.txHash]: receipt(c.txHash) } })], 'proof')).toBe('no');
  });
});

describe('resolveNonceDecision (§4.2, rows 13, 14, 33)', () => {
  it('exactly one receipt by consensus → winner; the others are losers; proof level follows the proof tag', () => {
    const orig = cand({ status: 'SENT' });
    const sp = cand({ kind: 'SPEED_UP', origin: 'SCRIPT', status: 'SENT' });
    const r = receipt(sp.txHash);
    const at = (proof: number) => ['a', 'b'].map((n) => view(n, { nonceLatest: 8, nonceProof: proof, receipts: { [orig.txHash]: null, [sp.txHash]: r } }));
    const latest = resolveNonceDecision([orig, sp], at(7), 7);
    expect(latest).toMatchObject({ kind: 'winner', winnerId: sp.id, losers: [orig.id], proofLevel: 'latest' });
    expect(resolveNonceDecision([orig, sp], at(8), 7)).toMatchObject({ kind: 'winner', proofLevel: 'proof' });
  });

  it('row 13: a node lagging on the receipt, a node error, a different block → uncertain; nothing becomes DEAD', () => {
    const a = cand();
    const lag = [view('a', { nonceLatest: 8, receipts: { [a.txHash]: receipt(a.txHash) } }), view('b', { nonceLatest: 8, receipts: { [a.txHash]: null } })];
    expect(resolveNonceDecision([a], lag, 7)).toMatchObject({ kind: 'uncertain', reason: 'RECEIPT_DISAGREE' });
    expect(resolveNonceDecision([a], [lag[0]!, { node: 'b', ok: false }], 7)).toMatchObject({ kind: 'uncertain', reason: 'NODE_ERROR' });
    const fork = [view('a', { nonceLatest: 8, receipts: { [a.txHash]: receipt(a.txHash, BLOCK_A) } }), view('b', { nonceLatest: 8, receipts: { [a.txHash]: receipt(a.txHash, BLOCK_B) } })];
    expect(resolveNonceDecision([a], fork, 7)).toMatchObject({ kind: 'uncertain', reason: 'RECEIPT_DISAGREE' });
    expect(resolveNonceDecision([a], [view('a', { nonceLatest: 8, receipts: {} })], 7)).toMatchObject({ kind: 'uncertain', reason: 'NODE_ERROR' });
  });

  it('more than one receipt for the same nonce is a data / node error: uncertain MULTIPLE_RECEIPTS', () => {
    const a = cand();
    const b = cand();
    const v = [view('a', { nonceLatest: 8, receipts: { [a.txHash]: receipt(a.txHash), [b.txHash]: receipt(b.txHash) } })];
    expect(resolveNonceDecision([a, b], v, 7)).toMatchObject({ kind: 'uncertain', reason: 'MULTIPLE_RECEIPTS' });
  });

  it('no receipt: consumed at latest by consensus → consumed-foreign; otherwise alive', () => {
    const a = cand();
    const consumed = ['a', 'b'].map((n) => view(n, { nonceLatest: 8, nonceProof: 8, receipts: { [a.txHash]: null } }));
    expect(resolveNonceDecision([a], consumed, 7)).toEqual({ kind: 'consumed-foreign', ids: [a.id], proofLevel: 'proof' });
    const split = [view('a', { nonceLatest: 8, receipts: { [a.txHash]: null } }), view('b', { nonceLatest: 7, receipts: { [a.txHash]: null } })];
    expect(resolveNonceDecision([a], split, 7)).toEqual({ kind: 'alive' });
    expect(resolveNonceDecision([a], [view('a', { nonceLatest: 7, receipts: { [a.txHash]: null } })], 7)).toEqual({ kind: 'alive' });
  });

  it('a receipt with the nonce not consumed at latest on every node is uncertain (reads straddled a block)', () => {
    const a = cand();
    const v = [view('a', { nonceLatest: 7, receipts: { [a.txHash]: receipt(a.txHash) } })];
    expect(resolveNonceDecision([a], v, 7)).toMatchObject({ kind: 'uncertain' });
  });

  it('row 14: a MINED row at latest whose block changed or vanished → reorg (with the DEAD-at-latest losers)', () => {
    const w = cand({ status: 'MINED_SUCCESS', proofLevel: 'latest', minedBlockHash: BLOCK_A });
    const l = cand({ status: 'DEAD', proofLevel: 'latest' });
    const gone = [view('a', { nonceLatest: 7, receipts: { [w.txHash]: null, [l.txHash]: null } })];
    expect(resolveNonceDecision([w, l], gone, 7)).toEqual({ kind: 'reorg', ids: [w.id, l.id] });
    const moved = [view('a', { nonceLatest: 8, receipts: { [w.txHash]: receipt(w.txHash, BLOCK_B), [l.txHash]: null } })];
    expect(resolveNonceDecision([w, l], moved, 7)).toEqual({ kind: 'reorg', ids: [w.id, l.id] });
  });

  it('row 14: a row proven at proof depth is never reverted (uncertain PROOF_LEVEL_REORG)', () => {
    const w = cand({ status: 'MINED_SUCCESS', proofLevel: 'proof', minedBlockHash: BLOCK_A });
    const gone = [view('a', { nonceLatest: 7, receipts: { [w.txHash]: null } })];
    expect(resolveNonceDecision([w], gone, 7)).toMatchObject({ kind: 'uncertain', reason: 'PROOF_LEVEL_REORG' });
  });

  it('row 14: DEAD-at-latest rows of a consumed-foreign nonce come back when the nonce is no longer consumed', () => {
    const d = cand({ status: 'DEAD', proofLevel: 'latest' });
    expect(resolveNonceDecision([d], [view('a', { nonceLatest: 7, receipts: { [d.txHash]: null } })], 7)).toEqual({ kind: 'reorg', ids: [d.id] });
  });

  it('a winner already at latest is upgraded to proof when the proof tag catches up (same block)', () => {
    const w = cand({ status: 'MINED_SUCCESS', proofLevel: 'latest', minedBlockHash: BLOCK_A });
    const v = [view('a', { nonceLatest: 8, nonceProof: 8, receipts: { [w.txHash]: receipt(w.txHash, BLOCK_A) } })];
    expect(resolveNonceDecision([w], v, 7)).toMatchObject({ kind: 'winner', winnerId: w.id, proofLevel: 'proof' });
  });
});

describe('chooseNonce (R2-P2-3)', () => {
  it('max(pending, highest live + 1)', () => {
    expect(chooseNonce(5, [])).toBe(5);
    expect(chooseNonce(5, [3, 4])).toBe(5);
    expect(chooseNonce(5, [5])).toBe(6); // a node lagging on pending would reuse a live nonce
    expect(chooseNonce(4, [7, 5])).toBe(8);
    expect(() => chooseNonce(-1, [])).toThrow(RangeError);
  });
});

describe('rebroadcastAllowed (R2-P1-3)', () => {
  const base = () => {
    const c = cand({ status: 'SEND_UNCONFIRMED' });
    const views = ['a', 'b'].map((n) => view(n, { nonceLatest: 7, known: { [c.txHash]: false }, receipts: { [c.txHash]: null } }));
    return { candidate: c, candidatesAtNonce: [c], views, hasRawTx: true, simulationOk: true, gateOpen: true };
  };
  it('head, only live candidate, unknown to every node, simulation ok, gate open → allowed', () => {
    expect(rebroadcastAllowed(base())).toEqual({ ok: true });
  });
  it('refused for each missing condition', () => {
    expect(rebroadcastAllowed({ ...base(), gateOpen: false })).toMatchObject({ reason: 'GATE_CLOSED' });
    expect(rebroadcastAllowed({ ...base(), hasRawTx: false })).toMatchObject({ reason: 'NO_RAW_TX' });
    expect(rebroadcastAllowed({ ...base(), simulationOk: false })).toMatchObject({ reason: 'SIMULATION_REVERTS' });
    const b = base();
    expect(rebroadcastAllowed({ ...b, views: b.views.map((v) => ({ ...v, nonceLatest: 6 })) })).toMatchObject({ reason: 'NOT_HEAD' });
    expect(rebroadcastAllowed({ ...b, views: [b.views[0]!, { node: 'b', ok: false }] })).toMatchObject({ reason: 'NODE_ERROR' });
    expect(rebroadcastAllowed({ ...b, views: [b.views[0]!, { ...b.views[1]!, known: { [b.candidate.txHash]: true } }] })).toMatchObject({ reason: 'KNOWN_OR_MINED' });
    const other = cand({ status: 'SIGNED' });
    expect(rebroadcastAllowed({ ...b, candidatesAtNonce: [b.candidate, other] })).toMatchObject({ reason: 'OTHER_LIVE_CANDIDATE' }); // row 29
    expect(rebroadcastAllowed({ ...b, candidate: { ...b.candidate, status: 'DEAD', proofLevel: 'proof' } })).toMatchObject({ reason: 'NOT_LIVE' });
  });
});

describe('admissibleOperations (R2-P2-1, plan §4.2, row 42)', () => {
  const head = (o: Partial<HeadSituation> = {}): HeadSituation => ({
    ourCandidate: true, jobTerminalOnChain: false, simulationPasses: true, foreignAcknowledged: false, payDecisionAffected: false, posture: 'none', ...o,
  });
  it('ours + simulation passes → speed-up only; cancel refused with the "does not settle" text', () => {
    const r = admissibleOperations(head());
    expect(r.speedUp).toEqual({ ok: true });
    expect(r.cancel).toMatchObject({ ok: false, reason: 'SPEED_UP_POSSIBLE' });
    expect((r.cancel as { detail: string }).detail).toMatch(/does not settle/i);
  });
  it('ours + simulation reverts → cancel only; job terminal → cancel only', () => {
    expect(admissibleOperations(head({ simulationPasses: false }))).toEqual({ speedUp: { ok: false, reason: 'SIMULATION_REVERTS' }, cancel: { ok: true } });
    expect(admissibleOperations(head({ jobTerminalOnChain: true })).cancel).toEqual({ ok: true });
    expect(admissibleOperations(head({ jobTerminalOnChain: true })).speedUp).toMatchObject({ ok: false, reason: 'JOB_TERMINAL' });
  });
  it('foreign head → cancel only after acknowledgement', () => {
    expect(admissibleOperations(head({ ourCandidate: false })).cancel).toMatchObject({ ok: false, reason: 'FOREIGN_NOT_ACKNOWLEDGED' });
    expect(admissibleOperations(head({ ourCandidate: false, foreignAcknowledged: true })).cancel).toEqual({ ok: true });
    expect(admissibleOperations(head({ ourCandidate: false, foreignAcknowledged: true })).speedUp.ok).toBe(false);
  });
  it('≤ M_min with a "pay" decision affected → cancel refused; after expiry → speed-up only, with the AFTER EXPIRY phrase', () => {
    expect(admissibleOperations(head({ simulationPasses: false, posture: 'hand-to-owner', payDecisionAffected: true })).cancel).toMatchObject({ reason: 'PAY_DECISION_NEAR_EXPIRY' });
    expect(admissibleOperations(head({ simulationPasses: false, posture: 'hand-to-owner', payDecisionAffected: false })).cancel).toEqual({ ok: true });
    expect(admissibleOperations(head({ posture: 'expired' })).speedUp).toEqual({ ok: true, requiresAfterExpiryPhrase: true });
    expect(admissibleOperations(head({ simulationPasses: false, posture: 'expired' })).cancel).toMatchObject({ ok: false });
    expect(admissibleOperations(head({ simulationPasses: null }))).toMatchObject({ speedUp: { ok: false }, cancel: { ok: false } });
  });
});

describe('proposeReplacementFees — plan P7 (rows 17, 36, 37)', () => {
  it('row 17: no caps → NO_CAPS; incoherent caps → INVALID_CAPS', () => {
    expect(proposeReplacementFees({ prevMaxFee: 7_000_000n, prevPrio: 1_000_000n, baseFee: BASE_FLOOR, prioP90: 5_000_000n, attempt: 1, caps: null })).toMatchObject({ ok: false, reason: 'NO_CAPS' });
    expect(capsProblem({ ...CAPS, bumpBps: 500 })).toMatchObject({ reason: 'INVALID_CAPS' });
    expect(capsProblem({ ...CAPS, multipliers: [] })).toMatchObject({ reason: 'INVALID_CAPS' });
    expect(capsProblem({ ...CAPS, maxFeePerGasWei: 0n })).toMatchObject({ reason: 'INVALID_CAPS' });
    expect(capsProblem(CAPS)).toBeNull();
  });

  it('row 36: base at the floor — prio = max(prev × 1.125, p90, floor), maxFee = max(prev × 1.125, base × m + prio)', () => {
    const r = proposeReplacementFees({ prevMaxFee: 7_000_000n, prevPrio: 1_000_000n, baseFee: BASE_FLOOR, prioP90: 5_000_000n, attempt: 1, caps: CAPS });
    expect(r).toEqual({ ok: true, maxPriorityFeePerGas: 5_000_000n, maxFeePerGas: 20_000_000n, effectiveCapWei: 200_000_000n });
  });

  it('row 36: original more expensive than m × base — the bump over it wins; both fees ≥ +12.5 %', () => {
    const r = proposeReplacementFees({ prevMaxFee: 100_000_000n, prevPrio: 20_000_000n, baseFee: BASE_FLOOR, prioP90: 5_000_000n, attempt: 1, caps: CAPS });
    expect(r).toMatchObject({ ok: true, maxFeePerGas: 112_500_000n, maxPriorityFeePerGas: 22_500_000n });
  });

  it('row 36: base rising 4 %/block, each step uses its multiplier and stays ≥ the bump over the previous step', () => {
    let prevMaxFee = 7_000_000n;
    let prevPrio = 1_000_000n;
    let base = BASE_FLOOR;
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (let b = 0; b < 5; b++) base = (base * 104n + 99n) / 100n;
      const r = proposeReplacementFees({ prevMaxFee, prevPrio, baseFee: base, prioP90: 5_000_000n, attempt, caps: CAPS });
      if (!r.ok) throw new Error(`attempt ${attempt}: ${r.reason}`);
      expect(r.maxFeePerGas).toBeGreaterThanOrEqual(bumped(prevMaxFee, 1_250));
      expect(r.maxPriorityFeePerGas).toBeGreaterThanOrEqual(bumped(prevPrio, 1_250));
      expect(r.maxFeePerGas).toBeGreaterThanOrEqual(base * CAPS.multipliers[attempt - 1]! + r.maxPriorityFeePerGas);
      expect(r.maxFeePerGas * 10_000n).toBeGreaterThanOrEqual(prevMaxFee * 11_250n);
      prevMaxFee = r.maxFeePerGas;
      prevPrio = r.maxPriorityFeePerGas;
    }
    // 4th replacement: refused (P8 / P4 steps exhausted)
    expect(proposeReplacementFees({ prevMaxFee, prevPrio, baseFee: base, prioP90: 5_000_000n, attempt: 4, caps: CAPS })).toMatchObject({ ok: false, reason: 'MAX_REPLACEMENTS' });
  });

  it('row 37: above the effective cap min(P2, P5 × base + P3) → refused with the missing value, never clipped', () => {
    expect(effectiveFeeCap(CAPS, BASE_FLOOR)).toBe(200_000_000n); // 0.2 gwei at the floor, not P2's 1 gwei
    expect(effectiveFeeCap(CAPS, 100_000_000n)).toBe(GWEI);         // base 0.1 gwei: P2 bites
    const r = proposeReplacementFees({ prevMaxFee: 190_000_000n, prevPrio: 1_000_000n, baseFee: BASE_FLOOR, prioP90: 5_000_000n, attempt: 1, caps: CAPS });
    expect(r).toEqual({ ok: false, reason: 'FEE_ABOVE_CAP', needed: 213_750_000n, cap: 200_000_000n });
    const p = proposeReplacementFees({ prevMaxFee: 7_000_000n, prevPrio: 90_000_000n, baseFee: BASE_FLOOR, prioP90: 5_000_000n, attempt: 1, caps: CAPS });
    expect(p).toMatchObject({ ok: false, reason: 'PRIORITY_ABOVE_CAP', needed: 101_250_000n, cap: GWEI / 10n });
  });
});

describe('replacementLimitCheck — P8 / P9 (row 38, rule)', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const row = (kind: CandidateRow['kind'], ageMs: number, broadcastAgeMs: number | null = null) => ({
    kind, createdAt: new Date(now.getTime() - ageMs), broadcastAt: broadcastAgeMs === null ? null : new Date(now.getTime() - broadcastAgeMs), lastBroadcastAt: null,
  });
  it('counts SPEED_UP / CANCEL rows; the 4th replacement is refused', () => {
    expect(replacementLimitCheck({ rowsAtNonce: [row('ORIGINAL', 600_000)], caps: CAPS, now })).toEqual({ ok: true, replacementsSoFar: 0 });
    const three = [row('ORIGINAL', 900_000), row('SPEED_UP', 800_000), row('SPEED_UP', 700_000), row('CANCEL', 600_000)];
    expect(replacementLimitCheck({ rowsAtNonce: three, caps: CAPS, now })).toMatchObject({ ok: false, reason: 'MAX_REPLACEMENTS' });
  });
  it('interval measured from the latest signature / send at the nonce', () => {
    const r = replacementLimitCheck({ rowsAtNonce: [row('ORIGINAL', 600_000, 30_000)], caps: CAPS, now });
    expect(r).toEqual({ ok: false, reason: 'INTERVAL', retryAt: new Date(now.getTime() + 30_000) });
    expect(replacementLimitCheck({ rowsAtNonce: [row('ORIGINAL', 600_000, 60_000)], caps: CAPS, now }).ok).toBe(true);
    expect(replacementLimitCheck({ rowsAtNonce: [row('ORIGINAL', 10_000)], caps: CAPS, now })).toMatchObject({ reason: 'INTERVAL' }); // signed, maybe sent
  });
  it('no caps → refused', () => {
    expect(replacementLimitCheck({ rowsAtNonce: [], caps: null, now })).toMatchObject({ reason: 'NO_CAPS' });
  });
});

describe('budgetCheck — P1, P11–P15 (rows 15, 39, 40, 41)', () => {
  const ok = { caps: CAPS, nonce: 10, gasLimit: 740_300n, maxFeePerGas: 200_000_000n, incidentMaxByNonce: {}, dayMaxByNonce: {}, liveMaxByNonce: {}, balanceWei: 5n * ETH / 1_000n };
  it('within every cap → ok with the totals', () => {
    expect(budgetCheck(ok)).toMatchObject({ ok: true, costWei: 740_300n * 200_000_000n });
  });
  it('row 17: no caps → NO_CAPS', () => {
    expect(budgetCheck({ ...ok, caps: null })).toMatchObject({ ok: false, reason: 'NO_CAPS' });
  });
  it('row 41: gas limit above P1 → refused', () => {
    expect(budgetCheck({ ...ok, gasLimit: 1_000_001n, maxFeePerGas: 1n })).toMatchObject({ ok: false, reason: 'GAS_LIMIT_ABOVE_CAP', cap: 1_000_000n });
  });
  it('P11: per-tx cost above the cap', () => {
    expect(budgetCheck({ ...ok, gasLimit: 1_000_000n, maxFeePerGas: GWEI })).toMatchObject({ ok: false, reason: 'TX_COST_ABOVE_CAP' });
    expect(budgetCheck({ ...ok, gasLimit: 1_000_000n, maxFeePerGas: 800_000_000n }).ok).toBe(true); // exactly P11
  });
  it('row 39: incident = Σ over nonces of the most expensive; a replacement at the same nonce does not add up', () => {
    const sameNonce = budgetCheck({ ...ok, incidentMaxByNonce: new Map([[10, 7n * 10n ** 14n]]), gasLimit: 1_000_000n, maxFeePerGas: 800_000_000n });
    expect(sameNonce).toMatchObject({ ok: true, incidentTotalWei: 8n * 10n ** 14n });
    const another = budgetCheck({ ...ok, nonce: 12, incidentMaxByNonce: { 10: 7n * 10n ** 14n, 11: 1n * 10n ** 14n }, gasLimit: 1_000_000n, maxFeePerGas: 750_000_000n });
    expect(another).toMatchObject({ ok: false, reason: 'INCIDENT_BUDGET_EXCEEDED', needed: 155n * 10n ** 13n });
  });
  it('row 39: rolling 24 h budget', () => {
    const r = budgetCheck({ ...ok, nonce: 3, dayMaxByNonce: { 1: 7n * 10n ** 14n, 2: 7n * 10n ** 14n }, gasLimit: 1_000_000n, maxFeePerGas: 700_000_000n });
    expect(r).toMatchObject({ ok: false, reason: 'DAILY_BUDGET_EXCEEDED', needed: 21n * 10n ** 14n });
  });
  it('rows 15 / 40: balance − Σ live reserved − L1 margin × nonces ≥ reserve', () => {
    const cost = 740_300n * 200_000_000n;
    const exact = CAPS.reserveWei + cost + CAPS.l1MarginWei;
    expect(budgetCheck({ ...ok, balanceWei: exact }).ok).toBe(true);
    expect(budgetCheck({ ...ok, balanceWei: exact - 1n })).toMatchObject({ ok: false, reason: 'RESERVE_BREACHED' });
    // a live script candidate at another nonce is still reserved
    expect(budgetCheck({ ...ok, balanceWei: exact, liveMaxByNonce: { 11: 1n } })).toMatchObject({ ok: false, reason: 'RESERVE_BREACHED' });
    // at the same nonce only the most expensive counts
    expect(budgetCheck({ ...ok, balanceWei: exact, liveMaxByNonce: { 10: 1n } }).ok).toBe(true);
  });
});

describe('expiryPosture — P18–P20 by block time (row 42)', () => {
  const cfg = { actWithinMs: 24 * 3_600_000, urgentWithinMs: 6 * 3_600_000, handToOwnerWithinMs: 3_600_000 };
  const block = new Date('2026-10-22T12:00:00Z');
  const at = (ms: number) => new Date(block.getTime() + ms);
  it('labels by distance between the latest block timestamp and the earliest delivered expiry', () => {
    expect(expiryPosture(null, block, cfg)).toBe('none');
    expect(expiryPosture(at(25 * 3_600_000), block, cfg)).toBe('none');
    expect(expiryPosture(at(24 * 3_600_000), block, cfg)).toBe('act');
    expect(expiryPosture(at(6 * 3_600_000), block, cfg)).toBe('urgent');
    expect(expiryPosture(at(3_600_000), block, cfg)).toBe('hand-to-owner');
    expect(expiryPosture(at(1), block, cfg)).toBe('hand-to-owner');
    expect(expiryPosture(at(0), block, cfg)).toBe('expired'); // claimRefund valid at block.timestamp >= expiredAt
    expect(expiryPosture(at(-1), block, cfg)).toBe('expired');
  });
  it('no thresholds (or unordered ones) → throws: no default numbers', () => {
    expect(() => expiryPosture(at(1), block, undefined as never)).toThrow(RangeError);
    expect(() => expiryPosture(at(1), block, { ...cfg, urgentWithinMs: 48 * 3_600_000 })).toThrow(RangeError);
  });
});

describe('planFingerprint (§8.3) and range plan (rows 18, 35)', () => {
  const base = {
    chainId: 84532, evaluator: EVALUATOR, nonce: 7,
    candidates: [{ txHash: H(1), status: 'SENT' as const }, { txHash: H(2), status: 'SIGNED' as const }],
    jobOnChainStatus: 'Submitted', operation: 'speed-up' as const,
    proposedFees: { maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 5_000_000n },
  };
  it('order-independent in the candidates and address case; changes with every input', () => {
    const f = planFingerprint(base);
    expect(f).toMatch(/^0x[0-9a-f]{64}$/);
    expect(planFingerprint({ ...base, evaluator: EVALUATOR.toLowerCase(), candidates: [...base.candidates].reverse() })).toBe(f);
    expect(planFingerprint({ ...base, nonce: 8 })).not.toBe(f); // one fingerprint per nonce (row 35)
    expect(planFingerprint({ ...base, candidates: [{ txHash: H(1), status: 'SENT' }, { txHash: H(2), status: 'SENT' }] })).not.toBe(f);
    expect(planFingerprint({ ...base, candidates: [...base.candidates, { txHash: H(3), status: 'SIGNED' }] })).not.toBe(f);
    expect(planFingerprint({ ...base, jobOnChainStatus: 'Completed' })).not.toBe(f);
    expect(planFingerprint({ ...base, operation: 'cancel' })).not.toBe(f);
    expect(planFingerprint({ ...base, proposedFees: { maxFeePerGas: 20_000_001n, maxPriorityFeePerGas: 5_000_000n } })).not.toBe(f);
  });
  it('row 18: a nonce that is not the head on every node is refused', () => {
    expect(headCheck(7, [view('a', { nonceLatest: 7 }), view('b', { nonceLatest: 7 })])).toEqual({ ok: true });
    expect(headCheck(8, [view('a', { nonceLatest: 7 })])).toMatchObject({ ok: false, reason: 'NOT_HEAD' });
    expect(headCheck(7, [view('a', { nonceLatest: 7 }), view('b', { nonceLatest: 6 })])).toMatchObject({ ok: false, reason: 'NOT_HEAD' });
    expect(headCheck(7, [{ node: 'a', ok: false }])).toMatchObject({ ok: false, reason: 'NODE_ERROR' });
  });
  it('row 35: range plan from the head, contiguous, at most P16 nonces', () => {
    expect(rangePlanCheck(7, [7, 8, 9], CAPS)).toEqual({ ok: true });
    expect(rangePlanCheck(7, [8, 9], CAPS)).toMatchObject({ reason: 'NOT_FROM_HEAD' });
    expect(rangePlanCheck(7, [7, 9], CAPS)).toMatchObject({ reason: 'NOT_CONTIGUOUS' });
    expect(rangePlanCheck(7, [7, 8, 9, 10], CAPS)).toMatchObject({ reason: 'TOO_MANY_NONCES' });
    expect(rangePlanCheck(7, [7], null)).toMatchObject({ reason: 'NO_CAPS' });
  });
});

describe('classifyHead — plan §6.3 (row 43)', () => {
  const head = (o: Partial<CandidateRow> = {}) => cand({ status: 'SENT', maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n, ...o });
  const knownViews = (c: CandidateRow, known: boolean) => ['a', 'b'].map((n) => view(n, { known: { [c.txHash]: known }, receipts: { [c.txHash]: null } }));
  const input = (c: CandidateRow, o = {}) => ({ candidates: [c], views: knownViews(c, true), backlog: true, baseFee: BASE_FLOOR, blocksStuck: 40, stuckBlocksThreshold: 30, ...o });
  it('price-stuck: maxFee below the base fee (or prio under p10 long enough)', () => {
    const c = head({ maxFeePerGas: 4_000_000n });
    expect(classifyHead(input(c))).toBe('price-stuck');
    expect(classifyHead(input(head(), { prioP10: 2_000_000n }))).toBe('price-stuck');
    expect(classifyHead(input(head(), { prioP10: 2_000_000n, blocksStuck: 5 }))).toBe('none');
  });
  it('lost-send: no node knows it, price fine', () => {
    const c = head();
    expect(classifyHead(input(c, { views: knownViews(c, false) }))).toBe('lost-send');
  });
  it('known-not-mined: a node knows it for ≥ threshold blocks; before that: none', () => {
    const c = head();
    expect(classifyHead(input(c))).toBe('known-not-mined');
    expect(classifyHead(input(c, { blocksStuck: 10 }))).toBe('none');
  });
  it('foreign: consumed without ours, or a backlog head with no ledger row', () => {
    expect(classifyHead(input(head(), { consumedForeign: true }))).toBe('foreign');
    expect(classifyHead({ candidates: [], views: [view('a')], backlog: true, baseFee: BASE_FLOOR, blocksStuck: 1, stuckBlocksThreshold: 30 })).toBe('foreign');
    expect(classifyHead({ candidates: [], views: [view('a')], backlog: false, baseFee: BASE_FLOOR, blocksStuck: null, stuckBlocksThreshold: 30 })).toBe('none');
  });
  it('a node error never yields lost-send', () => {
    const c = head();
    expect(classifyHead(input(c, { views: [knownViews(c, false)[0]!, { node: 'b', ok: false }] }))).toBe('none');
  });
});
