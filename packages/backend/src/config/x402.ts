/**
 * x402 configuration — facilitator endpoints and CAIP-2 network helpers.
 *
 * Note on roles: in x402 the *buyer* (our X402ClientService) never talks to
 * a facilitator. It signs an authorization and sends it to the resource
 * server, which calls its own facilitator to verify and settle. The URLs
 * below are therefore used only where AgentFi acts as a resource server or
 * reconciles settlements (later tasks), and are centralised here so the
 * per-chain choice is explicit.
 */

import type { Network } from '@x402/core/types';
import { env } from './env.js';

/**
 * Per-chain facilitator defaults.
 *
 *  - Base Sepolia (84532): the public x402.org facilitator. Testnet only,
 *    no authentication.
 *  - Base (8453): Coinbase Developer Platform. Requires a CDP API key; the
 *    key is attached by the facilitator client's `createAuthHeaders` in the
 *    task that wires AgentFi as a resource server — not here.
 */
export const X402_FACILITATOR_DEFAULTS: Readonly<Record<number, string>> = {
  84532: 'https://x402.org/facilitator',
  8453: 'https://api.cdp.coinbase.com/platform/v2/x402',
};

/**
 * Facilitator URL for a chain: `X402_FACILITATOR_URL` when set (applies to
 * every chain), otherwise the per-chain default. Throws for chains without
 * a known facilitator so callers never silently fall back to mainnet.
 */
export function getX402FacilitatorUrl(chainId: number): string {
  if (env.X402_FACILITATOR_URL) return env.X402_FACILITATOR_URL;
  const url = X402_FACILITATOR_DEFAULTS[chainId];
  if (!url) {
    throw new Error(
      `No x402 facilitator configured for chain ${chainId}. ` +
        'Set X402_FACILITATOR_URL or add a default in config/x402.ts.',
    );
  }
  return url;
}

/** `84532` → `eip155:84532` (CAIP-2, as used in x402 v2 payment requirements). */
export function chainIdToNetwork(chainId: number): Network {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid chain id: ${chainId}`);
  }
  return `eip155:${chainId}`;
}

/** `eip155:84532` → `84532`; `undefined` for non-EVM or malformed networks. */
export function networkToChainId(network: string): number | undefined {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : undefined;
}
