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
  encodeFunctionData,
  http,
  keccak256,
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
  /**
   * Signs and broadcasts a contract call; resolves with the tx hash.
   * `onBeforeBroadcast` (C3e) runs after the simulation, the gas estimate and
   * the (local) signature, right before the send, with the signed
   * transaction's hash (G1 review P3-2): a call that reverts in simulation
   * never reaches it, and a throw from it aborts the send. A rejection AFTER
   * it does not say whether a node took the transaction (a lost answer, a
   * refusal at send): the caller asks the nodes about that hash.
   */
  writeContract(params: EvaluatorWriteParams, opts?: { onBeforeBroadcast?: (signedTxHash: Hex) => Promise<void> }): Promise<Hex>;
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

export function createEvaluatorSigner(chainId: number, privateKey: Hex): EvaluatorSigner {
  const chain = getChain(chainId);
  const transport = http(getPrimaryRpcUrl(chainId));
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  return {
    address: account.address,
    chainId,
    async writeContract(params, opts) {
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
      const request = await wallet.prepareTransactionRequest({
        account,
        chain,
        to: params.address,
        data: encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args as never }),
        gas: evaluatorGasLimit(estimate),
      });
      const serializedTransaction = await wallet.signTransaction(request as never);
      const signedTxHash = keccak256(serializedTransaction);
      await opts?.onBeforeBroadcast?.(signedTxHash);
      await wallet.sendRawTransaction({ serializedTransaction });
      return signedTxHash;
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
