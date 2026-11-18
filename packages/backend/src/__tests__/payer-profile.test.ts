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
import { DEFAULT_AGENT_POLICY, classifyPolicyChange } from '../services/policy/policy-authority.js';
import { parseOpsArgs, runOps } from '../scripts/x402-ops.js';
import type { AgentPolicy } from '@prisma/client';

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

/** The reference payer of docs/alpha/payer-setup.md (the section 10 demo buyer is close to it). */
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
    expect(p.findings.map((f) => f.code)).toEqual(['AGENT_CAN_LIST_CONTRACTS']);
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
    expect(p.findings.map((f) => f.code)).toEqual(['ANY_RECIPIENT', 'ANY_USDC_TOKEN', 'AGENT_CAN_LIST_CONTRACTS']);
    expect(p.x402.perPaymentUsd).toBe('1');
    expect(p.x402.dailyUsd).toBe('10000');
    expect(p.ordinaryOutflows.verdict).toBe('refused');
  });

  it('an empty recipient list means any recipient', () => {
    expect(codes(reference({ allowedRecipients: [] }))).toEqual(['ANY_RECIPIENT', 'AGENT_CAN_LIST_CONTRACTS']);
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
    expect(p.findings.map((f) => f.code)).toEqual(['OUTFLOWS_OPEN', 'AGENT_CAN_LIST_CONTRACTS']);
    const unparsable = describePayerProfile(AGENT, reference({ maxOutflowPerTxUsd: 'lots' }), NOW);
    expect(unparsable.ordinaryOutflows.verdict).toBe('unrestricted');
    expect(unparsable.referencePayer).toBe(false);
  });

  it('an unparsable per-payment cap is no per-payment limit', () => {
    const p = describePayerProfile(AGENT, reference({ maxValuePerTxUsd: '1e6' }), NOW);
    expect(p.x402.perPaymentUsd).toBeNull();
    expect(p.findings.map((f) => f.code)).toEqual(['NO_PER_PAYMENT_CAP', 'AGENT_CAN_LIST_CONTRACTS']);
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

  it('an outflow cap of "0" refuses like NULL and is not flagged as open', () => {
    const p = describePayerProfile(AGENT, reference({ maxOutflowPerTxUsd: '0' }), NOW);
    expect(p.ordinaryOutflows).toMatchObject({ verdict: 'refused', capUsd: '0' });
    expect(p.referencePayer).toBe(true);
    expect(judgeOutflowCap(reference({ maxOutflowPerTxUsd: '0' }), { status: 'priced', usd: '0.01', source: 'usdc-peg' }).allowed).toBe(false);
  });

  it('the agent key CAN fill an empty allowedContracts (counted as tightening): the profile says so, and after it the row is no longer the reference payer', () => {
    const row = { ...reference(), id: 'p', agentId: AGENT.id, maxValuePerTxEth: '1.0', maxValueForAutoApprovalEth: '0.1', cooldownSeconds: 60, pausedByOperatorAt: null, updatedAt: NOW } as AgentPolicy;
    const verdict = classifyPolicyChange(row, { allowedContracts: [USDC] });
    expect(verdict).toMatchObject({ tightens: true, loosenedFields: [] });
    expect(codes(reference())).toContain('AGENT_CAN_LIST_CONTRACTS');
    expect(describePayerProfile(AGENT, reference({ allowedContracts: [USDC] }), NOW).referencePayer).toBe(false);
    // every OTHER way the key could widen the reference row is refused by the classifier
    for (const patch of [{ maxValuePerTxUsd: '0.51' }, { maxDailyVolumeUsd: '0' }, { maxDailyVolumeUsd: '3.01' }, { allowedRecipients: [] }, { allowedRecipients: [SELLER, OTHER] }, { maxOutflowPerTxUsd: '1' }, { allowedTokens: [] }]) {
      expect(classifyPolicyChange(row, patch as never).tightens, JSON.stringify(patch)).toBe(false);
    }
  });

  it('a stored daily limit below one micro-dollar still turns on the batch check, as the route reads it', () => {
    const p = describePayerProfile(AGENT, reference({ maxDailyVolumeUsd: '0.0000001' }), NOW);
    expect(p.batchOtherCalls.verdict).toBe('refused-unless-listed');
    expect(p.x402.dailyUsd).toBeNull(); // evaluateUsdcSpend reads it in micro-USD: no x402 daily limit
  });
});

describe('x402:ops payer (runOps)', () => {
  const policyRow = { ...reference(), id: 'p', agentId: AGENT.id };
  const fakeDb = (agent: unknown) => ({ agent: { findUnique: async () => agent } }) as never;
  it('prints the profile, JSON with --json, and exits 1 for an unknown agent', async () => {
    const lines: string[] = [];
    expect(await runOps({ command: 'payer', agentId: AGENT.id, apply: false, json: false, head: { tag: 'finalized' } }, { db: fakeDb({ ...AGENT, policy: policyRow }), rpcFor: () => '', print: (l) => lines.push(l) })).toBe(0);
    expect(lines.join('\n')).toContain('verdict: REFERENCE PAYER');
    lines.length = 0;
    expect(await runOps({ command: 'payer', agentId: AGENT.id, apply: false, json: true, head: { tag: 'finalized' } }, { db: fakeDb({ ...AGENT, policy: null }), rpcFor: () => '', print: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ hasPolicyRow: false, referencePayer: false });
    lines.length = 0;
    expect(await runOps({ command: 'payer', agentId: 'nope', apply: false, json: false, head: { tag: 'finalized' } }, { db: fakeDb(null), rpcFor: () => '', print: (l) => lines.push(l) })).toBe(1);
    expect(lines).toEqual(['No agent nope']);
  });
});
