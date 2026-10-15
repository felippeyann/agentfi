/**
 * C5 escrow validation runner — the pure plan (src/scripts/c5/plan.ts): the
 * approved amounts, the next-step decisions that make a rerun safe, the
 * window / hold arithmetic and the settlement checks. The runner itself is
 * exercised end to end on the Base Sepolia fork (docs/project/c5-escrow-validation.md §7).
 */
import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toBytes, type Address } from 'viem';
import {
  C5_CONTEST_WINDOW_SECONDS,
  C5_REPUTATION_REGISTRY,
  CHAIN_STATUS,
  authorityState,
  check,
  HOLD_MARGIN_SECONDS,
  MIN_ETH_WEI,
  PLANNED_GAS,
  PROVIDER_POLICY,
  SCENARIO_BUDGET,
  TOTAL_BUDGET_UNITS,
  expectedOutcome,
  feeUnits,
  holdSecondsLeft,
  jobViewChecks,
  nextStep,
  nonceCheck,
  requesterPolicy,
  requiredEthWei,
  settlementChecks,
  windowCheck,
  type DecodedEvent,
  type JobSnapshot,
  type Scenario,
} from '../scripts/c5/plan.js';

const REQUESTER = getAddress('0x1000000000000000000000000000000000000001');
const PROVIDER = getAddress('0x2000000000000000000000000000000000000002');
const ESCROW = getAddress('0x3000000000000000000000000000000000000003');
const HOOK = getAddress('0x4000000000000000000000000000000000000004');
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const EVALUATOR = getAddress('0x5000000000000000000000000000000000000005');
const STRANGER = getAddress('0x6000000000000000000000000000000000000006');
const JOB = 7n;
const AGENT = 9599n;

function job(status: string, onChainStatus: string | null, extra: Partial<NonNullable<JobSnapshot['escrow']>> = {}): JobSnapshot {
  return { status, escrow: { onChainStatus, providerAgentIdStatus: null, contestedAt: null, resolution: null, settleTxHash: null, ...extra } };
}

describe('the approved plan', () => {
  it('budgets: 2.0 / 1.5 / 1.0 USDC, 4.5 in total, each ≥ the hook minimum so feedback can be written', () => {
    expect(SCENARIO_BUDGET.happy.units).toBe(2_000_000n);
    expect(SCENARIO_BUDGET.contest.units).toBe(1_500_000n);
    expect(SCENARIO_BUDGET.cancel.units).toBe(1_000_000n);
    expect(TOTAL_BUDGET_UNITS).toBe(4_500_000n);
    for (const s of ['happy', 'contest'] as const) expect(SCENARIO_BUDGET[s].units).toBeGreaterThanOrEqual(1_000_000n);
  });

  it('fee 30 bps of the happy budget = 6 000 units; payout 1 994 000; refunds are the full budget', () => {
    expect(feeUnits(2_000_000n)).toBe(6_000n);
    expect(expectedOutcome('happy')).toMatchObject({ payoutUnits: 1_994_000n, feeUnits: 6_000n, refundUnits: 0n, chainStatus: CHAIN_STATUS.Completed });
    expect(expectedOutcome('contest')).toMatchObject({ payoutUnits: 0n, feeUnits: 0n, refundUnits: 1_500_000n, chainStatus: CHAIN_STATUS.Rejected, resolution: 'quality-rejected' });
    expect(expectedOutcome('cancel')).toMatchObject({ payoutUnits: 0n, feeUnits: 0n, refundUnits: 1_000_000n, feedback: { status: 'skipped:no-params' } });
  });

  it('policies: no maxOutflowPerTxUsd anywhere (ordinary outflows stay blocked); the requester may only pay the provider', () => {
    const requester = requesterPolicy(PROVIDER);
    expect(requester).not.toHaveProperty('maxOutflowPerTxUsd');
    expect(PROVIDER_POLICY).not.toHaveProperty('maxOutflowPerTxUsd');
    expect(requester.allowedRecipients).toEqual([PROVIDER]);
    expect(Number(requester.maxValuePerTxUsd)).toBeGreaterThanOrEqual(Number(SCENARIO_BUDGET.happy.amount));
    expect(Number(requester.maxDailyVolumeUsd) * 1_000_000).toBeGreaterThanOrEqual(Number(TOTAL_BUDGET_UNITS));
    expect(requester.cooldownSeconds).toBe(0);
  });

  it('the window is the approved 3600 s', () => {
    expect(C5_CONTEST_WINDOW_SECONDS).toBe(3600);
  });
});

describe('nextStep — every action is chosen from the current state, so a rerun repeats nothing', () => {
  it('waits while the funding chain runs', () => {
    for (const on of ['CREATING', 'OPEN', 'BUDGET_SET', 'APPROVED']) expect(nextStep('happy', job('PENDING', on)).kind).toBe('wait');
  });

  it('happy: accept once FUNDED, deliver only after BOUND, then wait through submit, window and settlement', () => {
    expect(nextStep('happy', job('PENDING', 'FUNDED')).kind).toBe('accept');
    expect(nextStep('happy', job('ACCEPTED', 'FUNDED', { providerAgentIdStatus: 'BINDING' })).kind).toBe('wait');
    expect(nextStep('happy', job('ACCEPTED', 'FUNDED', { providerAgentIdStatus: 'BOUND' })).kind).toBe('deliver');
    expect(nextStep('happy', job('PAYMENT_PENDING', 'FUNDED', { providerAgentIdStatus: 'BOUND' })).kind).toBe('wait');
    expect(nextStep('happy', job('PAYMENT_PENDING', 'SUBMITTED')).kind).toBe('wait');
    expect(nextStep('happy', job('PAYMENT_PENDING', 'SETTLING')).kind).toBe('wait');
    expect(nextStep('happy', job('COMPLETED', 'COMPLETED')).kind).toBe('done');
  });

  it('happy: a failed or skipped binding stops before the submit (the feedback would be skipped)', () => {
    expect(nextStep('happy', job('ACCEPTED', 'FUNDED', { providerAgentIdStatus: 'FAILED' }))).toMatchObject({ kind: 'stop' });
    expect(nextStep('happy', job('ACCEPTED', 'FUNDED', { providerAgentIdStatus: 'SKIPPED' }))).toMatchObject({ kind: 'stop' });
  });

  it('contest: contest once SUBMITTED and never twice; hold while CONTESTED; follow the settlement once resolved', () => {
    expect(nextStep('contest', job('PAYMENT_PENDING', 'SUBMITTED')).kind).toBe('contest');
    expect(nextStep('contest', job('PAYMENT_PENDING', 'SUBMITTED', { contestedAt: '2026-10-15T10:00:00Z' })).kind).toBe('wait');
    expect(nextStep('contest', job('PAYMENT_PENDING', 'CONTESTED', { contestedAt: 'x' })).kind).toBe('hold');
    expect(nextStep('contest', job('PAYMENT_PENDING', 'CONTESTED', { contestedAt: 'x', resolution: 'quality-rejected' })).kind).toBe('wait');
    expect(nextStep('contest', job('PAYMENT_FAILED', 'REJECTED')).kind).toBe('done');
  });

  it('cancel: cancel once FUNDED and only from PENDING; then wait for the refund', () => {
    expect(nextStep('cancel', job('PENDING', 'FUNDED')).kind).toBe('cancel');
    expect(nextStep('cancel', job('CANCELLED', 'FUNDED')).kind).toBe('wait');
    expect(nextStep('cancel', job('CANCELLED', 'REJECTED')).kind).toBe('done');
    expect(nextStep('cancel', job('ACCEPTED', 'FUNDED'))).toMatchObject({ kind: 'stop' });
  });

  it('stops on any outcome the scenario does not expect', () => {
    expect(nextStep('happy', job('PAYMENT_FAILED', 'REJECTED'))).toMatchObject({ kind: 'stop', reason: expect.stringContaining('expected COMPLETED') });
    expect(nextStep('contest', job('COMPLETED', 'COMPLETED'))).toMatchObject({ kind: 'stop' });
    expect(nextStep('cancel', job('COMPLETED', 'COMPLETED'))).toMatchObject({ kind: 'stop' });
    expect(nextStep('happy', job('PAYMENT_PENDING', 'CONTESTED'))).toMatchObject({ kind: 'stop' });
    expect(nextStep('happy', job('PENDING', 'FAILED'))).toMatchObject({ kind: 'stop' });
    expect(nextStep('happy', job('PENDING', 'EXPIRED'))).toMatchObject({ kind: 'stop' });
    expect(nextStep('happy', { status: 'PENDING', escrow: null })).toMatchObject({ kind: 'stop' });
  });
});

describe('recorded authority checks (#189 review)', () => {
  it('missing → run them; all ok → passed; any recorded failure → failed (never skipped on a rerun)', () => {
    expect(authorityState(undefined)).toBe('missing');
    expect(authorityState([])).toBe('missing');
    expect(authorityState([check('a', 401, 401), check('b', 'Unauthorized', 'Unauthorized')])).toBe('passed');
    expect(authorityState([check('a', 401, 401), check('b', 'Unauthorized', 'would succeed')])).toBe('failed');
  });
});

describe('window and hold', () => {
  it('the hold counts as proven only at submit + 3600 + margin', () => {
    const submitted = 1_000_000n;
    const proven = submitted + BigInt(C5_CONTEST_WINDOW_SECONDS + HOLD_MARGIN_SECONDS);
    expect(holdSecondsLeft(submitted, proven - 1n)).toBe(1n);
    expect(holdSecondsLeft(submitted, proven)).toBe(0n);
    expect(holdSecondsLeft(submitted, submitted)).toBe(BigInt(C5_CONTEST_WINDOW_SECONDS + HOLD_MARGIN_SECONDS));
  });

  it('a settlement earlier than the window fails the check (the window was shorter than approved)', () => {
    expect(windowCheck(1_000n, 4_600n).ok).toBe(true);
    expect(windowCheck(1_000n, 4_599n).ok).toBe(false);
  });
});

describe('settlementChecks — the settle transaction moves exactly the approved value', () => {
  const ev = (address: Address, eventName: string, args: Record<string, unknown>): DecodedEvent => ({ address, eventName, args });
  const happyEvents = (): DecodedEvent[] => [
    ev(ESCROW, 'JobCompleted', { jobId: JOB, evaluator: EVALUATOR, reason: keccak256(toBytes('agentfi.completed')) }),
    ev(USDC, 'Transfer', { from: ESCROW, to: PROVIDER, value: 1_994_000n }),
    ev(ESCROW, 'PaymentReleased', { jobId: JOB, provider: PROVIDER, amount: 1_994_000n }),
    ev(ESCROW, 'PlatformFeeAccrued', { jobId: JOB, amount: 6_000n }),
    ev(HOOK, 'FeedbackWritten', { jobId: JOB, agentId: AGENT, value: 100n }),
    ev(C5_REPUTATION_REGISTRY, 'NewFeedback', { agentId: AGENT, clientAddress: HOOK, value: 100n, tag1: 'agentfi.job', tag2: 'completed' }),
  ];
  const input = (scenario: Scenario, events: DecodedEvent[]) => ({
    scenario,
    onChainJobId: JOB,
    requester: REQUESTER,
    provider: PROVIDER,
    escrow: ESCROW,
    hook: HOOK,
    usdc: USDC,
    providerAgentId: AGENT,
    events,
    settleTxStatus: 'success' as const,
    settleTxFrom: EVALUATOR,
    evaluator: EVALUATOR,
  });

  it('happy: passes with payout, fee, feedback 100', () => {
    const checks = settlementChecks(input('happy', happyEvents()));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('happy: a transfer to any other address, a wrong amount or a missing feedback fails', () => {
    const extra = [...happyEvents(), ev(USDC, 'Transfer', { from: ESCROW, to: STRANGER, value: 1n })];
    expect(settlementChecks(input('happy', extra)).find((c) => c.name === 'USDC escrow → any other address')?.ok).toBe(false);
    const short = happyEvents().map((e) => (e.eventName === 'Transfer' ? ev(USDC, 'Transfer', { from: ESCROW, to: PROVIDER, value: 1_993_999n }) : e));
    expect(settlementChecks(input('happy', short)).find((c) => c.name === 'USDC escrow → provider')?.ok).toBe(false);
    const noFeedback = happyEvents().filter((e) => e.eventName !== 'FeedbackWritten' && e.eventName !== 'NewFeedback');
    expect(settlementChecks(input('happy', noFeedback)).filter((c) => !c.ok).map((c) => c.name)).toEqual(
      expect.arrayContaining(['hook FeedbackWritten', 'registry NewFeedback']),
    );
  });

  it('happy: a settlement sent by anyone but the evaluator fails', () => {
    expect(settlementChecks({ ...input('happy', happyEvents()), settleTxFrom: STRANGER }).find((c) => c.name === 'settle tx sent by the evaluator')?.ok).toBe(false);
  });

  it('contest: full refund, quality-rejected reason, feedback 0 "rejected", nothing to the provider', () => {
    const events = [
      ev(ESCROW, 'JobRejected', { jobId: JOB, rejector: EVALUATOR, reason: keccak256(toBytes('agentfi.quality-rejected')) }),
      ev(USDC, 'Transfer', { from: ESCROW, to: REQUESTER, value: 1_500_000n }),
      ev(ESCROW, 'Refunded', { jobId: JOB, client: REQUESTER, amount: 1_500_000n }),
      ev(HOOK, 'FeedbackWritten', { jobId: JOB, agentId: AGENT, value: 0n }),
      ev(C5_REPUTATION_REGISTRY, 'NewFeedback', { agentId: AGENT, clientAddress: HOOK, value: 0n, tag1: 'agentfi.job', tag2: 'rejected' }),
    ];
    expect(settlementChecks(input('contest', events)).filter((c) => !c.ok)).toEqual([]);
    const paid = [...events, ev(USDC, 'Transfer', { from: ESCROW, to: PROVIDER, value: 1n })];
    expect(settlementChecks(input('contest', paid)).find((c) => c.name === 'USDC escrow → provider')?.ok).toBe(false);
  });

  it('cancel: full refund, cancelled reason, feedback skipped, no NewFeedback', () => {
    const events = [
      ev(ESCROW, 'JobRejected', { jobId: JOB, rejector: EVALUATOR, reason: keccak256(toBytes('agentfi.cancelled')) }),
      ev(USDC, 'Transfer', { from: ESCROW, to: REQUESTER, value: 1_000_000n }),
      ev(ESCROW, 'Refunded', { jobId: JOB, client: REQUESTER, amount: 1_000_000n }),
      ev(HOOK, 'FeedbackSkipped', { jobId: JOB, reason: '0x' }),
    ];
    expect(settlementChecks({ ...input('cancel', events), providerAgentId: null }).filter((c) => !c.ok)).toEqual([]);
    const rated = [...events, ev(C5_REPUTATION_REGISTRY, 'NewFeedback', { agentId: AGENT, clientAddress: HOOK, value: 0n, tag1: 'agentfi.job', tag2: 'rejected' })];
    expect(settlementChecks({ ...input('cancel', rated), providerAgentId: null }).find((c) => c.name === 'no NewFeedback')?.ok).toBe(false);
  });
});

describe('jobViewChecks and nonce accounting', () => {
  it('happy job view: COMPLETED, fee 6000, feedback written, bound', () => {
    const view = { status: 'COMPLETED', escrow: { onChainStatus: 'COMPLETED', feedbackStatus: 'written', resolution: null, settleTxHash: `0x${'ab'.repeat(32)}`, platformFeeAmount: '6000', providerAgentIdStatus: 'BOUND' } };
    expect(jobViewChecks('happy', view).filter((c) => !c.ok)).toEqual([]);
    expect(jobViewChecks('happy', { ...view, escrow: { ...view.escrow, platformFeeAmount: '6001' } }).some((c) => !c.ok)).toBe(true);
  });

  it('gas floor: the static floor at today’s Base Sepolia price, the planned gas × price × 3 when gas is dear', () => {
    expect(requiredEthWei('requester', 6_000_000n)).toBe(MIN_ETH_WEI.requester); // 0.006 gwei: 1.6 M × 0.006 gwei × 3 ≪ 0.0005 ETH
    expect(requiredEthWei('evaluator', 3_000_000_000n)).toBe(PLANNED_GAS.evaluator * 3_000_000_000n * 3n); // 3 gwei (an Anvil fork)
    expect(requiredEthWei('evaluator', 3_000_000_000n)).toBeGreaterThan(MIN_ETH_WEI.evaluator);
  });

  it('nonces outside the explained range fail (an unexplained transaction)', () => {
    expect(nonceCheck('requester', 0, 12).ok).toBe(true);
    expect(nonceCheck('requester', 0, 13).ok).toBe(false);
    expect(nonceCheck('provider', 3, 8).ok).toBe(true);
    expect(nonceCheck('provider', 3, 10).ok).toBe(false);
    expect(nonceCheck('evaluator', 10, 13).ok).toBe(true);
    expect(nonceCheck('evaluator', 10, 14).ok).toBe(false);
  });
});
