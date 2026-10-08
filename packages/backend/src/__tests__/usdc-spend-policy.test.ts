/**
 * Unit tests — USDC spend policy (P6, `services/policy/usdc-spend-policy.ts`)
 * and the ResourcePayment counting rules (`resource-payment-ledger.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateUsdcSpend,
  formatMicroUsd,
  policyDecimalToMicro,
  usdTextToMicroCeil,
  type UsdcSpendPolicy,
} from '../services/policy/usdc-spend-policy.js';
import {
  LEGACY_REFUSAL_WINDOW_SECONDS,
  isLiveRefusal,
  isRetryable,
  refusalLiveUntil,
  startOfUtcDay,
  sumBaseUnits,
  utcDay,
} from '../services/payments/resource-payment-ledger.js';
import { MAX_AUTHORIZATION_WINDOW_SECONDS } from '../services/payments/x402-client.service.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SELLER = '0x00000000000000000000000000000000000000b0';
const NOW = new Date('2026-10-08T12:00:00Z');

function policy(overrides: Partial<UsdcSpendPolicy> = {}): UsdcSpendPolicy {
  return {
    active: true,
    expiresAt: null,
    maxValuePerTxEth: '1.0',
    maxDailyVolumeUsd: '10000',
    allowedTokens: [],
    allowedContracts: [],
    ...overrides,
  };
}

function spend(amount: bigint, spentTodayMicroUsd = 0n) {
  return { amount, token: USDC, counterparty: SELLER, spentTodayMicroUsd, now: NOW };
}

describe('evaluateUsdcSpend', () => {
  it('no policy row = no restrictions (same as validateTransaction)', () => {
    expect(evaluateUsdcSpend(null, spend(10n ** 12n))).toEqual({ allowed: true });
  });

  it('a paused or expired policy refuses', () => {
    expect(evaluateUsdcSpend(policy({ active: false }), spend(1n))).toMatchObject({ allowed: false, rule: 'policyPaused' });
    expect(evaluateUsdcSpend(policy({ expiresAt: new Date('2026-10-08T11:59:59Z') }), spend(1n))).toMatchObject({
      allowed: false,
      rule: 'policyExpired',
    });
    expect(evaluateUsdcSpend(policy({ expiresAt: new Date('2026-10-08T12:00:01Z') }), spend(1n)).allowed).toBe(true);
  });

  describe('per-transaction cap, read in USD for USDC', () => {
    it.each([
      ['1.0', 1_000_000n, true],
      ['1.0', 1_000_001n, false],
      ['0.25', 400_000n, false],
      ['0.4', 400_000n, true],
      ['0', 1n, false],
      ['0', 0n, true],
      // more than 6 decimals: the limit is rounded DOWN (stricter)
      ['0.4000009', 400_001n, false],
    ])('maxValuePerTxEth %s vs %s base units → allowed %s', (limit, amount, allowed) => {
      const verdict = evaluateUsdcSpend(policy({ maxValuePerTxEth: limit }), spend(amount));
      expect(verdict.allowed).toBe(allowed);
      if (!verdict.allowed) expect(verdict).toMatchObject({ rule: 'maxValuePerTx', limit });
    });

    it.each(['', ' 1', '1e3', '0x10', 'abc'])('an unparsable stored limit %j is unlimited (policy-numbers semantics)', (raw) => {
      const p = policy({ maxValuePerTxEth: raw, maxDailyVolumeUsd: '0' });
      expect(evaluateUsdcSpend(p, spend(10n ** 15n)).allowed).toBe(true);
    });
  });

  describe('daily volume', () => {
    it('counts what was already committed today plus this payment', () => {
      const p = policy({ maxDailyVolumeUsd: '1' });
      expect(evaluateUsdcSpend(p, spend(400_000n, 600_000n)).allowed).toBe(true);
      const verdict = evaluateUsdcSpend(p, spend(400_001n, 600_000n));
      expect(verdict).toMatchObject({ allowed: false, rule: 'maxDailyVolume', limit: '1' });
      if (!verdict.allowed) expect(verdict.reason).toContain('Already committed today: 0.6, requested: 0.400001');
    });

    it('"0" (and an unparsable value) means no daily limit', () => {
      expect(evaluateUsdcSpend(policy({ maxDailyVolumeUsd: '0' }), spend(1n, 10n ** 15n)).allowed).toBe(true);
      expect(evaluateUsdcSpend(policy({ maxDailyVolumeUsd: '' }), spend(1n, 10n ** 15n)).allowed).toBe(true);
    });
  });

  describe('allowlists', () => {
    it('allowedTokens must list USDC when non-empty (case-insensitive)', () => {
      expect(evaluateUsdcSpend(policy({ allowedTokens: [USDC.toLowerCase()] }), spend(1n)).allowed).toBe(true);
      expect(evaluateUsdcSpend(policy({ allowedTokens: ['0x0000000000000000000000000000000000000001'] }), spend(1n))).toMatchObject({
        allowed: false,
        rule: 'allowedTokens',
      });
    });

    it('allowedContracts, when non-empty, must list the counterparty (the payTo), not the USDC contract', () => {
      expect(evaluateUsdcSpend(policy({ allowedContracts: [SELLER.toUpperCase().replace('0X', '0x')] }), spend(1n)).allowed).toBe(
        true,
      );
      const verdict = evaluateUsdcSpend(policy({ allowedContracts: [USDC] }), spend(1n));
      expect(verdict).toMatchObject({ allowed: false, rule: 'allowedContracts' });
      if (!verdict.allowed) expect(verdict.reason).toContain(SELLER);
    });
  });
});

describe('decimal helpers', () => {
  it('policyDecimalToMicro floors to 6 decimals and returns null for non-decimals', () => {
    expect(policyDecimalToMicro('1')).toBe(1_000_000n);
    expect(policyDecimalToMicro('0.0000019')).toBe(1n);
    expect(policyDecimalToMicro('10000')).toBe(10_000_000_000n);
    expect(policyDecimalToMicro('-1')).toBeNull();
    expect(policyDecimalToMicro(null)).toBeNull();
  });

  it('usdTextToMicroCeil rounds spent money UP, treats empty / negative as nothing and throws on garbage', () => {
    expect(usdTextToMicroCeil('0.5')).toBe(500_000n);
    expect(usdTextToMicroCeil('0.30000000000000004')).toBe(300_001n);
    expect(usdTextToMicroCeil(undefined)).toBe(0n);
    expect(usdTextToMicroCeil('-0.25')).toBe(0n);
    expect(() => usdTextToMicroCeil('NaN')).toThrow();
  });

  it('formatMicroUsd trims trailing zeros', () => {
    expect(formatMicroUsd(900_000n)).toBe('0.9');
    expect(formatMicroUsd(1_000_000n)).toBe('1');
    expect(formatMicroUsd(1n)).toBe('0.000001');
  });
});

describe('ResourcePayment counting rules', () => {
  const at = (iso: string) => new Date(iso);

  it('the legacy refusal window equals the longest authorization window the client signs', () => {
    expect(LEGACY_REFUSAL_WINDOW_SECONDS).toBe(MAX_AUTHORIZATION_WINDOW_SECONDS);
  });

  it('a refused row is live until validBefore, then retryable', () => {
    const row = { status: 'refused' as const, authorizationValidBefore: at('2026-10-08T12:05:00Z'), updatedAt: at('2026-10-08T12:00:00Z') };
    expect(refusalLiveUntil(row)).toEqual(at('2026-10-08T12:05:00Z'));
    expect(isLiveRefusal(row, at('2026-10-08T12:04:59Z'))).toBe(true);
    expect(isRetryable(row, at('2026-10-08T12:04:59Z'))).toBe(false);
    expect(isLiveRefusal(row, at('2026-10-08T12:05:00Z'))).toBe(false);
    expect(isRetryable(row, at('2026-10-08T12:05:00Z'))).toBe(true);
  });

  it('a refused row without validBefore (pre-0018) is live for the legacy window after its last update', () => {
    const row = { status: 'refused' as const, authorizationValidBefore: null, updatedAt: at('2026-10-08T12:00:00Z') };
    expect(refusalLiveUntil(row)).toEqual(at('2026-10-08T12:10:00Z'));
    expect(isLiveRefusal(row, at('2026-10-08T12:09:59Z'))).toBe(true);
    expect(isLiveRefusal(row, at('2026-10-08T12:10:00Z'))).toBe(false);
  });

  it.each(['reserved', 'pending', 'settled', 'unknown'] as const)('%s is never retryable', (status) => {
    expect(isRetryable({ status, authorizationValidBefore: null, updatedAt: at('2000-01-01T00:00:00Z') }, NOW)).toBe(false);
  });

  it('failed_before_signing is always retryable and never live', () => {
    const row = { status: 'failed_before_signing' as const, authorizationValidBefore: null, updatedAt: NOW };
    expect(isRetryable(row, NOW)).toBe(true);
    expect(isLiveRefusal(row, NOW)).toBe(false);
    expect(refusalLiveUntil(row)).toBeNull();
  });

  it('sumBaseUnits skips malformed amounts; utcDay / startOfUtcDay use UTC', () => {
    expect(sumBaseUnits([{ amount: '400000' }, { amount: 'x' }, { amount: '1' }])).toBe(400_001n);
    expect(utcDay(at('2026-10-08T23:59:59-03:00'))).toBe('2026-10-09');
    expect(startOfUtcDay(at('2026-10-08T15:30:00Z'))).toEqual(at('2026-10-08T00:00:00Z'));
  });
});
