/**
 * C3g-A1 — pure rules over evaluator transaction candidates (no I/O).
 *
 * Normative sources: notes `2026-10-21-spec-c3g-a1.md` (Revision 1 + R2; R2
 * prevails), `2026-10-21-plano-a1-parametros.md` (P7 formula, P1–P22 as
 * configurable inputs, rows 36–45) and `2026-10-22-a1-contratos-interface.md`
 * (names and signatures).
 *
 * Cross-cutting rules every function here keeps:
 *  - nothing closes by time or by "not found": a candidate stops being able to
 *    mine only when its nonce is consumed, by CONSENSUS of every RPC node that
 *    answered; any node error is "uncertain" (the `tx-known.ts` rule);
 *  - more than one receipt for the same nonce is a data / node error: nothing
 *    is decided (and so nothing is written);
 *  - fee caps come from configuration only. There are NO default numbers in
 *    this file: with no caps configured every execution is refused.
 */
import { keccak256, toHex } from 'viem';

// ── Types ────────────────────────────────────────────────────────────────────

export type CandidateStatus = 'SIGNED' | 'SENT' | 'SEND_UNCONFIRMED' | 'MINED_SUCCESS' | 'MINED_REVERTED' | 'DEAD';
export type CandidateKind = 'ORIGINAL' | 'SPEED_UP' | 'CANCEL' | 'EXTERNAL' | 'LEGACY';
export type CandidateAction = 'COMPLETE' | 'REJECT' | 'CLAIM_REFUND' | 'CANCEL_NOOP' | 'UNKNOWN';
export type CandidateOrigin = 'WORKER' | 'SCRIPT' | 'BACKFILL' | 'RECONCILE';
export type ProofLevel = 'latest' | 'proof';

/** Statuses of a candidate that may still mine (spec §6.1). */
export const LIVE_STATUSES: readonly CandidateStatus[] = ['SIGNED', 'SENT', 'SEND_UNCONFIRMED'];
export const TERMINAL_STATUSES: readonly CandidateStatus[] = ['MINED_SUCCESS', 'MINED_REVERTED', 'DEAD'];

export function isLiveStatus(status: CandidateStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/**
 * One ledger row as the rules see it. `gasLimit` / fees are 0n and
 * `calldataHash` is '' ONLY on a LEGACY row with `nonce === null` (its tx data
 * is unknown; such a row never takes part in nonce rules).
 */
export interface CandidateRow {
  id: string;
  chainId: number;
  evaluator: string;
  nonce: number | null;
  jobId: string | null;
  kind: CandidateKind;
  action: CandidateAction;
  decision: string | null;
  calldataHash: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  txHash: string;
  status: CandidateStatus;
  proofLevel: ProofLevel | null;
  createdAt: Date;
  broadcastAt: Date | null;
  lastBroadcastAt: Date | null;
  origin: CandidateOrigin;
  incidentId: string | null;
  minedBlockHash: string | null;
}

export interface ReceiptView {
  txHash: string;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: string;
  logsForJob: { completed: boolean; rejected: boolean; expired: boolean };
}

/**
 * What ONE RPC node answered. `ok: false` = the node could not be read (any
 * of its answers is missing): every rule treats that as uncertain.
 * - `nonceLatest` / `nonceProof`: `getTransactionCount(evaluator, 'latest' | proofTag)`;
 * - `known[hash]`: the node returns the tx (`eth_getTransactionByHash`);
 * - `receipts[hash]`: the receipt, or `null` for "no receipt". A hash missing
 *   from the record was not asked: uncertain.
 */
export interface NodeView {
  node: string;
  ok: boolean;
  nonceLatest?: number;
  nonceProof?: number;
  nonceAtTag?: number;
  known?: Record<string, boolean>;
  receipts?: Record<string, ReceiptView | null>;
}

/**
 * Configured recovery caps (plan P1–P15). Every field is required; the
 * orchestrator builds this from env only when every value is configured and
 * passes `null` otherwise (→ refusal `NO_CAPS`).
 * Additions to the contract of 22/10 (reported to the orchestrator):
 * `maxGasLimit` (P1) and `minPriorityFeePerGasWei` (P7's priority floor).
 */
export interface RecoveryCaps {
  /** P2: absolute cap of maxFeePerGas. */
  maxFeePerGasWei: bigint;
  /** P3: cap of maxPriorityFeePerGas. */
  maxPriorityFeePerGasWei: bigint;
  /** P5: relative cap — maxFeePerGas ≤ relativeBaseMultiplier × baseFee + P3. */
  relativeBaseMultiplier: bigint;
  /** P6: replacement bump in basis points over the most expensive live candidate of the nonce. */
  bumpBps: number;
  /** P4: base-fee multiplier per replacement attempt (attempt 1 → multipliers[0]). */
  multipliers: bigint[];
  /** P8. */
  maxReplacementsPerNonce: number;
  /** P9 (ms). */
  minIntervalMs: number;
  /** P11: gasLimit × maxFeePerGas of one transaction. */
  maxCostPerTxWei: bigint;
  /** P12: per incident, Σ over nonces of the most expensive SCRIPT candidate. */
  maxCostPerIncidentWei: bigint;
  /** P13: rolling 24 h, same aggregation, SCRIPT rows. */
  maxCost24hWei: bigint;
  /** P14: balance kept after everything reserved. */
  reserveWei: bigint;
  /** P15: L1 data-fee margin per transaction. */
  l1MarginWei: bigint;
  /** P16: nonces in one range plan. */
  maxNoncesPerPlan: number;
  /** P1: gas limit cap (a cancel is always 21 000). */
  maxGasLimit: bigint;
  /** P7: floor of the proposed priority fee. */
  minPriorityFeePerGasWei: bigint;
}

export type Refusal<R extends string = string> = { ok: false; reason: R; detail?: string };
export type Allowed = { ok: true; requiresAfterExpiryPhrase?: boolean } | Refusal;

// ── Small helpers ────────────────────────────────────────────────────────────

const lower = (s: string) => s.toLowerCase();

function receiptOf(view: NodeView, hash: string): ReceiptView | null | undefined {
  const r = view.receipts;
  if (!r) return undefined;
  const key = Object.keys(r).find((k) => lower(k) === lower(hash));
  return key === undefined ? undefined : r[key];
}

function knownOf(view: NodeView, hash: string): boolean | undefined {
  const k = view.known;
  if (!k) return undefined;
  const key = Object.keys(k).find((x) => lower(x) === lower(hash));
  return key === undefined ? undefined : k[key];
}

function countAt(view: NodeView, depth: 'latest' | 'proof'): number | undefined {
  return depth === 'latest' ? view.nonceLatest : view.nonceProof;
}

/** Consensus "nonce consumed at depth" over the views: true / false / null (uncertain). */
export function nonceConsumed(views: NodeView[], nonce: number, depth: 'latest' | 'proof'): boolean | null {
  if (views.length === 0) return null;
  let all = true;
  for (const v of views) {
    if (!v.ok) return null;
    const c = countAt(v, depth);
    if (c === undefined || !Number.isInteger(c)) return null;
    if (!(c > nonce)) all = false;
  }
  return all;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** prev × (1 + bps/10 000), rounded UP (a node compares with ≥ +x %). */
export function bumped(prev: bigint, bumpBps: number): bigint {
  return ceilDiv(prev * BigInt(10_000 + bumpBps), 10_000n);
}

const maxBig = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a));
const minBig = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

// ── §6.1: may this candidate still mine? ─────────────────────────────────────

/**
 * Spec §6.1 + R2-P2-2. A live candidate can no longer mine once its nonce is
 * consumed AT THE REQUESTED DEPTH by consensus of the nodes that answered:
 *  - `'latest'`: re-signing the same decision / identical rebroadcast;
 *  - `'proof'`: anything that changes what can happen to the job (contest,
 *    resolve with another decision, backend claimRefund, cancellation reject,
 *    rebuilding the feedback file).
 * Any node error or missing answer → `'uncertain'` (API: 503). A receipt at
 * `latest` that is not yet at proof depth is still `'yes'` at depth `'proof'`
 * (the outcome may be reorganised away).
 *
 * A LEGACY row without nonce follows today's contest rule (P3-1): it may mine
 * while it has no receipt. The worker's re-sign rule for it is
 * `legacyResignAllowed`.
 */
export function mayStillMine(c: CandidateRow, views: NodeView[], depth: 'latest' | 'proof'): 'yes' | 'no' | 'uncertain' {
  if (!isLiveStatus(c.status)) return 'no';
  if (views.length === 0 || views.some((v) => !v.ok)) return 'uncertain';
  if (c.nonce === null) {
    let receipt = false;
    for (const v of views) {
      const r = receiptOf(v, c.txHash);
      if (r === undefined) return 'uncertain';
      if (r !== null) receipt = true;
    }
    return receipt ? 'no' : 'yes';
  }
  const consumed = nonceConsumed(views, c.nonce, depth);
  if (consumed === null) return 'uncertain';
  return consumed ? 'no' : 'yes';
}

/**
 * Today's worker rule for a LEGACY row without nonce (P3-1, `S:2187-2193`):
 * a new attempt is allowed when every node answered, none returns a receipt
 * and none knows the hash.
 */
export function legacyResignAllowed(c: CandidateRow, views: NodeView[]): boolean {
  if (c.nonce !== null || !isLiveStatus(c.status)) return false;
  if (views.length === 0) return false;
  for (const v of views) {
    if (!v.ok) return false;
    const r = receiptOf(v, c.txHash);
    const k = knownOf(v, c.txHash);
    if (r === undefined || k === undefined) return false;
    if (r !== null || k) return false;
  }
  return true;
}

// ── §4.2: who won a nonce ────────────────────────────────────────────────────

export type UncertainReason =
  | 'NODE_ERROR'          // a node failed / an answer is missing
  | 'NO_VIEWS'
  | 'RECEIPT_DISAGREE'    // nodes return different receipts (or one has it, another not) for the same hash
  | 'MULTIPLE_RECEIPTS'   // > 1 candidate of the nonce has a receipt: data / node error — ALERT, write nothing
  | 'PROOF_LEVEL_REORG'   // a row proven at proof depth lost its block: beyond the assumed depth — ALERT, write nothing
  | 'KNOWN_WITHOUT_RECEIPT'; // A1 review P2-1: nonce consumed, no receipt, but a node KNOWS one of our candidates — a read that straddled a block, not proof of a foreign tx

export type NonceResolution =
  | { kind: 'winner'; winnerId: string; losers: string[]; proofLevel: ProofLevel; receipt: ReceiptView }
  | { kind: 'consumed-foreign'; ids: string[]; proofLevel: ProofLevel }
  | { kind: 'alive' }
  | { kind: 'uncertain'; reason: UncertainReason; detail?: string }
  | { kind: 'reorg'; ids: string[] };

type ReceiptConsensus = { state: 'present'; receipt: ReceiptView } | { state: 'absent' } | { state: 'disagree' } | { state: 'unknown' };

function receiptConsensus(views: NodeView[], hash: string): ReceiptConsensus {
  let first: ReceiptView | null | undefined;
  for (let i = 0; i < views.length; i++) {
    const r = receiptOf(views[i]!, hash);
    if (r === undefined) return { state: 'unknown' };
    if (i === 0) { first = r; continue; }
    if ((first === null) !== (r === null)) return { state: 'disagree' };
    if (first && r && (lower(first.blockHash) !== lower(r.blockHash) || first.status !== r.status)) return { state: 'disagree' };
  }
  return first ? { state: 'present', receipt: first } : { state: 'absent' };
}

/**
 * Spec §4.2 + R2-P1-2 + R2-P2-2, for the candidates of ONE nonce.
 *  1. every node must have answered (else uncertain);
 *  2. a receipt counts only when every node returns the same one (same block
 *     hash); a node lagging behind is uncertain, not "absent";
 *  3. reorg: a MINED_* row whose receipt is now absent or in another block →
 *     `reorg` (with every DEAD row at `latest` of the nonce) when its proof
 *     level is `latest`; at level `proof` → uncertain `PROOF_LEVEL_REORG`.
 *     DEAD rows at `latest` whose nonce is no longer consumed at `latest` →
 *     `reorg` too;
 *  4. exactly one receipt → `winner` (the others are `losers`, DEAD with that
 *     proof); proof level `proof` only when the nonce is consumed at proof
 *     depth by consensus;
 *  5. more than one receipt → uncertain `MULTIPLE_RECEIPTS` (write nothing);
 *  6. no receipt and the nonce consumed at `latest` by consensus →
 *     `consumed-foreign` (the live rows become DEAD; §4.3 incident);
 *  7. otherwise `alive`.
 * The financial outcome is never read here: it comes from the job's own
 * terminal event (`receipt.logsForJob`) and `getJob`.
 */
export function resolveNonceDecision(cands: CandidateRow[], views: NodeView[], nonce: number): NonceResolution {
  if (views.length === 0) return { kind: 'uncertain', reason: 'NO_VIEWS' };
  if (views.some((v) => !v.ok)) return { kind: 'uncertain', reason: 'NODE_ERROR' };
  const atNonce = cands.filter((c) => c.nonce === nonce);
  const consumedLatest = nonceConsumed(views, nonce, 'latest');
  if (consumedLatest === null) return { kind: 'uncertain', reason: 'NODE_ERROR', detail: 'nonce at latest unreadable' };

  const receipts = new Map<string, ReceiptView>();
  for (const c of atNonce) {
    const rc = receiptConsensus(views, c.txHash);
    if (rc.state === 'unknown') return { kind: 'uncertain', reason: 'NODE_ERROR', detail: `receipt of ${c.txHash} not asked` };
    if (rc.state === 'disagree') return { kind: 'uncertain', reason: 'RECEIPT_DISAGREE', detail: c.txHash };
    if (rc.state === 'present') receipts.set(c.id, rc.receipt);
  }

  // 3. reorg of rows already resolved
  const reorged: string[] = [];
  for (const c of atNonce) {
    if (c.status !== 'MINED_SUCCESS' && c.status !== 'MINED_REVERTED') continue;
    const r = receipts.get(c.id);
    const lostBlock = !r || (c.minedBlockHash !== null && lower(r.blockHash) !== lower(c.minedBlockHash));
    if (!lostBlock) continue;
    if (c.proofLevel !== 'latest') return { kind: 'uncertain', reason: 'PROOF_LEVEL_REORG', detail: c.txHash };
    reorged.push(c.id);
  }
  const deadLatest = atNonce.filter((c) => c.status === 'DEAD' && c.proofLevel === 'latest').map((c) => c.id);
  if (reorged.length > 0) return { kind: 'reorg', ids: [...reorged, ...deadLatest] };
  if (receipts.size === 0 && !consumedLatest && deadLatest.length > 0) {
    if (atNonce.some((c) => c.status === 'DEAD' && c.proofLevel === 'proof')) {
      return { kind: 'uncertain', reason: 'PROOF_LEVEL_REORG', detail: `nonce ${nonce} no longer consumed` };
    }
    return { kind: 'reorg', ids: deadLatest };
  }

  if (receipts.size > 1) return { kind: 'uncertain', reason: 'MULTIPLE_RECEIPTS', detail: [...receipts.keys()].join(',') };
  const consumedProof = nonceConsumed(views, nonce, 'proof');
  const proofLevel: ProofLevel = consumedProof === true ? 'proof' : 'latest';
  if (receipts.size === 1) {
    // A receipt with the nonce not yet consumed at `latest` on every node: the
    // reads straddled a block. Uncertain (next pass), never a guess.
    if (!consumedLatest) return { kind: 'uncertain', reason: 'RECEIPT_DISAGREE', detail: 'receipt present, nonce not consumed at latest on every node' };
    const [winnerId, receipt] = [...receipts.entries()][0]!;
    return { kind: 'winner', winnerId, losers: atNonce.filter((c) => c.id !== winnerId).map((c) => c.id), proofLevel, receipt };
  }
  if (consumedLatest) {
    // A1 review P2-1: "consumed by a foreign transaction" needs every node to answer "not known" for every
    // live candidate of the nonce. A node that knows one of ours while the nonce moved most likely served
    // the receipt from before the block that mined it: uncertain, the next pass sees the receipt.
    for (const c of atNonce) {
      if (!isLiveStatus(c.status)) continue;
      if (views.some((v) => knownOf(v, c.txHash) === true)) return { kind: 'uncertain', reason: 'KNOWN_WITHOUT_RECEIPT', detail: c.txHash };
    }
    return { kind: 'consumed-foreign', ids: atNonce.filter((c) => isLiveStatus(c.status) || (c.status === 'DEAD' && c.proofLevel === 'latest')).map((c) => c.id), proofLevel };
  }
  return { kind: 'alive' };
}

// ── R2-P2-3: nonce choice ────────────────────────────────────────────────────

/** `max(pending, highest nonce with a live candidate + 1)`; never reuses an occupied nonce. */
export function chooseNonce(pending: number, liveNonces: number[]): number {
  if (!Number.isInteger(pending) || pending < 0) throw new RangeError(`invalid pending nonce ${pending}`);
  let next = pending;
  for (const n of liveNonces) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid live nonce ${n}`);
    if (n + 1 > next) next = n + 1;
  }
  return next;
}

// ── §9.3-3 / R2-P2-4: the head first ────────────────────────────────────────

/**
 * Is `nonce` the head (`latest` count) on every node? A speed-up of N+1 with
 * N stuck unblocks nothing (spec §9.3-3, matrix row 18).
 */
export function headCheck(nonce: number, views: NodeView[]): { ok: true } | Refusal<'NOT_HEAD' | 'NODE_ERROR'> {
  if (views.length === 0 || views.some((v) => !v.ok || v.nonceLatest === undefined)) return { ok: false, reason: 'NODE_ERROR' };
  const off = views.find((v) => v.nonceLatest !== nonce);
  return off ? { ok: false, reason: 'NOT_HEAD', detail: `${off.node}: head is ${off.nonceLatest}` } : { ok: true };
}

/**
 * R2-P2-4 range plan `N..N+k` (speed-up only): contiguous, ascending, starting
 * at the head, at most `maxNoncesPerPlan` (P16). Executed head first, one
 * fingerprint per nonce, stopping at the first deviation (the caller's loop).
 */
export function rangePlanCheck(head: number, nonces: number[], caps: RecoveryCaps | null):
  { ok: true } | Refusal<CapsRefusal | 'EMPTY' | 'NOT_FROM_HEAD' | 'NOT_CONTIGUOUS' | 'TOO_MANY_NONCES'> {
  const problem = capsProblem(caps);
  if (problem) return problem;
  if (nonces.length === 0) return { ok: false, reason: 'EMPTY' };
  if (nonces[0] !== head) return { ok: false, reason: 'NOT_FROM_HEAD', detail: `plan starts at ${nonces[0]}, head is ${head}` };
  for (let i = 1; i < nonces.length; i++) if (nonces[i] !== nonces[i - 1]! + 1) return { ok: false, reason: 'NOT_CONTIGUOUS' };
  if (nonces.length > caps!.maxNoncesPerPlan) return { ok: false, reason: 'TOO_MANY_NONCES', detail: `${nonces.length} > ${caps!.maxNoncesPerPlan}` };
  return { ok: true };
}

// ── R2-P1-3: identical rebroadcast by the worker ─────────────────────────────

export interface RebroadcastInput {
  candidate: CandidateRow;
  /** Every ledger row at the candidate's nonce (any status). */
  candidatesAtNonce: CandidateRow[];
  /** Read in the lane, in the same pass. */
  views: NodeView[];
  hasRawTx: boolean;
  /** `simulateContract` of the same calldata from the evaluator passes. */
  simulationOk: boolean;
  /** Q7 gate open. */
  gateOpen: boolean;
}

export type RebroadcastRefusal =
  | 'GATE_CLOSED' | 'NOT_LIVE' | 'NO_NONCE' | 'NO_RAW_TX' | 'NODE_ERROR' | 'NOT_HEAD'
  | 'OTHER_LIVE_CANDIDATE' | 'KNOWN_OR_MINED' | 'SIMULATION_REVERTS';

/**
 * Conditions of R2-P1-3 (all of them): gate open; the candidate is live, has
 * a nonce and a raw tx; it is the HEAD (every node's `latest` count equals its
 * nonce); it is the ONLY live candidate of that nonce; every node answered
 * "not found" (not known, no receipt); the simulation passes.
 */
export function rebroadcastAllowed(input: RebroadcastInput): { ok: true } | Refusal<RebroadcastRefusal> {
  const { candidate: c, views } = input;
  if (!input.gateOpen) return { ok: false, reason: 'GATE_CLOSED' };
  if (!isLiveStatus(c.status)) return { ok: false, reason: 'NOT_LIVE' };
  if (c.nonce === null) return { ok: false, reason: 'NO_NONCE' };
  if (!input.hasRawTx) return { ok: false, reason: 'NO_RAW_TX' };
  if (views.length === 0 || views.some((v) => !v.ok)) return { ok: false, reason: 'NODE_ERROR' };
  for (const v of views) {
    if (v.nonceLatest === undefined) return { ok: false, reason: 'NODE_ERROR' };
    if (v.nonceLatest !== c.nonce) return { ok: false, reason: 'NOT_HEAD', detail: `${v.node}: latest ${v.nonceLatest}` };
  }
  const others = input.candidatesAtNonce.filter((o) => o.id !== c.id && o.nonce === c.nonce && isLiveStatus(o.status));
  if (others.length > 0) return { ok: false, reason: 'OTHER_LIVE_CANDIDATE' };
  for (const v of views) {
    const k = knownOf(v, c.txHash);
    const r = receiptOf(v, c.txHash);
    if (k === undefined || r === undefined) return { ok: false, reason: 'NODE_ERROR' };
    if (k || r !== null) return { ok: false, reason: 'KNOWN_OR_MINED', detail: v.node };
  }
  if (!input.simulationOk) return { ok: false, reason: 'SIMULATION_REVERTS' };
  return { ok: true };
}

// ── R2-P2-1: speed-up / cancel admitted by the machine ───────────────────────

export type ExpiryPosture = 'none' | 'act' | 'urgent' | 'hand-to-owner' | 'expired';

export interface HeadSituation {
  /** A ledger candidate of ours sits at the head nonce. */
  ourCandidate: boolean;
  /** The job of that candidate is terminal on-chain (getJob). */
  jobTerminalOnChain: boolean;
  /** simulateContract of the candidate's calldata; null = could not be run. */
  simulationPasses: boolean | null;
  /** `--acknowledge-foreign <hash>` given for this head. */
  foreignAcknowledged: boolean;
  /** The head job, or any delivered job behind it, has a "pay" decision recorded and not executed. */
  payDecisionAffected: boolean;
  /** expiryPosture of the earliest delivered affected job (plan §4.2). */
  posture: ExpiryPosture;
}

/**
 * R2-P2-1 table, enforced (no override), plus plan §4.2:
 *  - ours, job not terminal, simulation passes → speed-up only (cancel refused);
 *  - ours, job not terminal, simulation reverts → cancel only;
 *  - ours, job terminal on-chain → cancel only;
 *  - not ours (foreign / unknown head) → cancel only, after acknowledgement;
 *  - within `hand-to-owner` with a "pay" decision affected → cancel refused
 *    (it would push the decision to the end of the queue), except on an
 *    acknowledged foreign head;
 *  - `expired` → speed-up only (and it requires the AFTER EXPIRY phrase);
 *    cancel of our live non-terminal candidate refused.
 */
export function admissibleOperations(head: HeadSituation): { speedUp: Allowed; cancel: Allowed } {
  const afterExpiry = head.posture === 'expired';
  if (!head.ourCandidate) {
    return {
      speedUp: { ok: false, reason: 'NO_OWN_CANDIDATE', detail: 'no calldata of ours to re-sign at the head' },
      cancel: head.foreignAcknowledged ? { ok: true } : { ok: false, reason: 'FOREIGN_NOT_ACKNOWLEDGED' },
    };
  }
  if (head.jobTerminalOnChain) {
    return {
      speedUp: { ok: false, reason: 'JOB_TERMINAL', detail: 'the job is terminal on-chain: the transaction would revert' },
      cancel: { ok: true },
    };
  }
  if (head.simulationPasses === null) {
    return { speedUp: { ok: false, reason: 'SIMULATION_UNKNOWN' }, cancel: { ok: false, reason: 'SIMULATION_UNKNOWN' } };
  }
  if (head.simulationPasses) {
    return {
      speedUp: afterExpiry ? { ok: true, requiresAfterExpiryPhrase: true } : { ok: true },
      cancel: { ok: false, reason: 'SPEED_UP_POSSIBLE', detail: CANCEL_DOES_NOT_SETTLE },
    };
  }
  // ours, not terminal, simulation reverts for another reason
  if (afterExpiry) return { speedUp: { ok: false, reason: 'SIMULATION_REVERTS' }, cancel: { ok: false, reason: 'AFTER_EXPIRY_ONLY_SPEED_UP' } };
  if (head.posture === 'hand-to-owner' && head.payDecisionAffected) {
    return { speedUp: { ok: false, reason: 'SIMULATION_REVERTS' }, cancel: { ok: false, reason: 'PAY_DECISION_NEAR_EXPIRY' } };
  }
  return { speedUp: { ok: false, reason: 'SIMULATION_REVERTS' }, cancel: { ok: true } };
}

export const CANCEL_DOES_NOT_SETTLE =
  'CANCEL does not settle the job. It stays Submitted; its decision will be re-sent later with a new nonce behind every queued evaluator transaction. Use SPEED-UP to settle it now.';

// ── Plan P7: replacement fees ────────────────────────────────────────────────

export type CapsRefusal = 'NO_CAPS' | 'INVALID_CAPS';

/** null when every cap is present and sane; a reason otherwise. */
export function capsProblem(caps: RecoveryCaps | null | undefined): Refusal<CapsRefusal> | null {
  if (!caps) return { ok: false, reason: 'NO_CAPS' };
  const big: Array<[string, bigint]> = [
    ['maxFeePerGasWei', caps.maxFeePerGasWei], ['maxPriorityFeePerGasWei', caps.maxPriorityFeePerGasWei],
    ['relativeBaseMultiplier', caps.relativeBaseMultiplier], ['maxCostPerTxWei', caps.maxCostPerTxWei],
    ['maxCostPerIncidentWei', caps.maxCostPerIncidentWei], ['maxCost24hWei', caps.maxCost24hWei],
    ['maxGasLimit', caps.maxGasLimit],
  ];
  for (const [k, v] of big) if (typeof v !== 'bigint' || v <= 0n) return { ok: false, reason: 'INVALID_CAPS', detail: k };
  const nonNeg: Array<[string, bigint]> = [['reserveWei', caps.reserveWei], ['l1MarginWei', caps.l1MarginWei], ['minPriorityFeePerGasWei', caps.minPriorityFeePerGasWei]];
  for (const [k, v] of nonNeg) if (typeof v !== 'bigint' || v < 0n) return { ok: false, reason: 'INVALID_CAPS', detail: k };
  if (!Number.isInteger(caps.bumpBps) || caps.bumpBps < 1_000) return { ok: false, reason: 'INVALID_CAPS', detail: 'bumpBps (a node requires ≥ +10 %)' };
  if (!Array.isArray(caps.multipliers) || caps.multipliers.length === 0 || caps.multipliers.some((m) => typeof m !== 'bigint' || m <= 0n)) {
    return { ok: false, reason: 'INVALID_CAPS', detail: 'multipliers' };
  }
  if (!Number.isInteger(caps.maxReplacementsPerNonce) || caps.maxReplacementsPerNonce < 1) return { ok: false, reason: 'INVALID_CAPS', detail: 'maxReplacementsPerNonce' };
  if (!Number.isInteger(caps.minIntervalMs) || caps.minIntervalMs < 0) return { ok: false, reason: 'INVALID_CAPS', detail: 'minIntervalMs' };
  if (!Number.isInteger(caps.maxNoncesPerPlan) || caps.maxNoncesPerPlan < 1) return { ok: false, reason: 'INVALID_CAPS', detail: 'maxNoncesPerPlan' };
  return null;
}

/** Plan §1.1: effective cap = min(P2, P5 × baseFee + P3). */
export function effectiveFeeCap(caps: RecoveryCaps, baseFee: bigint): bigint {
  return minBig(caps.maxFeePerGasWei, caps.relativeBaseMultiplier * baseFee + caps.maxPriorityFeePerGasWei);
}

export type FeeRefusal = CapsRefusal | 'MAX_REPLACEMENTS' | 'PRIORITY_ABOVE_CAP' | 'FEE_ABOVE_CAP' | 'INVALID_INPUT';

export interface ReplacementFeeInput {
  /** Highest maxFeePerGas among the live candidates of the nonce (P6: bump over the most expensive). */
  prevMaxFee: bigint;
  /** Highest maxPriorityFeePerGas among the live candidates of the nonce. */
  prevPrio: bigint;
  /** Base fee of the latest block. */
  baseFee: bigint;
  /** p90 of the priority fee over the recent feeHistory window. */
  prioP90: bigint;
  /** 1-based replacement attempt at this nonce (replacements already recorded + 1). */
  attempt: number;
  caps: RecoveryCaps | null;
}

/**
 * Plan P7 (+P4, P5, P6, P2, P3):
 *   prio_i   = max(prevPrio × (1 + bump), p90, floor)
 *   maxFee_i = max(prevMaxFee × (1 + bump), baseFee × m_i + prio_i)
 * Refused — never clipped to the cap (clipping could land under the bump or
 * under the base fee) — when prio_i > P3 or maxFee_i > min(P2, P5 × base + P3).
 * No caps → `NO_CAPS`. `needed` / `cap` explain a refusal.
 */
export function proposeReplacementFees(input: ReplacementFeeInput):
  | { ok: true; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; effectiveCapWei: bigint }
  | (Refusal<FeeRefusal> & { needed?: bigint; cap?: bigint }) {
  const problem = capsProblem(input.caps);
  if (problem) return problem;
  const caps = input.caps!;
  const { prevMaxFee, prevPrio, baseFee, prioP90, attempt } = input;
  if ([prevMaxFee, prevPrio, baseFee, prioP90].some((v) => typeof v !== 'bigint' || v < 0n) || !Number.isInteger(attempt) || attempt < 1) {
    return { ok: false, reason: 'INVALID_INPUT' };
  }
  if (attempt > caps.maxReplacementsPerNonce || attempt > caps.multipliers.length) {
    return { ok: false, reason: 'MAX_REPLACEMENTS', detail: `attempt ${attempt}; at most ${Math.min(caps.maxReplacementsPerNonce, caps.multipliers.length)}` };
  }
  const m = caps.multipliers[attempt - 1]!;
  const prio = maxBig(bumped(prevPrio, caps.bumpBps), prioP90, caps.minPriorityFeePerGasWei);
  if (prio > caps.maxPriorityFeePerGasWei) {
    return { ok: false, reason: 'PRIORITY_ABOVE_CAP', needed: prio, cap: caps.maxPriorityFeePerGasWei };
  }
  const maxFee = maxBig(bumped(prevMaxFee, caps.bumpBps), baseFee * m + prio);
  const cap = effectiveFeeCap(caps, baseFee);
  if (maxFee > cap) return { ok: false, reason: 'FEE_ABOVE_CAP', needed: maxFee, cap };
  return { ok: true, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, effectiveCapWei: cap };
}

// ── Plan P8 / P9: replacement count and interval at a nonce ──────────────────

export type ReplacementRefusal = CapsRefusal | 'MAX_REPLACEMENTS' | 'INTERVAL';

/**
 * P8: replacements (SPEED_UP / CANCEL rows, any status) already recorded at
 * the nonce < maxReplacementsPerNonce. P9: the last send (or signature, for a
 * row that may have left without a recorded broadcast) at the nonce is at
 * least `minIntervalMs` old. Read from the ledger rows: survives restarts and
 * a second operator.
 */
export function replacementLimitCheck(input: {
  rowsAtNonce: Array<Pick<CandidateRow, 'kind' | 'createdAt' | 'broadcastAt' | 'lastBroadcastAt'>>;
  caps: RecoveryCaps | null;
  now: Date;
}): { ok: true; replacementsSoFar: number } | (Refusal<ReplacementRefusal> & { retryAt?: Date }) {
  const problem = capsProblem(input.caps);
  if (problem) return problem;
  const caps = input.caps!;
  const replacements = input.rowsAtNonce.filter((r) => r.kind === 'SPEED_UP' || r.kind === 'CANCEL').length;
  if (replacements >= caps.maxReplacementsPerNonce) {
    return { ok: false, reason: 'MAX_REPLACEMENTS', detail: `${replacements} of ${caps.maxReplacementsPerNonce}` };
  }
  let last = -Infinity;
  for (const r of input.rowsAtNonce) {
    for (const d of [r.createdAt, r.broadcastAt, r.lastBroadcastAt]) if (d && d.getTime() > last) last = d.getTime();
  }
  if (last !== -Infinity && input.now.getTime() - last < caps.minIntervalMs) {
    return { ok: false, reason: 'INTERVAL', retryAt: new Date(last + caps.minIntervalMs) };
  }
  return { ok: true, replacementsSoFar: replacements };
}

// ── Plan P11–P15: budget ─────────────────────────────────────────────────────

export type BudgetRefusal =
  | CapsRefusal | 'INVALID_INPUT' | 'GAS_LIMIT_ABOVE_CAP' | 'TX_COST_ABOVE_CAP'
  | 'INCIDENT_BUDGET_EXCEEDED' | 'DAILY_BUDGET_EXCEEDED' | 'RESERVE_BREACHED';

/** Highest reserved cost (gasLimit × maxFeePerGas) per nonce. */
export type CostByNonce = ReadonlyMap<number, bigint> | Record<number, bigint>;

export interface BudgetInput {
  caps: RecoveryCaps | null;
  /** The nonce the new candidate occupies. */
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  /** SCRIPT rows of the open incident: max cost per nonce. */
  incidentMaxByNonce: CostByNonce;
  /** SCRIPT rows of the last 24 h (all incidents): max cost per nonce. */
  dayMaxByNonce: CostByNonce;
  /** LIVE SCRIPT rows (not yet resolved): max cost per nonce — what the balance must still cover. */
  liveMaxByNonce: CostByNonce;
  /** Native balance of the evaluator now. */
  balanceWei: bigint;
}

function entries(m: CostByNonce): Array<[number, bigint]> {
  return m instanceof Map ? [...m.entries()] : Object.entries(m).map(([k, v]) => [Number(k), v as bigint]);
}

/** Σ over nonces of the max cost, with `cost` occupying `nonce` (only one candidate per nonce mines). */
function sumWith(m: CostByNonce, nonce: number, cost: bigint): { total: bigint; nonces: number } {
  let total = 0n;
  let seen = false;
  let nonces = 0;
  for (const [n, v] of entries(m)) {
    nonces++;
    if (n === nonce) { total += maxBig(v, cost); seen = true; } else total += v;
  }
  if (!seen) { total += cost; nonces++; }
  return { total, nonces };
}

/**
 * Max cost of a candidate = gasLimit × maxFeePerGas (+ the L1 margin in the
 * reserve rule). Checks, in order: P1 gas limit, P11 per tx, P12 per incident,
 * P13 rolling 24 h (both Σ over nonces of the most expensive SCRIPT
 * candidate), P14 + P15 reserve: balance − Σ live reserved − l1Margin ×
 * nonces ≥ reserve.
 */
export function budgetCheck(input: BudgetInput):
  | { ok: true; costWei: bigint; incidentTotalWei: bigint; dayTotalWei: bigint; reservedWei: bigint }
  | (Refusal<BudgetRefusal> & { needed?: bigint; cap?: bigint }) {
  const problem = capsProblem(input.caps);
  if (problem) return problem;
  const caps = input.caps!;
  const { gasLimit, maxFeePerGas, balanceWei, nonce } = input;
  if (typeof gasLimit !== 'bigint' || typeof maxFeePerGas !== 'bigint' || typeof balanceWei !== 'bigint'
      || gasLimit <= 0n || maxFeePerGas <= 0n || balanceWei < 0n || !Number.isInteger(nonce) || nonce < 0) {
    return { ok: false, reason: 'INVALID_INPUT' };
  }
  if (gasLimit > caps.maxGasLimit) return { ok: false, reason: 'GAS_LIMIT_ABOVE_CAP', needed: gasLimit, cap: caps.maxGasLimit };
  const cost = gasLimit * maxFeePerGas;
  if (cost > caps.maxCostPerTxWei) return { ok: false, reason: 'TX_COST_ABOVE_CAP', needed: cost, cap: caps.maxCostPerTxWei };
  const incident = sumWith(input.incidentMaxByNonce, nonce, cost).total;
  if (incident > caps.maxCostPerIncidentWei) return { ok: false, reason: 'INCIDENT_BUDGET_EXCEEDED', needed: incident, cap: caps.maxCostPerIncidentWei };
  const day = sumWith(input.dayMaxByNonce, nonce, cost).total;
  if (day > caps.maxCost24hWei) return { ok: false, reason: 'DAILY_BUDGET_EXCEEDED', needed: day, cap: caps.maxCost24hWei };
  const live = sumWith(input.liveMaxByNonce, nonce, cost);
  const reserved = live.total + caps.l1MarginWei * BigInt(live.nonces);
  if (balanceWei - reserved < caps.reserveWei) {
    return { ok: false, reason: 'RESERVE_BREACHED', needed: reserved + caps.reserveWei, cap: balanceWei, detail: 'fund the evaluator key' };
  }
  return { ok: true, costWei: cost, incidentTotalWei: incident, dayTotalWei: day, reservedWei: reserved };
}

// ── Plan P18–P20: expiry posture ─────────────────────────────────────────────

export interface ExpiryThresholds {
  /** P18 (H / T): act now. */
  actWithinMs: number;
  /** P19: URGENT. */
  urgentWithinMs: number;
  /** P20: hand to the owner. */
  handToOwnerWithinMs: number;
}

/**
 * Plan §4.2: distance between the LATEST BLOCK's timestamp (never the server
 * clock) and the earliest `expiresAt` of a delivered affected job.
 * `claimRefund` is valid once `block.timestamp >= expiredAt` → distance ≤ 0
 * is `expired`. No thresholds configured → throws (no default numbers).
 */
export function expiryPosture(earliestDeliveredExpiry: Date | null, blockTime: Date, cfg: ExpiryThresholds): ExpiryPosture {
  if (!cfg || ![cfg.actWithinMs, cfg.urgentWithinMs, cfg.handToOwnerWithinMs].every((v) => Number.isFinite(v) && v >= 0)
      || !(cfg.handToOwnerWithinMs <= cfg.urgentWithinMs && cfg.urgentWithinMs <= cfg.actWithinMs)) {
    throw new RangeError('expiryPosture: thresholds missing or not ordered (handToOwner ≤ urgent ≤ act)');
  }
  if (earliestDeliveredExpiry === null) return 'none';
  const d = earliestDeliveredExpiry.getTime() - blockTime.getTime();
  if (d <= 0) return 'expired';
  if (d <= cfg.handToOwnerWithinMs) return 'hand-to-owner';
  if (d <= cfg.urgentWithinMs) return 'urgent';
  if (d <= cfg.actWithinMs) return 'act';
  return 'none';
}

// ── §8.3: plan fingerprint ───────────────────────────────────────────────────

export interface PlanFingerprintInput {
  chainId: number;
  evaluator: string;
  nonce: number;
  /** Every candidate of the nonce, with its status. */
  candidates: Array<{ txHash: string; status: CandidateStatus }>;
  /** getJob(...).status of the affected job (null for a foreign head). */
  jobOnChainStatus: string | null;
  operation: 'speed-up' | 'cancel' | 'rebroadcast';
  /**
   * Accepted for compatibility and IGNORED (A1 final review F-P2-1): the fees are not part of the
   * fingerprint. The operator confirms exact fees; the script signs with exactly those and re-checks them
   * (replacement minimum, base fee, caps, budget) inside the lane — a base fee that moves every block must
   * not make every confirmed speed-up abort.
   */
  proposedFees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null;
}

/**
 * keccak256 of a canonical encoding of the plan (spec §8.3, refined by F-P2-1): chain, key, nonce, the
 * candidates of the nonce with their status, the job's on-chain status and the operation — what the
 * operator decided ABOUT. Order-independent in the candidates; the fees are not included.
 */
export function planFingerprint(input: PlanFingerprintInput): string {
  const cands = input.candidates
    .map((c) => `${lower(c.txHash)}:${c.status}`)
    .sort();
  const canonical = JSON.stringify([
    'a1-plan-v2',
    input.chainId,
    lower(input.evaluator),
    input.nonce,
    cands,
    input.jobOnChainStatus,
    input.operation,
  ]);
  return keccak256(toHex(canonical));
}

// ── Plan §6.3 / row 43: head classification ──────────────────────────────────

export type HeadClass = 'price-stuck' | 'lost-send' | 'known-not-mined' | 'foreign' | 'none';

export interface HeadInput {
  /** Live ledger candidates at the head nonce (`latest`). */
  candidates: CandidateRow[];
  views: NodeView[];
  /** pending > latest by consensus (a backlog exists), or the head nonce was consumed by none of ours. */
  backlog: boolean;
  /** The head nonce was consumed with no receipt of ours (resolveNonceDecision → consumed-foreign). */
  consumedForeign?: boolean;
  baseFee: bigint;
  /** p10 of the priority fee over the recent window (optional second price-stuck signal). */
  prioP10?: bigint;
  /** Blocks since the head was first seen stuck (persisted clock); null if unknown. */
  blocksStuck: number | null;
  /** Configured threshold (plan: 30 blocks). */
  stuckBlocksThreshold: number;
}

/**
 * Plan §6.3:
 *  - `foreign`: the head nonce consumed with no candidate of ours, or a
 *    backlog whose head has no ledger row;
 *  - `price-stuck`: max maxFeePerGas of the live head candidates < base fee,
 *    or their max priority < p10 for ≥ threshold blocks;
 *  - `lost-send`: no node knows any live head candidate (and none has a
 *    receipt), maxFee ≥ base;
 *  - `known-not-mined`: a node knows it, maxFee ≥ base, for ≥ threshold blocks;
 *  - `none`: no backlog, a normal pending head, or the nodes cannot tell.
 */
export function classifyHead(input: HeadInput): HeadClass {
  if (input.consumedForeign) return 'foreign';
  const live = input.candidates.filter((c) => isLiveStatus(c.status) && c.nonce !== null);
  if (live.length === 0) return input.backlog ? 'foreign' : 'none';
  const maxFee = maxBig(...live.map((c) => c.maxFeePerGas));
  const maxPrio = maxBig(...live.map((c) => c.maxPriorityFeePerGas));
  const longEnough = input.blocksStuck !== null && input.blocksStuck >= input.stuckBlocksThreshold;
  if (maxFee < input.baseFee) return 'price-stuck';
  if (input.prioP10 !== undefined && maxPrio < input.prioP10 && longEnough) return 'price-stuck';
  if (input.views.length === 0 || input.views.some((v) => !v.ok)) return 'none';
  let anyKnown = false;
  for (const v of input.views) {
    for (const c of live) {
      const k = knownOf(v, c.txHash);
      const r = receiptOf(v, c.txHash);
      if (k === undefined) return 'none';
      if (k || (r !== undefined && r !== null)) anyKnown = true;
    }
  }
  if (!anyKnown) return 'lost-send';
  return longEnough ? 'known-not-mined' : 'none';
}
