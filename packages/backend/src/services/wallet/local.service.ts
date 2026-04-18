/**
 * LocalWalletService — development-only wallet provider that generates
 * random private keys in-process. NEVER use in production.
 *
 * Purpose: let developers and evaluators run the full stack end-to-end
 * without first creating a Turnkey account. This drops the zero-to-running
 * time from ~30 min (signup + API keys + org ID) to ~3 min (docker compose up).
 *
 * Security boundary:
 *   - Private keys live in process memory only (Map keyed by walletId)
 *   - Keys are lost on every restart — intentional, so no persistence risk
 *   - A runtime guard in env.ts refuses to boot with
 *     WALLET_PROVIDER=local + NODE_ENV=production
 *   - Every method logs a WARN-level line noting the provider is local
 *
 * Matches the TurnkeyService surface (createWallet, getWalletAddress,
 * signTransaction, listWallets, healthCheck) so the factory can swap
 * them transparently.
 */

import { randomBytes } from 'node:crypto';
import {
  getAddress,
  keccak256,
  parseTransaction,
  serializeTransaction,
  toHex,
  type Address,
  type Hex,
  type TransactionSerializable,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { logger } from '../../api/middleware/logger.js';

interface LocalWalletEntry {
  walletId: string;
  walletName: string;
  account: PrivateKeyAccount;
  createdAt: Date;
}

const wallets = new Map<string, LocalWalletEntry>();

function randomWalletId(): string {
  return `local-${toHex(randomBytes(8)).slice(2)}`;
}

function randomPrivateKey(): Hex {
  return toHex(randomBytes(32));
}

export class LocalWalletService {
  constructor() {
    logger.warn(
      '[local-wallet] LocalWalletService active — keys in process memory, NOT for production',
    );
  }

  /**
   * Provisions a new wallet. Generates a random secp256k1 key, stores
   * it in the in-memory map, returns the derived address.
   */
  async createWallet(agentName: string): Promise<{
    walletId: string;
    address: Address;
  }> {
    const walletId = randomWalletId();
    const privateKey = randomPrivateKey();
    const account = privateKeyToAccount(privateKey);

    wallets.set(walletId, {
      walletId,
      walletName: `agentfi-${agentName}-${Date.now()}`,
      account,
      createdAt: new Date(),
    });

    logger.info(
      { walletId, address: account.address },
      '[local-wallet] wallet created',
    );

    return { walletId, address: account.address };
  }

  async getWalletAddress(walletId: string): Promise<Address> {
    const entry = wallets.get(walletId);
    if (!entry) {
      throw new Error(
        `[local-wallet] wallet ${walletId} not found (in-memory store is cleared on restart)`,
      );
    }
    return getAddress(entry.account.address);
  }

  /**
   * Signs a serialized EIP-1559/Legacy unsigned transaction.
   * Returns the hex-encoded signed transaction.
   */
  async signTransaction(params: {
    walletId: string;
    unsignedTx: string;
    chainId: number;
  }): Promise<string> {
    const entry = wallets.get(params.walletId);
    if (!entry) {
      throw new Error(
        `[local-wallet] wallet ${params.walletId} not found (in-memory store is cleared on restart)`,
      );
    }

    // Parse the serialized unsigned tx back into fields, then sign.
    const parsed = parseTransaction(params.unsignedTx as Hex) as TransactionSerializable;
    const signed = await entry.account.signTransaction(parsed);
    return signed;
  }

  async listWallets(): Promise<Array<{ walletId: string; walletName: string }>> {
    return Array.from(wallets.values()).map((w) => ({
      walletId: w.walletId,
      walletName: w.walletName,
    }));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/** Exposed for tests only — clears the in-memory wallet map. */
export function __clearLocalWallets(): void {
  wallets.clear();
}

/** Exposed for tests only — returns the raw wallet map size. */
export function __localWalletCount(): number {
  return wallets.size;
}
