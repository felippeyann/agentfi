/**
 * Unit tests — Q9 spend pricing (`services/policy/spend-pricing.ts`), the
 * synthetic test prices parser (`config/synthetic-prices.ts`), its boot guard
 * (`config/env-guards.ts` `syntheticPricesProblem`), the testnet set
 * (`config/chains.ts`) and the price service's no-mainnet-proxy rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oracle = vi.hoisted(() => ({
  weiToUsd: vi.fn(async (_wei: bigint, _chainId: number) => '0'),
  tokenAmountToUsd: vi.fn(async (_units: bigint, _token: string, _decimals: number, _chainId: number) => '0'),
}));

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: oracle.weiToUsd,
  tokenAmountToUsd: oracle.tokenAmountToUsd,
}));

import { CHAIN_IDS, MAINNET_CHAIN_IDS, TESTNET_CHAIN_IDS, isMainnetChain, isTestnetChain } from '../config/chains.js';
import { parseSyntheticTestPrices, syntheticPriceKey } from '../config/synthetic-prices.js';
import { syntheticPricesProblem } from '../config/env-guards.js';
import {
  countedUsd,
  priceNativeSpend,
  priceSourceOf,
  priceTokenSpend,
  sumSpendPricings,
  syntheticTestPrices,
  syntheticUsd,
  unknownAmountSpend,
  usdcPegSpend,
} from '../services/policy/spend-pricing.js';

const USDC_84532 = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TESTNETS = [84532];

const savedNodeEnv = process.env['NODE_ENV'];
beforeEach(() => {
  oracle.weiToUsd.mockReset().mockResolvedValue('0');
  oracle.tokenAmountToUsd.mockReset().mockResolvedValue('0');
  delete process.env['SYNTHETIC_TEST_PRICES_USD'];
  process.env['NODE_ENV'] = 'test';
});
afterEach(() => {
  delete process.env['SYNTHETIC_TEST_PRICES_USD'];
  process.env['NODE_ENV'] = savedNodeEnv;
});

describe('config/chains.ts — the testnet set lives in one place', () => {
  it('84532 is the only testnet; every other supported chain is a mainnet chain', () => {
    expect(TESTNET_CHAIN_IDS).toEqual([84532]);
    expect([...MAINNET_CHAIN_IDS].sort()).toEqual(CHAIN_IDS.filter((id) => id !== 84532).sort());
    expect(isTestnetChain(84532)).toBe(true);
    expect(isMainnetChain(84532)).toBe(false);
    expect(isMainnetChain(8453)).toBe(true);
    expect(isTestnetChain(31337)).toBe(false);
    expect(isMainnetChain(31337)).toBe(false);
  });
});

describe('parseSyntheticTestPrices', () => {
  it('blank or unset = no synthetic prices', () => {
    expect(parseSyntheticTestPrices(undefined, TESTNETS)).toEqual({ ok: true, prices: new Map() });
    expect(parseSyntheticTestPrices('  ', TESTNETS)).toEqual({ ok: true, prices: new Map() });
  });

  it('parses native and checksummed token entries (whitespace around entries allowed)', () => {
    const parsed = parseSyntheticTestPrices(` 84532:native=2500 , 84532:${USDC_84532}=1 `, TESTNETS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.prices.get('84532:native')).toBe('2500');
    expect(parsed.prices.get(syntheticPriceKey(84532, USDC_84532))).toBe('1');
    expect(syntheticPriceKey(84532, USDC_84532)).toBe(`84532:${USDC_84532.toLowerCase()}`);
  });

  it.each([
    [`8453:${USDC_BASE}=1`, /not a testnet chain/],
    ['1:native=2500', /not a testnet chain/],
    ['31337:native=1', /not a testnet chain/],
    [`84532:${USDC_84532.toLowerCase()}=1`, /EIP-55 checksummed/],
    ['84532:0x036cbd53842c5426634e7929541ec2318f3dCF7e=1', /EIP-55 checksummed/],
    ['84532:0x0000000000000000000000000000000000000000=1', /zero address/],
    ['84532:ETH=2500', /"native" or a 0x token address/],
    ['84532:native=0', /greater than 0/],
    ['84532:native=0.000', /greater than 0/],
    ['84532:native=-1', /plain decimal/],
    ['84532:native=1e3', /plain decimal/],
    ['84532:native=abc', /plain decimal/],
    ['84532:native', /not chainId:asset=usd/],
    ['native=1', /not chainId:asset=usd/],
    ['84532:native=1,,', /empty/],
    ['84532:native=1,84532:native=2', /duplicate/],
  ])('refuses %j', (raw, message) => {
    const parsed = parseSyntheticTestPrices(raw, TESTNETS);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(' | ')).toMatch(message);
  });

  it('reports every bad entry at once', () => {
    const parsed = parseSyntheticTestPrices('1:native=1,84532:native=0', TESTNETS);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.errors).toHaveLength(2);
  });
});

describe('syntheticPricesProblem (boot guard)', () => {
  const valid = `84532:native=2500,84532:${USDC_84532}=1`;

  it.each(['production', 'staging'])('FATAL with NODE_ENV=%s whenever the variable is set at all', (nodeEnv) => {
    expect(syntheticPricesProblem(valid, nodeEnv, TESTNETS)).toMatch(/cannot run with NODE_ENV/);
    expect(syntheticPricesProblem('84532:native=1', nodeEnv, TESTNETS)).toMatch(/cannot run with NODE_ENV/);
  });

  it.each(['production', 'staging', 'development', 'test'])('blank is fine with NODE_ENV=%s', (nodeEnv) => {
    expect(syntheticPricesProblem(undefined, nodeEnv, TESTNETS)).toBeNull();
    expect(syntheticPricesProblem('', nodeEnv, TESTNETS)).toBeNull();
  });

  it('development / test: a valid testnet configuration boots, a mainnet entry or a malformed one is FATAL', () => {
    expect(syntheticPricesProblem(valid, 'development', TESTNETS)).toBeNull();
    expect(syntheticPricesProblem('8453:native=2500', 'development', TESTNETS)).toMatch(/invalid: .*not a testnet chain/);
    expect(syntheticPricesProblem('84532:native=two', 'test', TESTNETS)).toMatch(/invalid/);
  });
});

describe('priceNativeSpend / priceTokenSpend', () => {
  it('zero amount → zero (no lookup)', async () => {
    expect(await priceNativeSpend(0n, 8453)).toEqual({ status: 'zero' });
    expect(await priceTokenSpend(0n, USDC_84532, 6, 84532)).toEqual({ status: 'zero' });
    expect(oracle.weiToUsd).not.toHaveBeenCalled();
  });

  it('testnet: unpriced without a synthetic price — and the oracle is never asked (no mainnet-ETH proxy)', async () => {
    oracle.weiToUsd.mockResolvedValue('2000.000000');
    const native = await priceNativeSpend(10n ** 18n, 84532);
    expect(native).toMatchObject({ status: 'unpriced' });
    if (native.status === 'unpriced') expect(native.reason).toMatch(/no configured synthetic test price.*84532:native/);
    expect(await priceTokenSpend(25_000_000n, USDC_84532, 6, 84532)).toMatchObject({ status: 'unpriced' });
    expect(oracle.weiToUsd).not.toHaveBeenCalled();
    expect(oracle.tokenAmountToUsd).not.toHaveBeenCalled();
  });

  it('testnet: a configured synthetic price counts, rounded UP to the micro-dollar, source synthetic', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = `84532:native=2500,84532:${USDC_84532}=1`;
    expect(await priceNativeSpend(10n ** 16n, 84532)).toEqual({ status: 'priced', usd: '25.000000', source: 'synthetic' });
    expect(await priceTokenSpend(25_500_000n, USDC_84532, 6, 84532)).toEqual({ status: 'priced', usd: '25.500000', source: 'synthetic' });
    // 1 wei at 2500 USD/ETH = 2.5e-15 USD → one micro-dollar, never 0.
    expect(await priceNativeSpend(1n, 84532)).toEqual({ status: 'priced', usd: '0.000001', source: 'synthetic' });
    // Address lookups are case-insensitive once configured (the variable itself must be checksummed).
    expect(await priceTokenSpend(1_000_000n, USDC_84532.toLowerCase(), 6, 84532)).toMatchObject({ status: 'priced', usd: '1.000000' });
  });

  it('testnet: an unconfigured token stays unpriced even when other assets are configured', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2500';
    expect(await priceTokenSpend(1n, USDC_84532, 6, 84532)).toMatchObject({ status: 'unpriced' });
  });

  it('production / staging never read synthetic prices (the boot refuses them; this is the belt)', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2500';
    for (const nodeEnv of ['production', 'staging']) {
      process.env['NODE_ENV'] = nodeEnv;
      expect(syntheticTestPrices().size).toBe(0);
      expect(await priceNativeSpend(10n ** 18n, 84532)).toMatchObject({ status: 'unpriced' });
    }
  });

  it('a malformed variable yields no synthetic prices at runtime (boot refuses it anyway)', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2500,1:native=2500';
    expect(syntheticTestPrices().size).toBe(0);
  });

  it('mainnet: the oracle price, source oracle; a failed / zero oracle answer is unpriced', async () => {
    oracle.weiToUsd.mockResolvedValue('2000.000000');
    expect(await priceNativeSpend(10n ** 18n, 8453)).toEqual({ status: 'priced', usd: '2000.000000', source: 'oracle' });
    oracle.tokenAmountToUsd.mockResolvedValue('25.000000');
    expect(await priceTokenSpend(25_000_000n, USDC_BASE, 6, 8453)).toEqual({ status: 'priced', usd: '25.000000', source: 'oracle' });

    oracle.weiToUsd.mockResolvedValue('0');
    expect(await priceNativeSpend(10n ** 18n, 1)).toMatchObject({ status: 'unpriced' });
    oracle.tokenAmountToUsd.mockResolvedValue('0');
    const token = await priceTokenSpend(1n, USDC_BASE, 6, 8453);
    expect(token).toMatchObject({ status: 'unpriced' });
    if (token.status === 'unpriced') expect(token.reason).toMatch(/oracle has no price/);
  });

  it('mainnet: a priced dust amount ("0.000000") is priced, not unpriced', async () => {
    oracle.weiToUsd.mockResolvedValue('0.000000');
    expect(await priceNativeSpend(1n, 8453)).toEqual({ status: 'priced', usd: '0.000000', source: 'oracle' });
  });

  it('mainnet chains never consult synthetic prices', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2500';
    oracle.weiToUsd.mockResolvedValue('0');
    expect(await priceNativeSpend(10n ** 18n, 8453)).toMatchObject({ status: 'unpriced' });
    expect(oracle.weiToUsd).toHaveBeenCalledWith(10n ** 18n, 8453);
  });

  it('an unsupported chain has no price source', async () => {
    expect(await priceNativeSpend(1n, 31337)).toMatchObject({ status: 'unpriced', reason: expect.stringMatching(/no trusted price source/) });
    expect(oracle.weiToUsd).not.toHaveBeenCalled();
  });
});

describe('sums and helpers', () => {
  it('syntheticUsd is exact and rounds up', () => {
    expect(syntheticUsd(1_000_000n, 6, '1')).toBe('1.000000');
    expect(syntheticUsd(1n, 6, '0.5')).toBe('0.000001'); // 0.0000005 → up
    expect(syntheticUsd(3n, 18, '0.333333333333')).toBe('0.000001');
    expect(syntheticUsd(10n ** 18n, 18, '2512.123456789')).toBe('2512.123457');
  });

  it('any unpriced component makes the sum unpriced; all zero is zero', () => {
    expect(sumSpendPricings([{ status: 'zero' }, { status: 'zero' }])).toEqual({ status: 'zero' });
    expect(sumSpendPricings([usdcPegSpend(1_000_000n), unknownAmountSpend('x')])).toEqual({ status: 'unpriced', reason: 'x' });
  });

  it('a sum is synthetic when any part is, else oracle, else usdc-peg', () => {
    const oracleP = { status: 'priced' as const, usd: '2.000000', source: 'oracle' as const };
    const synthP = { status: 'priced' as const, usd: '0.500000', source: 'synthetic' as const };
    expect(sumSpendPricings([oracleP, synthP, { status: 'zero' }])).toEqual({ status: 'priced', usd: '2.500000', source: 'synthetic' });
    expect(sumSpendPricings([oracleP, usdcPegSpend(1_500_000n)])).toEqual({ status: 'priced', usd: '3.500000', source: 'oracle' });
    expect(sumSpendPricings([usdcPegSpend(1_500_000n)])).toEqual({ status: 'priced', usd: '1.500000', source: 'usdc-peg' });
  });

  it('countedUsd / priceSourceOf', () => {
    expect(countedUsd({ status: 'priced', usd: '3.5', source: 'oracle' })).toBe('3.5');
    expect(countedUsd({ status: 'unpriced', reason: 'x' })).toBe('0');
    expect(priceSourceOf({ status: 'zero' })).toBeNull();
    expect(priceSourceOf({ status: 'priced', usd: '1', source: 'synthetic' })).toBe('synthetic');
  });
});
