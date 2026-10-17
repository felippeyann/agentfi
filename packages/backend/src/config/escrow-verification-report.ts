/**
 * C3f item 4 — each process's Q7 verification state, as other processes see it.
 *
 * Q7 verifies every escrow chain in each process on its own and keeps the
 * state in memory (`escrow-verification.runtime.ts`). The worker is the
 * process that signs evaluator settlements and sends the queued escrow
 * steps, so its state is the one that decides whether they are deferred —
 * and the API process could not show it (`GET /admin/escrow/verification`
 * answered with the API's own state; the worker's was in its logs and
 * ESCROW_ALERT notifications only).
 *
 * After every check (boot and each re-check) a process publishes its
 * snapshot to Redis under `agentfi:escrow-verification:<role>`, readable for
 * three re-check periods: a process that stops checking (stopped, crashed,
 * stuck) disappears, and the reader says so instead of showing an old
 * "verified". Pure: the Redis I/O is in `escrow-verification-report.runtime.ts`.
 */

import type { EscrowVerificationSettings, EscrowVerificationView } from './escrow-verification.js';
import type { ProcessRole } from './process-capabilities.js';

export function escrowVerificationReportKey(role: ProcessRole): string {
  return `agentfi:escrow-verification:${role}`;
}

/** What a process publishes after a check. `chains` is its snapshot WITH reasons, sanitized before it leaves the process. */
export interface EscrowVerificationReport extends EscrowVerificationSettings {
  role: ProcessRole;
  host: string;
  publishedAt: string;
  chains: EscrowVerificationView[];
}

/** How long a report stays readable: three re-check periods (at least a minute). */
export function reportTtlSeconds(settings: Pick<EscrowVerificationSettings, 'recheckSeconds'>): number {
  return Math.max(60, settings.recheckSeconds * 3);
}

/**
 * The report as the reader shows it:
 *  - `reported`: the last snapshot, its age, and `stale` when it is older than
 *    two re-check periods (the publisher missed at least one re-check). Each
 *    chain is as of `publishedAt`: a `verified` chain stops being allowed at
 *    its own `validUntil`;
 *  - `missing`: no report (the process never checked, or has not reported for
 *    three re-check periods and the key expired);
 *  - `unreadable`: Redis or the stored value could not be read.
 */
export type PeerVerificationView =
  | ({ state: 'reported'; ageSeconds: number; stale: boolean } & EscrowVerificationReport)
  | { state: 'missing'; reason: string }
  | { state: 'unreadable'; reason: string };

export function peerVerificationView(raw: string | null, now: Date): PeerVerificationView {
  if (raw === null) {
    return {
      state: 'missing',
      reason: 'no verification report: the process has not run a check yet, or has not reported for three re-check periods',
    };
  }
  let report: EscrowVerificationReport;
  try {
    report = JSON.parse(raw) as EscrowVerificationReport;
  } catch {
    return { state: 'unreadable', reason: 'the stored verification report is not valid JSON' };
  }
  const published = Date.parse(report?.publishedAt ?? '');
  if (!Number.isFinite(published) || typeof report.recheckSeconds !== 'number' || !Array.isArray(report.chains)) {
    return { state: 'unreadable', reason: 'the stored verification report is incomplete' };
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - published) / 1000));
  return { state: 'reported', ...report, ageSeconds, stale: ageSeconds > 2 * report.recheckSeconds };
}
