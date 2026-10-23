/**
 * C3f item 4 — Redis I/O of the per-process Q7 verification reports (rules
 * in `escrow-verification-report.ts`).
 *
 * `publishEscrowVerificationReport` runs after every check of a process (boot
 * and each re-check, `escrow-boot.runtime.ts`); `readEscrowVerificationReport`
 * serves `GET /admin/escrow/verification` (the worker's report next to the
 * API's own state). Best effort both ways: a Redis problem is logged (publish)
 * or shown as `unreadable` (read) — it never blocks a check, a gate or a
 * request. The reasons are sanitized before they leave the process (they can
 * quote an RPC error, and viem errors carry the keyed RPC URL — C3d review P2-2).
 */

import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { logger } from '../api/middleware/logger.js';
import { sanitizeText, sanitizeValue } from '../api/errors/sanitize.js';
import { env } from './env.js';
import type { EscrowVerificationSettings, EscrowVerificationView } from './escrow-verification.js';
import {
  escrowVerificationReportKey,
  peerVerificationView,
  reportTtlSeconds,
  type EscrowVerificationReport,
  type PeerVerificationView,
} from './escrow-verification-report.js';
import type { ProcessRole } from './process-capabilities.js';

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false, connectTimeout: 5_000 });
    client.on('error', () => undefined); // surfaced by the calls below, never as an unhandled event
  }
  return client;
}

/** Publishes this process's snapshot (WITH reasons, sanitized). Returns whether it was written. */
export async function publishEscrowVerificationReport(
  role: ProcessRole,
  chains: readonly EscrowVerificationView[],
  settings: EscrowVerificationSettings,
  now: Date = new Date(),
): Promise<boolean> {
  const report: EscrowVerificationReport = {
    role,
    host: hostname(),
    publishedAt: now.toISOString(),
    ...settings,
    chains: sanitizeValue(chains) as EscrowVerificationView[],
  };
  try {
    await redis().set(escrowVerificationReportKey(role), JSON.stringify(report), 'EX', reportTtlSeconds(settings));
    return true;
  } catch (err) {
    logger.warn({ role, err: sanitizeText((err as Error)?.message ?? String(err)) }, 'Escrow verification report not published to Redis (the admin view of this process is unavailable)');
    return false;
  }
}

/** The last report `role` published, as the admin endpoint shows it. */
export async function readEscrowVerificationReport(role: ProcessRole, now: Date = new Date()): Promise<PeerVerificationView> {
  let raw: string | null;
  try {
    raw = await redis().get(escrowVerificationReportKey(role));
  } catch (err) {
    return { state: 'unreadable', reason: `Redis could not be read: ${sanitizeText((err as Error)?.message ?? String(err))}` };
  }
  return peerVerificationView(raw, now);
}

/** Testing hook: closes the Redis client. */
export function __closeEscrowVerificationReportForTests(): void {
  client?.disconnect();
  client = null;
}
