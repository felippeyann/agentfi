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
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChain, getPrimaryRpcUrl } from '../../config/chains.js';

export interface EvaluatorWriteParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export interface EvaluatorSigner {
  readonly address: Address;
  readonly chainId: number;
  /** Signs and broadcasts a contract call; resolves with the tx hash. */
  writeContract(params: EvaluatorWriteParams): Promise<Hex>;
  /** Waits for the receipt of a tx this signer sent (status 'success' | 'reverted'). */
  waitForTransactionReceipt(hash: Hex): Promise<TransactionReceipt>;
}

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

export function createEvaluatorSigner(chainId: number, privateKey: Hex): EvaluatorSigner {
  const chain = getChain(chainId);
  const transport = http(getPrimaryRpcUrl(chainId));
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  return {
    address: account.address,
    chainId,
    async writeContract(params) {
      // `simulateContract` first: a revert surfaces as a decoded error (e.g.
      // InvalidStatus) before any gas is spent, and the same request object
      // is then signed and broadcast — with an explicit gas limit, because the
      // bare estimate starves the reputation hook (EVALUATOR_GAS_HEADROOM).
      const call = {
        account,
        address: params.address,
        abi: params.abi,
        functionName: params.functionName,
        args: params.args as never,
      };
      const { request } = await publicClient.simulateContract(call);
      const estimate = await publicClient.estimateContractGas(call);
      return wallet.writeContract({ ...request, gas: evaluatorGasLimit(estimate) });
    },
    waitForTransactionReceipt(hash) {
      return publicClient.waitForTransactionReceipt({ hash, timeout: EVALUATOR_RECEIPT_TIMEOUT_MS });
    },
  };
}

const signers = new Map<number, EvaluatorSigner>();

/** Memoized per chain; `privateKey` is only read on the first call for a chain. */
export function getEvaluatorSigner(chainId: number, privateKey: Hex): EvaluatorSigner {
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
