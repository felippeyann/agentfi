/**
 * S8 — the operator-triggered on-chain policy sync and the DB-vs-chain view.
 *
 * `view(agentId)` reads the module and compares it with the stored policy,
 * so the operator sees both while a sync is pending or after it failed.
 * `sync(agentId)` queues the calls `planPolicySync` derives — ONLY from the
 * stored policy — as ordinary Transaction rows signed by the agent's own
 * wallet and sent DIRECTLY to the module (`msg.sender == safe` in EOA mode):
 * never through `AgentExecutor` (where the executor is `msg.sender` and the
 * module answers Unauthorized), never with caller-supplied calldata. The
 * routes call it with the admin credential only (`/admin/agents/:id/...`).
 *
 * The rows are `type: BATCH` with `metadata.kind = 'policy-sync'` and
 * `metadata.policySync` (the call, the module, the wallet, the parameters):
 * they ride the ordinary queue, wallet lane, broadcast stamps, monitor,
 * re-poll and stranded-QUEUED sweep. The pre-submit guard signs them even
 * while the agent is paused (the kill switch must reach the chain) but first
 * re-derives the call from the policy stored at that moment and fails it as
 * superseded when the DB moved on (`supersededReason`).
 *
 * Safe mode is refused: a transaction signed by the agent's key comes from
 * its EOA, not from the Safe, so `msg.sender == safe` would not hold (and the
 * provisioning path never leaves a Safe with the module enabled — see the S8
 * PR). The operator key (`module.operator()`) can always send the same calls
 * out of band.
 */
import type { PrismaClient } from '@prisma/client';
import { getAddress, type Address, type Hex } from 'viem';
import type { TransactionJobData } from '../../queues/transaction.processor.js';
import { isDefinitiveContractError } from '../../config/escrow-boot-check.js';
import type { GateVerdict } from '../../config/verification-state.js';
import { sanitizeText } from '../../api/errors/sanitize.js';
import {
  OFF_CHAIN_ONLY_POLICY_FIELDS,
  desiredOnChainPolicy,
  planPolicySync,
  readOnChainPolicy,
  syncHistory,
  type DesiredOnChainPolicy,
  type OnChainPolicyReading,
  type PolicyModuleReader,
  type PolicySyncCall,
  type PolicySyncCallName,
  type PolicySyncMetadata,
  type PolicySyncPlan,
} from './policy-sync.js';

export type PolicySyncState =
  /** The module holds the stored policy. */
  | 'in-sync'
  /** Sync transactions are queued or awaiting their receipt. */
  | 'pending'
  /** The chain differs from the DB and the latest sync attempt failed or reverted. */
  | 'failed'
  /** The chain differs from the DB (never synced, or the DB changed since). */
  | 'out-of-sync'
  /** No AgentPolicyModule is configured for the agent's chain. */
  | 'not-configured'
  /** The agent has no policy row (nothing to sync). */
  | 'no-db-policy'
  /** The stored policy has a value the module cannot hold. */
  | 'not-representable'
  /** The RPC could not be reached. */
  | 'unreadable'
  /** The configured module address did not answer as an AgentPolicyModule (no code, revert, bad data). */
  | 'mismatch';

export type WalletMode = 'eoa' | 'safe' | 'unknown';

interface SyncRowView {
  transactionId: string;
  call: PolicySyncCallName | 'unknown';
  status: string;
  txHash: string | null;
  error: string | null;
  createdAt: string;
}

export interface PolicySyncView {
  agentId: string;
  chainId: number;
  policyModule: Address | null;
  safe: string;
  walletMode: WalletMode;
  status: PolicySyncState;
  /** Why the status is not-representable / unreadable / mismatch / no-db-policy (operator-facing). */
  reason: string | null;
  /** The stored policy as the module would hold it. */
  db: {
    maxValuePerTxEth: string;
    maxValuePerTxWei: string;
    cooldownSeconds: number;
    active: boolean;
    expiresAt: number;
    allowedContracts: Address[];
    allowedTokens: Address[];
  } | null;
  /** What the module holds now (null when it could not be read). */
  onChain: {
    hasPolicy: boolean;
    maxValuePerTxWei: string | null;
    cooldownSeconds: number | null;
    active: boolean | null;
    expiresAt: number | null;
    contracts: { count: string | null; whitelisted: string[] };
    tokens: { count: string | null; whitelisted: string[] };
  } | null;
  differences: string[];
  pending: SyncRowView[];
  lastFailure: SyncRowView | null;
  offChainOnlyFields: readonly string[];
  warnings: string[];
  /** S9: this process's verification of the chain's AgentExecutor / AgentPolicyModule (a sync is queued only when allowed). */
  contracts: { allowed: boolean; state: string; reason: string | null };
}

export type PolicySyncOutcome =
  | { kind: 'not-found' }
  | { kind: 'refused'; httpStatus: 409 | 422 | 503; code: string; error: string; view: PolicySyncView }
  | { kind: 'in-sync'; view: PolicySyncView }
  | {
      kind: 'queued';
      transactions: Array<{ transactionId: string; call: PolicySyncCallName; reused: boolean }>;
      differences: string[];
      unknownExtras: { contracts: string; tokens: string };
      /** Set when some rows could not be enqueued (they are FAILED; the rest are queued). */
      enqueueError?: string;
    };

export interface PolicySyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PolicySyncDeps {
  db: PrismaClient;
  /** Adds the row's job to the transaction queue with its deterministic id. */
  enqueue(transactionId: string, data: TransactionJobData): Promise<void>;
  /** `readContract` for the chain. */
  reader(chainId: number): PolicyModuleReader;
  /** The address the agent's wallet signs as (Turnkey / local provider). */
  walletAddress(walletId: string): Promise<Address>;
  /** The configured `AgentPolicyModule` of the chain, if any. */
  policyModule(chainId: number): Address | undefined;
  /**
   * S9: the chain's AgentExecutor / AgentPolicyModule verification
   * (`policyStackGate`). A sync is queued only while it is allowed: the
   * module must run this build's code and be the executor's module.
   */
  contractsGate(chainId: number): GateVerdict;
  logger: PolicySyncLogger;
}

const SYNC_KIND = 'policy-sync';
const IN_FLIGHT = ['QUEUED', 'SUBMITTED', 'PENDING_APPROVAL'] as const;

function firstLine(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | null;
  return sanitizeText((e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0] ?? '') || 'unknown error';
}

function rowView(row: { id: string; status: string; txHash: string | null; error: string | null; createdAt: Date; metadata: unknown }): SyncRowView {
  const call = (row.metadata as { policySync?: { call?: unknown } } | null)?.policySync?.call;
  return {
    transactionId: row.id,
    call: typeof call === 'string' ? (call as PolicySyncCallName) : 'unknown',
    status: row.status,
    txHash: row.txHash,
    error: row.error ? sanitizeText(row.error) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function dbView(desired: DesiredOnChainPolicy, maxValuePerTxEth: string): NonNullable<PolicySyncView['db']> {
  return {
    maxValuePerTxEth,
    maxValuePerTxWei: desired.maxValuePerTxWei.toString(),
    cooldownSeconds: Number(desired.cooldownSeconds),
    active: desired.active,
    expiresAt: Number(desired.expiresAt),
    allowedContracts: desired.allowedContracts,
    allowedTokens: desired.allowedTokens,
  };
}

function onChainView(reading: OnChainPolicyReading): NonNullable<PolicySyncView['onChain']> {
  const whitelisted = (members: Map<string, boolean>) => [...members].filter(([, on]) => on).map(([a]) => getAddress(a));
  return {
    hasPolicy: reading.hasPolicy,
    maxValuePerTxWei: reading.core ? reading.core.maxValuePerTxWei.toString() : null,
    cooldownSeconds: reading.core ? Number(reading.core.cooldownSeconds) : null,
    active: reading.core ? reading.core.active : null,
    expiresAt: reading.core ? Number(reading.core.expiresAt) : null,
    contracts: { count: reading.contracts.count?.toString() ?? null, whitelisted: whitelisted(reading.contracts.members) },
    tokens: { count: reading.tokens.count?.toString() ?? null, whitelisted: whitelisted(reading.tokens.members) },
  };
}

/** Everything `view` and `sync` share: the agent, the derivation, the chain reading and the plan. */
interface Assessment {
  agent: { id: string; walletId: string; safeAddress: string; chainIds: number[]; tier: 'FREE' | 'PRO' | 'ENTERPRISE' };
  chainId: number;
  module: Address | null;
  walletMode: WalletMode;
  walletError: string | null;
  desired: DesiredOnChainPolicy | null;
  view: PolicySyncView;
  plan: PolicySyncPlan | null;
}

export class PolicySyncService {
  constructor(private readonly deps: PolicySyncDeps) {}

  /** DB policy, on-chain policy, differences and the sync rows of an agent; null when the agent does not exist. */
  async view(agentId: string): Promise<PolicySyncView | null> {
    const assessed = await this.assess(agentId);
    return assessed?.view ?? null;
  }

  /**
   * Queues the calls that make the module hold the stored policy. Refuses
   * (with the view) when the chain has no module, the policy cannot be held,
   * the wallet is not the safe (Safe mode), or the chain cannot be read.
   */
  async sync(agentId: string, trigger: string): Promise<PolicySyncOutcome> {
    const assessed = await this.assess(agentId);
    if (!assessed) return { kind: 'not-found' };
    const { view } = assessed;
    const refuse = (httpStatus: 409 | 422 | 503, code: string, error: string): PolicySyncOutcome => ({ kind: 'refused', httpStatus, code, error, view });

    if (view.status === 'not-configured') {
      return refuse(409, 'POLICY_MODULE_NOT_CONFIGURED', view.reason ?? 'no AgentPolicyModule configured for the agent\'s chain');
    }
    // S9: nothing is sent to a module this process has not verified (this
    // build's code, the executor's module, the expected operator).
    if (!view.contracts.allowed) {
      return refuse(
        503,
        'CONTRACTS_UNVERIFIED',
        `the AgentExecutor / AgentPolicyModule of chain ${assessed.chainId} is not verified against this build (${view.contracts.state})` +
          `${view.contracts.reason ? `: ${view.contracts.reason}` : ''}`,
      );
    }
    switch (view.status) {
      case 'no-db-policy':
        return refuse(409, 'NO_DB_POLICY', view.reason ?? 'the agent has no stored policy');
      case 'not-representable':
        return refuse(422, 'POLICY_NOT_REPRESENTABLE', view.reason ?? 'the stored policy cannot be held by the module');
      case 'unreadable':
        return refuse(503, 'ONCHAIN_POLICY_UNREADABLE', view.reason ?? 'the chain could not be read');
      case 'mismatch':
        return refuse(409, 'POLICY_MODULE_MISMATCH', view.reason ?? 'the configured module did not answer as an AgentPolicyModule');
      default:
        break;
    }
    if (assessed.walletMode !== 'eoa') {
      return refuse(
        409,
        'POLICY_SYNC_WALLET_MODE',
        assessed.walletMode === 'safe'
          ? `the agent's safeAddress ${assessed.agent.safeAddress} is not the address its wallet signs as: a transaction from the agent's key ` +
              "would not have msg.sender == safe, and the backend has no Safe-transaction path. Send the module calls with the operator key " +
              '(module.operator()) instead; GET /admin/agents/:id/policy/onchain shows what differs.'
          : `the agent's wallet could not be resolved (${assessed.walletError ?? 'unknown error'}), so nothing can be signed for it`,
      );
    }
    const plan = assessed.plan!;
    if (plan.calls.length === 0) {
      return view.differences.length === 0
        ? { kind: 'in-sync', view }
        : refuse(409, 'POLICY_SYNC_UNKNOWN_ENTRIES', view.differences.join('; '));
    }
    return this.queue(assessed, plan, trigger);
  }

  private async queue(assessed: Assessment, plan: PolicySyncPlan, trigger: string): Promise<PolicySyncOutcome> {
    const { db, logger } = this.deps;
    const { agent, chainId } = assessed;
    const module = assessed.module!;
    const safe = getAddress(agent.safeAddress);
    const transactions: Array<{ transactionId: string; call: PolicySyncCallName; reused: boolean }> = [];
    const toEnqueue: Array<{ id: string; call: PolicySyncCall }> = [];

    // Under the agent row lock: a concurrent request reuses the identical
    // in-flight row instead of queueing the same call twice.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agent.id} FOR NO KEY UPDATE`;
      const inFlight = await tx.transaction.findMany({
        where: { agentId: agent.id, type: 'BATCH', status: { in: [...IN_FLIGHT] }, metadata: { path: ['kind'], equals: SYNC_KIND } },
        select: { id: true, metadata: true },
      });
      for (const call of plan.calls) {
        const same = inFlight.find((row) => {
          const payload = (row.metadata as { queuePayload?: { data?: string; to?: string } } | null)?.queuePayload;
          return payload?.data?.toLowerCase() === call.data.toLowerCase() && payload?.to?.toLowerCase() === module.toLowerCase();
        });
        if (same) {
          transactions.push({ transactionId: same.id, call: call.name, reused: true });
          continue;
        }
        const policySync: PolicySyncMetadata = { call: call.name, module, safe, params: call.params };
        const row = await tx.transaction.create({
          data: {
            agentId: agent.id,
            chainId,
            status: 'QUEUED',
            type: 'BATCH',
            amountIn: '0',
            metadata: {
              kind: SYNC_KIND,
              admin: true,
              trigger,
              policySync: policySync as never,
              // What the stranded-QUEUED sweep re-enqueues after a crash before the add.
              queuePayload: { to: module, data: call.data, value: '0', feeAmountWei: '0', feeBps: 0, routedViaExecutor: false },
            },
          },
          select: { id: true },
        });
        transactions.push({ transactionId: row.id, call: call.name, reused: false });
        toEnqueue.push({ id: row.id, call });
      }
    });

    let enqueueError: string | undefined;
    for (const { id, call } of toEnqueue) {
      const data: TransactionJobData = {
        transactionId: id,
        chainId,
        walletId: agent.walletId,
        from: safe,
        to: module,
        data: call.data as Hex,
        value: '0',
        agentId: agent.id,
        tier: agent.tier,
        feeAmountWei: '0',
        feeUsd: '0',
        feeBps: 0,
        routedViaExecutor: false,
      };
      try {
        await this.deps.enqueue(id, data);
      } catch (err) {
        enqueueError = firstLine(err);
        await db.transaction
          .updateMany({
            where: { id, status: 'QUEUED', txHash: null, broadcastAttemptedAt: null },
            data: { status: 'FAILED', error: `enqueue failed: ${enqueueError}`.slice(0, 500) },
          })
          .catch((unwindErr: unknown) =>
            logger.error({ transactionId: id, err: firstLine(unwindErr) }, 'Policy sync enqueue failed AND the row could not be marked FAILED — the stranded-QUEUED sweep re-adds it'),
          );
      }
    }

    logger.info(
      { agentId: agent.id, chainId, module, trigger, calls: transactions.map((t) => `${t.call}${t.reused ? ' (reused)' : ''}`), differences: plan.differences },
      'Policy sync queued (agent wallet → AgentPolicyModule, not via the executor)',
    );
    return {
      kind: 'queued',
      transactions,
      differences: plan.differences,
      unknownExtras: { contracts: plan.unknownExtras.contracts.toString(), tokens: plan.unknownExtras.tokens.toString() },
      ...(enqueueError ? { enqueueError } : {}),
    };
  }

  private async assess(agentId: string): Promise<Assessment | null> {
    const { db } = this.deps;
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        walletId: true,
        safeAddress: true,
        chainIds: true,
        tier: true,
        active: true,
        policy: {
          select: { maxValuePerTxEth: true, cooldownSeconds: true, active: true, expiresAt: true, allowedContracts: true, allowedTokens: true },
        },
      },
    });
    if (!agent) return null;
    const chainId = agent.chainIds[0] ?? 1;
    const module = this.deps.policyModule(chainId) ?? null;

    const syncRows = await db.transaction.findMany({
      where: { agentId, type: 'BATCH', metadata: { path: ['kind'], equals: SYNC_KIND } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, txHash: true, error: true, createdAt: true, metadata: true },
    });
    const pending = syncRows.filter((r) => (IN_FLIGHT as readonly string[]).includes(r.status)).map(rowView);
    const latestConfirmed = syncRows.find((r) => r.status === 'CONFIRMED');
    const latestFailed = syncRows.find((r) => r.status === 'FAILED' || r.status === 'REVERTED');
    const lastFailure =
      latestFailed && (!latestConfirmed || latestFailed.createdAt >= latestConfirmed.createdAt) ? rowView(latestFailed) : null;

    let walletMode: WalletMode = 'unknown';
    let walletError: string | null = null;
    try {
      const signer = await this.deps.walletAddress(agent.walletId);
      walletMode = signer.toLowerCase() === agent.safeAddress.toLowerCase() ? 'eoa' : 'safe';
    } catch (err) {
      walletError = firstLine(err);
    }

    const gate = this.deps.contractsGate(chainId);
    const base: PolicySyncView = {
      agentId,
      chainId,
      policyModule: module,
      safe: agent.safeAddress,
      walletMode,
      status: 'out-of-sync',
      reason: null,
      db: null,
      onChain: null,
      differences: [],
      pending,
      lastFailure,
      offChainOnlyFields: OFF_CHAIN_ONLY_POLICY_FIELDS,
      warnings: [],
      contracts: gate.allowed
        ? { allowed: true, state: 'verified', reason: null }
        : { allowed: false, state: gate.block, reason: sanitizeText(gate.reason) },
    };
    const done = (view: PolicySyncView, extra: Partial<Assessment> = {}): Assessment => ({
      agent: { id: agent.id, walletId: agent.walletId, safeAddress: agent.safeAddress, chainIds: agent.chainIds, tier: agent.tier },
      chainId,
      module,
      walletMode,
      walletError,
      desired: null,
      plan: null,
      view,
      ...extra,
    });

    if (!module) {
      return done({ ...base, status: 'not-configured', reason: `no POLICY_MODULE_ADDRESS_${chainId} configured` });
    }
    if (!agent.policy) {
      return done({ ...base, status: 'no-db-policy', reason: 'the agent has no stored policy (no restrictions apply off-chain either)' });
    }
    const derived = desiredOnChainPolicy({ safeAddress: agent.safeAddress, agentActive: agent.active, policy: agent.policy });
    if (!derived.ok) {
      return done({ ...base, status: 'not-representable', reason: derived.problems.join('; ') });
    }
    const desired = derived.desired;
    const warnings: string[] = [];
    if (desired.cooldownSeconds > 0n) {
      warnings.push(
        `cooldown ${desired.cooldownSeconds} s: AgentPolicyModule applies the cooldown to every ACTION, so once synced any executor ` +
          'batch with more than one action reverts CooldownActive, and anyone can restart the cooldown through the unauthenticated ' +
          'validateTransaction (contract findings in the S8 PR)',
      );
    }
    if (walletMode === 'safe') {
      warnings.push('Safe mode: the sync cannot be signed by the agent wallet (msg.sender would not be the safe); use the operator key');
    }
    const history = syncHistory(syncRows);
    const candidates = {
      contracts: dedupe([...desired.allowedContracts, ...history.contracts]),
      tokens: dedupe([...desired.allowedTokens, ...history.tokens]),
    };
    let reading: OnChainPolicyReading;
    try {
      reading = await readOnChainPolicy(this.deps.reader(chainId), module, desired.safe, candidates);
    } catch (err) {
      const definitive = isDefinitiveContractError(err);
      return done(
        {
          ...base,
          db: dbView(desired, agent.policy.maxValuePerTxEth),
          status: definitive ? 'mismatch' : 'unreadable',
          reason: definitive
            ? `POLICY_MODULE_ADDRESS_${chainId}=${module} did not answer as an AgentPolicyModule (${firstLine(err)}) — no code, wrong address or wrong chain`
            : `the chain could not be read: ${firstLine(err)}`,
          warnings,
        },
        { desired },
      );
    }
    const plan = planPolicySync(desired, reading, history);
    const inSync = plan.differences.length === 0;
    const status: PolicySyncState = pending.length > 0 ? 'pending' : inSync ? 'in-sync' : lastFailure ? 'failed' : 'out-of-sync';
    return done(
      {
        ...base,
        status,
        db: dbView(desired, agent.policy.maxValuePerTxEth),
        onChain: onChainView(reading),
        differences: plan.differences,
        warnings,
      },
      { desired, plan },
    );
  }
}

function dedupe(list: Address[]): Address[] {
  const seen = new Map<string, Address>();
  for (const a of list) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}
