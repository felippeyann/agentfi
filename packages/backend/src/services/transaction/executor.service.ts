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
import type { TransactionData } from './builder.service.js';

const FEE_BPS = 30n; // mirrors on-chain value — used for pre-estimation only

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
  /**
   * Returns the deployed AgentExecutor address for a chain, or null if not deployed.
   */
  getExecutorAddress(chainId: number): Address | null {
    const addr = process.env[`EXECUTOR_ADDRESS_${chainId}`];
    if (!addr) return null;
    return addr as Address;
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
    const feeWei = (tx.value * FEE_BPS) / 10_000n;
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

    const totalValue = txs.reduce((sum, tx) => sum + tx.value, 0n);
    const feeWei     = (totalValue * FEE_BPS) / 10_000n;

    const wrappedData = encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [txs.map(toExecutorAction)],
    });

    return {
      to:    executorAddress,
      data:  wrappedData,
      value: totalValue + feeWei,
      feeWei,
      routedViaExecutor: true,
    };
  }

  /**
   * Calculates the fee for a given ETH value (mirrors on-chain logic).
   * Use for display / estimation before wrapping.
   */
  estimateFee(valueWei: bigint): bigint {
    return (valueWei * FEE_BPS) / 10_000n;
  }
}
