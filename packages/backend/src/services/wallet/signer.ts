/**
 * Client signer adapter — turns a wallet provider + walletId into the
 * minimal `{ address, signTypedData }` surface that x402's EVM "exact"
 * scheme needs to sign EIP-3009 / Permit2 authorizations.
 *
 * Both wallet providers already expose `signTypedData`; this adapter only
 * binds a walletId so the x402 client can stay unaware of AgentFi's wallet
 * abstraction. The private key never leaves the provider (in-memory for
 * `local`, MPC shards for Turnkey).
 */

import type { ClientEvmSigner } from '@x402/evm';
import { isAddress, type Address, type Hex } from 'viem';
import type { WalletService } from './index.js';

/** Structural EIP-712 payload, as x402 hands it to a signer. */
export type Eip712TypedData = Parameters<ClientEvmSigner['signTypedData']>[0];

/** What the x402 client needs from a wallet: an address and EIP-712 signing. */
export type ClientSigner = Pick<ClientEvmSigner, 'address' | 'signTypedData'>;

export interface TypedDataSigner {
  getWalletAddress(walletId: string): Promise<Address>;
  signTypedData(params: {
    walletId: string;
    typedData: Eip712TypedData;
  }): Promise<{ signature: Hex; address: Address }>;
}

/**
 * Binds `walletId` to the wallet provider and returns an x402-compatible
 * signer. Resolving the address is async because Turnkey looks it up
 * remotely; the returned object is then plain data plus one method.
 */
export async function toClientSigner(
  walletService: WalletService | TypedDataSigner,
  walletId: string,
): Promise<ClientSigner> {
  const address = await walletService.getWalletAddress(walletId);
  // viem's `Address` is widened to `string` in this project by the Safe SDK's
  // abitype `Register` augmentation; x402 wants the `0x${string}` literal.
  if (!isAddress(address)) {
    throw new Error(`Wallet ${walletId} returned an invalid address: ${address}`);
  }
  return {
    address: address as `0x${string}`,
    async signTypedData(typedData) {
      const { signature } = await walletService.signTypedData({ walletId, typedData });
      return signature;
    },
  };
}
