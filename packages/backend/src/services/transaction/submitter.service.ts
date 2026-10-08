/**
 * Transaction Submitter — signs via Turnkey and broadcasts via Alchemy.
 * Handles gas estimation, nonce management, and fallback RPCs.
 *
 * Nonces (C3c / N1): the whole read-nonce → sign → broadcast section runs
 * inside the wallet's broadcast lane (`wallet-lane.ts`), and the nonce is
 * `max(pending transaction count, last nonce this lane broadcast + 1)`. Two
 * transactions of one wallet processed at the same time therefore get
 * consecutive nonces instead of the same one (the old `latest` count let the
 * second broadcast collide and burn a BullMQ attempt, or all three).
 *
 * Lost broadcasts: when both RPCs throw on `sendRawTransaction`, the signed
 * transaction may still have reached a node. Its hash is computed locally and
 * looked up before giving up; when a node knows it, the submit succeeds with
 * that hash, so a retry does not sign a second transaction that would revert
 * once the first one mines (e.g. a second `fund`).
 */

import {
  createPublicClient,
  http,
  keccak256,
  serializeTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  getChain,
  getPrimaryRpcUrl,
  getSecondaryRpcUrl,
} from '../../config/chains.js';
import { getWalletService } from '../wallet/index.js';
import { NO_LANE, walletLaneKey, type LaneLock, type NonceStore } from './wallet-lane.js';

export interface SubmissionResult {
  txHash: Hex;
  nonce: number;
}

/** The slice of a viem public client the submitter uses. */
export type SubmitterClient = Pick<
  PublicClient,
  'estimateGas' | 'getTransactionCount' | 'getGasPrice' | 'getChainId' | 'sendRawTransaction' | 'getTransaction'
>;

export interface SubmitterDeps {
  wallet?: { signTransaction(params: { walletId: string; unsignedTx: string; chainId: number }): Promise<string> };
  /** Broadcast lane lock (Redis in production). Without it the submitter does not serialize. */
  lane?: LaneLock;
  /** Last broadcast nonce per lane. Optional. */
  nonces?: NonceStore;
  /** RPC client factory (`useFallback` selects the secondary RPC). */
  client?: (chainId: number, useFallback: boolean) => SubmitterClient;
}

export class SubmitterService {
  private readonly deps: SubmitterDeps;

  constructor(deps: SubmitterDeps = {}) {
    this.deps = deps;
  }

  private get wallet() {
    return this.deps.wallet ?? getWalletService();
  }

  /**
   * Signs a transaction via Turnkey MPC and broadcasts it.
   * Automatically retries with fallback RPC if primary fails.
   */
  async submit(params: {
    chainId: number;
    walletId: string;
    from: Address;
    to: Address;
    data: Hex;
    value: bigint;
    gasLimit?: bigint;
  }): Promise<SubmissionResult> {
    const lane = this.deps.lane ?? NO_LANE;
    const laneKey = walletLaneKey(params.chainId, params.from);
    return lane.run(laneKey, () => this.submitInLane(params, laneKey));
  }

  private async submitInLane(
    params: { chainId: number; walletId: string; from: Address; to: Address; data: Hex; value: bigint; gasLimit?: bigint },
    laneKey: string,
  ): Promise<SubmissionResult> {
    const client = this.getPublicClient(params.chainId, false);

    // Estimate gas if not provided
    const gasLimit =
      params.gasLimit ??
      (await client.estimateGas({
        account: params.from,
        to: params.to,
        data: params.data,
        value: params.value,
      }));

    const [pendingCount, lastUsed, gasPrice, chainId] = await Promise.all([
      client.getTransactionCount({ address: params.from, blockTag: 'pending' }),
      this.deps.nonces ? this.deps.nonces.lastUsed(laneKey).catch(() => null) : Promise.resolve(null),
      client.getGasPrice(),
      client.getChainId(),
    ]);
    const nonce = lastUsed === null ? pendingCount : Math.max(pendingCount, lastUsed + 1);

    // Construct the raw unsigned transaction
    const unsignedTx = {
      chainId,
      nonce,
      to: params.to,
      value: params.value,
      data: params.data,
      gas: gasLimit,
      gasPrice: (gasPrice * 12n) / 10n, // 20% tip to ensure fast inclusion
    };

    // Serialize to hex for Turnkey
    const serialized = serializeTransaction(unsignedTx);

    // Sign via Turnkey MPC — private key never leaves Turnkey
    const signedTx = (await this.wallet.signTransaction({
      walletId: params.walletId,
      unsignedTx: serialized,
      chainId: params.chainId,
    })) as Hex;

    const txHash = await this.broadcast(params.chainId, signedTx);
    await this.deps.nonces?.recordUsed(laneKey, nonce).catch(() => undefined);
    return { txHash, nonce };
  }

  /**
   * Broadcasts on the primary RPC, then the fallback. When both throw, the
   * transaction may still have been accepted (timeout after the node took
   * it, "already known"): look its locally computed hash up before failing.
   */
  private async broadcast(chainId: number, signedTx: Hex): Promise<Hex> {
    try {
      return await this.getPublicClient(chainId, false).sendRawTransaction({ serializedTransaction: signedTx });
    } catch {
      try {
        return await this.getPublicClient(chainId, true).sendRawTransaction({ serializedTransaction: signedTx });
      } catch (fallbackErr) {
        const hash = keccak256(signedTx);
        if (await this.isKnown(chainId, hash)) return hash;
        // Neither node has it: the error surfaces and BullMQ retries.
        throw fallbackErr;
      }
    }
  }

  private async isKnown(chainId: number, hash: Hex): Promise<boolean> {
    for (const useFallback of [false, true]) {
      try {
        const tx = await this.getPublicClient(chainId, useFallback).getTransaction({ hash });
        if (tx) return true;
      } catch {
        // not found on this node (or the node is down) — try the next one
      }
    }
    return false;
  }

  private getPublicClient(chainId: number, useFallback: boolean): SubmitterClient {
    if (this.deps.client) return this.deps.client(chainId, useFallback);
    const primary = getPrimaryRpcUrl(chainId);
    const secondary = getSecondaryRpcUrl(chainId);
    const url = useFallback ? secondary ?? primary : primary;

    if (!url) throw new Error(`No RPC URL for chain ${chainId}`);

    return createPublicClient({
      chain: getChain(chainId),
      transport: http(url),
    });
  }
}
