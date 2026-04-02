/**
 * AgentExecutor Integration Service
 *
 * Wraps any TransactionData into an AgentExecutor.executeSingle() or
 * executeBatch() call so that:
 *   1. Policy is validated on-chain
 *   2. Fee is collected atomically in the same transaction
 *   3. Excess ETH is refunded automatically
 *
 * Fee model:
 *   - ETH-value transactions: fee = value * feeBps / 10000 (on-chain, real-time)
 *   - ERC-20 only txs (value=0): not wrapped, so no on-chain fee collection in this path
 *
 * Contract addresses are read from env:
 *   EXECUTOR_ADDRESS_<chainId>=0x...
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { TransactionData } from './builder.service.js';

// AgentExecutor ABI — only what we need
const EXECUTOR_ABI = [
  {
    name: 'executeSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'action',
        type: 'tuple',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value',  type: 'uint256' },
          { name: 'data',   type: 'bytes'   },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: 'executeBatch',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'actions',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value',  type: 'uint256' },
          { name: 'data',   type: 'bytes'   },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: 'calculateFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'grossValue', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'feeBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const FEE_BPS = 30n; // mirrors on-chain value — used for pre-estimation only

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
      abi: EXECUTOR_ABI,
      functionName: 'executeSingle',
      args: [
        {
          target: tx.to,
          value:  tx.value,
          data:   tx.data,
        },
      ],
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
      abi: EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [
        txs.map(tx => ({
          target: tx.to,
          value:  tx.value,
          data:   tx.data,
        })),
      ],
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
