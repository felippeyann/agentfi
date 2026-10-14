/**
 * S7 — hard-coded contract addresses: every one is a valid EIP-55 address,
 * and the ones that were not are now the official deployments.
 *
 * The four addresses the G1 review flagged (Arbitrum GMX `gmxOrderVault` /
 * `gmxRouter`, Base Aave `aavePoolAddressProvider` / Uniswap
 * `uniswapV3Quoter`) were not casing slips: each was a wrong address with no
 * code on its chain (checked 2026-10-14 against the official sources cited in
 * `config/contracts.ts` and with `eth_getCode`). A casing-only "fix" would
 * have pointed the routes at empty addresses. The same scan found the Base
 * QuoterV2 the swap route uses, the GMX copies in `gmx.service.ts`, the GMX
 * BTC/USD market (also in the MCP server) and the ENS registry.
 *
 * Identity on-chain is checked by `contracts.addresses.fork.test.ts`
 * (opt-in, against Anvil forks); the routes by
 * `contracts.addresses.routes.db.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getAddress, isAddress } from 'viem';
import * as contracts from '../config/contracts.js';
import { GMX_CONTRACTS, GMX_MARKETS } from '../services/defi/gmx.service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

/** Every 0x-address string reachable in `value` (objects, arrays), with a path. */
function addressesIn(value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) out.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => addressesIn(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) addressesIn(v, `${path}.${k}`, out);
  }
  return out;
}

function expectChecksummed(entries: Array<[string, string]>) {
  expect(entries.length).toBeGreaterThan(0);
  const bad = entries.filter(([, a]) => !isAddress(a, { strict: true }) || getAddress(a) !== a);
  expect(bad, `invalid EIP-55: ${JSON.stringify(bad)}`).toEqual([]);
}

describe('S7 — hard-coded addresses are EIP-55', () => {
  it('config/contracts.ts: every chain table, registry default, legacy deployment and quoter', () => {
    const quoters = (contracts as Record<string, unknown>)['UNISWAP_V3_QUOTER_V2'];
    expect(quoters, 'UNISWAP_V3_QUOTER_V2 is exported from config/contracts.ts').toBeDefined();
    expectChecksummed([
      ...addressesIn(contracts.CONTRACT_ADDRESSES, 'CONTRACT_ADDRESSES'),
      ...addressesIn(contracts.DEFAULT_IDENTITY_REGISTRIES, 'DEFAULT_IDENTITY_REGISTRIES'),
      ...addressesIn(contracts.DEFAULT_REPUTATION_REGISTRIES, 'DEFAULT_REPUTATION_REGISTRIES'),
      ...addressesIn(contracts.LEGACY_CONTRACT_ADDRESSES, 'LEGACY_CONTRACT_ADDRESSES'),
      ...addressesIn(quoters, 'UNISWAP_V3_QUOTER_V2'),
    ]);
  });

  it('services/defi/gmx.service.ts: contracts and markets', () => {
    expectChecksummed([...addressesIn(GMX_CONTRACTS, 'GMX_CONTRACTS'), ...addressesIn(GMX_MARKETS, 'GMX_MARKETS')]);
  });

  it('every mixed-case address literal in backend and MCP source (tests and generated code excluded)', () => {
    const roots = [join(REPO, 'packages/backend/src'), join(REPO, 'packages/mcp-server/src')];
    // The MCP token map is pinned (EIP-55 + same addresses as the backend
    // registry) by mcp.token-map.sync.test.ts, added with X5.
    const excluded = new Set(['packages/mcp-server/src/tools/token-map.ts']);
    const found: Array<[string, string]> = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
          continue;
        }
        const rel = relative(REPO, full).replace(/\\/g, '/');
        if (!/\.tsx?$/.test(name) || name.endsWith('.test.ts') || name === 'api.generated.ts' || excluded.has(rel)) continue;
        readFileSync(full, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            for (const m of line.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
              const body = m[0].slice(2);
              if (body !== body.toLowerCase() && body !== body.toUpperCase()) found.push([`${rel}:${i + 1}`, m[0]]);
            }
          });
      }
    };
    roots.forEach(walk);
    expectChecksummed(found);
  });
});

describe('S7 — the corrected addresses are the official deployments', () => {
  it('Base: Aave V3 PoolAddressesProvider and Uniswap QuoterV2', () => {
    const base = contracts.getContracts(8453);
    expect(base.aavePoolAddressProvider).toBe('0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D');
    expect(base.uniswapV3Quoter).toBe('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
    const quoters = (contracts as Record<string, unknown>)['UNISWAP_V3_QUOTER_V2'] as Record<number, string> | undefined;
    // The swap route's quoter is the same contract (it used to be a second, different wrong address).
    expect(quoters?.[8453]).toBe('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
  });

  it('Arbitrum: GMX OrderVault and Router, the same in config/contracts.ts and gmx.service.ts', () => {
    const arb = contracts.getContracts(42161);
    expect(arb.gmxOrderVault).toBe('0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5');
    expect(arb.gmxRouter).toBe('0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6');
    expect(GMX_CONTRACTS[42161]?.orderVault).toBe(arb.gmxOrderVault);
    expect(GMX_CONTRACTS[42161]?.router).toBe(arb.gmxRouter);
    expect(GMX_CONTRACTS[42161]?.exchangeRouter).toBe(arb.gmxExchangeRouter);
  });

  it('Arbitrum: the GMX BTC/USD market is the BTC/USD [WBTC.e-USDC] market token', () => {
    expect(GMX_MARKETS['BTC/USD']?.marketToken).toBe('0x47c031236e19d024b42f8AE6780E44A573170703');
  });
});
