/**
 * S9 — boot-time wiring of the AgentExecutor / AgentPolicyModule verification
 * for `index.ts` (API) and `worker-process.ts` (worker), the counterpart of
 * the escrow check in `escrow-boot.runtime.ts`: read every configured chain
 * (`policy-stack-check.ts`), record the per-process state the gate reads
 * (`policy-stack-verification.runtime.ts`), FATAL on a mismatch in
 * production / staging, then re-check forever on the Q7 cadence. An
 * unreadable chain is never fatal: it stays unverified — executor-routed
 * transactions, policy syncs and Safe module enablement wait — until a
 * re-check reads it.
 *
 * Tests mock THIS module; the rules live in the modules above.
 */

import { logger } from '../api/middleware/logger.js';
import { sanitizeText } from '../api/errors/sanitize.js';
import { notificationService } from '../services/notification.service.js';
import { createChainPublicClient } from './chains.js';
import { env } from './env.js';
import type { ChainIdReader, CodeReader, ContractReader } from './escrow-boot-check.js';
import { checkPolicyStacks, policyStackBootVerdict, type PolicyStackBootVerdict } from './policy-stack-check.js';
import {
  policyStackExpectations,
  policyStackVerificationSettings,
  recordPolicyStackChecks,
  type PolicyStackTransition,
} from './policy-stack-verification.runtime.js';
import type { ProcessRole } from './process-capabilities.js';

function reader(chainId: number): ContractReader {
  const client = createChainPublicClient(chainId);
  return (params) => client.readContract(params as never);
}

function codeReader(chainId: number): CodeReader {
  const client = createChainPublicClient(chainId);
  return (address) => client.getCode({ address });
}

function chainIdReader(chainId: number): ChainIdReader {
  const client = createChainPublicClient(chainId);
  return () => client.getChainId();
}

function applyVerdict(role: ProcessRole, verdict: PolicyStackBootVerdict, opts: { quietUnreadable?: boolean } = {}): void {
  for (const warning of verdict.warnings) logger.warn({ role }, `AgentExecutor / AgentPolicyModule check: ${warning}`);
  for (const error of verdict.errors) {
    if (opts.quietUnreadable && error.includes('could not be verified')) continue;
    logger.error({ role }, error);
  }
  if (verdict.fatal) {
    console.error(verdict.fatal);
    logger.fatal?.({ role }, verdict.fatal);
    process.exit(1);
  }
}

async function reportTransitions(role: ProcessRole, transitions: readonly PolicyStackTransition[]): Promise<void> {
  for (const { chainId, previous, current } of transitions) {
    if (current.kind === 'verified') {
      logger.info({ role, chainId }, 'AgentExecutor / AgentPolicyModule verified against this build — executor-routed transactions and policy syncs allowed');
      if (!previous) continue;
    }
    const message =
      current.kind === 'verified'
        ? `AgentExecutor / AgentPolicyModule of chain ${chainId} verified again in the ${role} process: deferred executor-routed transactions and policy syncs resume.`
        : current.kind === 'unverified'
          ? `AgentExecutor / AgentPolicyModule of chain ${chainId} UNVERIFIED in the ${role} process since ${current.since.toISOString()} (${current.reason}). ` +
            'Executor-routed transactions answer 503 CONTRACTS_UNVERIFIED and queued ones wait; policy syncs and Safe module enablement wait; ' +
            'confirmations and reconciliation continue.'
          : `AgentExecutor / AgentPolicyModule of chain ${chainId} do NOT match this build / configuration in the ${role} process: ` +
            `${current.problems.join('; ')}. Executor-routed transactions, policy syncs and Safe module enablement are blocked.`;
    const clean = sanitizeText(message);
    if (current.kind === 'verified') logger.warn({ role, chainId }, clean);
    else logger.error({ role, chainId, state: current.kind }, clean);
    try {
      await notificationService.notify({
        type: 'POLICY_VIOLATION',
        agentId: 'contracts',
        agentName: 'AgentExecutor / AgentPolicyModule',
        message: clean,
        metadata: { kind: `contracts-${current.kind}`, chainId, role },
      });
    } catch (err) {
      logger.warn({ role, chainId, err: (err as Error)?.message ?? String(err) }, 'Contract verification alert could not be delivered');
    }
  }
}

let recheckTimer: ReturnType<typeof setInterval> | null = null;

function startRecheckLoop(role: ProcessRole): void {
  if (recheckTimer) return;
  const intervalMs = policyStackVerificationSettings().recheckSeconds * 1000;
  let running = false;
  recheckTimer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const chains = policyStackExpectations();
      const checks = await checkPolicyStacks({ chains, reader, codeReader, chainIdReader, attempts: 1, timeoutMs: Math.min(10_000, intervalMs) });
      const transitions = recordPolicyStackChecks(checks, chains);
      applyVerdict(role, policyStackBootVerdict(env.NODE_ENV, checks), { quietUnreadable: true });
      for (const check of checks) {
        if (check.unreadable) logger.warn({ role, chainId: check.chainId, err: check.unreadable }, 'AgentExecutor / AgentPolicyModule re-check failed — chain unverified');
      }
      await reportTransitions(role, transitions);
    })()
      .catch((err: unknown) => logger.error({ role, err: (err as Error)?.message ?? String(err) }, 'AgentExecutor / AgentPolicyModule re-check crashed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  recheckTimer.unref?.();
}

/**
 * Verifies every configured chain's executor / module against this build and
 * configuration, records the state the gate reads and starts the re-check.
 * FATAL (exit 1) on a mismatch in production / staging. Never throws.
 */
export async function runPolicyStackBootCheck(role: ProcessRole): Promise<PolicyStackBootVerdict | null> {
  const chains = policyStackExpectations();
  if (chains.length === 0) return null;
  let verdict: PolicyStackBootVerdict;
  try {
    const checks = await checkPolicyStacks({ chains, reader, codeReader, chainIdReader });
    verdict = policyStackBootVerdict(env.NODE_ENV, checks);
    const transitions = recordPolicyStackChecks(checks, chains);
    applyVerdict(role, verdict);
    await reportTransitions(role, transitions);
  } catch (err) {
    logger.error({ role, err: (err as Error)?.message ?? String(err) }, 'AgentExecutor / AgentPolicyModule boot check crashed — NOT verified (dependent operations blocked until a re-check succeeds)');
    startRecheckLoop(role);
    return null;
  }
  startRecheckLoop(role);
  return verdict;
}

/** Testing hook: stops the background re-check. */
export function __stopPolicyStackRecheckForTests(): void {
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
}
