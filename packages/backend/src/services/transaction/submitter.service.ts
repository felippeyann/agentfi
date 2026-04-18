/**
 * Transaction Submitter — signs via Turnkey and broadcasts via Alchemy.
 * Handles gas estimation, nonce management, and fallback RPCs.
 */

import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  getChain,
  getPrimaryRpcUrl,
  getSecondaryRpcUrl,
} from '../../config/chains.js';
import { getWalletService, type WalletService } from '../wallet/index.js';

export interface SubmissionResult {
  txHash: Hex;
  nonce: number;
}

export class SubmitterService {
  private readonly turnkey: WalletService;

  constructor() {
    this.turnkey = getWalletService();
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

    const [nonce, gasPrice, chainId] = await Promise.all([
      client.getTransactionCount({ address: params.from }),
      client.getGasPrice(),
      client.getChainId(),
    ]);

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
    const { serializeTransaction, parseTransaction } = await import('viem');
    const serialized = serializeTransaction(unsignedTx);

    // Sign via Turnkey MPC — private key never leaves Turnkey
    const signedTx = await this.turnkey.signTransaction({
      walletId: params.walletId,
      unsignedTx: serialized,
      chainId: params.chainId,
    });

    // Broadcast
    try {
      const txHash = await client.sendRawTransaction({
        serializedTransaction: signedTx as Hex,
      });
      return { txHash, nonce };
    } catch (err) {
      // Retry with fallback RPC
      const fallbackClient = this.getPublicClient(params.chainId, true);
      const txHash = await fallbackClient.sendRawTransaction({
        serializedTransaction: signedTx as Hex,
      });
      return { txHash, nonce };
    }
  }

  private getPublicClient(chainId: number, useFallback: boolean): PublicClient {
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
