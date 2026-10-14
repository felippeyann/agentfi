/**
 * X5 — `@agent_fi/mcp-server` resolves token symbols (`pay_agent`,
 * `transfer_token`, swaps, Aave) from its own map, `packages/mcp-server/src/
 * tools/token-map.ts`: the published package cannot import the backend. This
 * pins that map to the backend's registry (`token-registry.ts`), the source
 * the routes price and count spends with: a symbol both know must be the same
 * contract, and every backend token on a chain the MCP map covers must be
 * resolvable by the MCP server (Base Sepolia USDC was missing before X5).
 *
 * The sibling module is loaded by path, as `mcp.annotations.test.ts` does;
 * it is pure data (no env reads, no I/O).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { listKnownTokens } from '../services/transaction/token-registry.js';

type TokenMapModule = {
  tokenRegistryEntries: () => Array<{ chainId: number; symbol: string; address: string }>;
  resolvePaymentToken: (symbol: string, chainId: number) => string | undefined;
};

async function loadTokenMap(): Promise<TokenMapModule> {
  const here = dirname(fileURLToPath(import.meta.url));
  return (await import(resolve(here, '../../../mcp-server/src/tools/token-map.ts'))) as TokenMapModule;
}

describe('MCP token map vs backend token registry (X5)', () => {
  it('every MCP entry is a checksummed address', async () => {
    const { tokenRegistryEntries } = await loadTokenMap();
    for (const entry of tokenRegistryEntries()) {
      expect(getAddress(entry.address), `${entry.chainId}:${entry.symbol}`).toBe(entry.address);
    }
  });

  it('a symbol both registries know is the same contract', async () => {
    const { tokenRegistryEntries } = await loadTokenMap();
    const backend = new Map(listKnownTokens().map((t) => [`${t.chainId}:${t.symbol.toUpperCase()}`, t.address]));
    const shared = tokenRegistryEntries().filter((e) => backend.has(`${e.chainId}:${e.symbol}`));
    expect(shared.length).toBeGreaterThan(0);
    for (const entry of shared) {
      expect(entry.address, `${entry.chainId}:${entry.symbol}`).toBe(backend.get(`${entry.chainId}:${entry.symbol}`));
    }
  });

  it('every backend token on a chain the MCP map covers resolves to the same address in pay_agent', async () => {
    const { tokenRegistryEntries, resolvePaymentToken } = await loadTokenMap();
    const mcpChains = new Set(tokenRegistryEntries().map((e) => e.chainId));
    const covered = listKnownTokens().filter((t) => mcpChains.has(t.chainId));
    expect(covered.some((t) => t.chainId === 84532 && t.symbol === 'USDC')).toBe(true);
    for (const token of covered) {
      expect(resolvePaymentToken(token.symbol, token.chainId), `${token.chainId}:${token.symbol}`).toBe(token.address);
    }
  });
});
