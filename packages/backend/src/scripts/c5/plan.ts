/**
 * C5 escrow validation on Base Sepolia — the plan the owner approves, as data,
 * and the pure decisions the runner (`escrow-validation.ts`) takes from it.
 * No I/O here: everything is unit-tested (`__tests__/c5-escrow-validation.test.ts`).
 *
 * Three scenarios, one requester and one provider (fresh agents, EOA mode,
 * Turnkey wallets), faucet funds only:
 *   happy   — fund → ERC-8004 bind → submit → (contest window) → evaluator complete
 *   contest — fund → bind → submit → requester contest → held past the window →
 *             operator resolve (refund + "quality-rejected")
 *   cancel  — fund → requester cancel → evaluator reject → full refund
 *
 * Runbook and acceptance matrix: docs/project/c5-escrow-validation.md.
 */
import { getAddress, keccak256, toBytes, type Address, type Hex } from 'viem';

export const C5_CHAIN_ID = 84532;
export const C5_USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const C5_IDENTITY_REGISTRY: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const C5_REPUTATION_REGISTRY: Address = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

/** Owner decision Q6 / D12: the contest window of this validation. Never reduced on the real network. */
export const C5_CONTEST_WINDOW_SECONDS = 3600;
/** How long past the window the contest hold is observed before the operator may resolve. */
export const HOLD_MARGIN_SECONDS = 300;

export const PLATFORM_FEE_BPS = 30n;
export const MIN_FEEDBACK_BUDGET_UNITS = 1_000_000n;

export const SCENARIOS = ['happy', 'contest', 'cancel'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

/** Budgets (USDC, 6 decimals). Distinct amounts so every transfer names its scenario. */
export const SCENARIO_BUDGET: Record<Scenario, { amount: string; units: bigint }> = {
  happy: { amount: '2.0', units: 2_000_000n },
  contest: { amount: '1.5', units: 1_500_000n },
  cancel: { amount: '1.0', units: 1_000_000n },
};
export const TOTAL_BUDGET_UNITS = SCENARIO_BUDGET.happy.units + SCENARIO_BUDGET.contest.units + SCENARIO_BUDGET.cancel.units;

/**
 * Agent policies the setup registers. `maxOutflowPerTxUsd` is never sent, so it
 * stays NULL: ordinary outflows (transfers, swaps, deposits, batches) are
 * refused for both agents; escrow jobs are capped by `maxValuePerTxUsd` and
 * counted in `maxDailyVolumeUsd`. The requester may only fund jobs whose
 * provider wallet is the approved provider (`allowedRecipients`).
 */
export function requesterPolicy(provider: Address) {
  return { maxValuePerTxUsd: '2', maxDailyVolumeUsd: '5', cooldownSeconds: 0, allowedRecipients: [getAddress(provider)] };
}
export const PROVIDER_POLICY = { maxValuePerTxUsd: '1', maxDailyVolumeUsd: '1', cooldownSeconds: 0 } as const;

/** Native-gas floors below which the runner stops (wei). Funding proposal: docs §3. */
export const MIN_ETH_WEI = {
  requester: 500_000_000_000_000n, // 0.0005 ETH
  provider: 500_000_000_000_000n, // 0.0005 ETH
  evaluator: 1_000_000_000_000_000n, // 0.001 ETH
} as const;

/**
 * Gas each wallet sends over the whole run, rounded up from the fork
 * rehearsal's receipts (docs §3): requester 3 × (createJob 262 577 + approve
 * + setBudget 59 130 + fund 97 270); provider ERC-8004 register + up to 3 ×
 * setProviderAgentId 54 450 + 2 × submit 122 273; evaluator complete 340 302
 * + two rejects.
 */
export const PLANNED_GAS = { requester: 1_600_000n, provider: 900_000n, evaluator: 1_200_000n } as const;
export const GAS_SAFETY_FACTOR = 3n;

/** The ETH a wallet must hold: the static floor, or the planned gas at today's price × 3, whichever is higher. */
export function requiredEthWei(role: keyof typeof PLANNED_GAS, gasPriceWei: bigint): bigint {
  const dynamic = PLANNED_GAS[role] * gasPriceWei * GAS_SAFETY_FACTOR;
  return dynamic > MIN_ETH_WEI[role] ? dynamic : MIN_ETH_WEI[role];
}

export const REASONS = {
  completed: keccak256(toBytes('agentfi.completed')),
  cancelled: keccak256(toBytes('agentfi.cancelled')),
  qualityRejected: keccak256(toBytes('agentfi.quality-rejected')),
} as const;

/** AgentJobEscrow.JobStatus */
export const CHAIN_STATUS = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 } as const;

export const feeUnits = (budget: bigint): bigint => (budget * PLATFORM_FEE_BPS) / 10_000n;

export interface ExpectedOutcome {
  jobStatus: string;
  onChainStatus: 'COMPLETED' | 'REJECTED';
  chainStatus: number;
  /** escrow → provider */
  payoutUnits: bigint;
  /** stays in the escrow (`pendingPlatformFees`) */
  feeUnits: bigint;
  /** escrow → requester */
  refundUnits: bigint;
  escrowEvent: 'JobCompleted' | 'JobRejected';
  reason: Hex;
  feedback: { status: 'written'; value: bigint; tag2: 'completed' | 'rejected' } | { status: 'skipped:no-params' };
  resolution: string | null;
}

export function expectedOutcome(scenario: Scenario): ExpectedOutcome {
  const budget = SCENARIO_BUDGET[scenario].units;
  switch (scenario) {
    case 'happy':
      return {
        jobStatus: 'COMPLETED',
        onChainStatus: 'COMPLETED',
        chainStatus: CHAIN_STATUS.Completed,
        payoutUnits: budget - feeUnits(budget),
        feeUnits: feeUnits(budget),
        refundUnits: 0n,
        escrowEvent: 'JobCompleted',
        reason: REASONS.completed,
        feedback: { status: 'written', value: 100n, tag2: 'completed' },
        resolution: null,
      };
    case 'contest':
      return {
        jobStatus: 'PAYMENT_FAILED',
        onChainStatus: 'REJECTED',
        chainStatus: CHAIN_STATUS.Rejected,
        payoutUnits: 0n,
        feeUnits: 0n,
        refundUnits: budget,
        escrowEvent: 'JobRejected',
        reason: REASONS.qualityRejected,
        feedback: { status: 'written', value: 0n, tag2: 'rejected' },
        resolution: 'quality-rejected',
      };
    case 'cancel':
      return {
        jobStatus: 'CANCELLED',
        onChainStatus: 'REJECTED',
        chainStatus: CHAIN_STATUS.Rejected,
        payoutUnits: 0n,
        feeUnits: 0n,
        refundUnits: budget,
        escrowEvent: 'JobRejected',
        reason: REASONS.cancelled,
        feedback: { status: 'skipped:no-params' },
        resolution: null,
      };
  }
}

// ── What the runner does next ────────────────────────────────────────────────

/** The slice of `GET /v1/jobs/:id` the decisions read. */
export interface JobSnapshot {
  status: string;
  escrow: {
    onChainStatus: string | null;
    providerAgentIdStatus: string | null;
    contestedAt: string | null;
    resolution: string | null;
    settleTxHash: string | null;
  } | null;
}

export type Step =
  | { kind: 'wait'; for: string }
  | { kind: 'accept' }
  | { kind: 'deliver' }
  | { kind: 'cancel' }
  | { kind: 'contest' }
  | { kind: 'hold' }
  | { kind: 'resolve-by-operator' }
  | { kind: 'done' }
  | { kind: 'stop'; reason: string };

const FINAL = ['COMPLETED', 'REJECTED', 'EXPIRED', 'EXPIRED_UNFUNDED'];
const BINDING_ENDED = ['BOUND', 'FAILED', 'SKIPPED'];

/**
 * The single next step for `scenario` given the job as the backend reports it.
 * Every action is chosen from the job's CURRENT state, so a rerun after an
 * interruption repeats no action that already happened (the backend refuses a
 * repeated transition, and the runner never asks for one).
 */
export function nextStep(scenario: Scenario, job: JobSnapshot): Step {
  const e = job.escrow;
  if (!e) return { kind: 'stop', reason: 'the job is not an ERC-8183 escrow job (no escrow view)' };
  const on = e.onChainStatus ?? '';
  if (on === 'FAILED') return { kind: 'stop', reason: 'escrow funding FAILED (see escrow.escrowError)' };
  if (on === 'EXPIRED' || on === 'EXPIRED_UNFUNDED') return { kind: 'stop', reason: `the escrow ${on.toLowerCase()} — not an expected outcome of this run` };

  if (FINAL.includes(on)) {
    const expected = expectedOutcome(scenario).onChainStatus;
    return on === expected ? { kind: 'done' } : { kind: 'stop', reason: `settled ${on}, expected ${expected}` };
  }
  if (['CREATING', 'OPEN', 'BUDGET_SET', 'APPROVED'].includes(on)) return { kind: 'wait', for: 'funding (createJob → setBudget → approve → fund)' };

  switch (scenario) {
    case 'cancel':
      if (on === 'FUNDED' && job.status === 'PENDING') return { kind: 'cancel' };
      if (job.status === 'CANCELLED') return { kind: 'wait', for: 'the evaluator reject (refund)' };
      return { kind: 'stop', reason: `unexpected state for a cancellation: status ${job.status}, on-chain ${on}` };

    case 'happy':
    case 'contest': {
      if (job.status === 'CANCELLED' || job.status === 'FAILED') return { kind: 'stop', reason: `job ${job.status} — not part of the ${scenario} scenario` };
      if (on === 'FUNDED' && job.status === 'PENDING') return { kind: 'accept' };
      if (on === 'FUNDED' && job.status === 'ACCEPTED') {
        if (!BINDING_ENDED.includes(e.providerAgentIdStatus ?? '')) return { kind: 'wait', for: 'the ERC-8004 identity binding' };
        if (e.providerAgentIdStatus !== 'BOUND') return { kind: 'stop', reason: `identity binding ${e.providerAgentIdStatus}: feedback would be skipped` };
        return { kind: 'deliver' };
      }
      if (on === 'FUNDED' && job.status === 'PAYMENT_PENDING') return { kind: 'wait', for: 'the submit' };
      if (on === 'SUBMITTED') {
        if (scenario === 'contest' && !e.contestedAt) return { kind: 'contest' };
        return { kind: 'wait', for: 'the contest window and the evaluator complete' };
      }
      if (on === 'CONTESTED') {
        if (scenario === 'happy') return { kind: 'stop', reason: 'the happy job was contested' };
        return e.resolution ? { kind: 'wait', for: `the operator's ${e.resolution} settlement` } : { kind: 'hold' };
      }
      if (on === 'SETTLING') return { kind: 'wait', for: 'the settlement transaction' };
      return { kind: 'stop', reason: `unexpected state: status ${job.status}, on-chain ${on}` };
    }
  }
}

/**
 * The contest hold is proven once the chain's `submittedAt` + window + margin
 * has passed with the job still CONTESTED (nothing settled). Seconds left, or 0.
 */
export function holdSecondsLeft(submittedAt: bigint, nowSeconds: bigint, windowSeconds = C5_CONTEST_WINDOW_SECONDS): bigint {
  const until = submittedAt + BigInt(windowSeconds + HOLD_MARGIN_SECONDS);
  return nowSeconds >= until ? 0n : until - nowSeconds;
}

// ── Checks ───────────────────────────────────────────────────────────────────

export interface Check {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export function check(name: string, expected: unknown, actual: unknown, ok?: boolean): Check {
  const show = (v: unknown) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v : JSON.stringify(v));
  return { name, expected: show(expected), actual: show(actual), ok: ok ?? show(expected) === show(actual) };
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A decoded log, as viem's parseEventLogs returns it. */
export interface DecodedEvent {
  address: string;
  eventName: string;
  args: Record<string, unknown>;
}

export interface SettlementInput {
  scenario: Scenario;
  onChainJobId: bigint;
  requester: Address;
  provider: Address;
  escrow: Address;
  hook: Address;
  usdc: Address;
  providerAgentId: bigint | null;
  /** All logs of the settle transaction, decoded with the escrow, hook, registry and ERC-20 ABIs. */
  events: DecodedEvent[];
  settleTxStatus: 'success' | 'reverted';
  settleTxFrom: Address;
  evaluator: Address;
}

/** What the settle transaction must contain for `scenario` — and nothing that moves value elsewhere. */
export function settlementChecks(input: SettlementInput): Check[] {
  const x = expectedOutcome(input.scenario);
  const ev = (name: string, address: string) => input.events.filter((e) => e.eventName === name && sameAddress(e.address, address));
  const forJob = (e: DecodedEvent) => e.args['jobId'] === input.onChainJobId;
  const checks: Check[] = [
    check('settle tx succeeded', 'success', input.settleTxStatus),
    check('settle tx sent by the evaluator', input.evaluator, input.settleTxFrom, sameAddress(input.evaluator, input.settleTxFrom)),
  ];

  const decision = ev(x.escrowEvent, input.escrow).filter(forJob);
  checks.push(check(`${x.escrowEvent} for job #${input.onChainJobId}`, 1, decision.length));
  checks.push(check(`${x.escrowEvent} reason`, x.reason, decision[0]?.args['reason'] ?? null));
  const other = x.escrowEvent === 'JobCompleted' ? 'JobRejected' : 'JobCompleted';
  checks.push(check(`no ${other}`, 0, ev(other, input.escrow).length));

  const transfers = ev('Transfer', input.usdc);
  const fromEscrow = transfers.filter((t) => sameAddress(t.args['from'] as string, input.escrow));
  const toProvider = fromEscrow.filter((t) => sameAddress(t.args['to'] as string, input.provider));
  const toRequester = fromEscrow.filter((t) => sameAddress(t.args['to'] as string, input.requester));
  const elsewhere = fromEscrow.filter((t) => !sameAddress(t.args['to'] as string, input.provider) && !sameAddress(t.args['to'] as string, input.requester));
  const sum = (list: DecodedEvent[]) => list.reduce((acc, t) => acc + (t.args['value'] as bigint), 0n);
  checks.push(check('USDC escrow → provider', x.payoutUnits, sum(toProvider)));
  checks.push(check('USDC escrow → requester', x.refundUnits, sum(toRequester)));
  checks.push(check('USDC escrow → any other address', 0, elsewhere.length));

  const accrued = ev('PlatformFeeAccrued', input.escrow).filter(forJob);
  checks.push(check('PlatformFeeAccrued', x.feeUnits, accrued.reduce((acc, e) => acc + (e.args['amount'] as bigint), 0n)));
  if (x.payoutUnits > 0n) {
    const released = ev('PaymentReleased', input.escrow).filter(forJob);
    checks.push(check('PaymentReleased amount', x.payoutUnits, released[0]?.args['amount'] ?? null));
    checks.push(check('PaymentReleased provider', input.provider, released[0]?.args['provider'] ?? null, sameAddress(released[0]?.args['provider'] as string, input.provider)));
  }
  if (x.refundUnits > 0n) {
    const refunded = ev('Refunded', input.escrow).filter(forJob);
    checks.push(check('Refunded amount', x.refundUnits, refunded[0]?.args['amount'] ?? null));
    checks.push(check('Refunded client', input.requester, refunded[0]?.args['client'] ?? null, sameAddress(refunded[0]?.args['client'] as string, input.requester)));
  }

  const written = ev('FeedbackWritten', input.hook).filter(forJob);
  const skipped = ev('FeedbackSkipped', input.hook).filter(forJob);
  const failed = ev('FeedbackFailed', input.hook).filter(forJob);
  const feedback = ev('NewFeedback', C5_REPUTATION_REGISTRY);
  checks.push(check('hook FeedbackFailed', 0, failed.length));
  if (x.feedback.status === 'written') {
    checks.push(check('hook FeedbackWritten', 1, written.length));
    checks.push(check('FeedbackWritten value', x.feedback.value, written[0]?.args['value'] ?? null));
    checks.push(check('FeedbackWritten agentId', input.providerAgentId, written[0]?.args['agentId'] ?? null));
    checks.push(check('registry NewFeedback', 1, feedback.length));
    checks.push(check('NewFeedback client = hook', input.hook, feedback[0]?.args['clientAddress'] ?? null, sameAddress(feedback[0]?.args['clientAddress'] as string, input.hook)));
    checks.push(check('NewFeedback tag1', 'agentfi.job', feedback[0]?.args['tag1'] ?? null));
    checks.push(check('NewFeedback tag2', x.feedback.tag2, feedback[0]?.args['tag2'] ?? null));
    checks.push(check('NewFeedback value', x.feedback.value, feedback[0]?.args['value'] ?? null));
  } else {
    checks.push(check('hook FeedbackSkipped', 1, skipped.length));
    checks.push(check('no FeedbackWritten', 0, written.length));
    checks.push(check('no NewFeedback', 0, feedback.length));
  }
  return checks;
}

/** The job as the backend reports it once settled. */
export function jobViewChecks(scenario: Scenario, job: { status: string; escrow: Record<string, unknown> | null }): Check[] {
  const x = expectedOutcome(scenario);
  const e = job.escrow ?? {};
  const checks = [
    check('job status', x.jobStatus, job.status),
    check('escrow.onChainStatus', x.onChainStatus, e['onChainStatus'] ?? null),
    check('escrow.feedbackStatus', x.feedback.status, e['feedbackStatus'] ?? null),
    check('escrow.resolution', x.resolution, e['resolution'] ?? null),
    check('escrow.settleTxHash present', true, typeof e['settleTxHash'] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(e['settleTxHash'] as string)),
  ];
  if (scenario === 'happy') checks.push(check('escrow.platformFeeAmount', x.feeUnits, e['platformFeeAmount'] ?? null));
  if (scenario !== 'cancel') checks.push(check('escrow.providerAgentIdStatus', 'BOUND', e['providerAgentIdStatus'] ?? null));
  if (scenario === 'contest') checks.push(check('escrow.ratedAgentId = providerAgentId', e['providerAgentId'] ?? null, e['ratedAgentId'] ?? null));
  return checks;
}

/**
 * The recorded authority checks of a contest: `missing` (run them), `passed`
 * (every one ok), or `failed` — a recorded failure is never skipped on a
 * rerun: the run stops and the operator decision stays blocked.
 */
export function authorityState(checks: Check[] | undefined): 'missing' | 'passed' | 'failed' {
  if (!checks || checks.length === 0) return 'missing';
  return checks.every((c) => c.ok) ? 'passed' : 'failed';
}

/** The RPC head may lag the wall clock by at most this much on the real network. */
export const MAX_HEAD_AGE_SECONDS = 120;

/** Settlement no earlier than `submittedAt` + window: the approved window was applied, not a shorter one. */
export function windowCheck(submittedAt: bigint, settledAt: bigint, windowSeconds = C5_CONTEST_WINDOW_SECONDS): Check {
  const elapsed = settledAt - submittedAt;
  return check(`settled ≥ ${windowSeconds} s after submit`, `≥ ${windowSeconds}`, elapsed.toString(), elapsed >= BigInt(windowSeconds));
}

/**
 * The worker's own Q7 state, as `GET /admin/escrow/verification` shows it
 * under `worker` (C3f item 4). The worker signs every evaluator settlement
 * and sends the queued escrow steps, and it verifies on its own: the API
 * being verified does not mean the worker is. Passes only on a current
 * (`reported`, not `stale`) report in which this chain is `verified` and
 * allowed; `missing`, `unreadable`, an absent field (a backend without the
 * report) or a stale report fail — unknown is never verified.
 */
export function workerVerificationCheck(worker: unknown, chainId = C5_CHAIN_ID): Check {
  const name = `worker escrow configuration verified (Q7, chain ${chainId})`;
  const w = worker as { state?: unknown; stale?: unknown; ageSeconds?: unknown; reason?: unknown; chains?: unknown } | null | undefined;
  if (!w || typeof w !== 'object') return check(name, 'reported / verified / allowed', 'absent', false);
  if (w.state !== 'reported') return check(name, 'reported / verified / allowed', `${String(w.state)}${w.reason ? ` (${String(w.reason)})` : ''}`, false);
  if (w.stale !== false) return check(name, 'reported / verified / allowed', `stale report (${String(w.ageSeconds)} s old)`, false);
  const view = Array.isArray(w.chains) ? (w.chains as Array<{ chainId?: unknown; state?: unknown; allowed?: unknown }>).find((v) => v?.chainId === chainId) : undefined;
  if (!view) return check(name, 'reported / verified / allowed', 'chain absent from the report', false);
  return check(name, 'reported / verified / allowed', `reported / ${String(view.state)} / ${String(view.allowed)}`, view.state === 'verified' && view.allowed === true);
}

/**
 * Nonce accounting for the whole run: how many transactions each wallet may
 * have sent between the setup snapshot and the end. More means a transaction
 * this plan does not explain (stop and investigate); fewer means a step did
 * not happen. Ranges, because a provider identity binding may be retried or
 * skipped (cancel can race the evaluator's reject: docs §5.5 of testnet-log).
 */
export const EXPECTED_TX_COUNT = {
  // per job: createJob, setBudget, approve, fund
  requester: { min: 12, max: 12 },
  // register (first job only) + setProviderAgentId per job (cancel may skip it or revert) + submit (happy, contest)
  provider: { min: 5, max: 6 },
  // complete (happy) + reject (contest) + reject (cancel)
  evaluator: { min: 3, max: 3 },
} as const;

export function nonceCheck(role: keyof typeof EXPECTED_TX_COUNT, before: number, after: number): Check {
  const sent = after - before;
  const { min, max } = EXPECTED_TX_COUNT[role];
  return check(`${role} transactions sent`, min === max ? `${min}` : `${min}–${max}`, `${sent}`, sent >= min && sent <= max);
}
