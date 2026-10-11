/**
 * Boot-time wiring of the C3d checks for `index.ts` (API) and
 * `worker-process.ts` (worker): the escrow / hook deployment check
 * (`escrow-boot-check.ts`) and the per-process capabilities with the
 * API ↔ worker drift comparison (`process-capabilities.ts`).
 *
 * Tests mock THIS module; the rules live in the two pure modules above.
 */

import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import type { Address } from 'viem';
import { logger } from '../api/middleware/logger.js';
import { getKnownTokenBySymbol } from '../services/transaction/token-registry.js';
import { createChainPublicClient } from './chains.js';
import { getContracts, resolveIdentityRegistry, resolveReputationRegistry } from './contracts.js';
import { configuredEscrowChainIds, env, escrowEvaluatorAddress } from './env.js';
import {
  checkEscrowDeployments,
  escrowBootVerdict,
  type ContractReader,
  type EscrowChainExpectation,
  type EscrowBootVerdict,
} from './escrow-boot-check.js';
import {
  capabilityDrift,
  describeCapabilities,
  type EscrowChainCapability,
  type ProcessCapabilities,
  type ProcessRole,
} from './process-capabilities.js';

/**
 * Every chain with an escrow address: what the deployment check verifies
 * (escrow.token() always; the hook's wiring when a hook is configured).
 */
export function escrowExpectations(): EscrowChainExpectation[] {
  const expectations: EscrowChainExpectation[] = [];
  for (const chainId of configuredEscrowChainIds) {
    let contracts: ReturnType<typeof getContracts>;
    try {
      contracts = getContracts(chainId);
    } catch {
      continue;
    }
    if (!contracts.agentJobEscrow) continue;
    expectations.push({
      chainId,
      escrow: contracts.agentJobEscrow,
      hook: contracts.reputationHook ?? null,
      evaluator: escrowEvaluatorAddress,
      identityRegistry: resolveIdentityRegistry(chainId) ?? null,
      reputationRegistry: resolveReputationRegistry(chainId) ?? null,
      usdc: (getKnownTokenBySymbol('USDC', chainId)?.address as Address | undefined) ?? null,
    });
  }
  return expectations;
}

function reader(chainId: number): ContractReader {
  const client = createChainPublicClient(chainId);
  return (params) => client.readContract(params as never);
}

/** How often, and how many times, an unreadable chain is re-checked after boot. */
const RECHECK_INTERVAL_MS = 60_000;
const RECHECK_MAX_TRIES = 30;

function applyVerdict(role: ProcessRole, verdict: EscrowBootVerdict): void {
  for (const warning of verdict.warnings) logger.warn({ role }, `ERC-8183 boot check: ${warning}`);
  for (const error of verdict.errors) logger.error({ role }, error);
  if (verdict.verified.length > 0) {
    logger.info({ role, chainIds: verdict.verified }, 'ERC-8183 boot check: escrow (+ ReputationHook where configured) match the configuration');
  }
  if (verdict.fatal) {
    console.error(verdict.fatal);
    logger.fatal?.({ role }, verdict.fatal);
    process.exit(1);
  }
}

/**
 * C3d: verifies the deployed escrow / hook of every configured chain against
 * this process's configuration. FATAL (exit 1) on a mismatch in production /
 * staging, loud error in development / test. Chains that cannot be read are
 * errors and are re-checked every minute in the background (30 tries); a
 * mismatch found then gets the same treatment. Never throws.
 */
export async function runEscrowBootCheck(role: ProcessRole): Promise<EscrowBootVerdict | null> {
  const chains = escrowExpectations();
  if (chains.length === 0) return null;
  let verdict: EscrowBootVerdict;
  try {
    verdict = escrowBootVerdict(env.NODE_ENV, await checkEscrowDeployments({ chains, reader }));
  } catch (err) {
    logger.error({ role, err: (err as Error)?.message ?? String(err) }, 'ERC-8183 boot check crashed — deployment NOT verified');
    return null;
  }
  applyVerdict(role, verdict);

  if (verdict.unreadable.length > 0) {
    let pending = chains.filter((chain) => verdict.unreadable.includes(chain.chainId));
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      void (async () => {
        const checks = await checkEscrowDeployments({ chains: pending, reader, attempts: 1 });
        const later = escrowBootVerdict(env.NODE_ENV, checks);
        applyVerdict(role, { ...later, errors: later.errors.filter((e) => !e.includes('could not be verified')) });
        pending = pending.filter((chain) => later.unreadable.includes(chain.chainId));
        if (pending.length === 0 || tries >= RECHECK_MAX_TRIES) {
          clearInterval(timer);
          if (pending.length > 0) {
            logger.error({ role, chainIds: pending.map((c) => c.chainId) }, 'ERC-8183 boot check: deployment still unverified — giving up re-checks');
          }
        }
      })().catch((err: unknown) => logger.error({ role, err: (err as Error)?.message ?? String(err) }, 'ERC-8183 boot re-check failed'));
    }, RECHECK_INTERVAL_MS);
    timer.unref?.();
  }
  return verdict;
}

/** This process's capabilities from its environment and what it started. */
export function processCapabilities(
  role: ProcessRole,
  started: { transactionWorker: boolean; paymentRecovery: boolean; settlementWorker: boolean },
): ProcessCapabilities {
  const escrowChains: EscrowChainCapability[] = [];
  for (const chainId of configuredEscrowChainIds) {
    try {
      const contracts = getContracts(chainId);
      if (contracts.agentJobEscrow) escrowChains.push({ chainId, escrow: contracts.agentJobEscrow, hook: contracts.reputationHook ?? null });
    } catch {
      // no contract table for the chain
    }
  }
  return {
    role,
    nodeEnv: env.NODE_ENV,
    ...started,
    escrowChains,
    evaluator: escrowEvaluatorAddress,
    bootedAt: new Date().toISOString(),
  };
}

const CAPABILITIES_KEY = (role: ProcessRole) => `agentfi:process-capabilities:${role}`;
const CAPABILITIES_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Logs what this process enables, publishes it to Redis and compares it with
 * the last capabilities the other role published (C3d: silent config drift
 * between the API and the worker). Best effort — Redis problems are logged,
 * never fatal.
 */
export async function announceProcessCapabilities(caps: ProcessCapabilities): Promise<string[]> {
  logger.info({ ...caps, host: hostname() }, describeCapabilities(caps));
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false, connectTimeout: 5_000 });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.set(CAPABILITIES_KEY(caps.role), JSON.stringify({ ...caps, host: hostname() }), 'EX', CAPABILITIES_TTL_SECONDS);
    const peerRole: ProcessRole = caps.role === 'api' ? 'worker' : 'api';
    const raw = await redis.get(CAPABILITIES_KEY(peerRole));
    if (!raw) return [];
    const peer = JSON.parse(raw) as ProcessCapabilities;
    const drift = capabilityDrift(caps, peer);
    for (const message of drift) {
      logger.error({ role: caps.role, peerRole, peerBootedAt: peer.bootedAt }, `CONFIG DRIFT between the API and the worker: ${message}`);
    }
    return drift;
  } catch (err) {
    logger.warn({ role: caps.role, err: (err as Error)?.message ?? String(err) }, 'Process capabilities not exchanged through Redis (drift check skipped)');
    return [];
  } finally {
    redis.disconnect();
  }
}
