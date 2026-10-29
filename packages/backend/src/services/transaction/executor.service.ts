/**
 * AgentExecutor Integration Service
 *
 * Wraps any TransactionData into an AgentExecutor.executeSingle() or
 * executeBatch() call so that:
 *   1. Policy is validated on-chain (target, value AND token)
 *   2. Fee is collected atomically in the same transaction
 *   3. Excess ETH is refunded automatically
 *
 * Fee model:
 *   - ETH-value transactions: fee = value * feeBps / 10000 (on-chain, real-time)
 *   - ERC-20 only txs (value=0): not wrapped, so no on-chain fee collection in this path
 *
 * ABI: imported from the generated `abi/AgentExecutor.abi.ts` — regenerate with
 * `npm run abi:executor` after any change to AgentExecutor.sol. The `Action`
 * struct is `(target, value, token, data)`; `token` is the ERC-20 the action
 * moves (address(0) for pure ETH) and is forwarded to
 * AgentPolicyModule.validateTransaction for token-whitelist enforcement.
 * Contracts compiled from the pre-October-2026 struct `(target, value, data)`
 * expose different selectors and must be redeployed — see
 * docs/operations/contract-deployment.md ("ABI versioning").
 *
 * Contract addresses are read from env:
 *   EXECUTOR_ADDRESS_<chainId>=0x...
 */

import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { AGENT_EXECUTOR_ABI } from '../../abi/AgentExecutor.abi.js';
import { describeLegacyContract, resolveExecutorAddress } from '../../config/contracts.js';
import type { TransactionData } from './builder.service.js';

/**
 * The fee (bps) the backend adds to `msg.value` of executor-routed calls. It must
 * equal the deployed executor's immutable `feeBps()` — S9 verifies that
 * (`config/policy-stack-check.ts`) before any executor-routed transaction.
 */
export const FEE_BPS = 30n;

/**
 * F = floor(value × FEE_BPS / 10 000): the fee `AgentExecutor.calculateFee`
 * charges on the native value an executor call deploys. The one copy of the
 * formula (`estimateFee`, `wrapSingle`, `executorBatchValue`).
 */
export function executorFeeWei(valueWei: bigint): bigint {
  return (valueWei * FEE_BPS) / 10_000n;
}

/**
 * A6e(2): the fee an executor-routed call is charged, as the API reports it
 * (the 202 `fee`) and records it (`feeAmountWei` / `feeBps` in the job and
 * `queuePayload`, then the FeeEvent): F and the bps the executor applied.
 * The executor applies `FEE_BPS` on every tier; the tier schedule
 * (`FeeService.calculateFee`) is not applied on-chain.
 *
 * The one place that decides what an executor-routed route reports. Whether
 * a tier discount should ever apply to executor-routed calls (a rebate, or a
 * per-tier on-chain fee) is an open commercial decision (plan A6e(2)); none
 * is implemented, and this helper reports only what the contract takes.
 */
export interface ExecutorChargedFee {
  /** The rate the executor applied, in bps (its immutable `feeBps()`, = FEE_BPS, S9-verified). */
  feeBps: number;
  /** F in wei: what leaves the wallet on top of the value and reaches the fee wallet. */
  feeAmountWei: bigint;
}

export function executorChargedFee(feeWei: bigint): ExecutorChargedFee {
  return { feeBps: Number(FEE_BPS), feeAmountWei: feeWei };
}

/** What an `executeBatch` call must carry (A6d, S14). */
export interface ExecutorBatchValue {
  /** ΣV: the sum of the actions' native values. */
  actionsValueWei: bigint;
  /** F on ΣV — on the sum, never per action (200 + 200 wei: 1, not 0 + 0). What the fee wallet receives. */
  feeWei: bigint;
  /** msg.value = ΣV + F. Below it `executeBatch` reverts `InsufficientValueForFee(sent, required)`. */
  msgValueWei: bigint;
}

/**
 * The value of an `executeBatch` call: ΣV + F, the fee on the SUM of the
 * action values (the contract's own computation). Shared by every batch the
 * backend routes through the executor — `POST /v1/transactions/batch` (A6d),
 * `POST /admin/transactions/batch` (S14) and `wrapBatch` — and never the tier
 * schedule (`FeeService.calculateFee`: PRO 15 / ENTERPRISE 5 bps would
 * underpay and revert).
 */
export function executorBatchValue(actionValuesWei: readonly bigint[]): ExecutorBatchValue {
  const actionsValueWei = actionValuesWei.reduce((sum, v) => sum + v, 0n);
  const feeWei = executorFeeWei(actionsValueWei);
  return { actionsValueWei, feeWei, msgValueWei: actionsValueWei + feeWei };
}

/** Minimal logger surface (pino-compatible) so this module stays free of env.ts. */
export interface ExecutorLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const consoleLogger: ExecutorLogger = {
  warn: (obj, msg) => console.warn(msg, obj),
};

/** Mirrors `AgentExecutor.Action` (packages/contracts/src/AgentExecutor.sol). */
export interface ExecutorAction {
  target: Address;
  value: bigint;
  /** ERC-20 involved in the action; address(0) for pure ETH / none. */
  token: Address;
  data: Hex;
}

/**
 * Maps a TransactionData to the on-chain Action struct. Callers that never set
 * `token` (pure ETH, or legacy call sites) get address(0), which the policy
 * module treats as "no token to whitelist-check".
 */
export function toExecutorAction(tx: TransactionData): ExecutorAction {
  return {
    target: tx.to,
    value:  tx.value,
    token:  tx.token ?? zeroAddress,
    data:   tx.data,
  };
}

export interface WrappedTransaction extends TransactionData {
  /** Fee included in msg.value (wei). 0 for ERC-20 only transactions. */
  feeWei: bigint;
  /** Whether this tx was routed through the AgentExecutor. */
  routedViaExecutor: boolean;
}

export class ExecutorService {
  /** Chains whose legacy executor has already been reported — warn once per process. */
  private readonly warnedLegacyChains = new Set<number>();

  constructor(private readonly log: ExecutorLogger = consoleLogger) {}

  /**
   * Returns the deployed AgentExecutor address for a chain, or null if not
   * deployed. A configured address that is a known legacy deployment
   * (pre-October-2026 Action struct — every call through it reverts) is
   * treated as NOT deployed: transactions go direct, `routedViaExecutor`
   * is false, and the misconfiguration is logged once per chain. Production
   * and staging never get here with one (env.ts refuses to boot).
   */
  getExecutorAddress(chainId: number): Address | null {
    const { address, legacy } = resolveExecutorAddress(chainId);
    if (legacy && !this.warnedLegacyChains.has(chainId)) {
      this.warnedLegacyChains.add(chainId);
      this.log.warn(
        { chainId, executor: legacy.address },
        `${describeLegacyContract(legacy)} Routing transactions DIRECTLY (no executor, no on-chain fee) until then.`,
      );
    }
    return address;
  }

  /**
   * Wraps a single TransactionData to route through AgentExecutor.
   *
   * For ETH-value transactions (swaps with ETH input):
   *   - Encodes as executeSingle(action)
   *   - Adds fee to msg.value
   *
   * For zero-value transactions (ERC-20 approvals, token transfers):
   *   - Returns tx unchanged (executor can't collect fee on zero-value)
   *   - Sets routedViaExecutor=false
   */
  wrapSingle(
    chainId: number,
    tx: TransactionData,
  ): WrappedTransaction {
    const executorAddress = this.getExecutorAddress(chainId);

    // No executor deployed for this chain — send directly
    if (!executorAddress) {
      return { ...tx, feeWei: 0n, routedViaExecutor: false };
    }

    // Zero-value tx (ERC-20): can't extract ETH fee, send directly
    if (tx.value === 0n) {
      return { ...tx, feeWei: 0n, routedViaExecutor: false };
    }

    // ETH-value tx: wrap in executeSingle, add fee to msg.value
    const feeWei = executorFeeWei(tx.value);
    const totalValue = tx.value + feeWei;

    const wrappedData = encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeSingle',
      args: [toExecutorAction(tx)],
    });

    return {
      to:    executorAddress,
      data:  wrappedData,
      value: totalValue,
      feeWei,
      routedViaExecutor: true,
    };
  }

  /**
   * Wraps multiple TransactionData objects into a single executeBatch call.
   * Only used when all actions have a clear ETH value to fee against.
   */
  wrapBatch(
    chainId: number,
    txs: TransactionData[],
  ): WrappedTransaction {
    const executorAddress = this.getExecutorAddress(chainId);
    if (!executorAddress) {
      throw new Error(`No AgentExecutor deployed for chain ${chainId}`);
    }

    const { feeWei, msgValueWei } = executorBatchValue(txs.map((tx) => tx.value));

    const wrappedData = encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [txs.map(toExecutorAction)],
    });

    return {
      to:    executorAddress,
      data:  wrappedData,
      value: msgValueWei,
      feeWei,
      routedViaExecutor: true,
    };
  }

  /**
   * Calculates the fee for a given ETH value (mirrors on-chain logic).
   * Use for display / estimation before wrapping.
   */
  estimateFee(valueWei: bigint): bigint {
    return executorFeeWei(valueWei);
  }
}
