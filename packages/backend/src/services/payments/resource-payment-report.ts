/**
 * Operator view of x402 spend (first x402 delivery, 2026-11-15): for each
 * paying agent, what the operator authorized (its policy), what is committed
 * and spent today, and per job what is committed, proven spent, reported
 * spent, still open, why attempts were blocked, and what an operator has to
 * do for every row that cannot conclude on its own.
 *
 * Read-only. Money and delivery are kept apart on purpose:
 *   money     proven (chainVerifiedAt) · reported (server's word only) ·
 *             possibly moved (unknown / pending / live refusal) · not moved
 *             (failed_before_signing, expired) · held (reserved).
 *   delivery  delivered (a 2xx paid response, with its SHA-256) · not
 *             delivered (non-2xx) · no response.
 * A proven payment does not prove the resource was right; a 2xx does not
 * prove the money moved.
 */

import type { AgentPolicy, PrismaClient, ResourcePayment, ResourcePaymentReconcileState } from '@prisma/client';
import { formatUnits } from 'viem';
import { countedWhere, resourcePaymentSpentToday, sumBaseUnits, utcDay } from './resource-payment-ledger.js';
import { DEFAULT_STALE_AFTER_MS } from './resource-payment-reconciliation.js';
import { ResourcePaymentService } from './resource-payment.service.js';

export type MoneyState = 'proven' | 'reported' | 'possibly-moved' | 'held' | 'not-moved';
/** delivered = complete 2xx body · partial = cut at the read limit · not-delivered = non-2xx · unknown = no paid response arrived. */
export type DeliveryState = 'delivered' | 'partial' | 'not-delivered' | 'unknown';

export interface PaymentLine {
  paymentId: string;
  url: string;
  status: ResourcePayment['status'];
  amount: string;
  amountUsdc: string;
  payTo: string;
  counted: boolean;
  money: MoneyState;
  delivery: DeliveryState;
  responseStatus: number | null;
  resourceSha256: string | null;
  resourceBytes: number | null;
  txHash: string | null;
  /** The EIP-3009 authorization nonce the agent signed; null when nothing was signed. */
  authorizationNonce: string | null;
  reservedAt: string;
  /** Why the attempt was blocked or failed, when it was. */
  reason: string | null;
  /** What an operator should do; null when nothing is needed. */
  action: string | null;
  reconcileNote: string | null;
  /** What the automatic reconciliation is doing about the money (null when nothing is open). */
  automatic: string | null;
}

export interface JobSpend {
  jobId: string;
  jobStatus: string;
  /** Job reward = the per-job budget, USDC (null when the reward is not USDC). */
  budgetUsdc: string | null;
  committedUsdc: string;
  provenUsdc: string;
  reportedUsdc: string;
  openUsdc: string;
  remainingUsdc: string | null;
  /** Counted spend above the budget (possible only after reconciliation proved a refused payment settled). */
  overCommitted: boolean;
  payments: PaymentLine[];
}

export interface AgentSpend {
  agentId: string;
  name: string;
  policy: {
    active: boolean;
    expiresAt: string | null;
    maxValuePerTxUsd: string;
    maxDailyVolumeUsd: string;
    allowedRecipients: string[];
  } | null;
  today: {
    day: string;
    x402CommittedUsd: string;
    otherVolumeUsd: string;
    remainingDailyUsd: string | null;
  };
  jobs: JobSpend[];
  pendingActions: number;
}

const USDC_DECIMALS = 6;
const usdc = (units: bigint) => formatUnits(units, USDC_DECIMALS);

function moneyState(row: ResourcePayment, now: Date): MoneyState {
  switch (row.status) {
    case 'settled':
      return row.chainVerifiedAt ? 'proven' : 'reported';
    case 'pending':
    case 'unknown':
      return 'possibly-moved';
    case 'refused':
      // Counted until reconciliation proves it either way (2026-11-15).
      return 'possibly-moved';
    case 'reserved':
      return 'held';
    default:
      return 'not-moved';
  }
}

function deliveryState(row: ResourcePayment): DeliveryState {
  if (row.responseStatus === null) return 'unknown';
  if (row.responseStatus < 200 || row.responseStatus >= 300) return 'not-delivered';
  return row.resourceTruncated ? 'partial' : 'delivered';
}

/** The operator action for a row; null when it concludes (or concluded) on its own. */
type ReportRow = ResourcePayment & { reconcileState?: ResourcePaymentReconcileState | null };

/** Rows whose money is still to be judged (the automatic reconciliation's work list). */
function moneyOpen(row: ResourcePayment): boolean {
  return ['reserved', 'pending', 'unknown', 'refused'].includes(row.status) || (row.status === 'settled' && !row.chainVerifiedAt);
}

/** What the automation is doing about the money of a row; null when nothing is open. */
function automaticFor(row: ReportRow, now: Date): string | null {
  if (!moneyOpen(row)) return null;
  const state = row.reconcileState;
  if (state?.stopped) return `STOPPED at ${state.escalatedAt?.toISOString() ?? '?'}: ${state.escalationReason ?? 'operator needed'}`;
  if (state?.escalatedAt) {
    return `ALERT since ${state.escalatedAt.toISOString()} (${state.escalationReason ?? 'repeated failures'}); retrying, next look ${state.nextAttemptAt.toISOString()}`;
  }
  if (!state) return 'queued for the next automatic reconciliation';
  const when = state.nextAttemptAt.getTime() <= now.getTime() ? 'on the next tick' : `at ${state.nextAttemptAt.toISOString()}`;
  const failures = state.attempts > 0 ? `evidence source unavailable ${state.attempts}× (state kept, still counted); ` : '';
  return `${failures}next automatic look ${when} (last: ${state.lastVerdict ?? 'none'})`;
}

/** The manual action for open money, used when the automation is off or not running. */
function manualActionFor(row: ReportRow, now: Date, staleAfterMs: number): string | null {
  const age = now.getTime() - row.updatedAt.getTime();
  switch (row.status) {
    case 'reserved':
      return now.getTime() - row.reservedAt.getTime() >= staleAfterMs
        ? 'abandoned reservation (nothing was sent): run `x402:ops reconcile --apply` to release it'
        : null;
    case 'pending':
      return age >= staleAfterMs
        ? 'attempt interrupted after sending: run `x402:ops reconcile --apply` (reads the authorization on-chain); do not retry with a new paymentId'
        : null;
    case 'unknown':
      return 'outcome unknown: run `x402:ops reconcile --apply` (proves the transfer or waits for validBefore); do not retry with a new paymentId';
    case 'refused':
      return 'refused after signing; stays counted: run `x402:ops reconcile --apply` (settled if it moved, expired → released otherwise)';
    case 'settled':
      return row.chainVerifiedAt ? null : 'settlement only reported by the server: run `x402:ops reconcile --apply` to prove it on-chain';
    default:
      return null;
  }
}

/** How long a due row may wait before the report says the automation is not running. */
const AUTOMATION_SILENT_AFTER_MS = 10 * 60 * 1000;

function actionFor(row: ReportRow, now: Date, staleAfterMs: number, automationEnabled: boolean): string | null {
  const age = now.getTime() - row.updatedAt.getTime();
  const state = row.reconcileState;
  if (moneyOpen(row) && state?.stopped) {
    return `automatic reconciliation stopped (${state.escalationReason ?? 'escalated'}): check the chain / the seller, then \`x402:ops reconcile --apply\` (re-arms it) or \`x402:ops resolve\`; it stays counted until then`;
  }
  const chainJudgeable = row.authorizationMethod === 'eip3009' && row.payer !== null && row.authorizationNonce !== null;
  if ((row.status === 'unknown' || row.status === 'refused' || (row.status === 'pending' && age >= staleAfterMs)) && !chainJudgeable) {
    return `reconciliation cannot judge this row (${row.authorizationMethod ?? 'no method'}${row.payer ? '' : ', no payer recorded'}): check the chain / the seller, then \`x402:ops resolve --as expired|settled --operator … --note …\`; it stays counted until then`;
  }
  if (moneyOpen(row)) {
    if (!automationEnabled) return `automatic reconciliation is disabled (X402_RECONCILE_ENABLED=false): ${manualActionFor(row, now, staleAfterMs) ?? 'nothing to do yet'}`;
    // Due for a while with no visit: the worker is not running (not deployed, crashing, migration missing).
    const dueSince = state ? state.nextAttemptAt.getTime() : Math.max(row.updatedAt.getTime(), row.reservedAt.getTime());
    const visitedSince = state ? state.updatedAt.getTime() : 0;
    if (now.getTime() - dueSince > AUTOMATION_SILENT_AFTER_MS && visitedSince < dueSince) {
      const manual = manualActionFor(row, now, staleAfterMs);
      if (manual) return `automatic reconciliation has not looked at this row since ${new Date(dueSince).toISOString()} (is the worker running?): ${manual}`;
    }
    // Otherwise the automation will judge it (see `automatic`); an alert is shown there.
    return null;
  }
  switch (row.status) {
    case 'settled':
      if (deliveryState(row) === 'partial') {
        return `paid (proven) but only the first ${row.resourceBytes ?? '?'} bytes of the resource arrived (read limit; transfer aborted). The content is NOT recoverable by reconciliation and fetching it again would be a new purchase: take it up with the seller ${row.payTo}`;
      }
      if (deliveryState(row) !== 'delivered') {
        return `paid (proven) but the resource was not delivered (${row.responseStatus === null ? 'no paid response arrived — delivery unknown' : `HTTP ${row.responseStatus}`}). Reconciliation proves the money, not the content; fetching it again would be a new purchase: take it up with the seller ${row.payTo}`;
      }
      return null;
    default:
      return null;
  }
}

function reasonFor(row: ResourcePayment): string | null {
  if (row.status === 'settled' && !row.error) return null;
  return row.error;
}

export interface SpendReportFilter {
  agentId?: string;
  jobId?: string;
  now?: Date;
  staleAfterMs?: number;
  /** Is the automatic reconciliation enabled (default: X402_RECONCILE_ENABLED !== "false")? */
  automationEnabled?: boolean;
}

/** Builds the operator view for every agent that has x402 rows (or the filtered one). */
export async function buildSpendReport(
  db: Pick<PrismaClient, 'resourcePayment' | 'agent' | 'job' | 'dailyVolume'>,
  filter: SpendReportFilter = {},
): Promise<AgentSpend[]> {
  const now = filter.now ?? new Date();
  const staleAfterMs = filter.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const automationEnabled = filter.automationEnabled ?? process.env["X402_RECONCILE_ENABLED"] !== "false";
  const rows = await db.resourcePayment.findMany({
    where: {
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.jobId ? { jobId: filter.jobId } : {}),
    },
    orderBy: { reservedAt: 'asc' },
    include: { reconcileState: true },
  });
  const counted = new Set(
    (
      await db.resourcePayment.findMany({
        where: {
          ...countedWhere(now),
          ...(filter.agentId ? { agentId: filter.agentId } : {}),
          ...(filter.jobId ? { jobId: filter.jobId } : {}),
        },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  if (filter.agentId && !agentIds.includes(filter.agentId)) agentIds.push(filter.agentId);
  const report: AgentSpend[] = [];

  for (const agentId of agentIds) {
    const agent = await db.agent.findUnique({ where: { id: agentId }, include: { policy: true } });
    if (!agent) continue;
    const policy: AgentPolicy | null = agent.policy;
    const x402Today = await resourcePaymentSpentToday(db, agentId, now);
    const volume = await db.dailyVolume.findUnique({
      where: { agentId_date: { agentId, date: utcDay(now) } },
      select: { volumeUsd: true },
    });
    const otherUsd = volume?.volumeUsd ?? '0';
    let remainingDaily: string | null = null;
    if (policy && /^\d+(\.\d+)?$/.test(policy.maxDailyVolumeUsd)) {
      const cap = BigInt(Math.floor(Number(policy.maxDailyVolumeUsd) * 1e6));
      const other = BigInt(Math.ceil(Number(otherUsd) * 1e6));
      const left = cap - x402Today - other;
      remainingDaily = usdc(left > 0n ? left : 0n);
    }

    const agentRows = rows.filter((r) => r.agentId === agentId);
    const jobIds = [...new Set(agentRows.map((r) => r.jobId))];
    const jobs: JobSpend[] = [];
    let pendingActions = 0;
    for (const jobId of jobIds) {
      const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, status: true, reward: true } });
      const jobRows = agentRows.filter((r) => r.jobId === jobId);
      let total: bigint | null = null;
      try {
        total = ResourcePaymentService.resolveBudget(job?.reward).total;
      } catch {
        total = null;
      }
      const committed = sumBaseUnits(jobRows.filter((r) => counted.has(r.id)));
      const proven = sumBaseUnits(jobRows.filter((r) => r.status === 'settled' && r.chainVerifiedAt));
      const reported = sumBaseUnits(jobRows.filter((r) => r.status === 'settled' && !r.chainVerifiedAt));
      const payments = jobRows.map((row): PaymentLine => {
        const action = actionFor(row, now, staleAfterMs, automationEnabled);
        if (action) pendingActions++;
        return {
          paymentId: row.paymentId,
          url: row.url,
          status: row.status,
          amount: row.amount,
          amountUsdc: /^\d+$/.test(row.amount) ? usdc(BigInt(row.amount)) : row.amount,
          payTo: row.payTo,
          counted: counted.has(row.id),
          money: moneyState(row, now),
          delivery: deliveryState(row),
          responseStatus: row.responseStatus,
          resourceSha256: row.resourceSha256,
          resourceBytes: row.resourceBytes,
          txHash: row.settlementTxHash,
          authorizationNonce: row.authorizationNonce,
          reservedAt: row.reservedAt.toISOString(),
          reason: reasonFor(row),
          action,
          reconcileNote: row.reconcileNote,
          automatic: automaticFor(row, now),
        };
      });
      jobs.push({
        jobId,
        jobStatus: job?.status ?? 'missing',
        budgetUsdc: total === null ? null : usdc(total),
        committedUsdc: usdc(committed),
        provenUsdc: usdc(proven),
        reportedUsdc: usdc(reported),
        openUsdc: usdc(committed - proven - reported),
        remainingUsdc: total === null ? null : usdc(total - committed),
        overCommitted: total !== null && committed > total,
        payments,
      });
    }

    report.push({
      agentId,
      name: agent.name,
      policy: policy
        ? {
            active: policy.active,
            expiresAt: policy.expiresAt?.toISOString() ?? null,
            maxValuePerTxUsd: policy.maxValuePerTxUsd,
            maxDailyVolumeUsd: policy.maxDailyVolumeUsd,
            allowedRecipients: policy.allowedRecipients,
          }
        : null,
      today: { day: utcDay(now), x402CommittedUsd: usdc(x402Today), otherVolumeUsd: otherUsd, remainingDailyUsd: remainingDaily },
      jobs,
      pendingActions,
    });
  }
  return report;
}

/** Plain-text rendering for the CLI. */
export function renderSpendReport(report: AgentSpend[]): string {
  const out: string[] = [];
  if (report.length === 0) return 'No x402 payments recorded for this filter.';
  for (const agent of report) {
    out.push(`Agent ${agent.name} (${agent.agentId})`);
    if (agent.policy) {
      const p = agent.policy;
      out.push(
        `  Authorized by the operator: ≤ ${p.maxValuePerTxUsd} USD per payment, ≤ ${p.maxDailyVolumeUsd} USD per day` +
          `${p.allowedRecipients.length ? `, only to ${p.allowedRecipients.join(', ')}` : ', any payee'}` +
          `${p.active ? '' : ' — POLICY PAUSED'}${p.expiresAt ? `, expires ${p.expiresAt}` : ''}`,
      );
    } else {
      out.push('  Authorized by the operator: no policy row (no agent-level limits)');
    }
    out.push(
      `  Today (${agent.today.day}): x402 committed ${agent.today.x402CommittedUsd} USDC, other volume ${agent.today.otherVolumeUsd} USD` +
        `${agent.today.remainingDailyUsd !== null ? `, left today ${agent.today.remainingDailyUsd} USD` : ''}`,
    );
    for (const job of agent.jobs) {
      out.push(
        `  Job ${job.jobId} [${job.jobStatus}] budget ${job.budgetUsdc ?? 'n/a'} · committed ${job.committedUsdc} ` +
          `(proven ${job.provenUsdc}, reported ${job.reportedUsdc}, open ${job.openUsdc}) · remaining ${job.remainingUsdc ?? 'n/a'}` +
          `${job.overCommitted ? ' · OVER-COMMITTED' : ''}`,
      );
      for (const p of job.payments) {
        out.push(
          `    - ${p.paymentId} ${p.status.padEnd(21)} ${p.amountUsdc.padStart(8)} USDC  money:${p.money}  delivery:${p.delivery}` +
            `${p.responseStatus !== null ? ` (HTTP ${p.responseStatus})` : ''}${p.counted ? '' : '  [not counted]'}`,
        );
        out.push(`        ${p.url} → ${p.payTo}${p.txHash ? `  tx ${p.txHash}` : ''}`);
        if (p.resourceSha256) out.push(`        resource sha256 ${p.resourceSha256} (${p.resourceBytes} bytes received${p.delivery === 'partial' ? ', TRUNCATED' : ''})`);
        if (p.reason) out.push(`        reason: ${p.reason}`);
        // The operator's proof that a block emitted nothing: no authorization was signed for this row.
        if (p.status === 'failed_before_signing' && p.authorizationNonce === null) {
          out.push('        signature: none (refused before signing: no payment authorization exists for this row)');
        }
        if (p.reconcileNote) out.push(`        reconciled: ${p.reconcileNote}`);
        if (p.automatic) out.push(`        automatic: ${p.automatic}`);
        if (p.action) out.push(`        ACTION: ${p.action}`);
      }
    }
    out.push(`  Pending operator actions: ${agent.pendingActions}`);
  }
  return out.join('\n');
}
