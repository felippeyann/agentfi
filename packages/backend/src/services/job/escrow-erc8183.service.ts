/**
 * ERC-8183 escrow orchestrator (C3).
 *
 * Drives `AgentJobEscrow` (packages/contracts/src/AgentJobEscrow.sol) for paid
 * agent-to-agent jobs. Every function here is pure in the sense of
 * `transaction.processor.ts`: collaborators (`db`, the transaction queue, the
 * settlement queue, a public client factory, the evaluator signer, config)
 * are injected through `Erc8183Deps`, so the whole step chain is unit-tested
 * with a mocked Prisma client and fake receipts. `escrow-erc8183.runtime.ts`
 * binds the real singletons.
 *
 * Step chain (who signs what — see docs/architecture/erc-8183-mapping.md §6):
 *
 *   requester wallet   create ─► setBudget ─► approve(USDC) ─► fund      (TxType ESCROW_LOCK)
 *   provider wallet    [register] ─► setProviderAgentId (R2)            (TxType ERC8004_IDENTITY)
 *   provider wallet    submit                                           (TxType ESCROW_SUBMIT)
 *   evaluator signer   complete | reject | claimRefund                  (settlement queue, no Transaction row)
 *
 * R2: when `fund` confirms, `erc8004-identity.service.ts` gives the provider
 * an ERC-8004 identity (minted from its own wallet on its first funded job,
 * decision D7) and binds it to the job, so the ReputationHook can write
 * feedback at settlement. `setProviderAgentId` is only valid while the job is
 * Funded, so a `submit` requested while the binding is BINDING is deferred
 * (`Job.deferredSubmitAt`) and released here when the binding is terminal.
 * The binding never blocks payment: any failure ends it FAILED/SKIPPED.
 *
 * C3c — the chain is the source of truth:
 *  - A Transaction row is never enough to unwind a step: before a failed
 *    `setBudget`/`approve`/`fund`/`submit` unwinds the Job, `getJob(onChainJobId)`
 *    is read and, when the chain is further than the row says (a `fund` whose
 *    monitor timed out but mined, a retried `fund` that reverted because the
 *    first one mined), the Job advances from the chain instead. An unreadable
 *    chain never unwinds anything: the job is left for the reconciliation.
 *  - Every step advance is a conditional write from the expected previous
 *    `onChainStatus`, so the transaction monitor, the re-poll of SUBMITTED rows
 *    and the reconciliation can all observe the same confirmation and the
 *    effects (next step, binding, settlement) still happen once.
 *  - `reconcileEscrowJobs` (payment-recovery tick) re-reads the chain for
 *    escrow jobs whose step transactions went stale, re-enqueues a lost
 *    cancellation refund, and keeps the funding lane moving.
 *  - Funding lane: one requester's jobs `approve` → `fund` one at a time per
 *    chain (`pumpFunding`), because `approve(escrow, budget)` sets — not adds
 *    to — the allowance.
 *  - A cancellation never rejects a job that is Submitted on-chain (the
 *    provider delivered): the refusal is logged and alerted, settlement or the
 *    operator resolves it.
 *
 * `Job.onChainStatus` records the last CONFIRMED step:
 *   CREATING → OPEN → BUDGET_SET → APPROVED → FUNDED → SUBMITTED → SETTLING → COMPLETED | REJECTED
 *   FUNDED | SUBMITTED → EXPIRED (claimRefund after expiresAt)
 *   any step before FUNDED fails → FAILED (nothing is locked on-chain)
 *   expired while still Open on-chain → EXPIRED_UNFUNDED (nothing was ever locked; `fund` is closed)
 *
 * Idempotency: each agent-signed step has a deterministic Transaction
 * `intentId = "erc8183:<step>:<jobId>"`; the settlement queue dedupes on
 * `"<action>-<jobId>"` and every settlement reads the on-chain job status
 * first, so a redelivered or recovered job never settles twice.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToString,
  keccak256,
  parseEventLogs,
  parseUnits,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../../abi/ReputationHook.abi.js';
import { getKnownTokenBySymbol } from '../transaction/token-registry.js';
import { sanitizeStoredError } from '../../api/errors/sanitize.js';
import type { EvaluatorSigner, EvaluatorWriteParams } from '../escrow/evaluator-signer.js';
import type { FinalizeA2APaymentJobParams } from './payment-finalizer.service.js';
import type { ProcessorLogger, TransactionJobData } from '../../queues/transaction.processor.js';
import { NO_LANE, fundingLaneKey, type LaneLock } from '../transaction/wallet-lane.js';
import {
  enqueueAgentStep,
  IN_FLIGHT_TX,
  intentAttemptsFilter,
  PENDING_TX_STATUSES,
  type SigningAgent,
} from './escrow-tx-steps.js';
import {
  onIdentityTxOutcome,
  resumeBinding,
  startProviderBinding,
  TERMINAL_BINDING_STATUSES,
  type IdentityStep,
} from './erc8004-identity.service.js';

// ── Constants ──────────────────────────────────────────────────────────────

export const ESCROW_KIND = 'erc8183' as const;

/** USDC-only by decision D8; the escrow token has 6 decimals on every supported chain. */
export const ESCROW_TOKEN_DECIMALS = 6;

export type EscrowStep = 'create' | 'setBudget' | 'approve' | 'fund' | 'submit';

export type OnChainStatus =
  | 'CREATING'
  | 'OPEN'
  | 'BUDGET_SET'
  | 'APPROVED'
  | 'FUNDED'
  | 'SUBMITTED'
  | 'SETTLING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXPIRED_UNFUNDED'
  | 'FAILED';

/** `AgentJobEscrow.JobStatus` enum values. */
export const CHAIN_JOB_STATUS = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

/** `bytes32 reason` values the evaluator passes to complete/reject (hash of the human-readable reason). */
export const SETTLEMENT_REASONS = {
  completed: keccak256(toBytes('agentfi.completed')),
  contested: keccak256(toBytes('agentfi.contested')),
  cancelled: keccak256(toBytes('agentfi.cancelled')),
  providerFailed: keccak256(toBytes('agentfi.provider-failed')),
} as const;

export type SettlementAction = 'settle' | 'reject' | 'claimRefund' | 'sweep';
export type CancellationReason = 'cancelled' | 'provider-failed';

export interface EscrowSettlementJobData {
  jobId: string;
  action: SettlementAction;
  reason?: CancellationReason;
}

/** Minimal ERC-20 ABI for the client's `approve(escrow, budget)` step and the allowance read. */
const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** `onChainStatus` values before the budget is locked (a `fund` confirmation may still move them to FUNDED). */
export const PRE_FUNDED_STATUSES = ['CREATING', 'OPEN', 'BUDGET_SET', 'APPROVED', 'FAILED'] as const;
/** `onChainStatus` values after which the chain can never change again. */
export const FINAL_ON_CHAIN_STATUSES = ['COMPLETED', 'REJECTED', 'EXPIRED', 'EXPIRED_UNFUNDED'] as const;

// ── Dependencies ───────────────────────────────────────────────────────────

export interface Erc8183ChainConfig {
  chainId: number;
  escrow: Address;
  /** `REPUTATION_HOOK_ADDRESS_<chainId>` or null → `createJob(..., address(0))`. */
  hook: Address | null;
}

export interface Erc8183Config {
  /** Address derived from ESCROW_EVALUATOR_PRIVATE_KEY, or null when not configured. */
  evaluatorAddress: Address | null;
  jobTtlSeconds: number;
  evaluationDelaySeconds: number;
  backendPublicUrl: string;
  chain(chainId: number): Erc8183ChainConfig | null;
  /** R2: ERC-8004 Identity Registry on `chainId` (null/absent → the identity step is SKIPPED). */
  identityRegistry?(chainId: number): Address | null;
  /** R2: public MCP endpoint advertised in agent registration files (`MCP_PUBLIC_URL`). */
  mcpPublicUrl?: string | null;
  /** C3c: alert when the evaluator's native balance is below this (wei) before it sends. Absent → no check. */
  evaluatorMinBalanceWei?: bigint | null;
}

export type EscrowPublicClient = Pick<PublicClient, 'getTransactionReceipt' | 'readContract'> &
  Partial<Pick<PublicClient, 'getBalance'>>;

export interface SettlementEnqueue {
  add(data: EscrowSettlementJobData, opts?: { delayMs?: number }): Promise<void>;
}

/** Operator alert (C3c): a decision the backend refuses to take on its own, or a resource running out. */
export interface EscrowAlert {
  kind: 'cancellation-refused' | 'chain-conflict' | 'evaluator-balance-low';
  message: string;
  jobId?: string;
  chainId?: number | null;
  details?: Record<string, unknown>;
}

export interface Erc8183Deps {
  db: PrismaClient;
  queue: Pick<Queue<TransactionJobData>, 'add'>;
  settlement: SettlementEnqueue;
  publicClient(chainId: number): EscrowPublicClient;
  evaluatorSigner(chainId: number): EvaluatorSigner;
  config: Erc8183Config;
  releaseJobEscrow(jobId: string): Promise<void>;
  finalize(params: FinalizeA2APaymentJobParams): Promise<void>;
  logger: ProcessorLogger;
  now?: () => Date;
  /** C3c: cross-process lock for the funding lane (Redis in production). Absent → no locking (single caller). */
  lanes?: LaneLock;
  /** C3c: operator alert channel (notifications). Alerts are also logged. */
  alert?(alert: EscrowAlert): Promise<void> | void;
}

/** The slice of a BullMQ job the settlement processor reads — a plain object satisfies it in tests. */
export interface SettlementJobLike {
  data: EscrowSettlementJobData;
  attemptsMade?: number;
  opts?: { attempts?: number };
}

function nowOf(deps: Pick<Erc8183Deps, 'now'>): Date {
  return deps.now?.() ?? new Date();
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

async function raiseAlert(deps: Erc8183Deps, alert: EscrowAlert): Promise<void> {
  deps.logger.error({ alert: alert.kind, jobId: alert.jobId, chainId: alert.chainId, ...alert.details }, `ESCROW ALERT: ${alert.message}`);
  try {
    await deps.alert?.(alert);
  } catch (err) {
    deps.logger.warn({ alert: alert.kind, err: errorMessage(err) }, 'Escrow alert could not be delivered');
  }
}

// ── Enablement + token ─────────────────────────────────────────────────────

/** True when the chain has an escrow address AND the evaluator key is configured. */
export function isErc8183EnabledWith(config: Erc8183Config, chainId: number): boolean {
  return config.evaluatorAddress !== null && config.chain(chainId) !== null;
}

const escrowTokenCache = new Map<number, Address>();

/**
 * The escrow's immutable `token()` (USDC), read once per chain and cached.
 * Falls back to the token registry's USDC when the RPC read fails so job
 * creation does not depend on a live RPC for a value that never changes.
 */
export async function getEscrowToken(deps: Erc8183Deps, chainId: number): Promise<Address> {
  const cached = escrowTokenCache.get(chainId);
  if (cached) return cached;

  const chain = deps.config.chain(chainId);
  if (!chain) throw new Error(`ERC-8183 escrow is not configured on chain ${chainId}`);

  try {
    const token = (await deps.publicClient(chainId).readContract({
      address: chain.escrow,
      abi: AGENT_JOB_ESCROW_ABI,
      functionName: 'token',
    })) as Address;
    const checksummed = getAddress(token);
    escrowTokenCache.set(chainId, checksummed);
    return checksummed;
  } catch (err) {
    const fallback = getKnownTokenBySymbol('USDC', chainId)?.address;
    if (!fallback) {
      throw new Error(
        `Could not read AgentJobEscrow.token() on chain ${chainId} and no USDC is registered: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    deps.logger.warn(
      { chainId, escrow: chain.escrow, err: (err as Error)?.message ?? String(err) },
      'AgentJobEscrow.token() read failed — using the registry USDC address (not cached)',
    );
    return fallback;
  }
}

/** Testing hook — clears the per-chain `token()` cache. */
export function __resetEscrowTokenCacheForTests(): void {
  escrowTokenCache.clear();
  evaluatorBalanceAlertAt.clear();
}

/**
 * Decision D8: a reward on an ERC-8183 chain must be USDC — by symbol or by
 * the escrow token address (case-insensitive).
 */
export function isEscrowTokenReward(token: string, escrowToken: Address): boolean {
  return token.toUpperCase() === 'USDC' || token.toLowerCase() === escrowToken.toLowerCase();
}

// ── Transaction steps (agent wallets through the transaction queue) ────────

export function escrowIntentId(step: EscrowStep, jobId: string): string {
  return `erc8183:${step}:${jobId}`;
}

/**
 * Creates the Transaction row and enqueues it for the agent's wallet
 * (`escrow-tx-steps.ts`). A step whose deterministic `intentId` already exists
 * in a live state is returned as-is (idempotent); a terminal-failed one gets a
 * suffixed `intentId` so the provider can retry `submit` (the only ERC-8183
 * step that is ever retried).
 */
async function enqueueStep(
  deps: Erc8183Deps,
  params: {
    jobId: string;
    chainId: number;
    step: EscrowStep;
    signer: SigningAgent;
    to: Address;
    data: Hex;
    type: 'ESCROW_LOCK' | 'ESCROW_SUBMIT';
    extraMetadata?: Record<string, unknown>;
  },
): Promise<string> {
  return enqueueAgentStep(deps, { ...params, intentId: escrowIntentId(params.step, params.jobId) });
}

/** Latest attempt (any status) of a step for a job, or null. */
async function latestStepTx(deps: Erc8183Deps, step: EscrowStep, jobId: string) {
  return deps.db.transaction.findFirst({
    where: intentAttemptsFilter(escrowIntentId(step, jobId)),
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, error: true, txHash: true, createdAt: true },
  });
}

/** True while a `submit` of the job is queued, broadcast or confirmed (it may land / has landed on-chain). */
async function liveSubmitExists(deps: Erc8183Deps, jobId: string, excludeTransactionId?: string): Promise<boolean> {
  const live = await deps.db.transaction.findFirst({
    where: {
      ...intentAttemptsFilter(escrowIntentId('submit', jobId)),
      status: { in: [...IN_FLIGHT_TX] as never },
      ...(excludeTransactionId ? { id: { not: excludeTransactionId } } : {}),
    },
    select: { id: true },
  });
  return live !== null;
}

// ── startEscrow ────────────────────────────────────────────────────────────

export interface StartEscrowParams {
  job: { id: string };
  requester: SigningAgent;
  provider: { safeAddress: string };
  /** Human-readable reward amount (e.g. "12.5"). */
  amount: string;
  chainId: number;
}

/**
 * Persists the escrow columns on the Job and enqueues `createJob` from the
 * requester's wallet. Throws (before touching the queue) when the chain is not
 * enabled or the evaluator is missing; the route turns that into an error.
 */
export async function startEscrow(deps: Erc8183Deps, params: StartEscrowParams): Promise<void> {
  const chain = deps.config.chain(params.chainId);
  const evaluator = deps.config.evaluatorAddress;
  if (!chain || !evaluator) {
    throw new Error(`ERC-8183 escrow is not enabled on chain ${params.chainId}`);
  }

  const token = await getEscrowToken(deps, params.chainId);
  const budget = parseUnits(params.amount, ESCROW_TOKEN_DECIMALS);
  if (budget <= 0n) throw new Error('ERC-8183 budget must be greater than zero');

  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + deps.config.jobTtlSeconds * 1000);

  await deps.db.job.update({
    where: { id: params.job.id },
    data: {
      escrowKind: ESCROW_KIND,
      escrowChainId: params.chainId,
      escrowContract: chain.escrow,
      evaluator,
      budgetToken: token,
      budgetAmount: budget.toString(),
      expiresAt,
      onChainStatus: 'CREATING',
      escrowError: null,
    },
  });

  const description = `${deps.config.backendPublicUrl}/v1/jobs/${params.job.id}`;
  const data = encodeFunctionData({
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'createJob',
    args: [
      getAddress(params.provider.safeAddress),
      evaluator,
      BigInt(Math.floor(expiresAt.getTime() / 1000)),
      description,
      chain.hook ?? zeroAddress,
    ],
  });

  await enqueueStep(deps, {
    jobId: params.job.id,
    chainId: params.chainId,
    step: 'create',
    signer: params.requester,
    to: chain.escrow,
    data,
    type: 'ESCROW_LOCK',
  });
}

// ── Step outcomes (called by the transaction worker / guard) ───────────────

export interface EscrowTxOutcome {
  transactionId: string;
  status: 'CONFIRMED' | 'REVERTED' | 'FAILED';
  error?: string | null;
}

type EscrowJobRow = Prisma.JobGetPayload<{
  include: {
    requester: { select: { id: true; walletId: true; safeAddress: true } };
    provider: { select: { id: true; walletId: true; safeAddress: true } };
  };
}>;

const JOB_INCLUDE = {
  requester: { select: { id: true, walletId: true, safeAddress: true } },
  provider: { select: { id: true, walletId: true, safeAddress: true } },
} as const;

async function loadEscrowJob(deps: Erc8183Deps, jobId: string): Promise<EscrowJobRow | null> {
  const job = await deps.db.job.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
  if (!job || job.escrowKind !== ESCROW_KIND) return null;
  return job;
}

const LIVE_JOB_STATUSES = new Set(['PENDING', 'ACCEPTED']);
const LIVE_JOB_STATUS_LIST = ['PENDING', 'ACCEPTED'] as const;

interface StepTxRef {
  id: string;
  txHash: string | null;
}

/**
 * Entry point for rows with `metadata.erc8183 === true`, invoked from the
 * transaction processor's post-confirmation handler, its permanent-failure
 * handler and the pre-submit guard's fail path.
 */
export async function onEscrowTxOutcome(deps: Erc8183Deps, outcome: EscrowTxOutcome): Promise<void> {
  const tx = await deps.db.transaction.findUnique({
    where: { id: outcome.transactionId },
    select: { txHash: true, chainId: true, agentId: true, metadata: true },
  });
  const meta = (tx?.metadata ?? null) as
    | { jobId?: string; erc8183?: boolean; escrowStep?: EscrowStep | IdentityStep; deliverable?: Hex }
    | null;
  if (!tx || meta?.erc8183 !== true || typeof meta.jobId !== 'string' || !meta.escrowStep) return;

  // R2: the provider's ERC-8004 `register` / `setProviderAgentId`. A binding
  // that reaches a terminal state releases a `submit` deferred behind it.
  if (meta.escrowStep === 'register' || meta.escrowStep === 'bindAgent') {
    const terminalJobIds = await onIdentityTxOutcome(
      deps,
      { id: outcome.transactionId, agentId: tx.agentId, chainId: tx.chainId, txHash: tx.txHash },
      meta.escrowStep,
      meta.jobId,
      { status: outcome.status, error: outcome.error ?? null },
    );
    for (const jobId of terminalJobIds) await releaseDeferredSubmit(deps, jobId);
    return;
  }
  const escrowStep: EscrowStep = meta.escrowStep;

  const job = await loadEscrowJob(deps, meta.jobId);
  if (!job) {
    deps.logger.warn({ transactionId: outcome.transactionId, jobId: meta.jobId }, 'ERC-8183 outcome for unknown job');
    return;
  }

  const stepTx: StepTxRef = { id: outcome.transactionId, txHash: tx.txHash };
  if (outcome.status !== 'CONFIRMED') {
    await handleStepFailure(deps, job, escrowStep, `${escrowStep} ${outcome.status}: ${outcome.error ?? 'no error recorded'}`, stepTx);
    return;
  }
  await onStepConfirmed(deps, job, escrowStep, stepTx, meta.deliverable ?? null);
}

async function onStepConfirmed(
  deps: Erc8183Deps,
  job: EscrowJobRow,
  escrowStep: EscrowStep,
  tx: StepTxRef,
  deliverable: Hex | null,
): Promise<void> {
  switch (escrowStep) {
    case 'create': {
      if (!tx.txHash) {
        await handleStepFailure(deps, job, 'create', 'create CONFIRMED without a txHash', tx);
        return;
      }
      const onChainJobId = await readCreatedJobId(deps, job, tx.txHash as Hex);
      if (onChainJobId === null) {
        await handleStepFailure(deps, job, 'create', `JobCreated event not found in receipt ${tx.txHash}`, tx);
        return;
      }
      // Recorded even when the job is no longer live, so the expiry sweep and
      // the reconciliation can always find the on-chain job.
      const claimed = await deps.db.job.updateMany({
        where: { id: job.id, onChainJobId: null },
        data: { onChainJobId, onChainStatus: 'OPEN', escrowError: null },
      });
      if (claimed.count === 0) return; // another observer recorded it
      deps.logger.info({ jobId: job.id, onChainJobId, txHash: tx.txHash }, 'ERC-8183 job created on-chain');
      await continueChain(deps, job.id, 'setBudget');
      return;
    }
    case 'setBudget': {
      const claimed = await deps.db.job.updateMany({
        where: { id: job.id, onChainStatus: 'OPEN' },
        data: { onChainStatus: 'BUDGET_SET' },
      });
      if (claimed.count === 0) return;
      await afterBudgetSet(deps, job.id);
      return;
    }
    case 'approve': {
      const claimed = await deps.db.job.updateMany({
        where: { id: job.id, onChainStatus: 'BUDGET_SET' },
        data: { onChainStatus: 'APPROVED' },
      });
      if (claimed.count === 0) return;
      await continueChain(deps, job.id, 'fund');
      return;
    }
    case 'fund':
      await advanceToFunded(deps, job.id, `fund ${tx.txHash ?? ''} confirmed`);
      return;
    case 'submit':
      await advanceToSubmitted(deps, job.id, { deliverable, scheduleSettle: true });
      return;
  }
}

/** Reads the receipt of the `create` tx and returns the `JobCreated.jobId` emitted by our escrow. */
async function readCreatedJobId(deps: Erc8183Deps, job: EscrowJobRow, txHash: Hex): Promise<string | null> {
  const receipt = await deps.publicClient(job.escrowChainId!).getTransactionReceipt({ hash: txHash });
  const escrow = job.escrowContract!.toLowerCase();
  const created = parseEventLogs({
    abi: AGENT_JOB_ESCROW_ABI,
    eventName: 'JobCreated',
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === escrow),
  });
  const event = created[0];
  return event ? event.args.jobId.toString() : null;
}

/** BUDGET_SET confirmed: hand the job to its requester's funding lane (or stop a job that is no longer live). */
async function afterBudgetSet(deps: Erc8183Deps, jobId: string): Promise<void> {
  const job = await loadEscrowJob(deps, jobId);
  if (!job) return;
  if (!LIVE_JOB_STATUSES.has(job.status)) {
    deps.logger.warn(
      { jobId, status: job.status, onChainStatus: job.onChainStatus, nextStep: 'approve' },
      'ERC-8183 chain stopped — job is no longer live; nothing is locked on-chain',
    );
    return;
  }
  if (job.escrowChainId !== null) await pumpFunding(deps, job.requesterId, job.escrowChainId);
}

/** Enqueues the next requester-signed step unless the job has left PENDING/ACCEPTED (cancelled, failed). */
async function continueChain(deps: Erc8183Deps, jobId: string, step: 'setBudget' | 'fund'): Promise<void> {
  const job = await loadEscrowJob(deps, jobId);
  if (!job) return;
  if (!LIVE_JOB_STATUSES.has(job.status)) {
    deps.logger.warn(
      { jobId, status: job.status, onChainStatus: job.onChainStatus, nextStep: step },
      'ERC-8183 chain stopped — job is no longer live; nothing is locked on-chain',
    );
    // A job that stops after `approve` gives the requester's funding lane back.
    if (step === 'fund' && job.escrowChainId !== null) await pumpFunding(deps, job.requesterId, job.escrowChainId);
    return;
  }
  if (!job.onChainJobId || !job.budgetAmount || !job.budgetToken || !job.escrowContract || !job.escrowChainId) {
    await handleStepFailure(deps, job, step, `cannot build ${step}: escrow columns incomplete`, null);
    return;
  }

  const onChainJobId = BigInt(job.onChainJobId);
  const budget = BigInt(job.budgetAmount);
  const escrow = getAddress(job.escrowContract);
  const data =
    step === 'setBudget'
      ? encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'setBudget', args: [onChainJobId, budget, '0x'] })
      : encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'fund', args: [onChainJobId, budget, '0x'] });

  await enqueueStep(deps, {
    jobId,
    chainId: job.escrowChainId,
    step,
    signer: job.requester,
    to: escrow,
    data,
    type: 'ESCROW_LOCK',
  });
}

// ── Funding lane (C3c) ─────────────────────────────────────────────────────

/**
 * Sends the next `approve` of a requester's funding lane on `chainId`.
 *
 * `approve(escrow, budget)` SETS the allowance, so two jobs of one requester
 * funding at once (approve A, approve B, fund A, fund B) leave B's `fund`
 * short and it reverts. The lane admits one job at a time between `approve`
 * and the end of its `fund`: the lane is busy while a live job of the
 * requester is APPROVED (its `fund` is about to go out or is out) or while
 * any of its `approve`/`fund` transactions on the chain is pending. Waiting
 * jobs sit in BUDGET_SET and go oldest first. Every lane exit (fund
 * confirmed, funding unwound, chain stopped) calls this again; the
 * reconciliation calls it for jobs that waited too long. The check-and-claim
 * runs under the cross-process lock `funding:<chainId>:<requesterId>`.
 */
export async function pumpFunding(deps: Erc8183Deps, requesterId: string, chainId: number): Promise<string | null> {
  const lanes = deps.lanes ?? NO_LANE;
  return lanes.run(fundingLaneKey(chainId, requesterId), async () => {
    const scope = { requesterId, escrowChainId: chainId, escrowKind: ESCROW_KIND };
    const holder = await deps.db.job.findFirst({
      where: { ...scope, onChainStatus: 'APPROVED', status: { in: [...LIVE_JOB_STATUS_LIST] } },
      select: { id: true },
    });
    if (holder) return null;
    const pending = await deps.db.transaction.findFirst({
      where: {
        agentId: requesterId,
        chainId,
        type: 'ESCROW_LOCK',
        status: { in: [...PENDING_TX_STATUSES] },
        OR: [{ intentId: { startsWith: 'erc8183:approve:' } }, { intentId: { startsWith: 'erc8183:fund:' } }],
      },
      select: { id: true },
    });
    if (pending) return null;

    const next = await deps.db.job.findFirst({
      where: { ...scope, onChainStatus: 'BUDGET_SET', status: { in: [...LIVE_JOB_STATUS_LIST] } },
      orderBy: { createdAt: 'asc' },
      include: JOB_INCLUDE,
    });
    if (!next) return null;
    if (!next.onChainJobId || !next.budgetAmount || !next.budgetToken || !next.escrowContract) {
      await handleStepFailure(deps, next, 'approve', 'cannot build approve: escrow columns incomplete', null);
      return null;
    }
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [getAddress(next.escrowContract), BigInt(next.budgetAmount)],
    });
    await enqueueStep(deps, {
      jobId: next.id,
      chainId,
      step: 'approve',
      signer: next.requester,
      to: getAddress(next.budgetToken),
      data,
      type: 'ESCROW_LOCK',
    });
    return next.id;
  });
}

// ── Chain-driven advances (C3c) ────────────────────────────────────────────

interface ChainJob {
  status: number;
  budget: bigint;
}

async function readChainJob(deps: Erc8183Deps, job: Pick<EscrowJobRow, 'escrowChainId' | 'escrowContract' | 'onChainJobId'>): Promise<ChainJob> {
  const raw = (await deps.publicClient(job.escrowChainId!).readContract({
    address: getAddress(job.escrowContract!),
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'getJob',
    args: [BigInt(job.onChainJobId!)],
  })) as { status: number; budget: bigint };
  return { status: Number(raw.status), budget: BigInt(raw.budget ?? 0n) };
}

/** `readChainJob`, or null (logged) when the job has no on-chain id or the RPC fails. */
async function tryReadChainJob(deps: Erc8183Deps, job: EscrowJobRow): Promise<ChainJob | null> {
  if (!job.onChainJobId || !job.escrowContract || !job.escrowChainId) return null;
  try {
    return await readChainJob(deps, job);
  } catch (err) {
    deps.logger.warn({ jobId: job.id, onChainJobId: job.onChainJobId, err: errorMessage(err) }, 'ERC-8183 getJob read failed');
    return null;
  }
}

/**
 * The budget is locked on-chain (`fund` confirmed, or the chain says Funded
 * while the DB lags). Conditional on a pre-FUNDED `onChainStatus`, so the
 * effects run once however many observers report it: a cancellation that
 * landed meanwhile gets its evaluator `reject`, otherwise the provider's
 * ERC-8004 binding starts; the requester's funding lane moves on either way.
 */
async function advanceToFunded(deps: Erc8183Deps, jobId: string, source: string): Promise<boolean> {
  const claimed = await deps.db.job.updateMany({
    where: { id: jobId, onChainStatus: { in: [...PRE_FUNDED_STATUSES] } },
    data: { onChainStatus: 'FUNDED', escrowError: null },
  });
  if (claimed.count === 0) return false;
  const job = await loadEscrowJob(deps, jobId);
  if (!job) return true;
  deps.logger.info({ jobId, onChainJobId: job.onChainJobId, source }, 'ERC-8183 job funded');

  if (job.status === 'CANCELLED' || job.status === 'FAILED') {
    // A cancellation (or a funding failure) that landed while `fund` was in
    // flight: the budget is locked now, so unwind it through the evaluator.
    await deps.settlement.add({ jobId, action: 'reject', reason: 'cancelled' });
    deps.logger.warn({ jobId, status: job.status }, 'ERC-8183 job funded after cancellation — evaluator reject scheduled');
  } else {
    // R2: bind the provider's ERC-8004 identity (minting it first if this is
    // its first funded job on the chain). Never allowed to affect the funding
    // outcome above: any error ends the binding FAILED and the job goes on.
    // No submit can be deferred yet (ACCEPTED requires FUNDED), so the
    // terminal ids it returns need no release here.
    try {
      await startProviderBinding(deps, { id: job.id, status: job.status, escrowChainId: job.escrowChainId, provider: job.provider });
    } catch (err) {
      const reason = `binding could not be started: ${errorMessage(err)}`;
      await deps.db.job
        .updateMany({ where: { id: job.id, providerAgentIdStatus: 'BINDING' }, data: { providerAgentIdStatus: 'FAILED', providerAgentIdError: reason } })
        .catch(() => undefined);
      deps.logger.error({ jobId: job.id, err: reason }, 'ERC-8004 binding failed to start — job continues without feedback');
    }
  }
  if (job.escrowChainId !== null) await pumpFunding(deps, job.requesterId, job.escrowChainId);
  return true;
}

/**
 * The provider's deliverable is on-chain (`submit` confirmed, or the chain
 * says Submitted while the DB lags — a submit whose monitor was lost, or one
 * the DB already handed back to ACCEPTED). Conditional on a pre-SUBMITTED
 * `onChainStatus`. The Job follows the chain to PAYMENT_PENDING when it was
 * ACCEPTED; a CANCELLED/FAILED job is a conflict the backend does not resolve
 * on its own (alert: settlement or the operator decides; at `expiresAt` the
 * expiry sweep refunds). Settlement is scheduled for a PAYMENT_PENDING job.
 */
async function advanceToSubmitted(
  deps: Erc8183Deps,
  jobId: string,
  opts: { deliverable?: Hex | null; scheduleSettle: boolean },
): Promise<'advanced' | 'already' | 'conflict'> {
  const before = await deps.db.job.findUnique({ where: { id: jobId }, select: { onChainStatus: true } });
  const claimed = await deps.db.job.updateMany({
    where: { id: jobId, onChainStatus: { in: [...PRE_FUNDED_STATUSES, 'FUNDED'] } },
    data: {
      onChainStatus: 'SUBMITTED',
      ...(opts.deliverable ? { deliverableHash: opts.deliverable } : {}),
      escrowError: null,
    },
  });
  const job = await loadEscrowJob(deps, jobId);
  if (!job) return 'already';
  // Both the fund and the submit outcome were lost: the job skipped FUNDED in
  // the DB, so give the requester's funding lane back here.
  if (claimed.count > 0 && (PRE_FUNDED_STATUSES as readonly string[]).includes(before?.onChainStatus ?? '') && job.escrowChainId !== null) {
    await pumpFunding(deps, job.requesterId, job.escrowChainId);
  }

  if (job.status === 'ACCEPTED') {
    const moved = await deps.db.job.updateMany({ where: { id: jobId, status: 'ACCEPTED' }, data: { status: 'PAYMENT_PENDING' } });
    if (moved.count > 0) {
      deps.logger.warn({ jobId }, 'ERC-8183 deliverable is Submitted on-chain while the job was ACCEPTED — job follows the chain to PAYMENT_PENDING');
    }
  } else if (job.status !== 'PAYMENT_PENDING') {
    if (claimed.count > 0) {
      await raiseAlert(deps, {
        kind: 'chain-conflict',
        jobId,
        chainId: job.escrowChainId,
        message: `Job ${jobId} is ${job.status} but its deliverable is Submitted on-chain — not settled automatically; settle or reject it as the operator (the expiry sweep refunds the requester at expiresAt)`,
        details: { status: job.status, onChainJobId: job.onChainJobId },
      });
    }
    return 'conflict';
  }

  if (claimed.count === 0) return 'already';
  if (opts.scheduleSettle) {
    const delayMs = deps.config.evaluationDelaySeconds * 1000;
    await deps.settlement.add({ jobId, action: 'settle' }, delayMs > 0 ? { delayMs } : undefined);
    deps.logger.info({ jobId, delayMs }, 'ERC-8183 deliverable submitted — settlement scheduled');
  }
  return 'advanced';
}

/**
 * A step that REVERTED, was blocked by the guard, exhausted broadcast
 * retries or was dropped. C3c: once the job exists on-chain, the chain decides
 * before anything is unwound:
 *
 *  - chain terminal → mirrored (`reconcileTerminal`);
 *  - chain Submitted → the deliverable is on-chain: advance (never "retry");
 *  - chain Funded → the budget is locked: advance to FUNDED (a `fund` whose
 *    row says FAILED/REVERTED but whose first broadcast mined);
 *  - chain Open with the budget already set / the allowance already granted →
 *    that step did mine: advance;
 *  - chain unreadable → nothing is unwound; `escrowError` records why and the
 *    reconciliation retries;
 *  - otherwise (chain really behind):
 *     - `submit`: the budget stays locked; the Job goes back to ACCEPTED with
 *       `escrowError` so the provider can PATCH COMPLETED again — unless
 *       another `submit` of the job is in flight;
 *     - any funding step: nothing is locked on-chain, so the Job is FAILED,
 *       the DB reservation released, the requester's funding lane moves on,
 *       and no on-chain `reject` is sent (an Open job is inert and expires).
 */
async function handleStepFailure(
  deps: Erc8183Deps,
  job: EscrowJobRow,
  step: EscrowStep,
  reason: string,
  tx: StepTxRef | null,
): Promise<void> {
  if (step !== 'create' && job.onChainJobId) {
    const chain = await tryReadChainJob(deps, job);
    if (!chain) {
      await deps.db.job.update({
        where: { id: job.id },
        data: { escrowError: `${reason} — on-chain state unreadable, left for reconciliation` },
      });
      deps.logger.error({ jobId: job.id, step, reason }, 'ERC-8183 step failed but the chain could not be read — nothing unwound');
      return;
    }
    if (chain.status >= CHAIN_JOB_STATUS.Completed) {
      await reconcileTerminal(deps, job, chain.status);
      return;
    }
    if (chain.status === CHAIN_JOB_STATUS.Submitted) {
      deps.logger.warn({ jobId: job.id, step, reason }, 'ERC-8183 step reported failed but the job is Submitted on-chain — advancing from the chain');
      await advanceToSubmitted(deps, job.id, { scheduleSettle: true });
      return;
    }
    if (chain.status === CHAIN_JOB_STATUS.Funded) {
      if (step !== 'submit') {
        deps.logger.warn({ jobId: job.id, step, reason }, 'ERC-8183 step reported failed but the job is Funded on-chain — advancing from the chain');
        await advanceToFunded(deps, job.id, `chain Funded after ${step} failure`);
        return;
      }
    } else if (await openStepMined(deps, job, step, chain)) {
      return;
    }
  }

  if (step === 'submit') {
    if (await liveSubmitExists(deps, job.id, tx?.id)) {
      await deps.db.job.update({ where: { id: job.id }, data: { escrowError: reason } });
      deps.logger.warn({ jobId: job.id, reason }, 'ERC-8183 submit attempt failed while another submit is in flight — job left as is');
      return;
    }
    const returned = await deps.db.job.updateMany({
      where: { id: job.id, status: 'PAYMENT_PENDING' },
      data: { status: 'ACCEPTED', escrowError: reason },
    });
    if (returned.count === 0) await deps.db.job.update({ where: { id: job.id }, data: { escrowError: reason } });
    deps.logger.error({ jobId: job.id, reason }, 'ERC-8183 submit failed (chain still Funded) — job returned to ACCEPTED for retry');
    return;
  }

  await deps.db.job.update({
    where: { id: job.id },
    data: {
      onChainStatus: 'FAILED',
      escrowError: reason,
      ...(LIVE_JOB_STATUSES.has(job.status) ? { status: 'FAILED' } : {}),
    },
  });
  await deps.releaseJobEscrow(job.id);
  deps.logger.error({ jobId: job.id, step, reason }, 'ERC-8183 funding chain failed — job FAILED, reservation released');
  if (job.escrowChainId !== null) await pumpFunding(deps, job.requesterId, job.escrowChainId);
}

/**
 * Chain Open after a reported failure of `setBudget` / `approve`: did that
 * step mine anyway? `setBudget` is visible in `getJob().budget`, `approve` in
 * the allowance (with the funding lane, only this job's approve can have
 * granted it). Advances and returns true when it did.
 */
async function openStepMined(deps: Erc8183Deps, job: EscrowJobRow, step: EscrowStep, chain: ChainJob): Promise<boolean> {
  if (!job.budgetAmount) return false;
  const budget = BigInt(job.budgetAmount);
  if (step === 'setBudget' && chain.budget === budget) {
    const claimed = await deps.db.job.updateMany({ where: { id: job.id, onChainStatus: 'OPEN' }, data: { onChainStatus: 'BUDGET_SET' } });
    deps.logger.warn({ jobId: job.id }, 'ERC-8183 setBudget reported failed but the budget is set on-chain — advancing');
    if (claimed.count > 0) await afterBudgetSet(deps, job.id);
    return true;
  }
  if (step === 'approve' && chain.budget === budget && job.budgetToken && job.escrowContract) {
    let allowance: bigint;
    try {
      allowance = (await deps.publicClient(job.escrowChainId!).readContract({
        address: getAddress(job.budgetToken),
        abi: ERC20_APPROVE_ABI,
        functionName: 'allowance',
        args: [getAddress(job.requester.safeAddress), getAddress(job.escrowContract)],
      })) as bigint;
    } catch {
      return false;
    }
    if (allowance >= budget) {
      const claimed = await deps.db.job.updateMany({ where: { id: job.id, onChainStatus: 'BUDGET_SET' }, data: { onChainStatus: 'APPROVED' } });
      deps.logger.warn({ jobId: job.id }, 'ERC-8183 approve reported failed but the allowance is granted — advancing to fund');
      if (claimed.count > 0) await continueChain(deps, job.id, 'fund');
      return true;
    }
  }
  return false;
}

// ── Provider submit (PATCH COMPLETED on an escrow job) ─────────────────────

export function deliverableHashOf(result: unknown): Hex {
  return keccak256(toBytes(JSON.stringify(result ?? {})));
}

/** Enqueues `submit(onChainJobId, deliverable, "0x")` from the provider's wallet. */
async function sendSubmitStep(deps: Erc8183Deps, job: EscrowJobRow, deliverable: Hex): Promise<void> {
  const data = encodeFunctionData({
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'submit',
    args: [BigInt(job.onChainJobId!), deliverable, '0x'],
  });
  await enqueueStep(deps, {
    jobId: job.id,
    chainId: job.escrowChainId!,
    step: 'submit',
    signer: job.provider,
    to: getAddress(job.escrowContract!),
    data,
    type: 'ESCROW_SUBMIT',
    extraMetadata: { deliverable },
  });
}

/**
 * Puts a PAYMENT_PENDING job whose submit could not be sent back to ACCEPTED
 * — unless a submit of the job is queued, broadcast or confirmed, which may
 * still land (C3c: a job is never handed back while its deliverable can go
 * on-chain). Returns true when it was handed back.
 */
async function returnToAcceptedUnlessSubmitLive(deps: Erc8183Deps, jobId: string, reason: string): Promise<boolean> {
  if (await liveSubmitExists(deps, jobId)) return false;
  const returned = await deps.db.job.updateMany({
    where: { id: jobId, status: 'PAYMENT_PENDING' },
    data: { status: 'ACCEPTED', escrowError: reason },
  });
  return returned.count > 0;
}

/**
 * Enqueues `submit(onChainJobId, keccak256(result), "0x")` from the provider's
 * wallet. The route has already moved the Job to PAYMENT_PENDING; on a
 * synchronous failure the Job is put back to ACCEPTED before rethrowing —
 * unless another submit of the job is live (C3c), in which case nothing is
 * handed back and the call returns as if it had enqueued (one is in flight).
 *
 * R2: while the provider's ERC-8004 binding is BINDING the submit is DEFERRED
 * (`deferredSubmitAt` + `deliverableHash` stored, nothing enqueued):
 * `setProviderAgentId` reverts once the job is Submitted, and both
 * transactions come from the provider's wallet, so they must not race.
 * `releaseDeferredSubmit` sends it when the binding is BOUND/FAILED/SKIPPED.
 * The defer is a conditional write on `providerAgentIdStatus = BINDING`, the
 * same row the binding's terminal write is conditioned on, so exactly one of
 * "defer here" or "submit now" happens.
 */
export async function enqueueSubmit(
  deps: Erc8183Deps,
  params: { jobId: string; result: unknown },
): Promise<{ deferred: boolean }> {
  const job = await loadEscrowJob(deps, params.jobId);
  if (!job) throw new Error(`Job ${params.jobId} is not an ERC-8183 escrow job`);
  if (!job.onChainJobId || !job.escrowContract || !job.escrowChainId) {
    throw new Error(`Job ${params.jobId} has no on-chain id yet (onChainStatus=${job.onChainStatus})`);
  }

  const deliverable = deliverableHashOf(params.result);
  try {
    if (job.providerAgentIdStatus === 'BINDING') {
      const deferred = await deps.db.job.updateMany({
        where: { id: job.id, providerAgentIdStatus: 'BINDING' },
        data: { deferredSubmitAt: nowOf(deps), deliverableHash: deliverable, escrowError: null },
      });
      if (deferred.count > 0) {
        deps.logger.info(
          { jobId: job.id, providerAgentId: job.providerAgentId },
          'ERC-8183 submit deferred until the ERC-8004 binding is terminal',
        );
        return { deferred: true };
      }
      // The binding ended between the read and the conditional write: submit now.
    }
    await deps.db.job.update({ where: { id: job.id }, data: { deliverableHash: deliverable, escrowError: null } });
    await sendSubmitStep(deps, job, deliverable);
  } catch (err) {
    const reason = `submit enqueue failed: ${errorMessage(err)}`;
    if (await returnToAcceptedUnlessSubmitLive(deps, job.id, reason)) throw err;
    if (await liveSubmitExists(deps, job.id)) {
      deps.logger.warn(
        { jobId: job.id, err: errorMessage(err), uniqueViolation: isUniqueViolation(err) },
        'ERC-8183 submit enqueue failed but a submit of this job is already in flight — job kept PAYMENT_PENDING',
      );
      return { deferred: false };
    }
    throw err;
  }
  return { deferred: false };
}

/**
 * Sends a `submit` that `enqueueSubmit` deferred behind the ERC-8004 binding.
 * Called for every job whose binding just became terminal; a no-op unless
 * `deferredSubmitAt` is set. Claiming the deferral is a conditional write, so
 * a redelivered outcome or the recovery scan never sends it twice. Dropped
 * (with a log) when the job is no longer PAYMENT_PENDING + FUNDED, e.g. it
 * expired and was refunded meanwhile.
 */
export async function releaseDeferredSubmit(deps: Erc8183Deps, jobId: string): Promise<boolean> {
  // Conditioned on a terminal binding: this is the single place a deferred
  // submit leaves, so the "bind before submit" order cannot be broken by any
  // caller (outcome handler, recovery scan) releasing too early.
  const claimed = await deps.db.job.updateMany({
    where: { id: jobId, deferredSubmitAt: { not: null }, providerAgentIdStatus: { in: [...TERMINAL_BINDING_STATUSES] } },
    data: { deferredSubmitAt: null },
  });
  if (claimed.count === 0) return false;

  const job = await loadEscrowJob(deps, jobId);
  if (!job) return false;
  if (job.status !== 'PAYMENT_PENDING' || job.onChainStatus !== 'FUNDED' || !job.onChainJobId || !job.escrowContract || !job.escrowChainId) {
    deps.logger.warn(
      { jobId, status: job.status, onChainStatus: job.onChainStatus },
      'ERC-8183 deferred submit dropped — job is no longer PAYMENT_PENDING and Funded',
    );
    return false;
  }

  const deliverable = (job.deliverableHash as Hex | null) ?? deliverableHashOf(job.result);
  try {
    await sendSubmitStep(deps, job, deliverable);
  } catch (err) {
    const reason = `deferred submit could not be enqueued: ${errorMessage(err)}`;
    await returnToAcceptedUnlessSubmitLive(deps, job.id, reason);
    deps.logger.error({ jobId, err: reason }, 'ERC-8183 deferred submit failed — job returned to ACCEPTED for retry');
    return false;
  }
  deps.logger.info(
    { jobId, providerAgentIdStatus: job.providerAgentIdStatus },
    'ERC-8183 deferred submit released after the ERC-8004 binding ended',
  );
  return true;
}

// ── Cancellation (requester CANCELLED / provider FAILED) ───────────────────

/**
 * Schedules an evaluator `reject` for a cancelled/failed job that exists
 * on-chain. The reject action reads the chain first (C3c): Open → nothing
 * locked, no-op (a `fund` confirming later schedules the reject again);
 * Funded → full refund; Submitted → refused and alerted (the provider
 * delivered). Scheduling it whatever the DB's `onChainStatus` says covers a
 * `fund` whose monitor was lost (DB APPROVED, chain Funded). Returns true
 * when a reject was scheduled.
 */
export async function requestCancellationReject(
  deps: Erc8183Deps,
  params: { jobId: string; reason: CancellationReason },
): Promise<boolean> {
  const job = await deps.db.job.findUnique({
    where: { id: params.jobId },
    select: { escrowKind: true, onChainStatus: true, onChainJobId: true },
  });
  if (!job || job.escrowKind !== ESCROW_KIND) return false;
  if (!job.onChainJobId || (FINAL_ON_CHAIN_STATUSES as readonly string[]).includes(job.onChainStatus ?? '')) {
    deps.logger.info(
      { jobId: params.jobId, onChainStatus: job.onChainStatus },
      'ERC-8183 cancellation — no on-chain job to unwind, no reject needed',
    );
    return false;
  }
  await deps.settlement.add({ jobId: params.jobId, action: 'reject', reason: params.reason });
  deps.logger.info({ jobId: params.jobId, reason: params.reason }, 'ERC-8183 cancellation — evaluator reject scheduled');
  return true;
}

// ── Feedback file (ERC-8004, docs/architecture/erc-8004-integration.md §4) ──

export const FEEDBACK_FILE_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1';

export interface FeedbackFile {
  type: typeof FEEDBACK_FILE_TYPE;
  jobId: string;
  escrow: { chainId: number; contract: Address; onChainJobId: number };
  proofOfPayment: { chainId: number; txHash: Hex | null; fromAddress: Address; toAddress: Address };
  outcome: 'completed' | 'rejected';
  deliverableHash: Hex | null;
  evaluator: Address;
  issuedAt: string;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The exact bytes that are hashed on-chain and served at
 * `GET /v1/jobs/:id/feedback.json`. Keys are sorted recursively because the
 * file round-trips through a Postgres `jsonb` column, which does not preserve
 * key order; canonical ordering keeps `keccak256(served body)` equal to the
 * committed `feedbackHash` no matter how the JSON was stored.
 */
export function serializeFeedbackFile(file: FeedbackFile | Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(file));
}

export function feedbackHashOf(file: FeedbackFile | Record<string, unknown>): Hex {
  return keccak256(toBytes(serializeFeedbackFile(file)));
}

export function feedbackUriFor(config: Erc8183Config, jobId: string): string {
  return `${config.backendPublicUrl}/v1/jobs/${jobId}/feedback.json`;
}

async function buildFeedbackFile(deps: Erc8183Deps, job: EscrowJobRow, outcome: FeedbackFile['outcome']): Promise<FeedbackFile> {
  const fundTx = await deps.db.transaction.findUnique({
    where: { intentId: escrowIntentId('fund', job.id) },
    select: { txHash: true },
  });
  return {
    type: FEEDBACK_FILE_TYPE,
    jobId: job.id,
    escrow: { chainId: job.escrowChainId!, contract: getAddress(job.escrowContract!), onChainJobId: Number(job.onChainJobId) },
    proofOfPayment: {
      chainId: job.escrowChainId!,
      txHash: (fundTx?.txHash as Hex | undefined) ?? null,
      fromAddress: getAddress(job.requester.safeAddress),
      toAddress: getAddress(job.escrowContract!),
    },
    outcome,
    deliverableHash: (job.deliverableHash as Hex | null) ?? null,
    evaluator: getAddress(job.evaluator!),
    issuedAt: nowOf(deps).toISOString(),
  };
}

// ── Settlement (evaluator signer through the settlement queue) ─────────────

export class SettlementRevertedError extends Error {
  constructor(
    public readonly action: SettlementAction,
    public readonly txHash: Hex,
  ) {
    super(`ERC-8183 ${action} reverted on-chain (tx ${txHash})`);
    this.name = 'SettlementRevertedError';
  }
}

export interface ParsedSettlementReceipt {
  completed: boolean;
  rejected: boolean;
  expired: boolean;
  refunded: boolean;
  paymentReleased: bigint | null;
  platformFee: bigint | null;
  feedbackStatus: string | null;
}

/** Decodes the escrow + hook events of a complete/reject/claimRefund receipt. */
export function parseSettlementReceipt(logs: readonly Log[], escrow: Address, hook: Address | null): ParsedSettlementReceipt {
  const escrowLower = escrow.toLowerCase();
  const escrowEvents = parseEventLogs({
    abi: AGENT_JOB_ESCROW_ABI,
    logs: logs.filter((log) => log.address.toLowerCase() === escrowLower) as Log[],
    strict: false,
  });
  const hookLower = hook?.toLowerCase();
  const hookEvents = hookLower
    ? parseEventLogs({
        abi: REPUTATION_HOOK_ABI,
        logs: logs.filter((log) => log.address.toLowerCase() === hookLower) as Log[],
        strict: false,
      })
    : [];

  const parsed: ParsedSettlementReceipt = {
    completed: false,
    rejected: false,
    expired: false,
    refunded: false,
    paymentReleased: null,
    platformFee: null,
    feedbackStatus: null,
  };
  for (const event of escrowEvents) {
    switch (event.eventName) {
      case 'JobCompleted':
        parsed.completed = true;
        break;
      case 'JobRejected':
        parsed.rejected = true;
        break;
      case 'JobExpired':
        parsed.expired = true;
        break;
      case 'Refunded':
        parsed.refunded = true;
        break;
      case 'PaymentReleased':
        parsed.paymentReleased = event.args.amount ?? null;
        break;
      case 'PlatformFeeAccrued':
        parsed.platformFee = event.args.amount ?? null;
        break;
      default:
        break;
    }
  }
  for (const event of hookEvents) {
    switch (event.eventName) {
      case 'FeedbackWritten':
        parsed.feedbackStatus = 'written';
        break;
      case 'FeedbackSkipped': {
        const reason = event.args.reason ? hexToString(event.args.reason, { size: 32 }).replace(/\0+$/, '') : 'unknown';
        parsed.feedbackStatus = `skipped:${reason}`;
        break;
      }
      case 'FeedbackFailed':
        parsed.feedbackStatus = 'failed';
        break;
      default:
        break;
    }
  }
  return parsed;
}

/** True on the attempt after which BullMQ will not retry the job again. */
export function isLastSettlementAttempt(job: SettlementJobLike): boolean {
  return (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1);
}

export type SettlementResult =
  | { outcome: 'noop'; reason: string }
  | { outcome: 'reconciled'; onChainStatus: OnChainStatus }
  | { outcome: 'settled'; action: SettlementAction; onChainStatus: OnChainStatus; txHash: Hex; feedbackStatus: string | null }
  | { outcome: 'swept'; enqueued: number };

/** Minimum gap between two low-balance alerts for one chain. */
export const EVALUATOR_BALANCE_ALERT_INTERVAL_MS = 15 * 60_000;
const evaluatorBalanceAlertAt = new Map<number, number>();

/**
 * Cheap check before the evaluator spends gas (C3c): its native balance
 * against `config.evaluatorMinBalanceWei`. Below it → logged and alerted
 * (at most once per `EVALUATOR_BALANCE_ALERT_INTERVAL_MS` per chain); the
 * transaction is still attempted — refunds stall only when the key is
 * actually empty, and the operator has been told before that.
 */
async function checkEvaluatorBalance(deps: Erc8183Deps, chainId: number): Promise<void> {
  const min = deps.config.evaluatorMinBalanceWei;
  const evaluator = deps.config.evaluatorAddress;
  const client = deps.publicClient(chainId);
  if (!min || !evaluator || !client.getBalance) return;
  let balance: bigint;
  try {
    balance = await client.getBalance({ address: evaluator });
  } catch {
    return;
  }
  if (balance >= min) return;
  const now = nowOf(deps).getTime();
  const last = evaluatorBalanceAlertAt.get(chainId);
  if (last !== undefined && now - last < EVALUATOR_BALANCE_ALERT_INTERVAL_MS) return;
  evaluatorBalanceAlertAt.set(chainId, now);
  await raiseAlert(deps, {
    kind: 'evaluator-balance-low',
    chainId,
    message: `Evaluator ${evaluator} has ${balance} wei of native gas on chain ${chainId} (threshold ${min}) — settlements, cancellation refunds and expiry claims stop when it runs out`,
    details: { evaluator, balanceWei: balance.toString(), minBalanceWei: min.toString() },
  });
}

/** Every evaluator transaction goes through here: balance check, then sign + broadcast. */
async function sendEvaluatorTx(deps: Erc8183Deps, chainId: number, params: EvaluatorWriteParams): Promise<{ signer: EvaluatorSigner; txHash: Hex }> {
  await checkEvaluatorBalance(deps, chainId);
  const signer = deps.evaluatorSigner(chainId);
  const txHash = await signer.writeContract(params);
  return { signer, txHash };
}

/**
 * Settlement worker body. Reads the on-chain job first and reconciles when it
 * is already terminal (idempotent against redeliveries, crashes after
 * broadcast, and the expiry race); otherwise signs the requested action with
 * the evaluator key. Throws so BullMQ retries when the tx reverts or the RPC
 * fails; `handleFailedSettlementJob` records the final failure.
 */
export async function processSettlementJob(deps: Erc8183Deps, jobLike: SettlementJobLike): Promise<SettlementResult> {
  const { data } = jobLike;
  if (data.action === 'sweep') {
    const enqueued = await sweepExpiredEscrows(deps);
    return { outcome: 'swept', enqueued };
  }

  const job = await loadEscrowJob(deps, data.jobId);
  if (!job) return { outcome: 'noop', reason: 'not an ERC-8183 job' };
  if (!job.onChainJobId || !job.escrowContract || !job.escrowChainId) {
    return { outcome: 'noop', reason: `no on-chain job id (onChainStatus=${job.onChainStatus})` };
  }

  const chain = await readChainJob(deps, job);
  if (chain.status >= CHAIN_JOB_STATUS.Completed) {
    const onChainStatus = await reconcileTerminal(deps, job, chain.status);
    return { outcome: 'reconciled', onChainStatus };
  }

  switch (data.action) {
    case 'settle':
      return settle(deps, job, chain.status);
    case 'reject':
      return rejectForCancellation(deps, job, chain.status, data.reason ?? 'cancelled');
    case 'claimRefund':
      return claimRefund(deps, job, chain.status);
  }
}

async function settle(deps: Erc8183Deps, job: EscrowJobRow, chainStatus: number): Promise<SettlementResult> {
  if (chainStatus !== CHAIN_JOB_STATUS.Submitted) {
    if (job.status !== 'PAYMENT_PENDING') {
      return { outcome: 'noop', reason: `job is ${job.status}, not PAYMENT_PENDING` };
    }
    // Funded/Open while we believe it was submitted: the submit tx is not
    // mined (yet). Let BullMQ retry; payment recovery handles the long tail.
    throw new Error(`on-chain job ${job.onChainJobId} is status ${chainStatus}, expected Submitted (2)`);
  }

  // C3c: the chain says Submitted. When the DB disagrees (a lost submit
  // monitor left it FUNDED, a failed-but-mined submit put it back to
  // ACCEPTED), reconcile the DB first instead of walking away from a
  // deliverable that is on-chain.
  if (job.status !== 'PAYMENT_PENDING' || !['SUBMITTED', 'SETTLING'].includes(job.onChainStatus ?? '')) {
    const reconciled = await advanceToSubmitted(deps, job.id, { scheduleSettle: false });
    if (reconciled === 'conflict') {
      return { outcome: 'noop', reason: `job is ${job.status} while Submitted on-chain — left for the operator` };
    }
  }

  // Claim the settlement: contests are refused once SETTLING is set, and the
  // decision below is read after the claim so a contest filed just before it
  // is honoured.
  const claimed = await deps.db.job.updateMany({
    where: { id: job.id, status: 'PAYMENT_PENDING', onChainStatus: { in: ['SUBMITTED', 'SETTLING'] } },
    data: { onChainStatus: 'SETTLING' },
  });
  if (claimed.count === 0) {
    return { outcome: 'noop', reason: `onChainStatus ${job.onChainStatus} cannot be settled` };
  }

  const fresh = await loadEscrowJob(deps, job.id);
  if (!fresh) return { outcome: 'noop', reason: 'job vanished' };
  const contested = fresh.contestedAt !== null;
  const outcome: FeedbackFile['outcome'] = contested ? 'rejected' : 'completed';

  // Generate the feedback file once per outcome. The on-chain status check
  // above guarantees nothing carrying an earlier hash was mined (a reverted
  // attempt sets `settleTxHash` but changes nothing on-chain), so the only
  // reason to rebuild is a contest that flipped the outcome after a reverted
  // `complete` — the file must then say "rejected" like the tx it goes with.
  let file = (fresh.feedbackFile ?? null) as FeedbackFile | null;
  if (!file || file.outcome !== outcome) {
    file = await buildFeedbackFile(deps, fresh, outcome);
    await deps.db.job.update({ where: { id: job.id }, data: { feedbackFile: file as unknown as Prisma.InputJsonValue } });
  }
  const feedbackHash = feedbackHashOf(file);
  const optParams = encodeAbiParameters(
    [{ type: 'string' }, { type: 'bytes32' }],
    [feedbackUriFor(deps.config, job.id), feedbackHash],
  );

  const escrow = getAddress(fresh.escrowContract!);
  const functionName = contested ? 'reject' : 'complete';
  const reason = contested ? SETTLEMENT_REASONS.contested : SETTLEMENT_REASONS.completed;
  const { signer, txHash } = await sendEvaluatorTx(deps, fresh.escrowChainId!, {
    address: escrow,
    abi: AGENT_JOB_ESCROW_ABI,
    functionName,
    args: [BigInt(fresh.onChainJobId!), reason, optParams],
  });
  await deps.db.job.update({ where: { id: job.id }, data: { settleTxHash: txHash } });
  deps.logger.info({ jobId: job.id, action: functionName, txHash, contested }, 'ERC-8183 settlement sent');

  const receipt = await signer.waitForTransactionReceipt(txHash);
  if (receipt.status !== 'success') throw new SettlementRevertedError('settle', txHash);

  const parsed = parseSettlementReceipt(receipt.logs, escrow, deps.config.chain(fresh.escrowChainId!)?.hook ?? null);
  const onChainStatus: OnChainStatus = parsed.completed ? 'COMPLETED' : 'REJECTED';
  await deps.db.job.update({
    where: { id: job.id },
    data: {
      onChainStatus,
      settleTxHash: txHash,
      platformFeeAmount: parsed.platformFee !== null ? parsed.platformFee.toString() : null,
      feedbackStatus: parsed.feedbackStatus,
      escrowError: null,
    },
  });

  await deps.finalize({
    jobId: job.id,
    outcome: parsed.completed ? 'CONFIRMED' : 'FAILED',
    transactionId: null,
    ...(parsed.completed
      ? {}
      : { reason: `Rejected by evaluator (${contested ? 'contested by requester' : 'settlement'}) — refunded on-chain in tx ${txHash}` }),
  });
  deps.logger.info(
    { jobId: job.id, onChainStatus, txHash, platformFee: parsed.platformFee?.toString() ?? null, feedbackStatus: parsed.feedbackStatus },
    'ERC-8183 settlement confirmed',
  );
  return { outcome: 'settled', action: 'settle', onChainStatus, txHash, feedbackStatus: parsed.feedbackStatus };
}

async function rejectForCancellation(
  deps: Erc8183Deps,
  job: EscrowJobRow,
  chainStatus: number,
  reason: CancellationReason,
): Promise<SettlementResult> {
  if (chainStatus === CHAIN_JOB_STATUS.Open) {
    // Nothing locked: the funding chain stopped before `fund`.
    return { outcome: 'noop', reason: 'on-chain job is Open — no budget to refund' };
  }
  if (LIVE_JOB_STATUSES.has(job.status) || job.status === 'PAYMENT_PENDING') {
    // A reject is only ever scheduled after a CANCELLED/FAILED transition; a
    // live job here is a stale queue entry — never refund a job in progress.
    deps.logger.warn({ jobId: job.id, status: job.status }, 'ERC-8183 cancellation reject dropped — job is live');
    return { outcome: 'noop', reason: `job is ${job.status}, not cancelled` };
  }
  if (chainStatus === CHAIN_JOB_STATUS.Submitted) {
    // C3c: the provider's deliverable is on-chain; a cancellation must not
    // turn it into "requester keeps the result and the refund". Mirror the
    // chain (which also takes the job out of the reject recovery) and alert.
    const message =
      `Cancellation refused for job ${job.id}: the deliverable is Submitted on-chain — ` +
      'left for settlement or the operator (the expiry sweep refunds the requester at expiresAt)';
    await deps.db.job.update({
      where: { id: job.id },
      data: { onChainStatus: 'SUBMITTED', escrowError: message },
    });
    await raiseAlert(deps, {
      kind: 'cancellation-refused',
      jobId: job.id,
      chainId: job.escrowChainId,
      message,
      details: { status: job.status, reason, onChainJobId: job.onChainJobId },
    });
    return { outcome: 'noop', reason: 'on-chain job is Submitted — cancellation refused' };
  }
  const escrow = getAddress(job.escrowContract!);
  const { signer, txHash } = await sendEvaluatorTx(deps, job.escrowChainId!, {
    address: escrow,
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'reject',
    args: [BigInt(job.onChainJobId!), reason === 'cancelled' ? SETTLEMENT_REASONS.cancelled : SETTLEMENT_REASONS.providerFailed, '0x'],
  });
  await deps.db.job.update({ where: { id: job.id }, data: { settleTxHash: txHash } });
  const receipt = await signer.waitForTransactionReceipt(txHash);
  if (receipt.status !== 'success') throw new SettlementRevertedError('reject', txHash);

  const parsed = parseSettlementReceipt(receipt.logs, escrow, deps.config.chain(job.escrowChainId!)?.hook ?? null);
  await deps.db.job.update({
    where: { id: job.id },
    data: { onChainStatus: 'REJECTED', settleTxHash: txHash, feedbackStatus: parsed.feedbackStatus, escrowError: null },
  });
  await finalizeAfterRefund(deps, job, `Rejected by evaluator (${reason}) — refunded on-chain in tx ${txHash}`);
  deps.logger.info({ jobId: job.id, txHash, reason }, 'ERC-8183 cancellation refund confirmed');
  return { outcome: 'settled', action: 'reject', onChainStatus: 'REJECTED', txHash, feedbackStatus: parsed.feedbackStatus };
}

async function claimRefund(deps: Erc8183Deps, job: EscrowJobRow, chainStatus: number): Promise<SettlementResult> {
  if (chainStatus === CHAIN_JOB_STATUS.Open) {
    // Never funded. Once expired it never can be (`fund` reverts with
    // FundingWindowClosed): close it so the sweep stops looking at it.
    if (job.expiresAt && job.expiresAt.getTime() <= nowOf(deps).getTime()) {
      await closeUnfundedExpired(deps, job);
      return { outcome: 'reconciled', onChainStatus: 'EXPIRED_UNFUNDED' };
    }
    return { outcome: 'noop', reason: 'on-chain job is Open — nothing to claim' };
  }
  const escrow = getAddress(job.escrowContract!);
  const { signer, txHash } = await sendEvaluatorTx(deps, job.escrowChainId!, {
    address: escrow,
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'claimRefund',
    args: [BigInt(job.onChainJobId!)],
  });
  await deps.db.job.update({ where: { id: job.id }, data: { settleTxHash: txHash } });
  const receipt = await signer.waitForTransactionReceipt(txHash);
  if (receipt.status !== 'success') throw new SettlementRevertedError('claimRefund', txHash);

  await deps.db.job.update({
    where: { id: job.id },
    data: { onChainStatus: 'EXPIRED', settleTxHash: txHash, escrowError: null },
  });
  await finalizeAfterRefund(deps, job, `Expired on-chain — budget refunded in tx ${txHash}`);
  deps.logger.warn({ jobId: job.id, txHash }, 'ERC-8183 job expired — refund claimed');
  return { outcome: 'settled', action: 'claimRefund', onChainStatus: 'EXPIRED', txHash, feedbackStatus: null };
}

/** An expired job that is still Open on-chain: nothing was ever locked and nothing can be any more. */
async function closeUnfundedExpired(deps: Erc8183Deps, job: EscrowJobRow): Promise<void> {
  const closed = await deps.db.job.updateMany({
    where: { id: job.id, onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] } },
    data: { onChainStatus: 'EXPIRED_UNFUNDED' },
  });
  if (closed.count === 0) return;
  if (LIVE_JOB_STATUSES.has(job.status)) {
    await deps.db.job.update({
      where: { id: job.id },
      data: { status: 'FAILED', escrowError: 'Expired on-chain before it was funded — nothing was locked' },
    });
  }
  await deps.releaseJobEscrow(job.id);
  deps.logger.warn({ jobId: job.id, status: job.status }, 'ERC-8183 job expired while still Open on-chain — closed (nothing locked)');
}

/** After an on-chain refund: finalize a PAYMENT_PENDING job as FAILED, fail a live one, and release the DB reservation. */
async function finalizeAfterRefund(deps: Erc8183Deps, job: EscrowJobRow, reason: string): Promise<void> {
  if (job.status === 'PAYMENT_PENDING') {
    await deps.finalize({ jobId: job.id, outcome: 'FAILED', transactionId: null, reason });
    return;
  }
  if (LIVE_JOB_STATUSES.has(job.status)) {
    await deps.db.job.update({ where: { id: job.id }, data: { status: 'FAILED', escrowError: reason } });
  }
  await deps.releaseJobEscrow(job.id);
}

/** The chain already settled/refunded this job (crash after broadcast, expiry race, manual tx): mirror it, send nothing. */
async function reconcileTerminal(deps: Erc8183Deps, job: EscrowJobRow, chainStatus: number): Promise<OnChainStatus> {
  const onChainStatus: OnChainStatus =
    chainStatus === CHAIN_JOB_STATUS.Completed ? 'COMPLETED' : chainStatus === CHAIN_JOB_STATUS.Rejected ? 'REJECTED' : 'EXPIRED';
  await deps.db.job.update({ where: { id: job.id }, data: { onChainStatus, escrowError: null } });
  deps.logger.warn(
    { jobId: job.id, onChainJobId: job.onChainJobId, onChainStatus, jobStatus: job.status },
    'ERC-8183 job already terminal on-chain — reconciled without sending',
  );
  if (onChainStatus === 'COMPLETED') {
    if (job.status === 'PAYMENT_PENDING') {
      await deps.finalize({ jobId: job.id, outcome: 'CONFIRMED', transactionId: null });
    }
    return onChainStatus;
  }
  await finalizeAfterRefund(deps, job, `${onChainStatus.toLowerCase()} on-chain (reconciled)`);
  return onChainStatus;
}

/**
 * `worker.on('failed')` handler. On the final attempt only: record the error
 * and hand a `settle` back from SETTLING to SUBMITTED so the job is visible as
 * stuck-but-funded. Never refunds in the DB — the USDC is on-chain.
 */
export async function handleFailedSettlementJob(deps: Erc8183Deps, jobLike: SettlementJobLike | undefined, err: Error): Promise<void> {
  if (!jobLike || !isLastSettlementAttempt(jobLike)) return;
  const { jobId, action } = jobLike.data;
  if (action === 'sweep') return;
  const job = await deps.db.job.findUnique({ where: { id: jobId }, select: { onChainStatus: true } });
  if (!job) return;
  await deps.db.job.update({
    where: { id: jobId },
    data: {
      escrowError: `${action} failed after ${jobLike.attemptsMade ?? 0} attempts: ${err.message.slice(0, 400)}`,
      ...(action === 'settle' && job.onChainStatus === 'SETTLING' ? { onChainStatus: 'SUBMITTED' } : {}),
    },
  });
  deps.logger.error(
    { jobId, action, err: err.message, attempts: jobLike.attemptsMade ?? 0 },
    'ERC-8183 settlement permanently failed — job left PAYMENT_PENDING, funds remain on-chain',
  );
}

// ── Expiry sweep + payment recovery ────────────────────────────────────────

export const EXPIRY_SWEEP_LIMIT = 50;

/**
 * Enqueues `claimRefund` for every escrow job that exists on-chain, is past
 * `expiresAt` and is not final in the DB (C3c: whatever the DB thinks the
 * last step was — a `fund` whose monitor was lost leaves the DB at APPROVED
 * while the budget is locked). The claimRefund action reads the chain:
 * Funded/Submitted → refund; Open → closed as EXPIRED_UNFUNDED; terminal →
 * mirrored. SETTLING is left to the settlement in flight. Least recently
 * touched first, so a job whose claim keeps failing cannot starve the rest.
 * Returns how many were enqueued.
 */
export async function sweepExpiredEscrows(deps: Erc8183Deps): Promise<number> {
  const now = nowOf(deps);
  const expired = await deps.db.job.findMany({
    where: {
      escrowKind: ESCROW_KIND,
      onChainJobId: { not: null },
      onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES, 'SETTLING'] },
      expiresAt: { lt: now },
    },
    select: { id: true },
    take: EXPIRY_SWEEP_LIMIT,
    orderBy: { updatedAt: 'asc' },
  });
  for (const job of expired) {
    await deps.settlement.add({ jobId: job.id, action: 'claimRefund' });
  }
  if (expired.length > 0) {
    deps.logger.warn({ count: expired.length }, 'ERC-8183 expiry sweep — claimRefund enqueued');
  }
  return expired.length;
}

export type Erc8183RecoveryOutcome =
  | 'resettled'
  | 'returnedToAccepted'
  | 'inFlight'
  | 'awaitingBinding'
  | 'submitReleased'
  | 'reconciled'
  | 'chainUnreadable';

/**
 * Payment-recovery branch for a stale PAYMENT_PENDING escrow job. Never
 * finalizes as FAILED: the budget is on-chain, so the only safe moves are to
 * re-run the (idempotent) settlement or to let the provider retry `submit`.
 *
 * R2: a FUNDED job whose `submit` is deferred behind the ERC-8004 binding is
 * not stuck while an identity transaction is in flight (`awaitingBinding`);
 * otherwise the binding is resumed/closed and the deferred submit released.
 *
 * C3c: a FUNDED job is handed back to ACCEPTED only when the chain confirms
 * the deliverable is not there (still Funded); Submitted on-chain → the DB
 * follows and the settlement is scheduled.
 */
export async function recoverErc8183Job(
  deps: Erc8183Deps,
  job: { id: string; onChainStatus: string | null },
): Promise<Erc8183RecoveryOutcome> {
  if (job.onChainStatus === 'FUNDED') {
    const binding = await deps.db.job.findUnique({ where: { id: job.id }, select: { deferredSubmitAt: true } });
    if (binding?.deferredSubmitAt) {
      const resumed = await resumeBinding(deps, job.id);
      for (const jobId of resumed.terminalJobIds) await releaseDeferredSubmit(deps, jobId);
      if (resumed.waiting) return 'awaitingBinding';
      // The binding is terminal (possibly ended before a crash): send the submit.
      await releaseDeferredSubmit(deps, job.id);
      return 'submitReleased';
    }
    const submitTx = await latestStepTx(deps, 'submit', job.id);
    if (submitTx && IN_FLIGHT_TX.has(submitTx.status) && submitTx.status !== 'CONFIRMED') return 'inFlight';

    const full = await loadEscrowJob(deps, job.id);
    if (!full) return 'inFlight';
    const chain = await tryReadChainJob(deps, full);
    if (!chain) return 'chainUnreadable';
    if (chain.status >= CHAIN_JOB_STATUS.Completed) {
      await reconcileTerminal(deps, full, chain.status);
      return 'reconciled';
    }
    if (chain.status === CHAIN_JOB_STATUS.Submitted) {
      await advanceToSubmitted(deps, job.id, { scheduleSettle: true });
      return 'resettled';
    }
    const returned = await deps.db.job.updateMany({
      where: { id: job.id, status: 'PAYMENT_PENDING' },
      data: {
        status: 'ACCEPTED',
        escrowError: submitTx
          ? `Recovery: submit ${submitTx.status} (${submitTx.error ?? 'no error recorded'})`
          : 'Recovery: PAYMENT_PENDING without a submit transaction',
      },
    });
    return returned.count > 0 ? 'returnedToAccepted' : 'inFlight';
  }
  await deps.settlement.add({ jobId: job.id, action: 'settle' });
  return 'resettled';
}

// ── Reconciliation (C3c) ───────────────────────────────────────────────────

export type ReconcileOutcome =
  | 'skipped'
  | 'inFlight'
  | 'waitingForLane'
  | 'chainUnreadable'
  | 'advanced'
  | 'unwound'
  | 'reconciled'
  | 'rejectScheduled'
  | 'refused'
  | 'closed'
  | 'unchanged';

function txOutcomeOf(status: string): EscrowTxOutcome['status'] {
  return status === 'CONFIRMED' ? 'CONFIRMED' : status === 'REVERTED' ? 'REVERTED' : 'FAILED';
}

/**
 * Re-derives one escrow job from the chain and its step transactions, and
 * resumes whatever is stuck. Safe to run at any time and any number of
 * times: every move it makes is one of the conditional advances above, a
 * replay of a terminal transaction's outcome, an idempotent enqueue, or a
 * settlement job (which reads the chain again before sending anything).
 */
export async function reconcileEscrowJob(deps: Erc8183Deps, jobId: string): Promise<ReconcileOutcome> {
  const job = await loadEscrowJob(deps, jobId);
  if (!job || (FINAL_ON_CHAIN_STATUSES as readonly string[]).includes(job.onChainStatus ?? '')) return 'skipped';
  const live = LIVE_JOB_STATUSES.has(job.status);

  if (!job.onChainJobId) {
    // CREATING: the create transaction decides.
    if (!live) return 'skipped';
    const createTx = await latestStepTx(deps, 'create', job.id);
    if (!createTx) {
      await handleStepFailure(deps, job, 'create', 'reconciliation: no create transaction (start was interrupted)', null);
      return 'unwound';
    }
    if (PENDING_TX_STATUSES.includes(createTx.status as never)) return 'inFlight';
    await onEscrowTxOutcome(deps, { transactionId: createTx.id, status: txOutcomeOf(createTx.status), error: createTx.error });
    return 'advanced';
  }

  const chain = await tryReadChainJob(deps, job);
  if (!chain) return 'chainUnreadable';

  if (chain.status >= CHAIN_JOB_STATUS.Completed) {
    await reconcileTerminal(deps, job, chain.status);
    return 'reconciled';
  }

  if (chain.status === CHAIN_JOB_STATUS.Submitted) {
    if (job.status === 'CANCELLED' || job.status === 'FAILED') {
      // Same rule as the reject action: refuse and alert, once.
      await deps.settlement.add({ jobId: job.id, action: 'reject', reason: 'cancelled' });
      return 'refused';
    }
    const moved = await advanceToSubmitted(deps, job.id, { scheduleSettle: true });
    if (moved === 'already') {
      const fresh = await loadEscrowJob(deps, job.id);
      if (fresh?.status === 'PAYMENT_PENDING' && fresh.onChainStatus === 'SUBMITTED') {
        await deps.settlement.add({ jobId: job.id, action: 'settle' });
        return 'advanced';
      }
      return 'unchanged';
    }
    return moved === 'conflict' ? 'refused' : 'advanced';
  }

  if (chain.status === CHAIN_JOB_STATUS.Funded) {
    const advanced = await advanceToFunded(deps, job.id, 'reconciliation: chain Funded');
    if (job.status === 'CANCELLED' || job.status === 'FAILED') {
      // The cancellation refund was lost (evaluator outage, queue down, a
      // reject that ran while the chain was still Open): schedule it again.
      if (!advanced) {
        await deps.settlement.add({ jobId: job.id, action: 'reject', reason: job.onChainStatus === 'FAILED' || job.status === 'CANCELLED' ? 'cancelled' : 'provider-failed' });
      }
      return 'rejectScheduled';
    }
    if (job.status === 'PAYMENT_PENDING') {
      const outcome = await recoverErc8183Job(deps, { id: job.id, onChainStatus: 'FUNDED' });
      return outcome === 'returnedToAccepted' ? 'unwound' : outcome === 'inFlight' || outcome === 'awaitingBinding' ? 'inFlight' : 'advanced';
    }
    if (job.providerAgentIdStatus === 'BINDING') {
      const resumed = await resumeBinding(deps, job.id);
      for (const id of resumed.terminalJobIds) await releaseDeferredSubmit(deps, id);
    }
    return advanced ? 'advanced' : 'unchanged';
  }

  // Chain Open: nothing locked. Past expiry it never can be.
  if (job.expiresAt && job.expiresAt.getTime() <= nowOf(deps).getTime()) {
    await closeUnfundedExpired(deps, job);
    return 'closed';
  }
  if (!live) return 'unchanged';
  return resumeFundingStep(deps, job, chain);
}

/** A live job that is Open on-chain: find the funding step it is waiting on and resume it. */
async function resumeFundingStep(deps: Erc8183Deps, job: EscrowJobRow, chain: ChainJob): Promise<ReconcileOutcome> {
  const step: EscrowStep | null =
    job.onChainStatus === 'OPEN' ? 'setBudget' : job.onChainStatus === 'BUDGET_SET' ? 'approve' : job.onChainStatus === 'APPROVED' ? 'fund' : null;
  if (!step) return 'unchanged';
  const stepTx = await latestStepTx(deps, step, job.id);
  if (stepTx && PENDING_TX_STATUSES.includes(stepTx.status as never)) return 'inFlight';
  if (stepTx) {
    // Terminal but the job never moved: the outcome was lost — replay it
    // (a failure replay reads the chain before unwinding anything).
    await onEscrowTxOutcome(deps, { transactionId: stepTx.id, status: txOutcomeOf(stepTx.status), error: stepTx.error });
    return stepTx.status === 'CONFIRMED' ? 'advanced' : 'unwound';
  }
  if (step === 'setBudget' && chain.budget > 0n && job.budgetAmount && chain.budget === BigInt(job.budgetAmount)) {
    await openStepMined(deps, job, 'setBudget', chain);
    return 'advanced';
  }
  if (step === 'approve') {
    const sent = await pumpFunding(deps, job.requesterId, job.escrowChainId!);
    return sent === job.id ? 'advanced' : 'waitingForLane';
  }
  // The step was never enqueued (crash between the confirmation and the enqueue).
  await continueChain(deps, job.id, step);
  return 'advanced';
}

const QUIET_OUTCOMES = new Set<ReconcileOutcome>(['unchanged', 'inFlight', 'waitingForLane', 'chainUnreadable', 'skipped']);

export interface ReconcileSummary {
  stalledFunding: number;
  lostRejects: number;
  unsubmittedDeliverables: number;
  stalledBindings: number;
  outcomes: Partial<Record<ReconcileOutcome, number>>;
}

/**
 * The reconciliation pass of the payment-recovery tick (C3c). Picks, oldest
 * first and at most `limit` of each:
 *  - live jobs still before FUNDED whose row has not moved for `staleBefore`
 *    (a step transaction whose outcome was lost or is stuck, a job waiting in
 *    the funding lane, a create that never left);
 *  - CANCELLED/FAILED jobs the DB believes may hold a budget (APPROVED or
 *    FUNDED): their cancellation refund is re-enqueued when the chain is
 *    Funded (the reject itself refuses a Submitted job);
 *  - ACCEPTED jobs whose submit was attempted (a deliverable hash is stored)
 *    and which are still FUNDED in the DB: Submitted on-chain → settled;
 *  - jobs whose ERC-8004 binding has been BINDING for `staleBefore`.
 * Stale PAYMENT_PENDING jobs keep their own branch (`recoverErc8183Job`).
 */
export async function reconcileEscrowJobs(deps: Erc8183Deps, opts: { staleBefore: Date; limit: number }): Promise<ReconcileSummary> {
  const base = { escrowKind: ESCROW_KIND, updatedAt: { lt: opts.staleBefore } };
  const pick = (where: Prisma.JobWhereInput) =>
    deps.db.job.findMany({ where: { ...base, ...where }, select: { id: true }, orderBy: { updatedAt: 'asc' }, take: opts.limit });

  const [stalledFunding, lostRejects, unsubmitted, stalledBindings] = await Promise.all([
    pick({ status: { in: [...LIVE_JOB_STATUS_LIST] }, onChainStatus: { in: ['CREATING', 'OPEN', 'BUDGET_SET', 'APPROVED'] } }),
    pick({ status: { in: ['CANCELLED', 'FAILED'] }, onChainJobId: { not: null }, onChainStatus: { in: ['APPROVED', 'FUNDED'] } }),
    pick({ status: 'ACCEPTED', onChainStatus: 'FUNDED', deliverableHash: { not: null } }),
    pick({ status: { in: ['PENDING', 'ACCEPTED', 'PAYMENT_PENDING'] }, providerAgentIdStatus: 'BINDING' }),
  ]);

  const summary: ReconcileSummary = {
    stalledFunding: stalledFunding.length,
    lostRejects: lostRejects.length,
    unsubmittedDeliverables: unsubmitted.length,
    stalledBindings: stalledBindings.length,
    outcomes: {},
  };
  const seen = new Set<string>();
  for (const { id } of [...stalledFunding, ...lostRejects, ...unsubmitted, ...stalledBindings]) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const outcome = await reconcileEscrowJob(deps, id);
      summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
      if (QUIET_OUTCOMES.has(outcome)) {
        // Nothing to do yet: send the job to the back of the queue so jobs
        // that stay in this state (a cancelled job that will only close at
        // expiresAt, a long funding lane) cannot starve the others.
        await deps.db.job.update({ where: { id }, data: { updatedAt: nowOf(deps) } }).catch(() => undefined);
      } else {
        deps.logger.warn({ jobId: id, outcome }, 'ERC-8183 reconciliation acted on a stale escrow job');
      }
    } catch (err) {
      summary.outcomes.chainUnreadable = (summary.outcomes.chainUnreadable ?? 0) + 1;
      deps.logger.error({ jobId: id, err: errorMessage(err) }, 'ERC-8183 reconciliation failed for a job — retried next tick');
    }
  }
  return summary;
}

// ── API view ───────────────────────────────────────────────────────────────

export interface EscrowView {
  kind: 'erc8183';
  chainId: number | null;
  contract: string | null;
  onChainJobId: string | null;
  onChainStatus: string | null;
  evaluator: string | null;
  budgetAmount: string | null;
  budgetToken: string | null;
  expiresAt: Date | null;
  deliverableHash: string | null;
  settleTxHash: string | null;
  platformFeeAmount: string | null;
  feedbackStatus: string | null;
  contestedAt: Date | null;
  contestReason: string | null;
  escrowError: string | null;
  /** R2: ERC-8004 agent id bound to the on-chain job with setProviderAgentId (decimal string). */
  providerAgentId: string | null;
  /** R2: BINDING | BOUND | FAILED | SKIPPED; null for jobs funded before R2. */
  providerAgentIdStatus: string | null;
  providerAgentIdError: string | null;
  /** R2: the provider completed while BINDING; `submit` is sent when the binding ends. */
  deferredSubmitAt: Date | null;
}

const ESCROW_COLUMNS = [
  'escrowKind',
  'escrowChainId',
  'escrowContract',
  'onChainJobId',
  'onChainStatus',
  'evaluator',
  'budgetToken',
  'budgetAmount',
  'expiresAt',
  'deliverableHash',
  'settleTxHash',
  'platformFeeAmount',
  'feedbackStatus',
  'feedbackFile',
  'contestedAt',
  'contestReason',
  'escrowError',
  'providerAgentId',
  'providerAgentIdStatus',
  'providerAgentIdError',
  'deferredSubmitAt',
] as const;

/**
 * API shape: the raw escrow columns are folded into one `escrow` object (null
 * for legacy/free jobs) and the feedback file is never inlined — it has its
 * own public endpoint. `escrowError` and `providerAgentIdError` are stored
 * from worker `err.message` (a viem message carries the keyed RPC URL), so
 * they are sanitized on the way out (S5); the DB keeps the full text.
 */
export function toJobResponse<T extends Record<string, unknown>>(job: T): Omit<T, (typeof ESCROW_COLUMNS)[number]> & { escrow: EscrowView | null } {
  const rest = { ...job } as Record<string, unknown>;
  for (const column of ESCROW_COLUMNS) delete rest[column];
  const escrow: EscrowView | null =
    job['escrowKind'] === ESCROW_KIND
      ? {
          kind: 'erc8183',
          chainId: (job['escrowChainId'] as number | null) ?? null,
          contract: (job['escrowContract'] as string | null) ?? null,
          onChainJobId: (job['onChainJobId'] as string | null) ?? null,
          onChainStatus: (job['onChainStatus'] as string | null) ?? null,
          evaluator: (job['evaluator'] as string | null) ?? null,
          budgetAmount: (job['budgetAmount'] as string | null) ?? null,
          budgetToken: (job['budgetToken'] as string | null) ?? null,
          expiresAt: (job['expiresAt'] as Date | null) ?? null,
          deliverableHash: (job['deliverableHash'] as string | null) ?? null,
          settleTxHash: (job['settleTxHash'] as string | null) ?? null,
          platformFeeAmount: (job['platformFeeAmount'] as string | null) ?? null,
          feedbackStatus: (job['feedbackStatus'] as string | null) ?? null,
          contestedAt: (job['contestedAt'] as Date | null) ?? null,
          contestReason: (job['contestReason'] as string | null) ?? null,
          escrowError: sanitizeStoredError(job['escrowError'] as string | null),
          providerAgentId: (job['providerAgentId'] as string | null) ?? null,
          providerAgentIdStatus: (job['providerAgentIdStatus'] as string | null) ?? null,
          providerAgentIdError: sanitizeStoredError(job['providerAgentIdError'] as string | null),
          deferredSubmitAt: (job['deferredSubmitAt'] as Date | null) ?? null,
        }
      : null;
  return { ...(rest as Omit<T, (typeof ESCROW_COLUMNS)[number]>), escrow };
}
