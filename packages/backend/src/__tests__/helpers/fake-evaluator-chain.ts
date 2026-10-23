/**
 * A1 (C3g) — a multi-node fake chain for the evaluator key, for DB suites.
 *
 * Extends `FakeEscrowChain` (escrow / USDC / registry / ReputationHook model, third-party calls)
 * and REPLACES its hash-only evaluator model with one that has what the A1 rules read:
 *
 *  - real EIP-1559 raw transactions signed locally (`PreparedEvaluatorTx`: hash, raw, nonce, gas,
 *    fees, to, data, value): an identical re-sign gives the same hash (RFC 6979), an identical
 *    rebroadcast is the same bytes. The signing key is a throwaway generated per chain; `from` is
 *    the CONFIGURED evaluator address (the fake never recovers the sender), so the suites keep the
 *    `SIM_EVALUATOR` of `escrow-sim-registry.ts`;
 *  - blocks: a head number, block hashes, timestamps; mined evaluator transactions carry their
 *    block number and hash; `reorg(depth)` removes the last blocks (escrow state restored, the
 *    transactions back in the pool or dropped) — the next inclusion gets a NEW block hash;
 *  - a txpool with the geth rules the spec relies on: "already known", "nonce too low",
 *    same-nonce replacement only with BOTH fees ≥ +10 % ("replacement transaction underpriced"),
 *    a future nonce queued behind a gap, and a transaction priced below the base fee STAYS pending
 *    while blocks are produced (geth; Anvil drops it — the gap R2-§11 declares);
 *  - per-node views (`nodes`): a node can error, lag `latest` by N blocks, not see the pool for
 *    `pending` (a load-balanced node behind), or not know a pending hash (propagation). Readers:
 *    `readNodeViews` (shaped to F2's `evaluator-rpc.ts` contract → `NodeView[]`), `isKnown`
 *    (shaped to `Erc8183Deps.isKnownTransaction`, strict rule of `tx-known.ts`);
 *  - the proof tag: `safeHead` (settable, can stall) for 'safe' / 'finalized', or a block number;
 *  - viem's `checkReplacement`: `waitForOwnReceipt(hash)` resolves with the receipt of ANOTHER
 *    transaction mined in that nonce (with `replacedReason`), as the real signer does (C3h D2);
 *  - base fee, priority fee suggestion and `feeHistory` for the fee proposal (plan P4–P7).
 *
 * The signer it hands out (`signer()`) follows the F2 contract of 2026-10-22
 * (`writeContract(params, { onBeforeBroadcast(tx), chooseNonce, lease, minLeaseMs })`,
 * `signExplicit`, `sendRaw`, `waitForOwnReceipt`). The local copies of the F1/F2 types below are
 * structural: once F1/F2 land, the orchestrator replaces them with imports (search "A1-TYPES").
 *
 * What it does not model: gas usage (a fixed figure per call), L1 data fees, balances spent on gas,
 * more than one sender in the evaluator pool (third parties go through `thirdPartyCall` /
 * `queueThirdParty`).
 */

import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseTransaction,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { FakeEscrowChain, SIM_CHAIN_ID, SIM_ESCROW } from './fake-escrow-chain.js';
import type { NewCandidate } from '../../services/escrow/evaluator-ledger.js';
import type { EvaluatorSendRawOutcome, PreparedEvaluatorTx } from '../../services/escrow/evaluator-signer.js';
import type { NodeView, ReceiptView, RecoveryCaps } from '../../services/escrow/evaluator-candidates.js';
import type { EvaluatorNodeRead, EvaluatorProofTag as ProofTag } from '../../services/escrow/evaluator-rpc.js';
import { LeaseLostError, type LaneLease, type LeaseLock } from '../../services/transaction/wallet-lane.js';

// ── A1 types (the integrated F1/F2 APIs, 2026-10-22) ──────────────────────────────────────────

export type { PreparedEvaluatorTx, EvaluatorSendRawOutcome } from "../../services/escrow/evaluator-signer.js";
export type { NodeView, ReceiptView, RecoveryCaps } from "../../services/escrow/evaluator-candidates.js";
export type { EvaluatorNodeRead, EvaluatorProofTag as ProofTag } from "../../services/escrow/evaluator-rpc.js";
/** F2 `LaneLease`. */
export type LaneLeaseLike = LaneLease;

/** C3h D2 receipt shape (`EvaluatorReceipt` of `evaluator-signer.ts`). */
export type FakeEvaluatorReceipt = TransactionReceipt & { replacedReason?: 'cancelled' | 'repriced' | 'replaced' };

// ── internals ───────────────────────────────────────────────────────────────

interface EvalTx {
  hash: Hex;
  raw: Hex;
  from: Address;
  nonce: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The function name for escrow calls, 'cancel' for a 0-value self-transfer, else 'unknown'. */
  functionName: string;
  /** The escrow job id the call targets (arg 0), when it is an escrow call. */
  onChainJobId: bigint | null;
}

interface Mined {
  tx: EvalTx | null;
  hash: Hex;
  status: 'success' | 'reverted';
  logs: Log[];
  blockNumber: bigint;
  blockHash: Hex;
}

interface Block {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  hashes: Hex[];
  /** Escrow state and the evaluator's mined count BEFORE this block (for `reorg`). */
  before: { state: unknown; minedNonce: number };
}

interface QueuedThirdParty {
  hash: Hex;
  from: Address;
  data: Hex;
  tip: bigint;
}

/** The private members of `FakeEscrowChain` this subclass reuses (compile-time privacy only). */
interface EscrowInternals {
  execute(from: Address, to: Address, data: Hex, hash: Hex): { status: 'success' | 'reverted'; logs: Log[] };
  snapshot(): unknown;
  restore(s: unknown): void;
  receipts: Map<Hex, TransactionReceipt>;
  known: Map<Hex, { hash: Hex; from: Address; nonce: number; to: Address; data: Hex }>;
}

export interface FakeNode {
  name: string;
  /** Every read of this node throws with this message (RPC outage / bad node). */
  error: string | null;
  /** `latest` of this node is this many blocks behind the head. */
  latestLag: number;
  /** This node does not see the pool: its `pending` equals its `latest` (load-balanced node behind). */
  blindPending: boolean;
  /** Pending hashes this node has not seen (propagation). Mined ones are known once its head reaches them. */
  unknown: Set<Hex>;
}

export interface SendInfo {
  nonce: number;
  functionName: string;
  onChainJobId: bigint | null;
  hash: Hex;
}

/** Fixed gas figure of the fake (the `complete` of the C5 fork receipts, 0.2 of plan §0.2) + the worker's headroom. */
export const FAKE_EVALUATOR_GAS_LIMIT = 340_302n + 400_000n;
export const CANCEL_GAS = 21_000n;
/** Base Sepolia floor (plan §0.1). */
export const BASE_FEE_FLOOR_WEI = 5_000_000n;


function lower(a: string): string {
  return a.toLowerCase();
}

export class FakeEvaluatorChain extends FakeEscrowChain {
  readonly evaluator: Address;
  readonly chainId: number;
  private readonly key: PrivateKeyAccount;

  /** Current base fee (wei). A transaction with `maxFeePerGas` below it stays pending (geth). */
  baseFee = BASE_FEE_FLOOR_WEI;
  /** `eth_maxPriorityFeePerGas` / the p90 tip of `feeHistory`. */
  priorityFee = 1_000_000n;
  /** Mine a block after each accepted evaluator transaction (the `autoMine` of the base model). */
  evaluatorAutoMine = true;
  /** Evaluator transactions that are never included while this returns true (a stuck send, besides price). */
  holdEvaluatorTx: ((tx: SendInfo) => boolean) | null = null;
  /** The send is refused by the node (nothing broadcast): message thrown. Sticky while set. */
  refuseSend: ((tx: SendInfo) => string | null) | null = null;
  /** The node takes the transaction but the answer is lost (throws after accepting). Sticky while set. */
  loseAnswer: ((tx: SendInfo) => boolean) | null = null;
  /** Nodes that do NOT see an accepted transaction (propagation); default: every node sees it. */
  propagation: ((tx: SendInfo) => string[]) | null = null;
  /** Simulation of an evaluator call reverts with this message (besides the escrow model's own reverts). */
  simulationReverts: ((call: { functionName: string; onChainJobId: bigint | null }) => string | null) | null = null;
  /** Index of the node the signer reads `pending` from (`prepareTransactionRequest`). */
  signerNode = 0;
  /** One-shot hook when a receipt wait starts (a replacement can be mined behind the waiter's back). */
  onReceiptWait: ((hash: Hex) => void | Promise<void>) | null = null;
  /** The next N receipt waits time out although the transaction mined. */
  receiptTimeouts = 0;
  /**
   * One-shot, `signer().writeContract` only: runs after `onBeforeBroadcast` and BEFORE the send.
   * Throw from it to model a crash between "recorded" and "sent" (spec §7.3 row 1).
   */
  beforeSend: ((tx: PreparedEvaluatorTx) => Promise<void>) | null = null;
  /**
   * One-shot, `signer().writeContract` only: runs after the node ACCEPTED the transaction and before
   * the answer reaches the caller. Throw from it to model a crash / lost answer (spec §7.3 row 2).
   */
  afterAccept: ((tx: PreparedEvaluatorTx) => Promise<void>) | null = null;

  /** Proof head for 'safe' / 'finalized' (null → head − proofDepth). Set and leave it to model a stalled `safe`. */
  safeHead: bigint | null = null;
  /** Depth used when `safeHead` is null. */
  proofDepth = 0;

  readonly nodes: FakeNode[];
  head = 100n;
  readonly blocks: Block[] = [];
  /** Every evaluator transaction this chain accepted or that was signed through `signer()`, by hash. */
  readonly signed = new Map<Hex, EvalTx>();
  /** Accepted, not mined, not replaced. */
  private readonly pool = new Map<Hex, EvalTx>();
  private readonly mined = new Map<Hex, Mined>();
  /** nonce → hash mined in it. */
  private readonly minedAt = new Map<number, Hex>();
  private minedNonce = 0;
  private blockSalt = 0;
  private readonly queuedThirdParty: QueuedThirdParty[] = [];
  private thirdPartySeq = 0n;
  /** Every accepted evaluator broadcast (incl. identical rebroadcasts answered "already known"), in order. */
  readonly evaluatorSends: Array<SendInfo & { outcome: 'accepted' | 'already-known' | 'refused'; error?: string }> = [];
  /** Every broadcast attempt made while a lease was asserted (lease token, hash). */
  readonly leaseChecks: Array<{ key: string; token: string; hash: Hex }> = [];

  constructor(opts: { evaluator: Address; chainId?: number; nodes?: string[]; key?: Hex }) {
    super();
    this.evaluator = getAddress(opts.evaluator);
    this.chainId = opts.chainId ?? SIM_CHAIN_ID;
    this.key = privateKeyToAccount(opts.key ?? generatePrivateKey());
    this.nodes = (opts.nodes ?? ['node-a', 'node-b']).map((name) => ({ name, error: null, latestLag: 0, blindPending: false, unknown: new Set<Hex>() }));
  }

  private get internals(): EscrowInternals {
    return this as unknown as EscrowInternals;
  }

  node(name: string): FakeNode {
    const n = this.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`FakeEvaluatorChain: no node ${name}`);
    return n;
  }

  // ── nonces ─────────────────────────────────────────────────────────────────

  /** Evaluator transactions mined in blocks ≤ `block`. */
  minedCountAt(block: bigint): number {
    let count = 0;
    for (const m of this.mined.values()) if (m.tx && m.blockNumber <= block) count++;
    return count;
  }

  proofHead(): bigint {
    return this.safeHead ?? this.head - BigInt(this.proofDepth);
  }

  private nodeHead(n: FakeNode): bigint {
    return this.head - BigInt(n.latestLag);
  }

  /**
   * The contiguous pending run from `from`. `unknown` does NOT hide a transaction from `pending`
   * (a node can count it and still answer "not found" for its hash — the false "not found" of
   * C3f item 3); `blindPending` is the knob for a node whose `pending` lags.
   */
  private pendingRun(_n: FakeNode | null, from: number): number {
    let next = from;
    for (;;) {
      const at = [...this.pool.values()].some((tx) => tx.nonce === next);
      if (!at) return next;
      next++;
    }
  }

  /** Nonce of the evaluator at `tag` as node `n` (default: the canonical chain) answers it. */
  nonceAt(tag: ProofTag | 'pending', n: FakeNode | null = null): number {
    if (n?.error) throw new Error(n.error);
    const head = n ? this.nodeHead(n) : this.head;
    if (tag === 'latest') return this.minedCountAt(head);
    if (tag === 'pending') {
      const latest = this.minedCountAt(head);
      return n?.blindPending ? latest : this.pendingRun(n, latest);
    }
    return this.minedCountAt(this.tagBlock(tag, head));
  }

  /** The block a tag points at for a node whose head is `head` (bigint K = latest − K, as F2's `EvaluatorProofTag`). */
  tagBlock(tag: ProofTag, head: bigint = this.head): bigint {
    if (tag === 'latest') return head;
    if (tag === 'safe' || tag === 'finalized') {
      const proof = this.proofHead();
      return proof < head ? proof : head;
    }
    return head - tag;
  }

  // ── signing ────────────────────────────────────────────────────────────────

  private describe(to: Address, data: Hex): { functionName: string; onChainJobId: bigint | null } {
    if (lower(to) === lower(this.evaluator) && (data === '0x' || data === undefined)) return { functionName: 'cancel', onChainJobId: null };
    if (lower(to) !== lower(SIM_ESCROW)) return { functionName: 'unknown', onChainJobId: null };
    try {
      const decoded = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data });
      const arg0 = (decoded.args as readonly unknown[] | undefined)?.[0];
      return { functionName: decoded.functionName, onChainJobId: typeof arg0 === 'bigint' ? arg0 : null };
    } catch {
      return { functionName: 'unknown', onChainJobId: null };
    }
  }

  /** Signs exactly these fields (deterministic: the same fields give the same raw bytes and hash). */
  async signFields(input: { to: Address; data: Hex; value?: bigint; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<PreparedEvaluatorTx> {
    const value = input.value ?? 0n;
    const raw = await this.key.signTransaction({
      type: 'eip1559',
      chainId: this.chainId,
      nonce: input.nonce,
      to: input.to,
      data: input.data,
      value,
      gas: input.gas,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    });
    const prepared: PreparedEvaluatorTx = {
      hash: keccak256(raw),
      raw,
      nonce: input.nonce,
      gas: input.gas,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      to: getAddress(input.to),
      data: input.data,
      value,
      chainId: this.chainId,
      from: this.evaluator,
    };
    this.signed.set(prepared.hash, this.toEvalTx(prepared));
    return prepared;
  }

  private toEvalTx(p: PreparedEvaluatorTx): EvalTx {
    return { hash: p.hash, raw: p.raw, from: p.from, nonce: p.nonce, to: p.to, data: p.data, value: p.value, gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas, ...this.describe(p.to, p.data) };
  }

  /** What `prepareTransactionRequest` would pick now: the base fee × 1.2 + the suggested tip (viem `estimateFeesPerGas`). */
  defaultFees(): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
    return { maxFeePerGas: (this.baseFee * 12n) / 10n + this.priorityFee, maxPriorityFeePerGas: this.priorityFee };
  }

  /** Runs an evaluator call against the latest state and rolls it back. */
  simulate(to: Address, data: Hex): { status: 'success' | 'reverted'; reason?: string } {
    const d = this.describe(to, data);
    const forced = this.simulationReverts?.({ functionName: d.functionName, onChainJobId: d.onChainJobId }) ?? null;
    if (forced) return { status: 'reverted', reason: forced };
    if (d.functionName === 'cancel') return { status: 'success' };
    const snap = this.internals.snapshot();
    const result = this.internals.execute(this.evaluator, to, data, '0x' as Hex);
    this.internals.restore(snap);
    return result.status === 'success' ? { status: 'success' } : { status: 'reverted', reason: 'execution reverted' };
  }

  // ── the node: accepting a raw transaction ────────────────────────────────

  /**
   * `eth_sendRawTransaction` with the geth txpool rules. Returns the hash; throws the node's error
   * text. `lease` (when given) is asserted first, as the signer does immediately before the send.
   */
  async acceptRaw(raw: Hex, lease?: { lease: LaneLeaseLike; minLeaseMs: number }): Promise<Hex> {
    const parsed = parseTransaction(raw);
    const hash = keccak256(raw);
    const tx: EvalTx = this.signed.get(hash) ?? {
      hash,
      raw,
      from: this.evaluator,
      nonce: Number(parsed.nonce ?? 0),
      to: getAddress(parsed.to!),
      data: (parsed.data ?? '0x') as Hex,
      value: parsed.value ?? 0n,
      gas: parsed.gas ?? 0n,
      maxFeePerGas: parsed.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
      ...this.describe(getAddress(parsed.to!), (parsed.data ?? '0x') as Hex),
    };
    this.signed.set(hash, tx);
    const info: SendInfo = { nonce: tx.nonce, functionName: tx.functionName, onChainJobId: tx.onChainJobId, hash };
    if (lease) {
      await lease.lease.assertHeld(lease.minLeaseMs);
      this.leaseChecks.push({ key: lease.lease.key, token: lease.lease.token, hash });
    }
    const refuse = (message: string): never => {
      this.evaluatorSends.push({ ...info, outcome: 'refused', error: message });
      this.rejectedBroadcasts.push(`${this.evaluator}:${tx.nonce}: ${message}`);
      throw new Error(message);
    };
    const forced = this.refuseSend?.(info) ?? null;
    if (forced) refuse(forced);
    if (this.pool.has(hash)) {
      this.evaluatorSends.push({ ...info, outcome: 'already-known' });
      throw new Error('already known');
    }
    if (tx.nonce < this.minedNonce) refuse(`nonce too low: next nonce ${this.minedNonce}, tx nonce ${tx.nonce}`);
    const sameNonce = [...this.pool.values()].filter((p) => p.nonce === tx.nonce);
    for (const prev of sameNonce) {
      const bumped = tx.maxFeePerGas * 10n >= prev.maxFeePerGas * 11n && tx.maxPriorityFeePerGas * 10n >= prev.maxPriorityFeePerGas * 11n;
      if (!bumped) refuse('replacement transaction underpriced');
    }
    for (const prev of sameNonce) this.pool.delete(prev.hash); // geth drops the replaced transaction
    this.pool.set(hash, tx);
    for (const name of this.propagation?.(info) ?? []) this.node(name).unknown.add(hash);
    this.evaluatorSends.push({ ...info, outcome: 'accepted' });
    this.broadcasts.push({ from: this.evaluator, nonce: tx.nonce, functionName: tx.functionName, hash });
    if (this.evaluatorAutoMine) this.mineBlock();
    if (this.loseAnswer?.(info)) throw new Error('socket hang up (the node took the evaluator transaction, the answer was lost)');
    return hash;
  }

  // ── blocks ─────────────────────────────────────────────────────────────────

  /**
   * A third party's escrow call waiting in the pool with tip `tip` (e.g. the requester's
   * `claimRefund` after expiredAt). In the next block it runs BEFORE the evaluator's transaction
   * when its tip is ≥ the evaluator's (Anvil orders by fee). Returns its hash.
   */
  queueThirdParty(from: Address, functionName: string, args: readonly unknown[], tip: bigint): Hex {
    const hash = `0x${(++this.thirdPartySeq).toString(16).padStart(64, 'c')}` as Hex;
    const data = encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName, args } as never);
    this.queuedThirdParty.push({ hash, from: getAddress(from), data, tip });
    return hash;
  }

  private runThirdParty(q: QueuedThirdParty, block: { number: bigint; hash: Hex }, hashes: Hex[]): void {
    const { status, logs } = this.internals.execute(q.from, SIM_ESCROW, q.data, q.hash);
    this.internals.known.set(q.hash, { hash: q.hash, from: q.from, nonce: 0, to: SIM_ESCROW, data: q.data });
    this.internals.receipts.set(q.hash, this.receiptOf(q.hash, status, logs, block, q.from, SIM_ESCROW));
    this.mined.set(q.hash, { tx: null, hash: q.hash, status, logs, blockNumber: block.number, blockHash: block.hash });
    hashes.push(q.hash);
  }

  private receiptOf(hash: Hex, status: 'success' | 'reverted', logs: Log[], block: { number: bigint; hash: Hex }, from: Address, to: Address): TransactionReceipt {
    return {
      status,
      logs: logs.map((l) => ({ ...l, blockNumber: block.number, blockHash: block.hash })),
      gasUsed: 21_000n,
      effectiveGasPrice: this.baseFee,
      transactionHash: hash,
      blockNumber: block.number,
      blockHash: block.hash,
      from,
      to,
    } as unknown as TransactionReceipt;
  }

  /**
   * Mines ONE block: queued third-party calls, then evaluator transactions in nonce order (per
   * nonce the best-paying live candidate), skipping (and stopping at) a nonce whose candidates are
   * all held, priced below the base fee, or excluded. Returns the block.
   */
  mineBlock(opts: { exclude?: Hex[] } = {}): Block {
    const number = this.head + 1n;
    const hash = keccak256(toHex(`fake-block-${number}-${++this.blockSalt}`));
    const block = { number, hash };
    const before = { state: this.internals.snapshot(), minedNonce: this.minedNonce };
    const hashes: Hex[] = [];
    const exclude = new Set(opts.exclude ?? []);
    let topTip = -1n;
    const includable = (tx: EvalTx) =>
      !exclude.has(tx.hash) && tx.maxFeePerGas >= this.baseFee && !(this.holdEvaluatorTx?.({ nonce: tx.nonce, functionName: tx.functionName, onChainJobId: tx.onChainJobId, hash: tx.hash }) ?? false);
    const headCandidates = [...this.pool.values()].filter((tx) => tx.nonce === this.minedNonce && includable(tx));
    for (const c of headCandidates) if (c.maxPriorityFeePerGas > topTip) topTip = c.maxPriorityFeePerGas;
    const third = this.queuedThirdParty.splice(0);
    for (const q of third.filter((q) => q.tip >= topTip)) this.runThirdParty(q, block, hashes);
    for (;;) {
      const candidates = [...this.pool.values()].filter((tx) => tx.nonce === this.minedNonce && includable(tx));
      if (candidates.length === 0) break;
      const tx = candidates.reduce((best, c) => (c.maxPriorityFeePerGas > best.maxPriorityFeePerGas ? c : best));
      let status: 'success' | 'reverted' = 'success';
      let logs: Log[] = [];
      if (tx.functionName !== 'cancel') ({ status, logs } = this.internals.execute(this.evaluator, tx.to, tx.data, tx.hash));
      this.internals.receipts.set(tx.hash, this.receiptOf(tx.hash, status, logs, block, this.evaluator, tx.to));
      this.internals.known.set(tx.hash, { hash: tx.hash, from: this.evaluator, nonce: tx.nonce, to: tx.to, data: tx.data });
      this.mined.set(tx.hash, { tx, hash: tx.hash, status, logs, blockNumber: number, blockHash: hash });
      this.minedAt.set(tx.nonce, tx.hash);
      for (const p of [...this.pool.values()]) if (p.nonce === tx.nonce) this.pool.delete(p.hash);
      this.minedNonce++;
      hashes.push(tx.hash);
      if (tx.functionName !== 'cancel' && tx.functionName !== 'unknown') {
        this.evaluatorCalls.push({ functionName: tx.functionName, jobId: tx.onChainJobId ?? 0n });
      }
    }
    for (const q of third.filter((q) => q.tip < topTip)) this.runThirdParty(q, block, hashes);
    const b: Block = { number, hash, timestamp: this.time, hashes, before };
    this.blocks.push(b);
    this.head = number;
    return b;
  }

  /** Mines `n` blocks (empty ones advance `latest` for the proof tag). */
  mineBlocks(n: number): void {
    for (let i = 0; i < n; i++) this.mineBlock();
  }

  /**
   * Removes the last `depth` blocks: escrow state and the evaluator's mined count restored; their
   * evaluator transactions go back to the pool (`reinclude`, default) or are dropped. Receipts
   * disappear; a re-inclusion gets a new block hash (`minedBlockHash` changes).
   */
  reorg(depth: number, opts: { reinclude?: boolean } = {}): void {
    const removed = this.blocks.splice(this.blocks.length - depth, depth);
    if (removed.length === 0) return;
    this.internals.restore(removed[0]!.before.state);
    this.minedNonce = removed[0]!.before.minedNonce;
    for (const b of removed) {
      for (const h of b.hashes) {
        const m = this.mined.get(h);
        this.mined.delete(h);
        this.internals.receipts.delete(h);
        if (m?.tx) {
          this.minedAt.delete(m.tx.nonce);
          if (opts.reinclude !== false) this.pool.set(h, m.tx);
        }
      }
    }
    this.head = removed[0]!.number - 1n;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** The evaluator transaction mined in `nonce`, if any (canonical chain). */
  minedInNonce(nonce: number): Hex | null {
    return this.minedAt.get(nonce) ?? null;
  }

  /** A pending evaluator transaction is evicted from every mempool (never mines; no node knows it). */
  dropEvaluatorTx(hash: Hex): void {
    this.pool.delete(hash);
  }

  isPending(hash: Hex): boolean {
    return this.pool.has(hash);
  }

  minedInfo(hash: Hex): { status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex } | null {
    const m = this.mined.get(hash);
    return m ? { status: m.status, blockNumber: m.blockNumber, blockHash: m.blockHash } : null;
  }

  /** The escrow job events of `onChainJobId` in `hash`'s logs. */
  logsForJob(hash: Hex, onChainJobId: bigint | null): ReceiptView['logsForJob'] {
    const m = this.mined.get(hash);
    const out = { completed: false, rejected: false, expired: false };
    if (!m || onChainJobId === null) return out;
    const topicJob = toHex(onChainJobId, { size: 32 });
    for (const log of m.logs) {
      if (lower(log.address) !== lower(SIM_ESCROW) || lower(log.topics[1] ?? '') !== lower(topicJob)) continue;
      const name = this.eventName(log);
      if (name === 'JobCompleted') out.completed = true;
      if (name === 'JobRejected') out.rejected = true;
      if (name === 'JobExpired') out.expired = true;
    }
    return out;
  }

  private eventName(log: Log): string | null {
    try {
      return decodeEventLog({ abi: AGENT_JOB_ESCROW_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).eventName;
    } catch {
      return null;
    }
  }

  private nodeKnows(n: FakeNode, hash: Hex): boolean {
    const m = this.mined.get(hash);
    if (m) return m.blockNumber <= this.nodeHead(n);
    return this.pool.has(hash) && !n.unknown.has(hash);
  }

  private nodeMined(n: FakeNode, hash: Hex): Mined | null {
    const m = this.mined.get(hash);
    return !m || m.blockNumber > this.nodeHead(n) ? null : m;
  }

  /**
   * F2 `readNodeViews(chainId, evaluator, hashes, { proofTag })` → `EvaluatorNodeRead[]`: one read per
   * node; a node in error → `{ ok: false, error }`; `known` / `receipts` keyed by the LOWERCASE hash,
   * a receipt with its raw logs (the service filters them by jobId). bigint tag = latest − K.
   */
  async readNodeViews(_chainId: number, evaluator: string, hashes: readonly Hex[], opts: { proofTag: ProofTag; urls?: readonly string[] }): Promise<EvaluatorNodeRead[]> {
    if (lower(evaluator) !== lower(this.evaluator)) throw new Error('FakeEvaluatorChain: views are only kept for the evaluator key');
    return this.nodes.map((n, index): EvaluatorNodeRead => {
      if (n.error) return { node: n.name, index, ok: false, error: n.error };
      const head = this.nodeHead(n);
      const proofBlock = this.tagBlock(opts.proofTag, head);
      const blockOf = (num: bigint) => this.blocks.find((b) => b.number === num);
      const safe = this.tagBlock('safe', head);
      return {
        node: n.name,
        index,
        ok: true,
        nonceLatest: this.nonceAt('latest', n),
        noncePending: this.nonceAt('pending', n),
        nonceAtTag: this.minedCountAt(proofBlock),
        proofBlockNumber: proofBlock,
        blockNumber: head,
        blockTimestamp: blockOf(head)?.timestamp ?? this.time,
        blockHash: blockOf(head)?.hash ?? keccak256(toHex(`fake-block-${head}`)),
        safeHead: { number: safe, timestamp: blockOf(safe)?.timestamp ?? this.time, hash: blockOf(safe)?.hash ?? keccak256(toHex(`fake-block-${safe}`)) },
        known: Object.fromEntries(hashes.map((h) => [lower(h), this.nodeKnows(n, h)])) as Record<Hex, boolean>,
        receipts: Object.fromEntries(
          hashes.map((h) => {
            const m = this.nodeMined(n, h);
            return [lower(h), m ? { txHash: h, status: m.status, blockNumber: m.blockNumber, blockHash: m.blockHash, logs: m.logs } : null];
          }),
        ) as NonNullable<EvaluatorNodeRead['receipts']>,
      };
    });
  }

  /**
   * F1 `NodeView[]` for the pure rules (what the service builds from the F2 reads): `nonceProof` =
   * `nonceAtTag`, `logsForJob` for the job each hash's OWN calldata targets (override with `jobOf`).
   */
  async nodeViews(hashes: readonly Hex[], opts: { proofTag: ProofTag; jobOf?: (hash: Hex) => bigint | null }): Promise<NodeView[]> {
    const jobOf = opts.jobOf ?? ((h: Hex) => this.signed.get(h)?.onChainJobId ?? null);
    const reads = await this.readNodeViews(this.chainId, this.evaluator, hashes, { proofTag: opts.proofTag });
    return reads.map((r): NodeView => {
      if (!r.ok) return { node: r.node, ok: false };
      return {
        node: r.node,
        ok: true,
        nonceLatest: r.nonceLatest!,
        nonceProof: r.nonceAtTag!,
        nonceAtTag: r.nonceAtTag!,
        known: { ...r.known },
        receipts: Object.fromEntries(
          hashes.map((h): [string, ReceiptView | null] => {
            const rc = r.receipts?.[lower(h) as Hex] ?? null;
            return [lower(h), rc ? { txHash: rc.txHash, status: rc.status, blockNumber: rc.blockNumber, blockHash: rc.blockHash, logsForJob: this.logsForJob(h, jobOf(h)) } : null];
          }),
        ),
      };
    });
  }

  /** `Erc8183Deps.isKnownTransaction` (strict, `tx-known.ts`): true if any node knows it; throws when none knows it and one errored. */
  async isKnown(_chainId: number, hash: Hex): Promise<boolean> {
    let errored = false;
    for (const n of this.nodes) {
      if (n.error) {
        errored = true;
        continue;
      }
      if (this.nodeKnows(n, hash)) return true;
    }
    if (errored) throw new Error('fetch failed (an RPC node could not be asked)');
    return false;
  }

  /** `eth_feeHistory`-like: the last `blocks` base fees (current one repeated) and the p90 tip. */
  feeHistory(blocks = 20): { baseFeePerGas: bigint[]; reward: bigint[][] } {
    return { baseFeePerGas: Array.from({ length: blocks + 1 }, () => this.baseFee), reward: Array.from({ length: blocks }, () => [this.priorityFee]) };
  }

  /** The receipt of `hash` as viem's wait returns it (follows a same-nonce replacement). */
  private receiptOrReplacement(hash: Hex): FakeEvaluatorReceipt | null {
    const own = this.internals.receipts.get(hash);
    if (own && this.mined.has(hash)) return own as FakeEvaluatorReceipt;
    const tx = this.signed.get(hash);
    if (!tx) return null;
    const winner = this.minedAt.get(tx.nonce);
    if (!winner || winner === hash) return null;
    const w = this.mined.get(winner)!;
    const receipt = this.internals.receipts.get(winner)!;
    const reason: FakeEvaluatorReceipt['replacedReason'] =
      w.tx?.functionName === 'cancel' ? 'cancelled' : w.tx && w.tx.data === tx.data ? 'repriced' : 'replaced';
    return { ...(receipt as TransactionReceipt), replacedReason: reason } as FakeEvaluatorReceipt;
  }

  // ── clients ────────────────────────────────────────────────────────────────

  /**
   * The evaluator signer, shaped to F2's `EvaluatorA1Signer`. `writeContract` order (F2 note):
   * simulate → `pending` from `nodes[signerNode]` → `chooseNonce(pending)` (lower / non-integer →
   * error, nothing signed) → sign → `lease.assertHeld` → `onBeforeBroadcast(hash, tx)` →
   * [`beforeSend` knob] → `lease.assertHeld` → send → [`afterAccept` knob].
   */
  signer() {
    const sendKind = (err: unknown): Exclude<EvaluatorSendRawOutcome['kind'], 'accepted'> => {
      const m = String((err as Error)?.message ?? err).toLowerCase();
      if (m.includes('already known')) return 'already-known';
      if (m.includes('nonce too low')) return 'nonce-too-low';
      if (m.includes('underpriced')) return 'underpriced';
      if (m.includes('fetch failed') || m.includes('socket') || m.includes('timeout')) return 'transport';
      return 'rejected';
    };
    return {
      address: this.evaluator,
      chainId: this.chainId,
      writeContract: async (
        params: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
        opts?: {
          onBeforeBroadcast?: (signedTxHash: Hex, tx: PreparedEvaluatorTx) => Promise<void>;
          chooseNonce?: (pending: number) => Promise<number>;
          lease?: LaneLease;
          minLeaseMs?: number;
        },
      ): Promise<Hex> => {
        if (opts?.lease && opts.minLeaseMs === undefined) throw new TypeError('lease without minLeaseMs');
        const data = encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args } as never);
        const sim = this.simulate(params.address, data);
        if (sim.status !== 'success') throw new Error(`simulation reverted: ${params.functionName} (${sim.reason ?? 'revert'})`);
        const pending = this.nonceAt('pending', this.nodes[this.signerNode] ?? null);
        const nonce = opts?.chooseNonce ? await opts.chooseNonce(pending) : pending;
        if (!Number.isInteger(nonce) || nonce < pending) throw new Error(`nonce choice ${nonce} below pending ${pending}`);
        const prepared = await this.signFields({ to: params.address, data, nonce, gas: FAKE_EVALUATOR_GAS_LIMIT, ...this.defaultFees() });
        if (opts?.lease) await opts.lease.assertHeld(opts.minLeaseMs!);
        await opts?.onBeforeBroadcast?.(prepared.hash, prepared);
        const crash = this.beforeSend;
        if (crash) {
          this.beforeSend = null;
          await crash(prepared);
        }
        const hash = await this.acceptRaw(prepared.raw, opts?.lease ? { lease: opts.lease, minLeaseMs: opts.minLeaseMs! } : undefined);
        const lost = this.afterAccept;
        if (lost) {
          this.afterAccept = null;
          await lost(prepared);
        }
        return hash;
      },
      signExplicit: (input: { to: Address; data: Hex; value: bigint; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) =>
        this.signFields(input),
      /** F2 `sendRaw`: lease asserted first (a lost lease throws `LeaseLostError`, nothing sent); node answers typed. */
      sendRaw: async (raw: Hex, opts: { lease: LaneLease; minLeaseMs: number }): Promise<EvaluatorSendRawOutcome> => {
        await opts.lease.assertHeld(opts.minLeaseMs);
        const hash = keccak256(raw);
        try {
          await this.acceptRaw(raw);
          this.leaseChecks.push({ key: opts.lease.key, token: opts.lease.token, hash });
          return { kind: 'accepted', hash };
        } catch (err) {
          return { kind: sendKind(err), hash, message: (err as Error).message };
        }
      },
      waitForTransactionReceipt: (hash: Hex) => this.waitReceipt(hash),
    };
  }

  private async waitReceipt(hash: Hex): Promise<FakeEvaluatorReceipt> {
    const hook = this.onReceiptWait;
    if (hook) {
      this.onReceiptWait = null;
      await hook(hash);
    }
    if (this.receiptTimeouts > 0) {
      this.receiptTimeouts--;
      throw new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
    }
    const receipt = this.receiptOrReplacement(hash);
    if (!receipt) throw new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
    return receipt;
  }

  /** viem-shaped read client: the evaluator's reads go to `nodes[0]`, the rest to the base model. */
  override get publicClient() {
    const base = super.publicClient;
    const primary = () => this.nodes[0] ?? null;
    const evalTx = (hash: Hex) => this.signed.get(hash);
    return {
      ...base,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const n = primary();
        if (n?.error) throw new Error(n.error);
        if (evalTx(hash)) {
          const m = this.mined.get(hash);
          if (!m || (n && m.blockNumber > this.nodeHead(n))) {
            const { TransactionReceiptNotFoundError } = await import('viem');
            throw new TransactionReceiptNotFoundError({ hash });
          }
          return this.internals.receipts.get(hash)!;
        }
        return base.getTransactionReceipt({ hash });
      },
      getTransaction: async ({ hash }: { hash: Hex }) => {
        const n = primary();
        if (n?.error) throw new Error(n.error);
        const tx = evalTx(hash);
        if (tx) {
          if (!n || !this.nodeKnows(n, hash)) {
            const { TransactionNotFoundError } = await import('viem');
            throw new TransactionNotFoundError({ hash });
          }
          const m = this.mined.get(hash);
          return { hash, nonce: tx.nonce, from: tx.from, to: tx.to, input: tx.data, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, blockNumber: m?.blockNumber ?? null, blockHash: m?.blockHash ?? null };
        }
        return base.getTransaction({ hash });
      },
      getTransactionCount: async ({ address, blockTag, blockNumber }: { address: Address; blockTag?: 'latest' | 'pending' | 'safe' | 'finalized'; blockNumber?: bigint }) => {
        if (lower(address) === lower(this.evaluator)) {
          const n = primary();
          if (n?.error) throw new Error(n.error);
          // eth_getTransactionCount at a block number (the §4.3 binary search).
          if (blockNumber !== undefined) return this.minedCountAt(blockNumber);
          return this.nonceAt(blockTag ?? 'latest', n);
        }
        return base.getTransactionCount({ address, ...(blockTag === 'pending' ? { blockTag } : {}) });
      },
      getBlockNumber: async () => this.head,
      getBlock: async (args?: { blockTag?: 'latest' | 'safe' | 'finalized'; blockNumber?: bigint; includeTransactions?: boolean }) => {
        const number = args?.blockNumber ?? (args?.blockTag === 'safe' || args?.blockTag === 'finalized' ? this.proofHead() : this.head);
        const b = this.blocks.find((x) => x.number === number);
        const transactions = (b?.hashes ?? []).map((h) => {
          const tx = this.signed.get(h);
          const known = this.internals.known.get(h);
          return args?.includeTransactions
            ? {
                hash: h,
                from: tx?.from ?? known?.from,
                nonce: tx?.nonce ?? known?.nonce,
                to: tx?.to ?? known?.to,
                input: tx?.data ?? known?.data,
                value: tx?.value ?? 0n,
                gas: tx?.gas ?? 0n,
                maxFeePerGas: tx?.maxFeePerGas ?? 0n,
                maxPriorityFeePerGas: tx?.maxPriorityFeePerGas ?? 0n,
                blockNumber: number,
              }
            : h;
        });
        return { number, hash: b?.hash ?? keccak256(toHex(`fake-block-${number}`)), timestamp: b?.timestamp ?? this.time, baseFeePerGas: this.baseFee, transactions };
      },
      getGasPrice: async () => this.baseFee + this.priorityFee,
      estimateMaxPriorityFeePerGas: async () => this.priorityFee,
      estimateFeesPerGas: async () => this.defaultFees(),
      getFeeHistory: async ({ blockCount }: { blockCount: number }) => this.feeHistory(blockCount),
      /** `eth_call` as the evaluator (the rebroadcast pass simulates the candidate's calldata with it). */
      call: async (p: { account: Address | { address: Address }; to: Address; data: Hex; value?: bigint }) => {
        const sim = this.simulate(getAddress(p.to), p.data);
        if (sim.status !== 'success') throw new Error(`execution reverted (${sim.reason ?? 'revert'})`);
        return { data: '0x' as Hex };
      },
      simulateContract: async (p: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => {
        const data = encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args ?? [] } as never);
        const sim = this.simulate(p.address, data);
        if (sim.status !== 'success') throw new Error(`simulation reverted: ${p.functionName} (${sim.reason ?? 'revert'})`);
        return { result: undefined, request: p };
      },
      getCode: async ({ address }: { address: Address }) => (lower(address) === lower(SIM_ESCROW) ? ('0x6080' as Hex) : undefined),
      getChainId: async () => this.chainId,
    };
  }
}

// ── lease ─────────────────────────────────────────────────────────────────────

/**
 * In-memory lease lock with an injectable clock (deterministic for plan row 44: a slow critical
 * section, PTTL below the margin). Shaped to F2's `LeaseLock` (`acquire` → `LaneLease`) and to the
 * existing `LaneLock` (`run`).
 */
export class FakeLeaseLock implements LeaseLock {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();
  private seq = 0;
  readonly acquired: string[] = [];

  constructor(
    private readonly opts: { ttlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async acquire(key: string, opts?: { waitMs?: number }): Promise<LaneLeaseLike> {
    const deadline = Date.now() + (opts?.waitMs ?? 5_000);
    for (;;) {
      const current = this.held.get(key);
      if (!current || current.expiresAt <= this.now()) break;
      if (Date.now() >= deadline) throw new Error(`lane ${key} is busy`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const token = `lease-${++this.seq}`;
    const acquiredAt = this.now();
    this.held.set(key, { token, expiresAt: this.now() + (this.opts.ttlMs ?? 120_000) });
    this.acquired.push(key);
    const self = this;
    return {
      key,
      token,
      acquiredAt,
      async assertHeld(minRemainingMs: number) {
        const h = self.held.get(key);
        if (!h || h.token !== token) throw new LeaseLostError(key, 'not-held', null, minRemainingMs);
        if (h.expiresAt - self.now() < minRemainingMs) throw new LeaseLostError(key, 'margin', h.expiresAt - self.now(), minRemainingMs);
      },
      async release() {
        if (self.held.get(key)?.token === token) self.held.delete(key);
      },
    };
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(key);
    try {
      return await fn();
    } finally {
      await lease.release();
    }
  }

  /** Another holder takes the lane (our TTL ran out and someone acquired it). */
  steal(key: string): void {
    this.held.set(key, { token: `thief-${++this.seq}`, expiresAt: this.now() + (this.opts.ttlMs ?? 120_000) });
  }
}

// ── builders for the suites ─────────────────────────────────────────────────

/** The `RecoveryCaps` fixture of plan §1 (C4/C5 column). TEST VALUES ONLY — never a code default. */
export function planCapsFixture(): RecoveryCaps {
  return {
    maxGasLimit: 1_000_000n, // P1
    maxFeePerGasWei: 1_000_000_000n, // P2
    maxPriorityFeePerGasWei: 100_000_000n, // P3
    relativeBaseMultiplier: 20n, // P5
    bumpBps: 1_250, // P6
    multipliers: [3n, 6n, 12n], // P4
    minPriorityFeePerGasWei: 1_000_000n, // P7 floor (0.001 gwei)
    maxReplacementsPerNonce: 3, // P8
    minIntervalMs: 60_000, // P9
    maxCostPerTxWei: 800_000_000_000_000n, // P11
    maxCostPerIncidentWei: 1_500_000_000_000_000n, // P12
    maxCost24hWei: 2_000_000_000_000_000n, // P13
    reserveWei: 1_000_000_000_000_000n, // P14
    l1MarginWei: 10_000_000_000_000n, // P15
    maxNoncesPerPlan: 3, // P16
  };
}

/**
 * F1 `NewCandidate` for a signed transaction, to seed a SCRIPT / RECONCILE candidate through
 * `insertCandidateWithJobStamp` before the recovery CLI exists. Evaluator checksummed, hashes
 * lowercase (F1 convention). SCRIPT requires `operator` and `incidentId`.
 */
export function candidateInput(
  tx: PreparedEvaluatorTx,
  meta: {
    jobId: string | null;
    kind: 'ORIGINAL' | 'SPEED_UP' | 'CANCEL';
    action: 'COMPLETE' | 'REJECT' | 'CLAIM_REFUND' | 'CANCEL_NOOP';
    origin: 'WORKER' | 'SCRIPT' | 'RECONCILE';
    decision?: string | null;
    replacesId?: string | null;
    operator?: string | null;
    note?: string | null;
    incidentId?: string | null;
  },
): NewCandidate {
  return {
    chainId: tx.chainId,
    evaluator: getAddress(tx.from),
    nonce: tx.nonce,
    jobId: meta.jobId,
    kind: meta.kind,
    action: meta.action,
    decision: meta.decision ?? null,
    replacesId: meta.replacesId ?? null,
    toAddress: getAddress(tx.to),
    valueWei: tx.value,
    calldata: tx.data,
    calldataHash: keccak256(tx.data),
    gasLimit: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    txHash: tx.hash.toLowerCase(),
    rawTx: tx.raw,
    origin: meta.origin,
    operator: meta.operator ?? null,
    note: meta.note ?? null,
    incidentId: meta.incidentId ?? null,
  };
}

/** Fees ≥ +12.5 % (plan P6) over `prev` on BOTH fields. */
export function bumped(prev: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, bps = 1_250n): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const up = (v: bigint) => (v * (10_000n + bps) + 9_999n) / 10_000n;
  return { maxFeePerGas: up(prev.maxFeePerGas), maxPriorityFeePerGas: up(prev.maxPriorityFeePerGas) };
}

/** Calldata of an escrow call, for asserting `calldataHash` (speed-up = same calldata). */
export function escrowCalldata(functionName: 'complete' | 'reject' | 'claimRefund', args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName, args } as never);
}
