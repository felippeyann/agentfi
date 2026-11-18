/**
 * What an agent API key can do with money, as the SERVER enforces it today
 * (alpha payer reference, 2026-11-18). Read-only: it reads the Agent row and
 * its AgentPolicy row and applies the same readings as the enforcers —
 * `evaluateUsdcSpend` (x402 `pay-resource`, escrow job budgets),
 * `judgeOutflowCap` (ordinary outflows on `/v1/transactions/*`), the batch
 * route's calldata rule (`batch-calldata.ts`: non-transfer calldata is only
 * refused while a daily limit applies) and the tighten-only rule of
 * `PATCH /v1/agents/:id/policy` (`policy-authority.ts`). It never calls an
 * enforcer with a real spend and never writes.
 *
 * It answers the operator's question "is this the reference payer?" — an
 * agent whose key can pay x402 resources only to listed sellers, under a
 * per-payment and a daily ceiling, and cannot move funds by any other route
 * (`maxOutflowPerTxUsd` NULL) — and names every way the current row differs.
 * See docs/alpha/payer-setup.md and docs/architecture/payer-authorization.md.
 *
 * Not covered here (not in the database): the wallet's USDC balance (the hard
 * ceiling of every payment), each job's remaining budget (`x402:ops status`),
 * and which MCP tools a client shows the agent (a client-side filter only).
 */
import { judgeOutflowCap } from './outflow-cap.js';
import { policyDecimalToMicro, formatMicroUsd } from './usdc-spend-policy.js';
import { parsePolicyDecimal } from './policy-numbers.js';

/** The Agent fields read here (a Prisma `Agent` row satisfies it). */
export interface PayerProfileAgent {
  id: string;
  name: string;
  active: boolean;
  safeAddress: string;
  chainIds: number[];
}

/** The AgentPolicy fields read here (a Prisma `AgentPolicy` row satisfies it). */
export interface PayerProfilePolicy {
  active: boolean;
  expiresAt: Date | null;
  maxValuePerTxUsd: string;
  maxDailyVolumeUsd: string;
  maxOutflowPerTxUsd: string | null;
  allowedTokens: string[];
  allowedRecipients: string[];
  allowedContracts: string[];
}

export type PayerFindingLevel = 'RISK' | 'BLOCKED' | 'NOTE';

export interface PayerFinding {
  level: PayerFindingLevel;
  /** Stable code for scripts and tests. */
  code:
    | 'AGENT_INACTIVE'
    | 'NO_POLICY_ROW'
    | 'POLICY_PAUSED'
    | 'POLICY_EXPIRED'
    | 'ANY_RECIPIENT'
    | 'NO_PER_PAYMENT_CAP'
    | 'NO_DAILY_LIMIT'
    | 'OUTFLOWS_OPEN'
    | 'CONTRACT_CALLS_OPEN'
    | 'AGENT_CAN_LIST_CONTRACTS'
    | 'ANY_USDC_TOKEN';
  text: string;
}

export interface PayerProfile {
  agentId: string;
  agentName: string;
  wallet: string;
  chainIds: number[];
  agentActive: boolean;
  hasPolicyRow: boolean;
  /** x402 `pay-resource` (and escrow job budgets): what one payment and one day may spend, and to whom. */
  x402: {
    /** `null` = no limit. */
    perPaymentUsd: string | null;
    /** `null` = no daily limit. */
    dailyUsd: string | null;
    /** `null` = any recipient (empty list or no policy row). */
    recipients: string[] | null;
    /** `null` = any token (the route itself only pays USDC on the job's network). */
    tokens: string[] | null;
    /** Why every payment is refused right now, or null. */
    refusedNowBecause: string | null;
  };
  /** `/v1/transactions/*` transfers, swaps, deposits, GMX collateral, batches, legacy A2A payments. */
  ordinaryOutflows: { verdict: 'refused' | 'capped' | 'unrestricted'; capUsd: string | null; text: string };
  /** Batch actions whose calldata is not an ERC-20 transfer (approve, unknown selectors). */
  batchOtherCalls: { verdict: 'refused-unless-listed' | 'not-checked'; allowedContracts: string[]; text: string };
  /** What the agent key may change on its own policy. */
  policyChanges: string;
  findings: PayerFinding[];
  /** True when nothing in `findings` is RISK or BLOCKED. */
  referencePayer: boolean;
}

const PROBE_USD = '0.01';

/** Pure: the profile of `agent` under `policy` (`null` = the agent has no policy row) at `now`. */
export function describePayerProfile(agent: PayerProfileAgent, policy: PayerProfilePolicy | null, now: Date = new Date()): PayerProfile {
  const findings: PayerFinding[] = [];

  if (!agent.active) {
    findings.push({ level: 'BLOCKED', code: 'AGENT_INACTIVE', text: 'The agent is deactivated: its key is refused (403) on every route.' });
  }

  if (!policy) {
    findings.push({
      level: 'RISK',
      code: 'NO_POLICY_ROW',
      text:
        'No policy row: every enforcer reads "no restrictions" (x402 payments, transfers, swaps, batches, any amount, any recipient). ' +
        'An agent registered by the operator without a policy before 2026-11-18 is in this state. ' +
        'Operator: PATCH /v1/agents/<id>/policy with the operator secret and a full payer policy (docs/alpha/payer-setup.md).',
    });
    return {
      agentId: agent.id,
      agentName: agent.name,
      wallet: agent.safeAddress,
      chainIds: agent.chainIds,
      agentActive: agent.active,
      hasPolicyRow: false,
      x402: { perPaymentUsd: null, dailyUsd: null, recipients: null, tokens: null, refusedNowBecause: agent.active ? null : 'agent deactivated' },
      ordinaryOutflows: { verdict: 'unrestricted', capUsd: null, text: 'UNRESTRICTED (no policy row)' },
      batchOtherCalls: { verdict: 'not-checked', allowedContracts: [], text: 'NOT checked (no policy row)' },
      policyChanges: 'tighten only, judged against the registration defaults (the agent cannot seed limits above them); the operator may set anything',
      findings,
      referencePayer: false,
    };
  }

  let refusedNowBecause: string | null = agent.active ? null : 'agent deactivated';
  if (!policy.active) {
    refusedNowBecause ??= 'policy paused';
    findings.push({ level: 'BLOCKED', code: 'POLICY_PAUSED', text: 'The policy is paused: every payment and outflow is refused until the operator resumes it.' });
  }
  if (policy.expiresAt && policy.expiresAt < now) {
    refusedNowBecause ??= `policy expired at ${policy.expiresAt.toISOString()}`;
    findings.push({ level: 'BLOCKED', code: 'POLICY_EXPIRED', text: `The policy expired at ${policy.expiresAt.toISOString()}: every payment is refused; only the operator can extend it.` });
  }

  const perPaymentMicro = policyDecimalToMicro(policy.maxValuePerTxUsd);
  const perPaymentUsd = perPaymentMicro === null ? null : formatMicroUsd(perPaymentMicro);
  if (perPaymentUsd === null) {
    findings.push({ level: 'RISK', code: 'NO_PER_PAYMENT_CAP', text: `maxValuePerTxUsd ${JSON.stringify(policy.maxValuePerTxUsd)} is not a plain decimal, so it reads as no per-payment limit.` });
  }

  const dailyMicro = policyDecimalToMicro(policy.maxDailyVolumeUsd);
  const dailyUsd = dailyMicro === null || dailyMicro === 0n ? null : formatMicroUsd(dailyMicro);
  if (dailyUsd === null) {
    findings.push({
      level: 'RISK',
      code: 'NO_DAILY_LIMIT',
      text:
        `maxDailyVolumeUsd ${JSON.stringify(policy.maxDailyVolumeUsd)} means no daily limit. Besides removing the daily ceiling, ` +
        'it switches off the batch route\'s check on non-transfer calldata (an ERC-20 approve to any spender is then not refused). Set a daily limit.',
    });
  }

  const recipients = policy.allowedRecipients.length > 0 ? [...policy.allowedRecipients] : null;
  if (recipients === null) {
    findings.push({
      level: 'RISK',
      code: 'ANY_RECIPIENT',
      text:
        'allowedRecipients is empty, which means ANY recipient: the agent pays whatever payTo a resource server asks for (and an escrow job may name any provider). ' +
        'List the sellers\' payTo addresses.',
    });
  }
  const tokens = policy.allowedTokens.length > 0 ? [...policy.allowedTokens] : null;
  if (tokens === null) {
    findings.push({ level: 'NOTE', code: 'ANY_USDC_TOKEN', text: 'allowedTokens is empty (any token). pay-resource only pays USDC on the job\'s network anyway; listing the USDC contract makes that explicit.' });
  }

  const outflow = judgeOutflowCap(policy, { status: 'priced', usd: PROBE_USD, source: 'usdc-peg' });
  let ordinaryOutflows: PayerProfile['ordinaryOutflows'];
  if (!outflow.allowed && outflow.code === 'USD_CAP_NOT_CONFIGURED') {
    ordinaryOutflows = {
      verdict: 'refused',
      capUsd: null,
      text: 'REFUSED (maxOutflowPerTxUsd not configured): transfers, swaps, deposits, GMX collateral, batches with value or ERC-20 transfers, A2A payments',
    };
  } else if (policyDecimalToMicro(policy.maxOutflowPerTxUsd) === 0n) {
    // A cap of 0 refuses every priced outflow, exactly like NULL (a zero-priced call passes both).
    ordinaryOutflows = {
      verdict: 'refused',
      capUsd: '0',
      text: 'REFUSED (maxOutflowPerTxUsd is 0): transfers, swaps, deposits, GMX collateral, batches with value or ERC-20 transfers, A2A payments',
    };
  } else {
    const capMicro = policyDecimalToMicro(policy.maxOutflowPerTxUsd);
    const capUsd = capMicro === null ? null : formatMicroUsd(capMicro);
    ordinaryOutflows = {
      verdict: capUsd === null ? 'unrestricted' : 'capped',
      capUsd,
      text: capUsd === null ? `UNLIMITED (maxOutflowPerTxUsd ${JSON.stringify(policy.maxOutflowPerTxUsd)} is not a plain decimal)` : `ALLOWED up to ${capUsd} USD per transaction (maxOutflowPerTxUsd)`,
    };
    findings.push({
      level: 'RISK',
      code: 'OUTFLOWS_OPEN',
      text:
        'maxOutflowPerTxUsd is set, so this key can also move funds outside x402 (transfers, swaps, deposits, batches), within the other limits. ' +
        'A payer that only buys x402 resources keeps it unset (null).',
    });
  }

  // The batch route's own predicate (api/routes/transactions.ts): a float read of the daily limit, > 0, on an active policy.
  const dailyLimited = policy.active && (parsePolicyDecimal(policy.maxDailyVolumeUsd) ?? 0) > 0;
  const batchOtherCalls: PayerProfile['batchOtherCalls'] = dailyLimited
    ? {
        verdict: 'refused-unless-listed',
        allowedContracts: [...policy.allowedContracts],
        text:
          policy.allowedContracts.length > 0
            ? `REFUSED unless the target is one of ${policy.allowedContracts.length} allowedContracts`
            : 'REFUSED (approve and other non-transfer calldata need a target listed in allowedContracts)',
      }
    : { verdict: 'not-checked', allowedContracts: [...policy.allowedContracts], text: 'NOT checked while no daily limit applies' };
  if (policy.allowedContracts.length > 0) {
    findings.push({
      level: 'RISK',
      code: 'CONTRACT_CALLS_OPEN',
      text:
        `allowedContracts lists ${policy.allowedContracts.length} contract(s): a batch may call them with any calldata the backend cannot count ` +
        '(an ERC-20 approve included), and such a call is not an outflow for maxOutflowPerTxUsd. A payer that only buys x402 resources keeps it empty.',
    });
  } else if (dailyLimited) {
    findings.push({
      level: 'NOTE',
      code: 'AGENT_CAN_LIST_CONTRACTS',
      text:
        'allowedContracts is empty, and the server counts filling an empty list as a tightening: the agent key can set it to contracts of its choosing, ' +
        'which would reopen batch calls to them (CONTRACT_CALLS_OPEN). This report is a snapshot of the row: re-run it.',
    });
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    wallet: agent.safeAddress,
    chainIds: agent.chainIds,
    agentActive: agent.active,
    hasPolicyRow: true,
    x402: { perPaymentUsd, dailyUsd, recipients, tokens, refusedNowBecause },
    ordinaryOutflows,
    batchOtherCalls,
    policyChanges:
      'the agent key may only make changes the server counts as tightening (lower caps, a subset of a non-empty list, pause); raising a cap, ' +
      'clearing a list or adding to a non-empty list is 403 with nothing written. Filling an EMPTY list counts as tightening. The operator secret may change anything',
    findings,
    referencePayer: !findings.some((f) => f.level !== 'NOTE'),
  };
}

export function renderPayerProfile(p: PayerProfile): string {
  const or = (v: string | null, none: string) => v ?? none;
  const lines = [
    `Agent ${p.agentId} (${p.agentName}) wallet ${p.wallet} chains ${p.chainIds.join(',') || '-'}${p.agentActive ? '' : ' [DEACTIVATED]'}`,
    `  policy row: ${p.hasPolicyRow ? 'yes' : 'NO'}`,
    '  x402 purchases (pay-resource; also escrow job budgets):',
    `    per payment: ${p.x402.perPaymentUsd === null ? 'NO LIMIT' : `<= ${p.x402.perPaymentUsd} USD`}`,
    `    per day:     ${p.x402.dailyUsd === null ? 'NO LIMIT' : `<= ${p.x402.dailyUsd} USD`}`,
    `    recipients:  ${p.x402.recipients === null ? 'ANY' : p.x402.recipients.join(', ')}`,
    `    tokens:      ${or(p.x402.tokens?.join(', ') ?? null, 'any (the route pays USDC only)')}`,
    ...(p.x402.refusedNowBecause ? [`    right now:   every payment REFUSED (${p.x402.refusedNowBecause})`] : []),
    `  other outflows (transfers, swaps, deposits, batches, A2A): ${p.ordinaryOutflows.text}`,
    `  batch approve / other calldata: ${p.batchOtherCalls.text}`,
    '  withdrawals back to this wallet: allowed (not an outflow), counted against the daily limit, under allowedTokens and the cooldown; they spend ETH on gas',
    `  policy changes: ${p.policyChanges}`,
    '  per job: a payment also fits the job\'s remaining budget (x402:ops status --job <id>); the wallet\'s USDC balance is the hard ceiling',
  ];
  if (p.findings.length > 0) {
    lines.push('  findings:');
    for (const f of p.findings) lines.push(`    ${f.level.padEnd(7)} ${f.code}: ${f.text}`);
  }
  lines.push(
    p.referencePayer
      ? '  verdict: REFERENCE PAYER — x402 purchases to the listed recipients under both ceilings; transfers, swaps, deposits, batches with value and A2A payments are refused (as of this read).'
      : `  verdict: NOT the reference payer (${p.findings.filter((f) => f.level !== 'NOTE').map((f) => f.code).join(', ')}).`,
  );
  return lines.join('\n');
}
