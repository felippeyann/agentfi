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
 * `Job.onChainStatus` records the last CONFIRMED step:
 *   CREATING → OPEN → BUDGET_SET → APPROVED → FUNDED → SUBMITTED → SETTLING → COMPLETED | REJECTED
 *   FUNDED | SUBMITTED → EXPIRED (claimRefund after expiresAt)
 *   any step before FUNDED fails → FAILED (nothing is locked on-chain)
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
import type { EvaluatorSigner } from '../escrow/evaluator-signer.js';
import type { FinalizeA2APaymentJobParams } from './payment-finalizer.service.js';
import type { ProcessorLogger, TransactionJobData } from '../../queues/transaction.processor.js';
import { enqueueAgentStep, IN_FLIGHT_TX, type SigningAgent } from './escrow-tx-steps.js';
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

/** Minimal ERC-20 ABI for the client's `approve(escrow, budget)` step. */
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
] as const;

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
}

export type EscrowPublicClient = Pick<PublicClient, 'getTransactionReceipt' | 'readContract'>;

export interface SettlementEnqueue {
  add(data: EscrowSettlementJobData, opts?: { delayMs?: number }): Promise<void>;
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
}

/** The slice of a BullMQ job the settlement processor reads — a plain object satisfies it in tests. */
export interface SettlementJobLike {
  data: EscrowSettlementJobData;
  attemptsMade?: number;
  opts?: { attempts?: number };
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

  const now = deps.now?.() ?? new Date();
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

  if (outcome.status !== 'CONFIRMED') {
    await handleStepFailure(deps, job, escrowStep, `${escrowStep} ${outcome.status}: ${outcome.error ?? 'no error recorded'}`);
    return;
  }

  switch (escrowStep) {
    case 'create': {
      if (!tx.txHash) {
        await handleStepFailure(deps, job, 'create', 'create CONFIRMED without a txHash');
        return;
      }
      const onChainJobId = await readCreatedJobId(deps, job, tx.txHash as Hex);
      if (onChainJobId === null) {
        await handleStepFailure(deps, job, 'create', `JobCreated event not found in receipt ${tx.txHash}`);
        return;
      }
      await deps.db.job.update({
        where: { id: job.id },
        data: { onChainJobId, onChainStatus: 'OPEN', escrowError: null },
      });
      deps.logger.info({ jobId: job.id, onChainJobId, txHash: tx.txHash }, 'ERC-8183 job created on-chain');
      await continueChain(deps, job.id, 'setBudget');
      return;
    }
    case 'setBudget':
      await deps.db.job.update({ where: { id: job.id }, data: { onChainStatus: 'BUDGET_SET' } });
      await continueChain(deps, job.id, 'approve');
      return;
    case 'approve':
      await deps.db.job.update({ where: { id: job.id }, data: { onChainStatus: 'APPROVED' } });
      await continueChain(deps, job.id, 'fund');
      return;
    case 'fund': {
      await deps.db.job.update({ where: { id: job.id }, data: { onChainStatus: 'FUNDED', escrowError: null } });
      deps.logger.info({ jobId: job.id, onChainJobId: job.onChainJobId, txHash: tx.txHash }, 'ERC-8183 job funded');
      // A cancellation that landed while `fund` was in flight: the budget is
      // now locked, so unwind it through the evaluator (full refund).
      const fresh = await deps.db.job.findUnique({ where: { id: job.id }, select: { status: true } });
      if (fresh && (fresh.status === 'CANCELLED' || fresh.status === 'FAILED')) {
        await deps.settlement.add({ jobId: job.id, action: 'reject', reason: 'cancelled' });
        deps.logger.warn({ jobId: job.id }, 'ERC-8183 job funded after cancellation — evaluator reject scheduled');
      }
      // R2: bind the provider's ERC-8004 identity (minting it first if this is
      // its first funded job on the chain). Never allowed to affect the funding
      // outcome above: any error ends the binding FAILED and the job goes on.
      // No submit can be deferred yet (ACCEPTED requires FUNDED), so the
      // terminal ids it returns need no release here.
      try {
        await startProviderBinding(deps, { id: job.id, status: fresh?.status ?? job.status, escrowChainId: job.escrowChainId, provider: job.provider });
      } catch (err) {
        const reason = `binding could not be started: ${(err as Error)?.message ?? String(err)}`;
        await deps.db.job
          .updateMany({ where: { id: job.id, providerAgentIdStatus: 'BINDING' }, data: { providerAgentIdStatus: 'FAILED', providerAgentIdError: reason } })
          .catch(() => undefined);
        deps.logger.error({ jobId: job.id, err: reason }, 'ERC-8004 binding failed to start — job continues without feedback');
      }
      return;
    }
    case 'submit': {
      await deps.db.job.update({
        where: { id: job.id },
        data: {
          onChainStatus: 'SUBMITTED',
          ...(meta.deliverable ? { deliverableHash: meta.deliverable } : {}),
          escrowError: null,
        },
      });
      const delayMs = deps.config.evaluationDelaySeconds * 1000;
      await deps.settlement.add({ jobId: job.id, action: 'settle' }, delayMs > 0 ? { delayMs } : undefined);
      deps.logger.info({ jobId: job.id, txHash: tx.txHash, delayMs }, 'ERC-8183 deliverable submitted — settlement scheduled');
      return;
    }
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

/** Enqueues the next requester-signed step unless the job has left PENDING/ACCEPTED (cancelled, failed). */
async function continueChain(deps: Erc8183Deps, jobId: string, step: 'setBudget' | 'approve' | 'fund'): Promise<void> {
  const job = await loadEscrowJob(deps, jobId);
  if (!job) return;
  if (!LIVE_JOB_STATUSES.has(job.status)) {
    deps.logger.warn(
      { jobId, status: job.status, onChainStatus: job.onChainStatus, nextStep: step },
      'ERC-8183 chain stopped — job is no longer live; nothing is locked on-chain',
    );
    return;
  }
  if (!job.onChainJobId || !job.budgetAmount || !job.budgetToken || !job.escrowContract || !job.escrowChainId) {
    await handleStepFailure(deps, job, step, `cannot build ${step}: escrow columns incomplete`);
    return;
  }

  const onChainJobId = BigInt(job.onChainJobId);
  const budget = BigInt(job.budgetAmount);
  const escrow = getAddress(job.escrowContract);
  let to: Address;
  let data: Hex;
  switch (step) {
    case 'setBudget':
      to = escrow;
      data = encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'setBudget', args: [onChainJobId, budget, '0x'] });
      break;
    case 'approve':
      to = getAddress(job.budgetToken);
      data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [escrow, budget] });
      break;
    case 'fund':
      to = escrow;
      data = encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'fund', args: [onChainJobId, budget, '0x'] });
      break;
  }

  await enqueueStep(deps, {
    jobId,
    chainId: job.escrowChainId,
    step,
    signer: job.requester,
    to,
    data,
    type: 'ESCROW_LOCK',
  });
}

/**
 * A step that REVERTED, was blocked by the guard, or exhausted broadcast retries.
 *
 *  - `submit` (provider): the budget stays locked; the Job goes back to
 *    ACCEPTED with `escrowError` so the provider can PATCH COMPLETED again.
 *  - any funding step: nothing is locked on-chain (fund never confirmed), so
 *    the Job is FAILED, the DB reservation released, and no on-chain `reject`
 *    is sent — an Open job with no budget is inert and simply expires.
 */
async function handleStepFailure(deps: Erc8183Deps, job: EscrowJobRow, step: EscrowStep, reason: string): Promise<void> {
  if (step === 'submit') {
    if (job.status === 'PAYMENT_PENDING') {
      await deps.db.job.update({ where: { id: job.id }, data: { status: 'ACCEPTED', escrowError: reason } });
    } else {
      await deps.db.job.update({ where: { id: job.id }, data: { escrowError: reason } });
    }
    deps.logger.error({ jobId: job.id, reason }, 'ERC-8183 submit failed — job returned to ACCEPTED for retry');
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
 * Enqueues `submit(onChainJobId, keccak256(result), "0x")` from the provider's
 * wallet. The route has already moved the Job to PAYMENT_PENDING; on a
 * synchronous failure the Job is put back to ACCEPTED before rethrowing.
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
        data: { deferredSubmitAt: deps.now?.() ?? new Date(), deliverableHash: deliverable, escrowError: null },
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
    const reason = `submit enqueue failed: ${(err as Error)?.message ?? String(err)}`;
    await deps.db.job.update({ where: { id: job.id }, data: { status: 'ACCEPTED', escrowError: reason } });
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
    const reason = `deferred submit could not be enqueued: ${(err as Error)?.message ?? String(err)}`;
    await deps.db.job.update({ where: { id: job.id }, data: { status: 'ACCEPTED', escrowError: reason } });
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
 * Schedules an evaluator `reject` when the budget is locked on-chain. Returns
 * true when a refund was scheduled; false when nothing is locked (the funding
 * chain stops by itself, or `fund` confirming later triggers the reject).
 */
export async function requestCancellationReject(
  deps: Erc8183Deps,
  params: { jobId: string; reason: CancellationReason },
): Promise<boolean> {
  const job = await deps.db.job.findUnique({
    where: { id: params.jobId },
    select: { escrowKind: true, onChainStatus: true },
  });
  if (!job || job.escrowKind !== ESCROW_KIND) return false;
  if (job.onChainStatus !== 'FUNDED' && job.onChainStatus !== 'SUBMITTED') {
    deps.logger.info(
      { jobId: params.jobId, onChainStatus: job.onChainStatus },
      'ERC-8183 cancellation — budget not locked on-chain, no reject needed',
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
    issuedAt: (deps.now?.() ?? new Date()).toISOString(),
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

async function readChainJob(deps: Erc8183Deps, job: EscrowJobRow): Promise<{ status: number; budget: bigint }> {
  const raw = (await deps.publicClient(job.escrowChainId!).readContract({
    address: getAddress(job.escrowContract!),
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'getJob',
    args: [BigInt(job.onChainJobId!)],
  })) as { status: number; budget: bigint };
  return { status: Number(raw.status), budget: BigInt(raw.budget ?? 0n) };
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
  if (job.status !== 'PAYMENT_PENDING') {
    return { outcome: 'noop', reason: `job is ${job.status}, not PAYMENT_PENDING` };
  }
  if (chainStatus !== CHAIN_JOB_STATUS.Submitted) {
    // Funded/Open while we believe it was submitted: the submit tx is not
    // mined (yet). Let BullMQ retry; payment recovery handles the long tail.
    throw new Error(`on-chain job ${job.onChainJobId} is status ${chainStatus}, expected Submitted (2)`);
  }

  // Claim the settlement: contests are refused once SETTLING is set, and the
  // decision below is read after the claim so a contest filed just before it
  // is honoured.
  const claimed = await deps.db.job.updateMany({
    where: { id: job.id, onChainStatus: { in: ['SUBMITTED', 'SETTLING'] } },
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

  const signer = deps.evaluatorSigner(fresh.escrowChainId!);
  const escrow = getAddress(fresh.escrowContract!);
  const functionName = contested ? 'reject' : 'complete';
  const reason = contested ? SETTLEMENT_REASONS.contested : SETTLEMENT_REASONS.completed;
  const txHash = await signer.writeContract({
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
  const signer = deps.evaluatorSigner(job.escrowChainId!);
  const escrow = getAddress(job.escrowContract!);
  const txHash = await signer.writeContract({
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
    return { outcome: 'noop', reason: 'on-chain job is Open — nothing to claim' };
  }
  const signer = deps.evaluatorSigner(job.escrowChainId!);
  const escrow = getAddress(job.escrowContract!);
  const txHash = await signer.writeContract({
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

/** Enqueues `claimRefund` for funded/submitted jobs past `expiresAt`. Returns how many were enqueued. */
export async function sweepExpiredEscrows(deps: Erc8183Deps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const expired = await deps.db.job.findMany({
    where: {
      escrowKind: ESCROW_KIND,
      onChainStatus: { in: ['FUNDED', 'SUBMITTED'] },
      expiresAt: { lt: now },
    },
    select: { id: true },
    take: EXPIRY_SWEEP_LIMIT,
    orderBy: { expiresAt: 'asc' },
  });
  for (const job of expired) {
    await deps.settlement.add({ jobId: job.id, action: 'claimRefund' });
  }
  if (expired.length > 0) {
    deps.logger.warn({ count: expired.length }, 'ERC-8183 expiry sweep — claimRefund enqueued');
  }
  return expired.length;
}

export type Erc8183RecoveryOutcome = 'resettled' | 'returnedToAccepted' | 'inFlight' | 'awaitingBinding' | 'submitReleased';

/**
 * Payment-recovery branch for a stale PAYMENT_PENDING escrow job. Never
 * finalizes as FAILED: the budget is on-chain, so the only safe moves are to
 * re-run the (idempotent) settlement or to let the provider retry `submit`.
 *
 * R2: a FUNDED job whose `submit` is deferred behind the ERC-8004 binding is
 * not stuck while an identity transaction is in flight (`awaitingBinding`);
 * otherwise the binding is resumed/closed and the deferred submit released.
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
    const submitTx = await deps.db.transaction.findFirst({
      where: { intentId: { startsWith: escrowIntentId('submit', job.id) } },
      orderBy: { createdAt: 'desc' },
      select: { status: true, error: true },
    });
    if (submitTx && IN_FLIGHT_TX.has(submitTx.status)) return 'inFlight';
    await deps.db.job.update({
      where: { id: job.id },
      data: {
        status: 'ACCEPTED',
        escrowError: submitTx
          ? `Recovery: submit ${submitTx.status} (${submitTx.error ?? 'no error recorded'})`
          : 'Recovery: PAYMENT_PENDING without a submit transaction',
      },
    });
    return 'returnedToAccepted';
  }
  await deps.settlement.add({ jobId: job.id, action: 'settle' });
  return 'resettled';
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
