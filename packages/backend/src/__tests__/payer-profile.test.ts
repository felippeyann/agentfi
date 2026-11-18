/**
 * Unit tests — the payer profile (`services/policy/payer-profile.ts`) behind
 * `x402:ops payer`: it must read a policy row exactly as the enforcers do
 * (evaluateUsdcSpend, judgeOutflowCap, the batch calldata rule), and the
 * reference payer verdict must fail for every row that leaves a way open.
 */
import { describe, expect, it } from 'vitest';
import { describePayerProfile, renderPayerProfile, type PayerProfilePolicy } from '../services/policy/payer-profile.js';
import { evaluateUsdcSpend } from '../services/policy/usdc-spend-policy.js';
import { judgeOutflowCap } from '../services/policy/outflow-cap.js';
import { DEFAULT_AGENT_POLICY } from '../services/policy/policy-authority.js';
import { parseOpsArgs } from '../scripts/x402-ops.js';

describe('x402:ops payer arguments', () => {
  it('needs --agent, takes --json, refuses --apply', () => {
    expect(parseOpsArgs(['payer'])).toBe('payer needs --agent <id>');
    expect(parseOpsArgs(['payer', '--agent', 'a1', '--json'])).toMatchObject({ command: 'payer', agentId: 'a1', json: true, apply: false });
    expect(parseOpsArgs(['payer', '--agent', 'a1', '--apply'])).toBe('--apply does not apply to payer');
  });
});

const SELLER = '0x00000000000000000000000000000000000000b0';
const OTHER = '0x00000000000000000000000000000000000000c1';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NOW = new Date('2026-11-18T12:00:00Z');
const AGENT = { id: 'agent-1', name: 'buyer', active: true, safeAddress: '0x00000000000000000000000000000000000000a1', chainIds: [84532] };

/** The reference payer of docs/alpha/payer-setup.md (and of the section 10 demo). */
function reference(overrides: Partial<PayerProfilePolicy> = {}): PayerProfilePolicy {
  return {
    active: true,
    expiresAt: null,
    maxValuePerTxUsd: '0.50',
    maxDailyVolumeUsd: '3.00',
    maxOutflowPerTxUsd: null,
    allowedTokens: [USDC],
    allowedRecipients: [SELLER],
    allowedContracts: [],
    ...overrides,
  };
}

const codes = (p: PayerProfilePolicy | null, agent = AGENT) => describePayerProfile(agent, p, NOW).findings.map((f) => f.code);

describe('payer profile', () => {
  it('the reference policy is the reference payer, with both ceilings, the listed seller and outflows refused', () => {
    const p = describePayerProfile(AGENT, reference(), NOW);
    expect(p.referencePayer).toBe(true);
    expect(p.findings).toEqual([]);
    expect(p.x402).toEqual({ perPaymentUsd: '0.5', dailyUsd: '3', recipients: [SELLER], tokens: [USDC], refusedNowBecause: null });
    expect(p.ordinaryOutflows.verdict).toBe('refused');
    expect(p.batchOtherCalls.verdict).toBe('refused-unless-listed');
    expect(renderPayerProfile(p)).toContain('verdict: REFERENCE PAYER');
  });

  it('agrees with the enforcers on the reference policy', () => {
    const policy = reference();
    // x402: the listed seller at the cap passes; above the cap, another payee, or past the day are refused.
    expect(evaluateUsdcSpend(policy, { amount: 500_000n, token: USDC, recipient: SELLER, spentTodayMicroUsd: 0n, now: NOW }).allowed).toBe(true);
    expect(evaluateUsdcSpend(policy, { amount: 500_001n, token: USDC, recipient: SELLER, spentTodayMicroUsd: 0n, now: NOW }).allowed).toBe(false);
    expect(evaluateUsdcSpend(policy, { amount: 100_000n, token: USDC, recipient: OTHER, spentTodayMicroUsd: 0n, now: NOW }).allowed).toBe(false);
    expect(evaluateUsdcSpend(policy, { amount: 100_000n, token: USDC, recipient: SELLER, spentTodayMicroUsd: 2_950_000n, now: NOW }).allowed).toBe(false);
    // ordinary outflows: refused because the cap is not configured.
    const outflow = judgeOutflowCap(policy, { status: 'priced', usd: '0.01', source: 'usdc-peg' });
    expect(outflow.allowed).toBe(false);
    expect(!outflow.allowed && outflow.code).toBe('USD_CAP_NOT_CONFIGURED');
  });

  it('no policy row: unrestricted everywhere, never the reference payer', () => {
    const p = describePayerProfile(AGENT, null, NOW);
    expect(p.hasPolicyRow).toBe(false);
    expect(p.referencePayer).toBe(false);
    expect(p.ordinaryOutflows.verdict).toBe('unrestricted');
    expect(codes(null)).toEqual(['NO_POLICY_ROW']);
    expect(renderPayerProfile(p)).toContain('policy row: NO');
    // the enforcers agree: no row = no restrictions
    expect(evaluateUsdcSpend(null, { amount: 10n ** 12n, token: USDC, recipient: OTHER, spentTodayMicroUsd: 0n }).allowed).toBe(true);
    expect(judgeOutflowCap(null, { status: 'priced', usd: '1000000', source: 'usdc-peg' }).allowed).toBe(true);
  });

  it('the registration defaults (no explicit policy) are NOT a reference payer: any recipient', () => {
    const p = describePayerProfile(AGENT, { ...DEFAULT_AGENT_POLICY, allowedContracts: [], allowedRecipients: [], allowedTokens: [] }, NOW);
    expect(p.referencePayer).toBe(false);
    expect(p.findings.map((f) => f.code)).toEqual(['ANY_RECIPIENT', 'ANY_USDC_TOKEN']);
    expect(p.x402.perPaymentUsd).toBe('1');
    expect(p.x402.dailyUsd).toBe('10000');
    expect(p.ordinaryOutflows.verdict).toBe('refused');
  });

  it('an empty recipient list means any recipient', () => {
    expect(codes(reference({ allowedRecipients: [] }))).toEqual(['ANY_RECIPIENT']);
    expect(describePayerProfile(AGENT, reference({ allowedRecipients: [] }), NOW).x402.recipients).toBeNull();
    expect(evaluateUsdcSpend(reference({ allowedRecipients: [] }), { amount: 1n, token: USDC, recipient: OTHER, spentTodayMicroUsd: 0n, now: NOW }).allowed).toBe(true);
  });

  it('"0" or an unparsable daily limit is no daily limit, and switches off the batch calldata check', () => {
    for (const daily of ['0', '0.000', 'unlimited']) {
      const p = describePayerProfile(AGENT, reference({ maxDailyVolumeUsd: daily }), NOW);
      expect(p.x402.dailyUsd).toBeNull();
      expect(p.batchOtherCalls.verdict).toBe('not-checked');
      expect(p.findings.map((f) => f.code)).toEqual(['NO_DAILY_LIMIT']);
    }
  });

  it('a set outflow cap opens transfers / swaps, and says so', () => {
    const p = describePayerProfile(AGENT, reference({ maxOutflowPerTxUsd: '25' }), NOW);
    expect(p.ordinaryOutflows).toMatchObject({ verdict: 'capped', capUsd: '25' });
    expect(p.findings.map((f) => f.code)).toEqual(['OUTFLOWS_OPEN']);
    const unparsable = describePayerProfile(AGENT, reference({ maxOutflowPerTxUsd: 'lots' }), NOW);
    expect(unparsable.ordinaryOutflows.verdict).toBe('unrestricted');
    expect(unparsable.referencePayer).toBe(false);
  });

  it('an unparsable per-payment cap is no per-payment limit', () => {
    const p = describePayerProfile(AGENT, reference({ maxValuePerTxUsd: '1e6' }), NOW);
    expect(p.x402.perPaymentUsd).toBeNull();
    expect(p.findings.map((f) => f.code)).toEqual(['NO_PER_PAYMENT_CAP']);
  });

  it('paused, expired or deactivated: every payment refused right now, flagged BLOCKED', () => {
    const paused = describePayerProfile(AGENT, reference({ active: false }), NOW);
    expect(paused.x402.refusedNowBecause).toBe('policy paused');
    expect(paused.batchOtherCalls.verdict).toBe('not-checked'); // validateTransaction refuses the batch first
    expect(paused.findings.map((f) => f.level)).toEqual(['BLOCKED']);
    const expired = describePayerProfile(AGENT, reference({ expiresAt: new Date('2026-11-01T00:00:00Z') }), NOW);
    expect(expired.x402.refusedNowBecause).toMatch(/^policy expired/);
    const inactive = describePayerProfile({ ...AGENT, active: false }, reference(), NOW);
    expect(inactive.x402.refusedNowBecause).toBe('agent deactivated');
    expect(inactive.referencePayer).toBe(false);
    expect(renderPayerProfile(inactive)).toContain('[DEACTIVATED]');
  });

  it('allowedContracts listed: batch calls to them pass uncounted (an approve too), so it is a RISK', () => {
    const p = describePayerProfile(AGENT, reference({ allowedContracts: [USDC] }), NOW);
    expect(p.batchOtherCalls.text).toMatch(/unless the target is one of 1 allowedContracts/);
    expect(p.findings.map((f) => f.code)).toEqual(['CONTRACT_CALLS_OPEN']);
    expect(p.referencePayer).toBe(false);
    // the outflow cap does not see such a call: it prices to zero, and zero passes even when the cap is NULL
    expect(judgeOutflowCap(reference({ allowedContracts: [USDC] }), { status: 'zero' }).allowed).toBe(true);
  });
});
