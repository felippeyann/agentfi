/**
 * `@agent_fi/mcp-server` checks `pay_agent`'s `recipient_address` and
 * `transfer_token`'s `to` before calling `POST /v1/transactions/transfer`
 * (review of #181, P2). The published package does not depend on viem, so it
 * carries its own check (`packages/mcp-server/src/addresses.ts`, keccak from
 * `@noble/hashes`). This pins it to the rule the route's schema applies —
 * viem `isAddress(x, { strict: true })` — on a corpus that covers every
 * branch: checksummed, all-lowercase, all-uppercase, one letter's case
 * flipped, malformed.
 *
 * The sibling module is loaded by path, as `mcp.token-map.sync.test.ts` does.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getAddress, isAddress } from 'viem';
import { CONTRACT_ADDRESSES, UNISWAP_V3_QUOTER_V2 } from '../config/contracts.js';
import { listKnownTokens } from '../services/transaction/token-registry.js';

type AddressModule = {
  isStrictAddress: (value: string) => boolean;
  toChecksumAddress: (value: string) => string;
};

async function loadAddresses(): Promise<AddressModule> {
  const here = dirname(fileURLToPath(import.meta.url));
  return (await import(resolve(here, '../../../mcp-server/src/addresses.ts'))) as AddressModule;
}

/** 200 deterministic pseudo-random addresses (sha256 chain), checksummed by viem. */
function pseudoRandomAddresses(count: number): string[] {
  const out: string[] = [];
  let seed = 'agentfi-mcp-address-sync';
  for (let i = 0; i < count; i++) {
    seed = createHash('sha256').update(seed).digest('hex');
    out.push(getAddress(`0x${seed.slice(0, 40)}`));
  }
  return out;
}

/** Every letter position of `address` with its case flipped, one at a time. */
function caseFlips(address: string): string[] {
  const out: string[] = [];
  for (let i = 2; i < address.length; i++) {
    const c = address[i]!;
    if (!/[a-fA-F]/.test(c)) continue;
    const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    out.push(address.slice(0, i) + flipped + address.slice(i + 1));
  }
  return out;
}

function corpus(): string[] {
  const checksummed = [
    ...pseudoRandomAddresses(200),
    ...listKnownTokens().map((t) => t.address),
    ...Object.values(UNISWAP_V3_QUOTER_V2),
    ...Object.values(CONTRACT_ADDRESSES).flatMap((c) => [c.uniswapV3Router, c.aavePoolAddressProvider]),
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    '0x0000000000000000000000000000000000000000',
  ];
  const variants = checksummed.flatMap((a) => [
    a,
    a.toLowerCase(),
    `0x${a.slice(2).toUpperCase()}`,
    `0X${a.slice(2)}`,
    ...caseFlips(a).slice(0, 3),
  ]);
  const malformed = ['', '0x', 'agent-42', 'USDC', 'ETH', '0x123', `${checksummed[0]!}00`, checksummed[0]!.slice(2), ` ${checksummed[0]!}`];
  return [...new Set([...variants, ...malformed])];
}

describe('MCP address check vs the transfer route (viem strict isAddress)', () => {
  it('agrees with viem isAddress(x, { strict: true }) on every corpus entry', async () => {
    const { isStrictAddress } = await loadAddresses();
    const entries = corpus();
    expect(entries.length).toBeGreaterThan(1000);
    const disagreements = entries.filter((a) => isStrictAddress(a) !== isAddress(a, { strict: true }));
    expect(disagreements).toEqual([]);
    // Both outcomes are exercised.
    expect(entries.some((a) => isAddress(a, { strict: true }))).toBe(true);
    expect(entries.some((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && !isAddress(a, { strict: true }))).toBe(true);
  });

  it('checksums exactly like viem getAddress', async () => {
    const { toChecksumAddress } = await loadAddresses();
    for (const address of pseudoRandomAddresses(200)) {
      expect(toChecksumAddress(address.toLowerCase())).toBe(address);
    }
  });
});
