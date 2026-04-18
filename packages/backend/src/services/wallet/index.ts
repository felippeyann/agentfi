/**
 * Wallet provider factory.
 *
 * Selects the wallet implementation based on env.WALLET_PROVIDER:
 *   - "turnkey" (default): Turnkey MPC — production-grade, keys split across shards
 *   - "local": in-memory viem private keys — DEVELOPMENT ONLY
 *
 * A single long-lived instance is memoized per process.
 */

import { env } from '../../config/env.js';
import { TurnkeyService } from './turnkey.service.js';
import { LocalWalletService } from './local.service.js';

export type WalletService = TurnkeyService | LocalWalletService;

let instance: WalletService | null = null;

export function getWalletService(): WalletService {
  if (!instance) {
    instance =
      env.WALLET_PROVIDER === 'local'
        ? new LocalWalletService()
        : new TurnkeyService();
  }
  return instance;
}

/** Testing hook — resets the memoized instance so env changes take effect. */
export function __resetWalletServiceForTests(): void {
  instance = null;
}
