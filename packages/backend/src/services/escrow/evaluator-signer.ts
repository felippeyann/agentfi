/**
 * ERC-8183 evaluator signer (decision D5).
 *
 * The backend is the `evaluator` of every `AgentJobEscrow` job: it signs
 * `complete` / `reject` after the provider's `submit`, and `claimRefund`
 * after expiry. The evaluator is an operator key, not an Agent row, so it
 * cannot go through the transaction queue (Transaction.agentId is a required
 * FK and the pre-submit guard re-validates an agent policy). This module is
 * the small dedicated signer the settlement worker uses instead: a viem
 * wallet client on the chain's primary RPC, one instance per chain.
 *
 * Only `EvaluatorSigner` is used by the orchestrator so tests can inject a
 * fake that records calls and returns canned receipts.
 *
 * A1 (spec C3g-A1 §7–§8, R2-P1-3, R2-P2-3, R2-P3-2): `writeContract` hands the
 * whole signed transaction to `onBeforeBroadcast` (second argument), lets the
 * caller move the nonce up (`chooseNonce`) and asserts the evaluator lane
 * lease right before the send; `EvaluatorA1Signer` adds `signExplicit`
 * (explicit nonce and fees, no simulation — the recovery script's speed-up /
 * cancel) and `sendRaw` (identical rebroadcast with a typed node answer).
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sanitizeText } from '../../api/errors/sanitize.js';
import { getChain, getPrimaryRpcUrl } from '../../config/chains.js';
import type { LaneLease } from '../transaction/wallet-lane.js';

export interface EvaluatorWriteParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * A1: an evaluator transaction signed locally and not yet (or not provably)
 * broadcast. Every field is read back from the SIGNED bytes (`raw`), so it is
 * exactly what a node would execute; `hash = keccak256(raw)`. Always EIP-1559.
 */
export interface PreparedEvaluatorTx {
  hash: Hex;
  raw: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  from: Address;
}

/**
 * Options of `writeContract`.
 *
 * A1 change to `onBeforeBroadcast` (kept backward compatible on purpose): it
 * now receives the full `PreparedEvaluatorTx` as its SECOND argument; the
 * first stays the signed hash, so the C3e/P3-2 callers that only read the
 * hash keep working unchanged. The A1 caller (the orchestrator's
 * `sendEvaluatorTx`) uses `(_hash, tx) => …` and records `tx.raw`, nonce,
 * gas and fees with the candidate row.
 */
export interface EvaluatorWriteOptions {
  /**
   * Runs after the simulation, the estimate, the nonce choice and the local
   * signature; before the send. Awaited; a throw aborts the send (nothing is
   * broadcast).
   */
  onBeforeBroadcast?: (signedTxHash: Hex, tx: PreparedEvaluatorTx) => Promise<void>;
  /**
   * R2-P2-3: called with the nonce `prepareTransactionRequest` chose (the
   * node's `pending`); returns the nonce to sign with — the caller's
   * `max(pending, highest live candidate + 1)`. A different answer re-prepares
   * the request with that explicit nonce. An answer BELOW `pending` is refused
   * (`EvaluatorNonceChoiceError`): that would replace a transaction, which
   * this path never does.
   */
  chooseNonce?: (pending: number) => Promise<number>;
  /** The evaluator lane lease: `assertHeld(minLeaseMs)` runs before the hook and again IMMEDIATELY before the send. */
  lease?: LaneLease;
  /** Required with `lease`: the minimum TTL left on the lane to broadcast (plan P17). */
  minLeaseMs?: number;
}

/** The nonce a `chooseNonce` returned cannot be signed on this path. */
export class EvaluatorNonceChoiceError extends Error {
  constructor(
    readonly pending: number,
    readonly chosen: unknown,
  ) {
    super(`Evaluator nonce choice refused: chose ${String(chosen)} with the node's pending nonce at ${pending} (never below pending, never a non-integer)`);
    this.name = 'EvaluatorNonceChoiceError';
  }
}

/** Fields of an explicitly priced evaluator transaction (A1 script: speed-up / cancel). */
export interface EvaluatorExplicitTx {
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Answer of an identical rebroadcast (`sendRaw`, R2-P1-3). Expected node
 * answers are values, never throws:
 *  - `accepted`: the node took it;
 *  - `already-known`: the node already has these bytes (pending) — the send happened;
 *  - `nonce-too-low`: the nonce is consumed (by this or another tx) — prove it via the receipts (§4.2);
 *  - `underpriced`: the node refused it on price — stays pending as a normal backlog (speed-up is the operator's);
 *  - `transport`: no answer (timeout, connection) — nothing can be concluded; retry next tick;
 *  - `rejected`: any other node refusal (e.g. insufficient funds), with its sanitized message.
 * A lost lease throws `LeaseLostError` instead (nothing was sent).
 */
export type EvaluatorSendRawOutcome =
  | { kind: 'accepted'; hash: Hex }
  | { kind: 'already-known' | 'nonce-too-low' | 'underpriced' | 'transport' | 'rejected'; hash: Hex; message: string };

export interface EvaluatorSigner {
  readonly address: Address;
  readonly chainId: number;
  /**
   * Simulates, estimates (+ `EVALUATOR_GAS_HEADROOM`), prepares (nonce from
   * the node's `pending`, then `chooseNonce`), signs locally, calls
   * `onBeforeBroadcast(hash, tx)`, asserts the lease and broadcasts; resolves
   * with the tx hash. A call that reverts in simulation never reaches the
   * hook, and a throw from the hook (or a lost lease) aborts the send. A
   * rejection AFTER the hook does not say whether a node took the transaction
   * (a lost answer, a refusal at send) — except `LeaseLostError`, which is
   * thrown before the send: the caller asks the nodes about that hash.
   */
  writeContract(params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions): Promise<Hex>;
  /**
   * Waits for the receipt of a tx this signer sent (status 'success' | 'reverted').
   *
   * C3h D2: viem's wait follows a same-nonce REPLACEMENT (`checkReplacement`,
   * on by default in viem 2.57.3): when another transaction of the key is
   * mined in that nonce, it resolves with THAT transaction's receipt
   * (`replacedReason` set here: `cancelled` / `repriced` / `replaced`). A
   * caller must compare `receipt.transactionHash` with the hash it waited for
   * before reading anything from it (`awaitOwnReceipt` in the orchestrator).
   */
  waitForTransactionReceipt(hash: Hex): Promise<EvaluatorReceipt>;
}

/** The A1 signer: the settlement signer plus explicit signing and identical rebroadcast (the recovery script, the rebroadcast pass). */
export interface EvaluatorA1Signer extends EvaluatorSigner {
  /**
   * Signs exactly the given fields (EIP-1559, this signer's chain) without
   * any RPC call and without simulation: the caller simulated, chose the
   * nonce and priced it. Nothing is sent.
   */
  signExplicit(input: EvaluatorExplicitTx): Promise<PreparedEvaluatorTx>;
  /**
   * Broadcasts `raw` byte for byte (identical rebroadcast, R2-P1-3) after
   * `lease.assertHeld(minLeaseMs)`; classifies the node's answer.
   */
  sendRaw(raw: Hex, opts: { lease: LaneLease; minLeaseMs: number }): Promise<EvaluatorSendRawOutcome>;
}

/** C3h D2: a receipt from `waitForTransactionReceipt`; `replacedReason` is set when it is a replacement's receipt. */
export type EvaluatorReceipt = TransactionReceipt & { replacedReason?: 'cancelled' | 'repriced' | 'replaced' };

/** How long the settlement worker waits for a settlement tx to be mined before letting BullMQ retry. */
export const EVALUATOR_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Gas added on top of `eth_estimateGas` for every evaluator transaction.
 *
 * `complete` / `reject` run the job's `ReputationHook.afterAction`, which
 * calls the ERC-8004 Reputation Registry inside a try/catch so a registry
 * failure can never block settlement. That makes the gas estimate wrong in a
 * specific way: `eth_estimateGas` returns the LOWEST limit at which the tx
 * succeeds, and at that limit `giveFeedback` runs out of gas, the hook
 * catches it and emits `FeedbackFailed(jobId, "")` — settlement goes through,
 * the feedback is silently lost. Found by the C5a fork rehearsal against the
 * real Base Sepolia registry (v2.0.0): estimate 246 770 → FeedbackFailed;
 * the full path uses 340 231 (`giveFeedback` alone 179 416). The headroom
 * covers the feedback path with a wide margin (longer feedback URIs, registry
 * upgrades); unused gas is not charged.
 *
 * R3c fixed the root cause in the contract: the hook now forwards a fixed gas
 * cap to every registry call and reverts the whole settlement with
 * `InsufficientGasForFeedback` when the caller's gas cannot cover those caps,
 * so the estimate already includes the feedback path and can no longer drop
 * it silently. The headroom stays as cheap insurance: the estimate is now the
 * exact minimum, and any drift between estimation and inclusion (e.g. storage
 * that is warm in the simulation and cold on-chain) would otherwise cost a
 * reverted settlement and a BullMQ retry.
 */
export const EVALUATOR_GAS_HEADROOM = 400_000n;

/** Gas limit of an evaluator transaction: the node's estimate plus `EVALUATOR_GAS_HEADROOM`. */
export function evaluatorGasLimit(estimate: bigint): bigint {
  return estimate + EVALUATOR_GAS_HEADROOM;
}

/** Reads a signed evaluator transaction back from its bytes (A1). Refuses anything but an EIP-1559 tx of `chainId`. */
export function describeSignedEvaluatorTx(raw: Hex, from: Address, chainId: number): PreparedEvaluatorTx {
  const tx = parseTransaction(raw);
  if (tx.type !== 'eip1559') throw new Error(`Evaluator transaction is not EIP-1559 (type ${String(tx.type)})`);
  if (tx.chainId !== chainId) throw new Error(`Evaluator transaction signed for chain ${String(tx.chainId)}, expected ${chainId}`);
  if (tx.nonce === undefined || tx.gas === undefined || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined || !tx.to) {
    throw new Error('Evaluator transaction is missing nonce, gas, fees or recipient');
  }
  return {
    hash: keccak256(raw),
    raw,
    nonce: tx.nonce,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    to: getAddress(tx.to),
    data: tx.data ?? '0x',
    value: tx.value ?? 0n,
    chainId,
    from,
  };
}

const ALREADY_KNOWN = /already known|already imported|known transaction|already exists|already in (?:the )?(?:mempool|pool|txpool)|ALREADY_EXISTS/i;
const NONCE_TOO_LOW = /nonce too low|nonce has already been used|nonce is too low|NONCE_EXPIRED|OldNonce/i;
const UNDERPRICED =
  /underpriced|fee too low|less than (?:the )?block base fee|fee cap (?:less|lower) than|feecap too low|gas price too low|max fee per gas too low|priority fee too low|insufficient fee/i;
const TRANSPORT_ERROR_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'WebSocketRequestError', 'SocketClosedError', 'AbortError']);
const TRANSPORT_TEXT = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|took too long to respond/i;

/**
 * Classifies a broadcast failure (A1 `sendRaw`). Order matters: the node's
 * explicit answers first (they also arrive through an HTTP error body), then
 * "no answer" (transport), else a plain refusal.
 */
export function classifySendRawError(err: unknown): Exclude<EvaluatorSendRawOutcome['kind'], 'accepted'> {
  const texts: string[] = [];
  let transport = false;
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    if (typeof e.name === 'string' && TRANSPORT_ERROR_NAMES.has(e.name)) transport = true;
    for (const t of [e.details, e.shortMessage, e.message]) if (typeof t === 'string') texts.push(t);
    current = e.cause;
  }
  if (typeof err === 'string') texts.push(err);
  const text = texts.join('\n');
  if (ALREADY_KNOWN.test(text)) return 'already-known';
  if (NONCE_TOO_LOW.test(text)) return 'nonce-too-low';
  if (UNDERPRICED.test(text)) return 'underpriced';
  if (transport || TRANSPORT_TEXT.test(text)) return 'transport';
  return 'rejected';
}

function errorText(err: unknown): string {
  const e = err as { shortMessage?: unknown; details?: unknown; message?: unknown };
  const parts = [e?.shortMessage, e?.details].filter((t): t is string => typeof t === 'string' && t.length > 0);
  const text = parts.length > 0 ? parts.join(': ') : typeof e?.message === 'string' ? e.message : String(err);
  return sanitizeText(text.split('\n')[0] ?? '') || 'unknown error';
}

function assertLeaseOptions(lease: LaneLease | undefined, minLeaseMs: number | undefined): void {
  if (lease && !(typeof minLeaseMs === 'number' && Number.isFinite(minLeaseMs) && minLeaseMs >= 0)) {
    throw new TypeError('Evaluator signer: a lease needs a non-negative minLeaseMs');
  }
}

function assertExplicitTx(input: EvaluatorExplicitTx): void {
  const bad = (what: string) => {
    throw new TypeError(`signExplicit: ${what}`);
  };
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) bad('nonce must be a non-negative integer');
  if (input.gas <= 0n) bad('gas must be positive');
  if (input.maxFeePerGas <= 0n) bad('maxFeePerGas must be positive');
  if (input.maxPriorityFeePerGas < 0n) bad('maxPriorityFeePerGas must not be negative');
  if (input.maxPriorityFeePerGas > input.maxFeePerGas) bad('maxPriorityFeePerGas must not exceed maxFeePerGas');
  if (input.value < 0n) bad('value must not be negative');
}

export function createEvaluatorSigner(chainId: number, privateKey: Hex): EvaluatorA1Signer {
  const chain = getChain(chainId);
  const transport = http(getPrimaryRpcUrl(chainId));
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  return {
    address: account.address,
    chainId,
    async writeContract(params, opts = {}) {
      assertLeaseOptions(opts.lease, opts.minLeaseMs);
      // `simulateContract` first: a revert surfaces as a decoded error (e.g.
      // InvalidStatus) before any gas is spent, and the same call is then
      // signed and broadcast — with an explicit gas limit, because the bare
      // estimate starves the reputation hook (EVALUATOR_GAS_HEADROOM).
      const call = {
        account,
        address: params.address,
        abi: params.abi,
        functionName: params.functionName,
        args: params.args as never,
      };
      await publicClient.simulateContract(call);
      const estimate = await publicClient.estimateContractGas(call);
      // G1 review P3-2: the evaluator is a local private-key account, so the
      // transaction is signed here and its hash is known BEFORE anything is
      // sent: the hook records it, then the raw transaction is broadcast. A
      // send that throws after that is resolved by the caller from the hash
      // (no node knows it → never sent; known → in flight).
      const base = {
        account,
        chain,
        type: 'eip1559' as const,
        to: params.address,
        data: encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args as never }),
        gas: evaluatorGasLimit(estimate),
      };
      let request = await wallet.prepareTransactionRequest(base);
      if (opts.chooseNonce) {
        // R2-P2-3: never sign on top of a live candidate's nonce (a load-balanced
        // RPC's `pending` may lag); re-prepare with the explicit nonce.
        const pending = Number(request.nonce);
        const chosen = await opts.chooseNonce(pending);
        if (!Number.isSafeInteger(chosen) || chosen < pending) throw new EvaluatorNonceChoiceError(pending, chosen);
        if (chosen !== pending) request = await wallet.prepareTransactionRequest({ ...base, nonce: chosen });
        if (Number(request.nonce) !== chosen) throw new EvaluatorNonceChoiceError(pending, request.nonce);
      }
      const serializedTransaction = (await wallet.signTransaction(request as never)) as Hex;
      const tx = describeSignedEvaluatorTx(serializedTransaction, account.address, chainId);
      // A lease already lost records nothing; the hook may take time (a DB transaction): checked again after it.
      if (opts.lease) await opts.lease.assertHeld(opts.minLeaseMs!);
      await opts.onBeforeBroadcast?.(tx.hash, tx);
      if (opts.lease) await opts.lease.assertHeld(opts.minLeaseMs!);
      await wallet.sendRawTransaction({ serializedTransaction });
      return tx.hash;
    },
    async signExplicit(input) {
      assertExplicitTx(input);
      const raw = await account.signTransaction({
        chainId,
        type: 'eip1559',
        to: input.to,
        data: input.data,
        value: input.value,
        nonce: input.nonce,
        gas: input.gas,
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      });
      return describeSignedEvaluatorTx(raw, account.address, chainId);
    },
    async sendRaw(raw, opts) {
      if (!opts?.lease) throw new TypeError('sendRaw: a lane lease is required');
      assertLeaseOptions(opts.lease, opts.minLeaseMs);
      const hash = keccak256(raw);
      await opts.lease.assertHeld(opts.minLeaseMs);
      try {
        await wallet.sendRawTransaction({ serializedTransaction: raw });
        return { kind: 'accepted', hash };
      } catch (err) {
        return { kind: classifySendRawError(err), hash, message: errorText(err) };
      }
    },
    async waitForTransactionReceipt(hash) {
      let replacedReason: EvaluatorReceipt['replacedReason'];
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: EVALUATOR_RECEIPT_TIMEOUT_MS,
        // C3h D2: recorded, never trusted — the caller compares the receipt's hash with `hash`.
        onReplaced: (replacement) => {
          replacedReason = replacement.reason;
        },
      });
      return replacedReason ? { ...receipt, replacedReason } : receipt;
    },
  };
}

const signers = new Map<number, EvaluatorA1Signer>();

/** Memoized per chain; `privateKey` is only read on the first call for a chain. */
export function getEvaluatorSigner(chainId: number, privateKey: Hex): EvaluatorA1Signer {
  let signer = signers.get(chainId);
  if (!signer) {
    signer = createEvaluatorSigner(chainId, privateKey);
    signers.set(chainId, signer);
  }
  return signer;
}

/** Testing hook — drops the memoized signers. */
export function __resetEvaluatorSignersForTests(): void {
  signers.clear();
}
