/**
 * Unit tests — x402 configuration helpers (facilitator defaults per chain,
 * CAIP-2 helpers). config/env is replaced because it parses process.env at
 * import time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
  envState: { env: { X402_FACILITATOR_URL: undefined as string | undefined } },
}));

vi.mock('../config/env.js', () => ({ env: envState.env }));

import {
  X402_FACILITATOR_DEFAULTS,
  chainIdToNetwork,
  getX402FacilitatorUrl,
  networkToChainId,
} from '../config/x402.js';

describe('getX402FacilitatorUrl', () => {
  beforeEach(() => {
    envState.env.X402_FACILITATOR_URL = undefined;
  });

  it('defaults Base Sepolia to the public x402.org facilitator', () => {
    expect(getX402FacilitatorUrl(84532)).toBe('https://x402.org/facilitator');
  });

  it('defaults Base to the CDP facilitator', () => {
    expect(getX402FacilitatorUrl(8453)).toBe('https://api.cdp.coinbase.com/platform/v2/x402');
    expect(X402_FACILITATOR_DEFAULTS[8453]).toContain('coinbase.com');
  });

  it('honours X402_FACILITATOR_URL for every chain', () => {
    envState.env.X402_FACILITATOR_URL = 'http://localhost:4020/facilitator';
    expect(getX402FacilitatorUrl(84532)).toBe('http://localhost:4020/facilitator');
    expect(getX402FacilitatorUrl(1)).toBe('http://localhost:4020/facilitator');
  });

  it('throws for a chain without a default instead of guessing', () => {
    expect(() => getX402FacilitatorUrl(1)).toThrow(/No x402 facilitator configured for chain 1/);
  });
});

describe('CAIP-2 helpers', () => {
  it('round-trips EVM chain ids', () => {
    expect(chainIdToNetwork(84532)).toBe('eip155:84532');
    expect(networkToChainId('eip155:84532')).toBe(84532);
  });

  it('rejects malformed input', () => {
    expect(() => chainIdToNetwork(0)).toThrow(/Invalid chain id/);
    expect(networkToChainId('solana:mainnet')).toBeUndefined();
    expect(networkToChainId('eip155:*')).toBeUndefined();
  });
});
