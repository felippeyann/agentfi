/**
 * Unit tests — policy authority ("tighten-only for agents, operator may loosen")
 *
 * `classifyPolicyChange` is pure. These tests pin down every loosening rule
 * plus the "no policy row yet" baseline so the route guard cannot regress:
 *  - maxValuePerTxEth / maxValuePerTxUsd (Q8) / maxDailyVolumeUsd increase
 *    (incl. "0" = no daily limit, a non-decimal value = unlimited)
 *  - whitelist (contracts, recipients — Q8 —, tokens) cleared or gains an
 *    unknown address (case-insensitive)
 *  - cooldownSeconds decrease
 *  - active false → true
 *  - expiresAt cleared or moved later
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '@prisma/client';
import {
  classifyPolicyChange,
  changedPolicyFields,
  toPolicyPatch,
} from '../services/policy/policy-authority.js';
import { parsePolicyDecimal, isPolicyDecimal } from '../services/policy/policy-numbers.js';

/**
 * Strings `Number()` and `parseFloat()` disagree on (or both mis-handle).
 * None may ever be classified as a tightening — the S1 bypass sent `""`.
 */
const UNPARSABLE_LIMITS = ['', '   ', '\n', '1e3', ' 5', '0x10', '5abc', 'unlimited'];

// ── Fixtures ───────────────────────────────────────────────────────────────

const UNISWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const SELLER = '0x00000000000000000000000000000000000000b0';
const PROVIDER = '0x00000000000000000000000000000000000000c1';

const EXPIRY = new Date('2026-12-01T00:00:00Z');
const EARLIER = new Date('2026-11-01T00:00:00Z');
const LATER = new Date('2027-01-01T00:00:00Z');

function basePolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    id: 'policy-1',
    agentId: 'agent-1',
    active: true,
    maxValuePerTxEth: '1.0',
    maxValuePerTxUsd: '1.0',
    maxOutflowPerTxUsd: null,
    maxValueForAutoApprovalEth: '0.1',
    maxDailyVolumeUsd: '10000',
    allowedContracts: [UNISWAP_ROUTER],
    allowedRecipients: [SELLER],
    allowedTokens: [USDC],
    cooldownSeconds: 60,
    expiresAt: null,
    pausedByOperatorAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── Per-field loosening rules ──────────────────────────────────────────────

describe('classifyPolicyChange', () => {
  describe('maxValuePerTxEth', () => {
    it('loosens when the limit increases', () => {
      const result = classifyPolicyChange(basePolicy(), { maxValuePerTxEth: '2.0' });
      expect(result).toEqual({ tightens: false, loosenedFields: ['maxValuePerTxEth'] });
    });

    it('tightens when the limit decreases', () => {
      const result = classifyPolicyChange(basePolicy(), { maxValuePerTxEth: '0.5' });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('is neutral when the limit is numerically unchanged', () => {
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxEth: '1' }).tightens).toBe(true);
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxEth: '1.00' }).tightens).toBe(true);
    });

    it('treats a non-numeric limit as unlimited (loosening)', () => {
      // PolicyService reads the limit through the same parser; null = no limit.
      const result = classifyPolicyChange(basePolicy(), { maxValuePerTxEth: 'unlimited' });
      expect(result.loosenedFields).toEqual(['maxValuePerTxEth']);
    });

    it.each(UNPARSABLE_LIMITS)(
      'treats %j as unlimited (loosening) — never as a tightening to 0 (S1 bypass)',
      (raw) => {
        const result = classifyPolicyChange(basePolicy(), { maxValuePerTxEth: raw });
        expect(result).toEqual({ tightens: false, loosenedFields: ['maxValuePerTxEth'] });
      },
    );

    it('still loosens against a tighter current limit, and against no policy row it is neutral-free: always loosening', () => {
      // Infinity > any finite limit, and Infinity > Infinity is false — so against
      // no policy row a bad value is "unchanged", exactly like the no-row baseline.
      expect(classifyPolicyChange(basePolicy({ maxValuePerTxEth: '0.01' }), { maxValuePerTxEth: '' }).tightens).toBe(false);
      expect(classifyPolicyChange(null, { maxValuePerTxEth: '' }).tightens).toBe(true);
    });
  });

  describe('maxDailyVolumeUsd', () => {
    it('loosens when the limit increases', () => {
      const result = classifyPolicyChange(basePolicy(), { maxDailyVolumeUsd: '20000' });
      expect(result.loosenedFields).toEqual(['maxDailyVolumeUsd']);
    });

    it.each(UNPARSABLE_LIMITS)('treats %j as no daily limit (loosening)', (raw) => {
      const result = classifyPolicyChange(basePolicy(), { maxDailyVolumeUsd: raw });
      expect(result).toEqual({ tightens: false, loosenedFields: ['maxDailyVolumeUsd'] });
    });

    it('tightens when the limit decreases', () => {
      const result = classifyPolicyChange(basePolicy(), { maxDailyVolumeUsd: '5000' });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('loosens when a positive limit is set to "0" (0 = no daily limit)', () => {
      const result = classifyPolicyChange(basePolicy(), { maxDailyVolumeUsd: '0' });
      expect(result.loosenedFields).toEqual(['maxDailyVolumeUsd']);
    });

    it('tightens when an unlimited ("0") policy gets a positive limit', () => {
      const result = classifyPolicyChange(basePolicy({ maxDailyVolumeUsd: '0' }), {
        maxDailyVolumeUsd: '100',
      });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });
  });

  describe('allowedContracts', () => {
    it('loosens when a non-empty whitelist is cleared', () => {
      const result = classifyPolicyChange(basePolicy(), { allowedContracts: [] });
      expect(result.loosenedFields).toEqual(['allowedContracts']);
    });

    it('loosens when it gains an address not in the current list', () => {
      const result = classifyPolicyChange(basePolicy(), {
        allowedContracts: [UNISWAP_ROUTER, AAVE_POOL],
      });
      expect(result.loosenedFields).toEqual(['allowedContracts']);
    });

    it('loosens when it is replaced by a different address', () => {
      const result = classifyPolicyChange(basePolicy(), { allowedContracts: [AAVE_POOL] });
      expect(result.loosenedFields).toEqual(['allowedContracts']);
    });

    it('tightens when it shrinks to a subset', () => {
      const current = basePolicy({ allowedContracts: [UNISWAP_ROUTER, AAVE_POOL] });
      const result = classifyPolicyChange(current, { allowedContracts: [AAVE_POOL] });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('compares addresses case-insensitively (checksummed vs lowercased)', () => {
      const result = classifyPolicyChange(basePolicy(), {
        allowedContracts: [UNISWAP_ROUTER.toLowerCase()],
      });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });

      const lowerCurrent = basePolicy({ allowedContracts: [UNISWAP_ROUTER.toLowerCase()] });
      expect(classifyPolicyChange(lowerCurrent, { allowedContracts: [UNISWAP_ROUTER] }).tightens).toBe(
        true,
      );
    });

    it('tightens when a whitelist is introduced against an empty (unrestricted) list', () => {
      const result = classifyPolicyChange(basePolicy({ allowedContracts: [] }), {
        allowedContracts: [AAVE_POOL],
      });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });
  });

  describe('maxValuePerTxUsd (Q8)', () => {
    it('loosens when the USD cap increases, tightens when it decreases, neutral when equal', () => {
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxUsd: '5' })).toEqual({
        tightens: false,
        loosenedFields: ['maxValuePerTxUsd'],
      });
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxUsd: '0.5' })).toEqual({ tightens: true, loosenedFields: [] });
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxUsd: '1.00' }).tightens).toBe(true);
    });

    it.each(UNPARSABLE_LIMITS)('a non-decimal value %j is unlimited, so it always loosens', (raw) => {
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxUsd: raw })).toEqual({
        tightens: false,
        loosenedFields: ['maxValuePerTxUsd'],
      });
    });

    it('is independent of maxValuePerTxEth (no cross-reading of units)', () => {
      // Raising the USD cap while lowering the ETH cap still loosens the USD field.
      const result = classifyPolicyChange(basePolicy(), { maxValuePerTxEth: '0.1', maxValuePerTxUsd: '100' });
      expect(result.loosenedFields).toEqual(['maxValuePerTxUsd']);
      // A current non-decimal (unlimited) USD cap can be tightened to a real one.
      expect(classifyPolicyChange(basePolicy({ maxValuePerTxUsd: 'unlimited' }), { maxValuePerTxUsd: '1000' }).tightens).toBe(true);
    });
  });

  describe('maxOutflowPerTxUsd (§5-6: NULL = not configured = most restrictive)', () => {
    it('setting ANY value from NULL loosens (operator only) — even "0"', () => {
      for (const value of ['0', '0.01', '25', '1000000']) {
        expect(classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: null }), { maxOutflowPerTxUsd: value })).toEqual({
          tightens: false,
          loosenedFields: ['maxOutflowPerTxUsd'],
        });
      }
    });

    it('NULL → NULL is neutral; a value → NULL tightens (blocks again)', () => {
      expect(classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: null }), { maxOutflowPerTxUsd: null }).tightens).toBe(true);
      expect(classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: '25' }), { maxOutflowPerTxUsd: null })).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('with a value: lowering tightens (the agent may), raising loosens, equal is neutral', () => {
      const current = basePolicy({ maxOutflowPerTxUsd: '25' });
      expect(classifyPolicyChange(current, { maxOutflowPerTxUsd: '10' })).toEqual({ tightens: true, loosenedFields: [] });
      expect(classifyPolicyChange(current, { maxOutflowPerTxUsd: '25.0' }).tightens).toBe(true);
      expect(classifyPolicyChange(current, { maxOutflowPerTxUsd: '25.01' })).toEqual({ tightens: false, loosenedFields: ['maxOutflowPerTxUsd'] });
    });

    it.each(UNPARSABLE_LIMITS)('a non-decimal value %j is unlimited, so it always loosens', (raw) => {
      expect(classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: '25' }), { maxOutflowPerTxUsd: raw }).loosenedFields).toEqual(['maxOutflowPerTxUsd']);
      expect(classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: null }), { maxOutflowPerTxUsd: raw }).loosenedFields).toEqual(['maxOutflowPerTxUsd']);
    });

    it('with no policy row (no restrictions) any value — NULL included — tightens', () => {
      expect(classifyPolicyChange(null, { maxOutflowPerTxUsd: '1000000' }).tightens).toBe(true);
      expect(classifyPolicyChange(null, { maxOutflowPerTxUsd: null }).tightens).toBe(true);
    });

    it('is independent of maxValuePerTxEth and maxValuePerTxUsd (no unit cross-reading)', () => {
      const result = classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: null }), { maxValuePerTxEth: '0.1', maxValuePerTxUsd: '0.5', maxOutflowPerTxUsd: '10' });
      expect(result.loosenedFields).toEqual(['maxOutflowPerTxUsd']);
    });

    it('an omitted field never loosens', () => {
      expect(classifyPolicyChange(basePolicy({ maxOutflowPerTxUsd: null }), { cooldownSeconds: 120 }).tightens).toBe(true);
    });
  });

  describe('allowedRecipients (Q8)', () => {
    it('loosens when a non-empty list is cleared or gains an address', () => {
      expect(classifyPolicyChange(basePolicy(), { allowedRecipients: [] }).loosenedFields).toEqual(['allowedRecipients']);
      expect(classifyPolicyChange(basePolicy(), { allowedRecipients: [SELLER, PROVIDER] }).loosenedFields).toEqual([
        'allowedRecipients',
      ]);
      expect(classifyPolicyChange(basePolicy(), { allowedRecipients: [PROVIDER] }).loosenedFields).toEqual(['allowedRecipients']);
    });

    it('tightens or is neutral for a subset / the same list in another case', () => {
      const current = basePolicy({ allowedRecipients: [SELLER, PROVIDER] });
      expect(classifyPolicyChange(current, { allowedRecipients: [PROVIDER] })).toEqual({ tightens: true, loosenedFields: [] });
      expect(classifyPolicyChange(basePolicy(), { allowedRecipients: [SELLER.toUpperCase().replace('0X', '0x')] }).tightens).toBe(
        true,
      );
    });

    it('tightens when a list is introduced against an empty (unrestricted) one', () => {
      expect(classifyPolicyChange(basePolicy({ allowedRecipients: [] }), { allowedRecipients: [PROVIDER] })).toEqual({
        tightens: true,
        loosenedFields: [],
      });
    });

    it('is judged against the current recipients, never against allowedContracts', () => {
      // The router is an allowed CONTRACT, not an allowed recipient: adding it as a recipient loosens.
      expect(classifyPolicyChange(basePolicy(), { allowedRecipients: [SELLER, UNISWAP_ROUTER] }).loosenedFields).toEqual([
        'allowedRecipients',
      ]);
    });
  });

  describe('allowedTokens', () => {
    it('loosens when a non-empty whitelist is cleared', () => {
      const result = classifyPolicyChange(basePolicy(), { allowedTokens: [] });
      expect(result.loosenedFields).toEqual(['allowedTokens']);
    });

    it('loosens when it gains an address not in the current list', () => {
      const result = classifyPolicyChange(basePolicy(), { allowedTokens: [USDC, WETH] });
      expect(result.loosenedFields).toEqual(['allowedTokens']);
    });

    it('is neutral for the same list in a different case', () => {
      const result = classifyPolicyChange(basePolicy(), { allowedTokens: [USDC.toLowerCase()] });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('tightens when a whitelist is introduced against an empty (unrestricted) list', () => {
      const result = classifyPolicyChange(basePolicy({ allowedTokens: [] }), { allowedTokens: [WETH] });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });
  });

  describe('cooldownSeconds', () => {
    it('loosens when the cooldown decreases', () => {
      const result = classifyPolicyChange(basePolicy(), { cooldownSeconds: 30 });
      expect(result.loosenedFields).toEqual(['cooldownSeconds']);
    });

    it('loosens when the cooldown is removed (0)', () => {
      const result = classifyPolicyChange(basePolicy(), { cooldownSeconds: 0 });
      expect(result.loosenedFields).toEqual(['cooldownSeconds']);
    });

    it('tightens when the cooldown increases', () => {
      const result = classifyPolicyChange(basePolicy(), { cooldownSeconds: 120 });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('is neutral when unchanged, and treats negative values like 0', () => {
      expect(classifyPolicyChange(basePolicy(), { cooldownSeconds: 60 }).tightens).toBe(true);
      expect(classifyPolicyChange(basePolicy({ cooldownSeconds: 0 }), { cooldownSeconds: -5 }).tightens).toBe(
        true,
      );
    });
  });

  describe('active', () => {
    it('loosens when a paused policy is re-activated (false → true)', () => {
      const result = classifyPolicyChange(basePolicy({ active: false }), { active: true });
      expect(result).toEqual({ tightens: false, loosenedFields: ['active'] });
    });

    it('tightens when the policy is paused (true → false)', () => {
      const result = classifyPolicyChange(basePolicy({ active: true }), { active: false });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('is neutral when unchanged', () => {
      expect(classifyPolicyChange(basePolicy({ active: true }), { active: true }).tightens).toBe(true);
      expect(classifyPolicyChange(basePolicy({ active: false }), { active: false }).tightens).toBe(true);
    });
  });

  describe('expiresAt', () => {
    it('loosens when an existing expiry is removed (null)', () => {
      const result = classifyPolicyChange(basePolicy({ expiresAt: EXPIRY }), { expiresAt: null });
      expect(result).toEqual({ tightens: false, loosenedFields: ['expiresAt'] });
    });

    it('loosens when an existing expiry is moved later', () => {
      const result = classifyPolicyChange(basePolicy({ expiresAt: EXPIRY }), { expiresAt: LATER });
      expect(result.loosenedFields).toEqual(['expiresAt']);
    });

    it('tightens when an existing expiry is moved earlier', () => {
      const result = classifyPolicyChange(basePolicy({ expiresAt: EXPIRY }), { expiresAt: EARLIER });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('tightens when an expiry is added to a permanent policy', () => {
      const result = classifyPolicyChange(basePolicy({ expiresAt: null }), { expiresAt: EXPIRY });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('is neutral when clearing an expiry that did not exist, or re-setting the same one', () => {
      expect(classifyPolicyChange(basePolicy({ expiresAt: null }), { expiresAt: null }).tightens).toBe(true);
      expect(
        classifyPolicyChange(basePolicy({ expiresAt: EXPIRY }), { expiresAt: new Date(EXPIRY) }).tightens,
      ).toBe(true);
    });
  });

  // ── No policy row yet ──────────────────────────────────────────────────

  describe('when there is no current policy (null)', () => {
    it('treats any patch that sets limits as tightening', () => {
      const result = classifyPolicyChange(null, {
        maxValuePerTxEth: '100',
        maxValuePerTxUsd: '100',
        maxDailyVolumeUsd: '1000000',
        allowedContracts: [UNISWAP_ROUTER],
        allowedRecipients: [SELLER],
        allowedTokens: [USDC],
        cooldownSeconds: 1,
        expiresAt: EXPIRY,
      });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('accepts active: true as neutral', () => {
      expect(classifyPolicyChange(null, { active: true })).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('treats active: false as tightening', () => {
      expect(classifyPolicyChange(null, { active: false })).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('treats "no limit" values as neutral', () => {
      const result = classifyPolicyChange(null, {
        maxDailyVolumeUsd: '0',
        allowedContracts: [],
        allowedTokens: [],
        cooldownSeconds: 0,
        expiresAt: null,
      });
      expect(result).toEqual({ tightens: true, loosenedFields: [] });
    });

    it('treats an empty patch as neutral', () => {
      expect(classifyPolicyChange(null, {})).toEqual({ tightens: true, loosenedFields: [] });
    });
  });

  // ── Aggregation ────────────────────────────────────────────────────────

  it('reports every loosened field in canonical order', () => {
    const current = basePolicy({ active: false, expiresAt: EXPIRY });
    const result = classifyPolicyChange(current, {
      expiresAt: null,
      active: true,
      cooldownSeconds: 0,
      allowedTokens: [],
      allowedRecipients: [],
      allowedContracts: [],
      maxDailyVolumeUsd: '99999',
      maxValuePerTxUsd: '10',
      maxValuePerTxEth: '10',
    });
    expect(result.tightens).toBe(false);
    expect(result.loosenedFields).toEqual([
      'maxValuePerTxEth',
      'maxValuePerTxUsd',
      'maxDailyVolumeUsd',
      'allowedContracts',
      'allowedRecipients',
      'allowedTokens',
      'cooldownSeconds',
      'active',
      'expiresAt',
    ]);
  });

  it('only reports the loosened fields of a mixed patch', () => {
    const result = classifyPolicyChange(basePolicy(), {
      maxValuePerTxEth: '0.1', // tighter
      cooldownSeconds: 10, // looser
      allowedTokens: [USDC], // unchanged
    });
    expect(result).toEqual({ tightens: false, loosenedFields: ['cooldownSeconds'] });
  });

  it('never flags fields absent from the patch', () => {
    const current = basePolicy({ active: false, expiresAt: EXPIRY, maxValuePerTxEth: '0' });
    expect(classifyPolicyChange(current, {})).toEqual({ tightens: true, loosenedFields: [] });
  });
});

// ── Patch helpers ──────────────────────────────────────────────────────────

describe('toPolicyPatch', () => {
  it('drops undefined keys and ignores unknown keys', () => {
    const patch = toPolicyPatch({
      maxValuePerTxEth: '0.5',
      maxDailyVolumeUsd: undefined,
      allowedContracts: undefined,
      ...({ syncOnChain: true } as object),
    });
    expect(patch).toEqual({ maxValuePerTxEth: '0.5' });
    expect(Object.keys(patch)).toEqual(['maxValuePerTxEth']);
  });

  it('keeps expiresAt: null (an explicit clear) as a change', () => {
    const patch = toPolicyPatch({ expiresAt: null });
    expect(patch).toEqual({ expiresAt: null });
    expect(changedPolicyFields(patch)).toEqual(['expiresAt']);
  });
});

describe('changedPolicyFields', () => {
  it('lists present fields in canonical order regardless of patch key order', () => {
    const fields = changedPolicyFields({ active: false, maxValuePerTxEth: '0.1', cooldownSeconds: 90 });
    expect(fields).toEqual(['maxValuePerTxEth', 'cooldownSeconds', 'active']);
  });

  it('returns an empty list for an empty patch', () => {
    expect(changedPolicyFields({})).toEqual([]);
  });
});

// ── Shared limit parser (used by classifier AND PolicyService) ─────────────

describe('parsePolicyDecimal / isPolicyDecimal', () => {
  it('accepts plain non-negative decimals', () => {
    expect(parsePolicyDecimal('0')).toBe(0);
    expect(parsePolicyDecimal('0.5')).toBe(0.5);
    expect(parsePolicyDecimal('10000')).toBe(10000);
    expect(parsePolicyDecimal('1.00')).toBe(1);
    expect(isPolicyDecimal('123.456')).toBe(true);
  });

  it.each(UNPARSABLE_LIMITS)('rejects %j (null = unlimited for every reader)', (raw) => {
    expect(isPolicyDecimal(raw)).toBe(false);
    expect(parsePolicyDecimal(raw)).toBeNull();
  });

  it('rejects signs, trailing dots, and non-strings', () => {
    expect(parsePolicyDecimal('-1')).toBeNull();
    expect(parsePolicyDecimal('+1')).toBeNull();
    expect(parsePolicyDecimal('1.')).toBeNull();
    expect(parsePolicyDecimal('.5')).toBeNull();
    expect(parsePolicyDecimal(null)).toBeNull();
    expect(parsePolicyDecimal(undefined)).toBeNull();
    expect(isPolicyDecimal(5)).toBe(false);
  });

  it('replaces the Number() / parseFloat() split that produced the S1 bypass', () => {
    expect(Number('')).toBe(0);
    expect(Number.isNaN(parseFloat(''))).toBe(true);
    expect(Number('0x10')).toBe(16);
    expect(parseFloat('0x10')).toBe(0);
    expect(parsePolicyDecimal('')).toBeNull();
    expect(parsePolicyDecimal('0x10')).toBeNull();
  });
});
