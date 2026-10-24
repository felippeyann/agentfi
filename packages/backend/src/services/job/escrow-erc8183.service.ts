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
 * C3d — contest → operator review (decision D9):
 *  - A requester's contest moves the job SUBMITTED → CONTESTED (a DB hold:
 *    the chain still says Submitted). The settlement worker never completes or
 *    rejects a CONTESTED job on its own; the operator decides with
 *    `resolveEscrowJob` (admin `POST /admin/jobs/:id/resolve`): pay (complete,
 *    rating 100), refund (reject, no rating), refund with the quality verdict
 *    (reject with REASON_QUALITY_REJECTED, rating 0) or payout-blocked (reject
 *    with REASON_PAYOUT_BLOCKED, no rating). The same decision resolves a
 *    CANCELLED/FAILED job whose deliverable is Submitted on-chain (C3c alert).
 *  - Race rule: contest and settle both claim the job from SUBMITTED with a
 *    conditional write, so exactly one wins; a contest is also refused (409)
 *    once an evaluator settlement of the job may still mine (a broadcast
 *    whose receipt is not a revert) or when the chain no longer says Submitted.
 *    So the reconciliation can never find a contested job Completed by the
 *    backend's own earlier `complete`; if the chain disagrees anyway, the DB
 *    follows it and the operator is alerted (`review-overridden`).
 *  - After `expiresAt`, `claimRefund` is permissionless: an unresolved contest
 *    ends as a full refund to the requester without feedback (alerted).
 *
 * `Job.onChainStatus` records the last CONFIRMED step:
 *   CREATING → OPEN → BUDGET_SET → APPROVED → FUNDED → SUBMITTED → SETTLING → COMPLETED | REJECTED
 *   SUBMITTED → CONTESTED (requester contest, held) → SETTLING (operator decision) → COMPLETED | REJECTED
 *   FUNDED | SUBMITTED | CONTESTED → EXPIRED (claimRefund after expiresAt)
 *   any step before FUNDED fails → FAILED (nothing is locked on-chain)
 *   expired while still Open on-chain → EXPIRED_UNFUNDED (nothing was ever locked; `fund` is closed)
 *
 * Idempotency: each agent-signed step has a deterministic Transaction
 * `intentId = "erc8183:<step>:<jobId>"`; the settlement queue dedupes on
 * `"<action>-<jobId>"` and every settlement reads the on-chain job status
 * first, so a redelivered or recovered job never settles twice.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
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
  type TransactionReceipt,
} from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../../abi/ReputationHook.abi.js';
import { getKnownTokenBySymbol } from '../transaction/token-registry.js';
import { publicErrorMessage, sanitizeContextFromEnv, sanitizeStoredError, sanitizeText, sanitizeValue } from '../../api/errors/sanitize.js';
import type { EvaluatorA1Signer, EvaluatorReceipt, EvaluatorSigner, EvaluatorWriteParams, PreparedEvaluatorTx } from '../escrow/evaluator-signer.js';
import type { EscrowGateVerdict } from '../../config/escrow-verification.js';
import type { FinalizeA2APaymentJobParams } from './payment-finalizer.service.js';
import type { ProcessorLogger, TransactionJobData } from '../../queues/transaction.processor.js';
import { NO_LANE, evaluatorLaneKey, fundingLaneKey, type LaneLease, type LaneLock, type LeaseLock } from '../transaction/wallet-lane.js';
import {
  chooseNonce,
  isLiveStatus,
  nonceConsumed,
  rebroadcastAllowed,
  resolveNonceDecision,
  legacyResignAllowed,
  type CandidateRow,
  type NodeView,
  type ReceiptView,
  type RecoveryCaps,
} from '../escrow/evaluator-candidates.js';
import type { EvaluatorNodeRead, EvaluatorProofTag } from '../escrow/evaluator-rpc.js';
import {
  prismaEvaluatorLedger,
  singleClientNodeReads,
  toNodeViews,
  type CandidateIntent,
  type EvaluatorLedgerPort,
  type EvaluatorNodeReader,
  type LedgerCandidate,
} from './escrow-evaluator-a1.js';
import { SettlementStillPendingError, SettlementSupersededError } from './escrow-errors.js';

export { SettlementStillPendingError, SettlementSupersededError };
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
  | 'CONTESTED'
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

/** " = Completed" for a known on-chain status, "" otherwise (for messages). */
function chainStatusName(status: number): string {
  const name = Object.entries(CHAIN_JOB_STATUS).find(([, value]) => value === status)?.[0];
  return name ? ` = ${name}` : '';
}

/** `bytes32 reason` values the evaluator passes to complete/reject (hash of the human-readable reason). */
export const SETTLEMENT_REASONS = {
  completed: keccak256(toBytes('agentfi.completed')),
  contested: keccak256(toBytes('agentfi.contested')),
  cancelled: keccak256(toBytes('agentfi.cancelled')),
  providerFailed: keccak256(toBytes('agentfi.provider-failed')),
  /**
   * `ReputationHook.REASON_QUALITY_REJECTED`: the operator's explicit verdict
   * that delivered work failed review — the ONLY reject reason the hook rates
   * (value 0, decision D9). Sent only by an operator decision (C3d).
   */
  qualityRejected: keccak256(toBytes('agentfi.quality-rejected')),
  /**
   * `ReputationHook.REASON_PAYOUT_BLOCKED`: the provider cannot receive the
   * token (`complete` keeps reverting); the job is unwound to the requester
   * without a rating.
   */
  payoutBlocked: keccak256(toBytes('agentfi.payout-blocked')),
  /** An operator refund of a job that was neither contested nor cancelled (no rating). */
  operatorRefund: keccak256(toBytes('agentfi.operator-refund')),
} as const;

/** `settle` is the automatic settlement; `resolve` executes an operator decision (C3d). */
export type SettlementAction = 'settle' | 'reject' | 'claimRefund' | 'sweep' | 'resolve';
export type CancellationReason = 'cancelled' | 'provider-failed';

/**
 * Operator decisions on a job held for review (C3d, decision D9), stored in
 * `Job.resolution`:
 *  - `pay`              complete(…, feedback) — the provider is paid, the hook rates 100;
 *  - `refund`           reject(…, "0x") — the requester is refunded, nothing is rated;
 *  - `quality-rejected` reject(REASON_QUALITY_REJECTED, feedback) — refund AND the
 *                       operator's verdict: the hook rates 0;
 *  - `payout-blocked`   reject(REASON_PAYOUT_BLOCKED, "0x") — the provider cannot
 *                       receive USDC; refund, nothing is rated.
 */
export const REVIEW_DECISIONS = ['pay', 'refund', 'quality-rejected', 'payout-blocked'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Default lead time of the "job held for review expires soon" alert (ESCROW_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS). */
export const DEFAULT_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS = 86_400;

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
  /**
   * C3d: alert the operator this long before `expiresAt` about a job held for
   * review (contested, or CANCELLED/FAILED while Submitted on-chain) that is
   * still unresolved. Absent → DEFAULT_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS; 0 disables.
   */
  reviewAlertBeforeExpirySeconds?: number;
}

export type EscrowPublicClient = Pick<PublicClient, 'getTransactionReceipt' | 'readContract'> &
  Partial<Pick<PublicClient, 'getBalance' | 'getTransaction' | 'getTransactionCount' | 'getLogs' | 'getBlockNumber' | 'getBlock' | 'call'>>;

/**
 * C3g-A1 settings of the evaluator key (`config/env.ts`; every field has the
 * documented fallback when absent).
 */
export interface EvaluatorA1Settings {
  /** P17: minimum lane TTL left at each `assertHeld` before the broadcast (ms). */
  leaseMinRemainingMs: number;
  /** P17: the critical section (lane requested → candidate recorded) may not be older than this (ms). */
  criticalSectionMaxMs: number;
  /** R2-P1-3: a live head candidate unknown to every node for this long → `evaluator-send-lost`. Default EVALUATOR_STUCK_ALERT_AFTER_MS. */
  sendLostAlertAfterMs?: number;
  /** R2-P2-5 T: an affected delivered job this close to expiresAt (vs the last block time) alerts at first sight. Default: `reviewAlertBeforeExpirySeconds`. */
  earlyAlertBeforeExpirySeconds?: number;
  /** R2-P2-2 item 4: the proof-tag head not advancing for this long → `evaluator-proof-stalled`. Null/absent → not watched (proof tag `latest` / `latest−K`). */
  proofStalledAlertAfterMs?: number | null;
  /** R2-P3-10: consecutive failed reads of one node before `rpc-node-unhealthy`. */
  rpcUnhealthyAfterFailures?: number;
}

export interface SettlementEnqueue {
  add(data: EscrowSettlementJobData, opts?: { delayMs?: number }): Promise<void>;
}

/**
 * Operator alert: a decision the backend refuses to take on its own, or a
 * resource running out (C3c); a job held for operator review, its decision
 * failing or its expiry approaching (C3d).
 */
export interface EscrowAlert {
  kind:
    | 'cancellation-refused'
    | 'chain-conflict'
    | 'evaluator-balance-low'
    | 'contested'
    | 'review-expiring'
    | 'review-expired'
    | 'review-overridden'
    | 'settlement-failed'
    /** G1 review P2-1: past expiresAt, a delivery accepted in time is waiting for its submit / settlement — not refunded. */
    | 'delivery-held'
    /** C3f item 1: the evaluator key's lowest pending transaction has not been mined for a while — every later evaluator transaction waits behind it. */
    | 'evaluator-stuck'
    /**
     * C3h D2: the evaluator transaction the worker waited for was REPLACED in its nonce (a manual
     * `cast send --nonce`, a second worker): the receipt viem returned is another transaction's and
     * is not read as this job's outcome. The job keeps its uncertain state; the chain decides.
     */
    | 'evaluator-replaced'
    /**
     * P3-6 (24/10): the same detection as `evaluator-replaced`, when the replacement is a KNOWN recovery
     * operation: the recovery script's SPEED_UP / CANCEL of this nonce, recorded in the ledger (origin
     * SCRIPT, with its incident) before its send. Informational (`severity: 'info'`), with the incident; the
     * settlement path is the same (nothing recorded from that receipt, the chain decides). Any other
     * replacement — no ledger row, another origin, no incident, another nonce or key, an unreadable ledger —
     * stays `evaluator-replaced`.
     */
    | 'evaluator-replaced-by-recovery'
    /** C3h D2: the job's own evaluator transaction mined without this job's terminal event — nothing is recorded from it. */
    | 'settlement-unproven'
    /**
     * C3h D3: a delivery accepted in time, with a decision to pay (automatic settlement or the
     * operator's "pay"), ended refunded on-chain (claimRefund by anyone, or a reject) — the provider
     * was not paid. Once per job (the row's transition to its final on-chain status).
     */
    | 'provider-unpaid'
    /** A1 R2-P1-3: a live evaluator candidate at the head of the key that no RPC node knows (lost send), or whose identical rebroadcast was refused. */
    | 'evaluator-send-lost'
    /** A1 R2-P2-2: an evaluator candidate's outcome proven only at `latest` was reorganised away (or a row proven at the proof depth lost its block). */
    | 'evaluator-reorg'
    /** A1 R2-P2-2 item 4: the proof-tag head (`safe` / `finalized`) has not advanced for a while — every proof-depth gate stays closed. */
    | 'evaluator-proof-stalled'
    /** A1 R2-P3-10: an RPC node of the chain failed its reads several times in a row — "consumed" needs every node, nothing is concluded by majority. */
    | 'rpc-node-unhealthy'
    /** A1 §4.3: a nonce of the evaluator key was consumed by a transaction no ledger row covers (a manual send, another environment, a compromised key). */
    | 'evaluator-nonce-foreign'
    /** A1 §4.2: the ledger and the chain disagree in a way nothing may be written for (more than one receipt for a nonce). */
    | 'evaluator-ledger-conflict'
    /** Rechecagem R-P3-b: a nonce consumed without a receipt while a node knows our candidate, persisting past the send-lost / stuck threshold. */
    | 'evaluator-proof-uncertain'
    /** A1 plan §3: the recovery script refused an execution (a cap, the budget, the reserve, a replacement limit) — escalate to the owner. */
    | 'evaluator-recovery-refused';
  message: string;
  jobId?: string;
  chainId?: number | null;
  details?: Record<string, unknown>;
  /**
   * P3-6: `info` = an operator notice about a known operation (logged as a warning, delivered with
   * `severity: info`), not an incident. Absent = an alert (the default for every kind).
   */
  severity?: 'info';
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
  /**
   * Q7: is the on-chain configuration of `chainId` verified in this process
   * (config/escrow-verification.runtime.ts)? Consulted before every
   * evaluator signature; a refusal defers the settlement
   * (`EscrowConfigUnverifiedError`). Absent → allowed (unit tests only: the
   * runtime always wires it).
   */
  configGate?(chainId: number): EscrowGateVerdict;
  /**
   * G1 review P3-1: whether ANY RPC node of `chainId` knows the transaction
   * (pending or mined) — every candidate asked with its own client
   * (`services/transaction/tx-known.ts`); false only when every node answered
   * "not found", and throws when it cannot tell (no node knows it and one
   * errored) — callers treat the throw as "may still mine". `publicClient`
   * is a fallback transport that stops at the first node that answers, and
   * "not found" is an answer. Absent (unit tests) → the single
   * `publicClient(chainId).getTransaction`.
   */
  isKnownTransaction?(chainId: number, hash: Hex): Promise<boolean>;
  /**
   * C3g-A1: the evaluator candidate ledger (`EvaluatorTransaction` and the
   * chain state). Absent → the Prisma ledger on `db` (the runtime and the DB
   * suites); unit tests with a mocked Prisma inject an in-memory double.
   */
  evaluatorLedger?: EvaluatorLedgerPort;
  /**
   * C3g-A1: per-node reads of the evaluator key (nonces at latest / pending /
   * proof tag, known, receipts) over EVERY RPC candidate of the chain — the
   * runtime binds `readNodeViews` with the configured proof tag. Absent (test
   * doubles) → one node: `publicClient(chainId)`, proof = latest.
   */
  readNodeViews?: EvaluatorNodeReader;
  /**
   * C3g-A1 D-g / R2-P2-2: the proof tag (`latest`, `safe`, `finalized`, or a
   * bigint K = `latest − K`). Finalizing a job in the DB (terminal status,
   * finalizer, reservation release) requires the job terminal AT this tag
   * (orchestrator decision A3). Absent → `latest` (test doubles).
   */
  proofTag?: EvaluatorProofTag;
  /** C3g-A1 §8.5: the configured recovery caps of a chain; null = none configured (every recovery execution refused). Read by the recovery script. */
  recoveryCaps?(chainId: number): RecoveryCaps | null;
  /** C3g-A1 §7.1: the evaluator lane lock (a `LeaseLock`). Absent → `lanes` when it hands out leases; neither → no lane (single caller, test doubles). */
  evaluatorLanes?: LeaseLock;
  /** C3g-A1 settings (`config/env.ts`). Absent → `DEFAULT_EVALUATOR_A1_SETTINGS`. */
  evaluatorA1?: EvaluatorA1Settings;
}

/** Fallback A1 settings (P17: half / a quarter of the 120 s lane TTL — the plan's proposal, see `.env.example`). */
export const DEFAULT_EVALUATOR_A1_SETTINGS: EvaluatorA1Settings = {
  leaseMinRemainingMs: 30_000,
  criticalSectionMaxMs: 60_000,
};

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

/** Longest requester-supplied text an alert carries (the contest reason). */
export const ALERT_TEXT_MAX_CHARS = 200;

/** Requester- or chain-supplied text for an alert: sanitized FIRST, then clipped (a clipped key would escape the exact-match rule). */
function alertText(value: string | null | undefined, max = ALERT_TEXT_MAX_CHARS): string | null {
  if (value === null || value === undefined) return null;
  const clean = sanitizeText(value);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Logs and delivers an operator alert. C3d review P2-2: alerts leave the
 * process (webhook / chat channel) and error texts from viem embed the RPC URL
 * with the provider key in its path, so the message and every string in
 * `details` go through the S5 sanitizer here, whatever the caller built.
 * Returns whether the alert was delivered (true without a channel: the log
 * line is the alert).
 */
/** The sanitized alert channel, for the A1 recovery script (same rules as every orchestrator alert). */
export function raiseEscrowAlert(deps: Erc8183Deps, alert: EscrowAlert): Promise<boolean> {
  return raiseAlert(deps, alert);
}

/** The S5 sanitizer over an alert's message and every string of its details (the alert channel and the CLI output). */
function sanitizeAlert(alert: EscrowAlert): EscrowAlert {
  const ctx = sanitizeContextFromEnv();
  return {
    ...alert,
    message: sanitizeText(alert.message, ctx),
    ...(alert.details ? { details: sanitizeValue(alert.details, ctx) as Record<string, unknown> } : {}),
  };
}

async function raiseAlert(deps: Erc8183Deps, alert: EscrowAlert): Promise<boolean> {
  const clean = sanitizeAlert(alert);
  if (clean.severity === 'info') {
    deps.logger.warn({ alert: clean.kind, severity: 'info', jobId: clean.jobId, chainId: clean.chainId, ...clean.details }, `ESCROW NOTICE: ${clean.message}`);
  } else {
    deps.logger.error({ alert: clean.kind, jobId: clean.jobId, chainId: clean.chainId, ...clean.details }, `ESCROW ALERT: ${clean.message}`);
  }
  if (!deps.alert) return true;
  try {
    await deps.alert(clean);
    return true;
  } catch (err) {
    deps.logger.warn({ alert: clean.kind, jobId: clean.jobId, err: publicErrorMessage(err) }, 'Escrow alert could not be delivered');
    return false;
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
  settlementFailureAlertAt.clear();
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
      await recordSubmitHookEvents(deps, job, tx.txHash as Hex | null);
      await advanceToSubmitted(deps, job.id, { deliverable, scheduleSettle: true });
      return;
  }
}

/**
 * C3d: the hook's identity events in the provider's `submit` receipt. The
 * first verified `submit` of a provider address fixes its canonical ERC-8004
 * id (`CanonicalAgentIdSet`) — the id every later settlement of its jobs is
 * rated under, which can differ from the job's `providerAgentId`; an id the
 * Identity Registry did not confirm (`AgentIdNotVerified`) means this job's
 * settlement will skip the feedback (`agent-not-provider`). Best effort: a
 * receipt that cannot be read changes nothing (the settlement receipt and
 * `canonicalAgentId` still tell the truth later).
 */
async function recordSubmitHookEvents(deps: Erc8183Deps, job: EscrowJobRow, txHash: Hex | null): Promise<void> {
  const hook = job.escrowChainId !== null ? deps.config.chain(job.escrowChainId)?.hook ?? null : null;
  if (!hook || !txHash) return;
  let events: HookIdentityEvents;
  try {
    const receipt = await deps.publicClient(job.escrowChainId!).getTransactionReceipt({ hash: txHash });
    events = parseHookIdentityEvents(receipt.logs, hook);
  } catch (err) {
    deps.logger.warn({ jobId: job.id, txHash, err: errorMessage(err) }, 'ERC-8183 submit receipt not readable for hook identity events');
    return;
  }
  const data: Prisma.JobUpdateInput = {};
  if (events.canonicalAgentId) {
    data.ratedAgentId = events.canonicalAgentId;
    if (job.providerAgentId && job.providerAgentId !== events.canonicalAgentId) {
      deps.logger.warn(
        { jobId: job.id, providerAgentId: job.providerAgentId, canonicalAgentId: events.canonicalAgentId },
        'ReputationHook canonical agent id differs from the id bound to the job',
      );
    }
  }
  if (events.notVerifiedAgentId) {
    data.providerAgentIdError =
      `ReputationHook did not verify ERC-8004 agent id ${events.notVerifiedAgentId} for the provider at submit ` +
      '(not owned by / not the agent wallet of the provider, or a registry failure): settlement will skip the feedback (agent-not-provider)';
    deps.logger.warn({ jobId: job.id, agentId: events.notVerifiedAgentId }, 'ERC-8004 agent id not verified by the ReputationHook at submit');
  }
  if (Object.keys(data).length > 0) await deps.db.job.update({ where: { id: job.id }, data });
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
  // A job that cannot be funded is unwound AFTER the lane is released:
  // handleStepFailure pumps the same lane again.
  let broken: EscrowJobRow | null = null;
  const sent = await lanes.run(fundingLaneKey(chainId, requesterId), async (): Promise<string | null> => {
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
      broken = next;
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
  const unfundable = broken as EscrowJobRow | null;
  if (unfundable) await handleStepFailure(deps, unfundable, 'approve', 'cannot build approve: escrow columns incomplete', null);
  return sent;
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

/**
 * C3g-A1, orchestrator decision A3 (R2-P2-2): finalizing a job in the DB
 * changes what can happen to it (terminal status, finalizer, reservation
 * release), so the chain's terminal status must hold AT THE PROOF TAG. With
 * proof tag `latest` (or none: test doubles) it is the `latest` read. Returns
 * the on-chain status at the proof tag; throws when unreadable.
 */
async function readChainJobAtProof(deps: Erc8183Deps, job: Pick<EscrowJobRow, 'escrowChainId' | 'escrowContract' | 'onChainJobId'>): Promise<ChainJob> {
  const tag = deps.proofTag ?? 'latest';
  if (tag === 'latest' || tag === 0n) return readChainJob(deps, job);
  const client = deps.publicClient(job.escrowChainId!);
  let at: { blockTag: 'safe' | 'finalized' } | { blockNumber: bigint };
  if (typeof tag === 'bigint') {
    if (!client.getBlockNumber) throw new Error('the read client cannot tell the latest block (proof tag latest − K)');
    const latest = await client.getBlockNumber();
    at = { blockNumber: latest > tag ? latest - tag : 0n };
  } else {
    at = { blockTag: tag };
  }
  const raw = (await client.readContract({
    address: getAddress(job.escrowContract!),
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'getJob',
    args: [BigInt(job.onChainJobId!)],
    ...at,
  } as never)) as { status: number; budget: bigint };
  return { status: Number(raw.status), budget: BigInt(raw.budget ?? 0n) };
}

/**
 * A3: the job is terminal on-chain at `latest` but not (yet, or not readably)
 * at the proof tag: nothing is finalized — the job keeps its live status, its
 * mined candidate stays at proof level `latest` (a reorg below the proof
 * depth reopens it via `revertForReorg` without anything finalized). The
 * reconciliation pass enqueues the job again once the outcome is proven.
 */
export class SettlementAwaitingProofError extends Error {
  constructor(
    readonly jobId: string,
    readonly chainStatus: number,
  ) {
    super(`ERC-8183 job ${jobId} is terminal on-chain (status ${chainStatus}) at latest but not yet at the proof tag — not finalized yet`);
    this.name = 'SettlementAwaitingProofError';
  }
}

/** A3: throws `SettlementAwaitingProofError` unless the job is terminal at the proof tag (with the same status family). */
async function assertTerminalAtProof(deps: Erc8183Deps, job: EscrowJobRow, latestStatus: number): Promise<void> {
  if ((deps.proofTag ?? 'latest') === 'latest') return;
  let proven: ChainJob;
  try {
    proven = await readChainJobAtProof(deps, job);
  } catch (err) {
    deps.logger.warn({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 getJob at the proof tag unreadable — not finalized yet');
    throw new SettlementAwaitingProofError(job.id, latestStatus);
  }
  if (proven.status !== latestStatus) throw new SettlementAwaitingProofError(job.id, latestStatus);
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
    const { delayMs, clamped } = settlementDelay(deps.config, job.expiresAt, nowOf(deps));
    await deps.settlement.add({ jobId, action: 'settle' }, delayMs > 0 ? { delayMs } : undefined);
    if (clamped) {
      deps.logger.warn(
        { jobId, delayMs, configuredDelayMs: deps.config.evaluationDelaySeconds * 1000, expiresAt: job.expiresAt },
        'ERC-8183 evaluation delay clamped so the settlement runs before expiresAt',
      );
    }
    deps.logger.info({ jobId, delayMs }, 'ERC-8183 deliverable submitted — settlement scheduled');
  }
  return 'advanced';
}

/**
 * C3d: how close to `expiresAt` the backend still lets a provider accept or
 * deliver, and how far before it a settlement must be scheduled: 2 minutes,
 * or 10 % of the job TTL when that is shorter (short test TTLs). Past
 * `expiresAt` anybody can `claimRefund`, which would hand the requester the
 * deliverable AND the refund.
 */
export function expiryMarginMs(config: Pick<Erc8183Config, 'jobTtlSeconds'>): number {
  return Math.min(120_000, config.jobTtlSeconds * 100);
}

/**
 * C3d: the evaluation delay (the contest window) clamped to the time left
 * before `expiresAt` minus `expiryMarginMs`, so a long
 * ESCROW_EVALUATION_DELAY_SECONDS can never push the settlement past expiry.
 */
export function settlementDelay(
  config: Pick<Erc8183Config, 'evaluationDelaySeconds' | 'jobTtlSeconds'>,
  expiresAt: Date | null,
  now: Date,
): { delayMs: number; clamped: boolean } {
  const configured = Math.max(0, config.evaluationDelaySeconds * 1000);
  if (!expiresAt) return { delayMs: configured, clamped: false };
  const latest = Math.max(0, expiresAt.getTime() - now.getTime() - expiryMarginMs(config));
  return configured > latest ? { delayMs: latest, clamped: true } : { delayMs: configured, clamped: false };
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
      try {
        await reconcileTerminal(deps, job, chain.status);
      } catch (err) {
        if (!(err instanceof SettlementAwaitingProofError)) throw err;
        deps.logger.warn({ jobId: job.id, step }, 'ERC-8183 step failed and the job is terminal on-chain but not yet at the proof tag — left for reconciliation');
      }
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

// ── C3g-A1: the evaluator candidate ledger as a gate ───────────────────────

function ledgerOf(deps: Erc8183Deps): EvaluatorLedgerPort {
  return deps.evaluatorLedger ?? prismaEvaluatorLedger(deps.db);
}

function a1Settings(deps: Erc8183Deps): EvaluatorA1Settings {
  return deps.evaluatorA1 ?? DEFAULT_EVALUATOR_A1_SETTINGS;
}

/** Per-node reads of the evaluator key and `hashes` (every RPC node; one node for test doubles). Never throws. */
async function readEvaluatorNodes(deps: Erc8183Deps, chainId: number, evaluator: Address, hashes: readonly string[]): Promise<EvaluatorNodeRead[]> {
  const list = hashes.map((h) => h.toLowerCase() as Hex);
  try {
    if (deps.readNodeViews) return await deps.readNodeViews(chainId, evaluator, list);
    return await singleClientNodeReads(deps.publicClient(chainId) as never, evaluator, list);
  } catch (err) {
    return [{ node: '#? reader', index: 0, ok: false, error: errorMessage(err) }];
  }
}

/** The evaluator key that signed a job's candidates (the configured one; the candidate rows carry it too). */
function evaluatorOf(deps: Erc8183Deps, cands: readonly LedgerCandidate[]): Address | null {
  const fromRow = cands.find((c) => c.evaluator)?.evaluator;
  return (fromRow ? getAddress(fromRow) : deps.config.evaluatorAddress) ?? null;
}

type Verdict = { state: 'clear' } | { state: 'blocks'; reason: string; txHash: string } | { state: 'uncertain'; reason: string; txHash: string };

function receiptsOf(views: readonly NodeView[], hash: string): Array<ReceiptView | null | undefined> {
  return views.map((v) => {
    const r = v.receipts;
    if (!r) return undefined;
    const key = Object.keys(r).find((k) => k.toLowerCase() === hash.toLowerCase());
    return key === undefined ? undefined : r[key];
  });
}

/**
 * A1 §6.1 + R2-P2-2: can this candidate of the job still change what happens
 * to the job, at `depth`?
 *  - `proof` (contest, resolve, a different decision, claimRefund, the
 *    cancellation reject, rebuilding the feedback file): clear only when its
 *    nonce is consumed at the proof tag by consensus of every node AND its own
 *    receipt is absent or a revert on every node (a mined success of a
 *    decision candidate settled the job: blocks). A CANCEL settles nothing.
 *  - `latest` (re-signing the SAME calldata): clear once its nonce is consumed
 *    at `latest` by consensus (the worker's C3e rule; a mined success would
 *    have made the chain terminal, which the caller read first).
 * A row already proven at the proof depth is decided by its status. Any node
 * in error or an answer missing → uncertain. Time never clears anything.
 * A LEGACY row without a nonce follows today's rule (R2-P3-1): `proof` →
 * clear only with a reverted receipt; `latest` → `legacyResignAllowed`.
 */
function candidateVerdict(c: CandidateRow, views: readonly NodeView[], depth: 'latest' | 'proof'): Verdict {
  const settles = c.kind !== 'CANCEL';
  const tx = c.txHash;
  if (c.proofLevel === 'proof') {
    if (c.status === 'MINED_SUCCESS' && settles && depth === 'proof') return { state: 'blocks', reason: `the evaluator transaction ${tx} was mined`, txHash: tx };
    return { state: 'clear' };
  }
  if (!isLiveStatus(c.status) && depth === 'latest') return { state: 'clear' };
  if (views.length === 0 || views.some((v) => !v.ok)) {
    return { state: 'uncertain', reason: `the RPC nodes could not all be read for candidate ${tx}${c.nonce !== null ? ` at nonce ${c.nonce}` : ''}`, txHash: tx };
  }
  if (c.nonce === null) {
    if (depth === 'latest') {
      const mined = receiptsOf(views, tx);
      // Today's rule: mined (any status) → the caller read the chain first, a new attempt is safe.
      if (mined.length > 0 && mined.every((r) => r !== undefined && r !== null)) return { state: 'clear' };
      return legacyResignAllowed(c, [...views])
        ? { state: 'clear' }
        : { state: 'blocks', reason: `legacy settlement ${tx} has no receipt and is not proven dropped (a node knows it, or a node could not tell)`, txHash: tx };
    }
    const rs = receiptsOf(views, tx);
    if (rs.some((r) => r === undefined)) return { state: 'uncertain', reason: `the receipt of ${tx} could not be read on every node`, txHash: tx };
    if (rs.length > 0 && rs.every((r) => r && r.status === 'reverted')) return { state: 'clear' };
    if (rs.some((r) => r && r.status === 'success')) return { state: 'blocks', reason: `the settlement transaction ${tx} was mined`, txHash: tx };
    return { state: 'blocks', reason: `the settlement transaction ${tx} is pending (no receipt yet)`, txHash: tx };
  }
  const consumed = nonceConsumed([...views], c.nonce, depth);
  if (consumed === null) return { state: 'uncertain', reason: `the nonce ${c.nonce} of ${tx} could not be read on every node`, txHash: tx };
  if (!consumed) {
    return {
      state: 'blocks',
      reason: `candidate tx ${tx} at nonce ${c.nonce} may still mine${depth === 'proof' && !isLiveStatus(c.status) ? ` (its outcome is not yet at the proof depth)` : ''}`,
      txHash: tx,
    };
  }
  if (depth === 'latest' || !settles) return { state: 'clear' };
  const rs = receiptsOf(views, tx);
  if (rs.some((r) => r === undefined)) return { state: 'uncertain', reason: `the receipt of ${tx} could not be read on every node`, txHash: tx };
  if (rs.some((r) => r && r.status === 'success')) return { state: 'blocks', reason: `the evaluator transaction ${tx} was mined`, txHash: tx };
  return { state: 'clear' };
}

/** Candidates of the job a gate must look at (rows still undecided at the proof depth, plus mined decisions). */
function gateRows(cands: readonly LedgerCandidate[]): LedgerCandidate[] {
  return cands.filter((c) => isLiveStatus(c.status) || c.proofLevel === 'latest' || (c.status === 'MINED_SUCCESS' && c.kind !== 'CANCEL'));
}

/**
 * A1 gate over the ledger: the first candidate of the job that blocks (or is
 * uncertain) at `depth`; null when every candidate is clear. `sameCalldataHash`
 * lowers the depth to `latest` for the candidates carrying exactly that
 * calldata (re-signing the same decision, R2-P2-2).
 */
async function jobCandidatesVerdict(
  deps: Erc8183Deps,
  chainId: number,
  cands: readonly LedgerCandidate[],
  depth: 'latest' | 'proof',
  sameCalldataHash: string | null = null,
): Promise<Exclude<Verdict, { state: 'clear' }> | null> {
  const rows = gateRows(cands);
  if (rows.length === 0) return null;
  const evaluator = evaluatorOf(deps, rows);
  if (!evaluator) return { state: 'uncertain', reason: 'no evaluator key configured to read its nonces', txHash: rows[0]!.txHash };
  const views = toNodeViews(await readEvaluatorNodes(deps, chainId, evaluator, rows.map((c) => c.txHash)));
  let uncertain: Exclude<Verdict, { state: 'clear' }> | null = null;
  for (const c of rows) {
    // Re-signing the SAME decision (the worker gate passes its calldata hash): `latest` is enough (R2-P2-2) for
    //  - a candidate carrying exactly that calldata;
    //  - D-B (row 33): a CANCEL of the job — it never settles anything, its nonce consumed at `latest` is enough
    //    to re-sign the decision (a reorg costs at worst the gas of a revert);
    //  - D-A (row 32, R2-P3-1): a LEGACY row without nonce — today's worker rule (`legacyResignAllowed`),
    //    whatever its (unknown) calldata.
    // Contest, resolve with another decision and the backend's claimRefund / cancellation reject still call
    // with `sameCalldataHash = null`: the proof depth.
    const resign = depth === 'proof' && sameCalldataHash !== null;
    const d: 'latest' | 'proof' =
      resign && (c.calldataHash === sameCalldataHash!.toLowerCase() || c.kind === 'CANCEL' || c.nonce === null) ? 'latest' : depth;
    const v = candidateVerdict(c, views, d);
    if (v.state === 'blocks') return v;
    if (v.state === 'uncertain' && !uncertain) uncertain = v;
  }
  return uncertain;
}

// ── Contest → operator review (C3d, decision D9) ───────────────────────────

/**
 * True when no evaluator transaction of the job can still change the chain.
 *
 * C3g-A1 (§6.1, R2-P2-2): with candidates in the ledger, every candidate of
 * the job (any origin) must be clear at the PROOF depth: nonce consumed at the
 * proof tag by consensus of every RPC node, and no mined success of a
 * decision. Unreadable → `unverifiable` (contest 503 CONTEST_UNVERIFIABLE,
 * resolve `unverifiable`). A job without any candidate (a legacy row, R2-P3-1)
 * keeps today's rule: no broadcast, or the last one reverted.
 */
async function noSettlementInFlight(
  deps: Erc8183Deps,
  job: Pick<EscrowJobRow, 'id' | 'settleTxHash' | 'escrowChainId' | 'settleAttemptAt'>,
): Promise<{ ok: boolean; reason?: string; unverifiable?: boolean }> {
  const cands = await ledgerOf(deps).candidatesForJob(job.id);
  const recorded = job.settleTxHash ? cands.some((c) => c.txHash.toLowerCase() === job.settleTxHash!.toLowerCase()) : false;
  if (cands.length > 0 && (!job.settleAttemptAt || recorded)) {
    const verdict = await jobCandidatesVerdict(deps, job.escrowChainId!, cands, 'proof');
    if (!verdict) return { ok: true };
    return { ok: false, reason: verdict.reason, ...(verdict.state === 'uncertain' ? { unverifiable: true } : {}) };
  }
  // C3e item 2 / G1 review P3-2: an evaluator send is stamped (with its
  // signed hash) before it leaves and the stamp is cleared once the send is
  // resolved; a stamp still set means a send in progress, or a process that
  // died mid-send: it may still mine. (A1: a stamp whose hash has a ledger
  // row is decided by the ledger above.)
  if (job.settleAttemptAt) {
    return {
      ok: false,
      reason:
        `a settlement was being sent at ${job.settleAttemptAt.toISOString()} ` +
        `(transaction ${job.settleTxHash ?? 'not recorded'}) and its send is not resolved yet; it may still mine`,
    };
  }
  if (!job.settleTxHash) return { ok: true };
  try {
    const receipt = await deps.publicClient(job.escrowChainId!).getTransactionReceipt({ hash: job.settleTxHash as Hex });
    if (receipt.status === 'reverted') return { ok: true };
    return { ok: false, reason: `the settlement transaction ${job.settleTxHash} was mined` };
  } catch {
    return { ok: false, reason: `the settlement transaction ${job.settleTxHash} is pending (no receipt yet)` };
  }
}

/** A job whose deliverable is Submitted on-chain and that only an operator decision settles. */
function isHeldForReview(job: Pick<EscrowJobRow, 'onChainStatus' | 'status'>): boolean {
  return job.onChainStatus === 'CONTESTED' || (job.onChainStatus === 'SUBMITTED' && (job.status === 'CANCELLED' || job.status === 'FAILED'));
}

export type ContestOutcome =
  | { outcome: 'held'; contestedAt: Date }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'unverifiable'; reason: string };

/**
 * `POST /v1/jobs/:id/contest` (requester; ownership checked by the route).
 * Decision D9: a contest is a claim, not a verdict — it puts the job on hold
 * for operator review (SUBMITTED → CONTESTED) and alerts the operator; the
 * settlement worker leaves a CONTESTED job alone.
 *
 * Race rule (explicit): accepted only while the job is PAYMENT_PENDING +
 * SUBMITTED in the DB, Submitted on-chain, and no evaluator settlement of it
 * can still mine (none broadcast, or the last one reverted). The write is
 * conditional on exactly that row state (incl. `settleTxHash`), and the
 * settlement claims SUBMITTED → SETTLING the same way, so exactly one of
 * contest / settle wins; the loser is refused (409) or becomes a no-op. A
 * contest can therefore never be "accepted" while a `complete` the backend
 * already sent mines behind it.
 */
export async function contestEscrowJob(deps: Erc8183Deps, params: { jobId: string; reason: string | null }): Promise<ContestOutcome> {
  const job = await loadEscrowJob(deps, params.jobId);
  if (!job) return { outcome: 'refused', reason: 'not an ERC-8183 escrow job' };
  if (job.status !== 'PAYMENT_PENDING' || job.onChainStatus !== 'SUBMITTED' || job.contestedAt !== null) {
    return { outcome: 'refused', reason: 'A job can only be contested while PAYMENT_PENDING, SUBMITTED on-chain, not contested yet and before settlement' };
  }
  // G1 review P2-1: the contest window (the evaluation delay) is clamped to
  // end at `expiresAt − margin`, where the settlement is due. A contest after
  // that point could only meet a settlement that was delayed (Q7 deferral,
  // failures) and, as an unresolved contest at expiry, turn a delivery made in
  // time into a full refund — the requester keeping the deliverable.
  if (job.expiresAt && nowOf(deps).getTime() >= job.expiresAt.getTime() - expiryMarginMs(deps.config)) {
    return {
      outcome: 'refused',
      reason:
        `The contest window has closed: the escrow expires at ${job.expiresAt.toISOString()} and the settlement of a delivery is due ` +
        'before expiresAt (minus the expiry margin). Ask the operator to review the job.',
    };
  }
  let chain: ChainJob;
  try {
    chain = await readChainJob(deps, job);
  } catch (err) {
    deps.logger.warn({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 contest: on-chain status unreadable');
    return { outcome: 'unverifiable', reason: 'The on-chain job status could not be read; retry the contest' };
  }
  if (chain.status !== CHAIN_JOB_STATUS.Submitted) {
    return { outcome: 'refused', reason: `The job is no longer Submitted on-chain (status ${chain.status}): settlement already happened` };
  }
  const inFlight = await noSettlementInFlight(deps, job);
  if (!inFlight.ok && inFlight.unverifiable) {
    return { outcome: 'unverifiable', reason: `Whether an evaluator transaction of this job may still mine could not be verified (${inFlight.reason}); retry the contest` };
  }
  if (!inFlight.ok) return { outcome: 'refused', reason: `Settlement already started: ${inFlight.reason}` };

  const contestedAt = nowOf(deps);
  const claimed = await deps.db.job.updateMany({
    where: { id: job.id, status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', contestedAt: null, settleTxHash: job.settleTxHash, settleAttemptAt: null },
    data: { onChainStatus: 'CONTESTED', contestedAt, contestReason: params.reason, escrowError: null },
  });
  if (claimed.count === 0) {
    return { outcome: 'refused', reason: 'Settlement was claimed while the contest was processed' };
  }
  await raiseAlert(deps, {
    kind: 'contested',
    jobId: job.id,
    chainId: job.escrowChainId,
    message:
      `Job ${job.id} was contested by its requester and is held for operator review: decide with ` +
      `POST /admin/jobs/${job.id}/resolve (pay | refund | refund + quality-rejected verdict) before expiresAt ` +
      `${job.expiresAt?.toISOString() ?? '(unknown)'}. After expiresAt anyone can claimRefund: the contest then ends as a ` +
      'full refund to the requester without feedback.',
    // The requester's free text: sanitized and clipped before it reaches the channel.
    details: { reason: alertText(params.reason), expiresAt: job.expiresAt?.toISOString() ?? null, onChainJobId: job.onChainJobId },
  });
  deps.logger.warn({ jobId: job.id, reason: alertText(params.reason) }, 'ERC-8183 job contested — held for operator review');
  return { outcome: 'held', contestedAt };
}

export interface ResolveParams {
  jobId: string;
  decision: ReviewDecision;
  note: string;
  /** Who decided (admin UI user, or "admin-api" for a bare ADMIN_SECRET call). */
  operator: string;
}

export type ResolveRefusal = 'NOT_FOUND' | 'NOT_ESCROW_JOB' | 'NOT_RESOLVABLE' | 'SETTLEMENT_IN_PROGRESS' | 'CHAIN_NOT_SUBMITTED';

export type ResolveOutcome =
  | { outcome: 'scheduled'; resolution: ReviewDecision; previousStatus: string; previousOnChainStatus: string | null; queued: boolean }
  | { outcome: 'refused'; code: ResolveRefusal; message: string; status?: string; onChainStatus?: string | null }
  | { outcome: 'unverifiable'; message: string };

/** One entry of `Job.reviewLog`. */
export interface ReviewLogEntry {
  at: string;
  by: string;
  decision: ReviewDecision;
  note: string;
  status: string;
  onChainStatus: string | null;
}

/**
 * Operator decision on an ERC-8183 job whose deliverable is Submitted on-chain
 * (C3d): a contested job (CONTESTED), a CANCELLED/FAILED job the backend
 * refused to refund on its own (C3c conflict), or a PAYMENT_PENDING job whose
 * settlement is stuck (e.g. the provider cannot receive USDC — `payout-blocked`).
 *
 * Checks the chain (still Submitted) and that no evaluator settlement can
 * still mine, then claims the job (→ SETTLING) with the decision, its author,
 * time and note recorded on the row and appended to `reviewLog`, and enqueues
 * the `resolve` settlement. The settlement worker executes the decision (see
 * `settle`); a decision whose settlement keeps failing goes back to the hold
 * and is retried by the recovery tick until another decision replaces it.
 */
export async function resolveEscrowJob(deps: Erc8183Deps, params: ResolveParams): Promise<ResolveOutcome> {
  const job = await deps.db.job.findUnique({ where: { id: params.jobId }, include: JOB_INCLUDE });
  if (!job) return { outcome: 'refused', code: 'NOT_FOUND', message: 'Job not found' };
  if (job.escrowKind !== ESCROW_KIND || !job.onChainJobId || !job.escrowContract || !job.escrowChainId) {
    return { outcome: 'refused', code: 'NOT_ESCROW_JOB', message: 'Only ERC-8183 jobs that exist on-chain can be resolved' };
  }
  const refusal = (code: ResolveRefusal, message: string): ResolveOutcome => ({
    outcome: 'refused',
    code,
    message,
    status: job.status,
    onChainStatus: job.onChainStatus,
  });
  if (job.onChainStatus === 'SETTLING') {
    return refusal('SETTLEMENT_IN_PROGRESS', 'A settlement of this job is running; retry once it has finished or failed');
  }
  const resolvable =
    job.onChainStatus === 'CONTESTED' ||
    (job.onChainStatus === 'SUBMITTED' && ['PAYMENT_PENDING', 'CANCELLED', 'FAILED'].includes(job.status));
  if (!resolvable) {
    return refusal(
      'NOT_RESOLVABLE',
      'Only a job whose deliverable is Submitted on-chain can be resolved: CONTESTED, or SUBMITTED while PAYMENT_PENDING / CANCELLED / FAILED',
    );
  }
  let chain: ChainJob;
  try {
    chain = await readChainJob(deps, job);
  } catch (err) {
    deps.logger.warn({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 resolve: on-chain status unreadable');
    return { outcome: 'unverifiable', message: 'The on-chain job status could not be read; retry' };
  }
  if (chain.status !== CHAIN_JOB_STATUS.Submitted) {
    // Nothing is written here. The payment-recovery tick records the chain's
    // outcome once the row is stale: the reconciliation pass for a held job
    // (read-only, review P3-1), the PAYMENT_PENDING scan for the others.
    return refusal(
      'CHAIN_NOT_SUBMITTED',
      `The job is no longer Submitted on-chain (status ${chain.status}${chainStatusName(chain.status)}): there is nothing left to decide. ` +
        'This call changes nothing; the payment-recovery tick records the on-chain outcome in the DB on its next pass over stale ' +
        'escrow jobs (and alerts when it overrode a review).',
    );
  }
  const inFlight = await noSettlementInFlight(deps, job);
  if (!inFlight.ok && inFlight.unverifiable) {
    return { outcome: 'unverifiable', message: `Whether an evaluator transaction of this job may still mine could not be verified (${inFlight.reason}); retry` };
  }
  if (!inFlight.ok) return refusal('SETTLEMENT_IN_PROGRESS', `A settlement transaction may still mine: ${inFlight.reason}`);

  const at = nowOf(deps);
  const previous = { status: job.status, onChainStatus: job.onChainStatus, settleTxHash: job.settleTxHash, reviewLog: job.reviewLog };
  const claimed = await deps.db.job.updateMany({
    where: { id: job.id, status: previous.status, onChainStatus: previous.onChainStatus, settleTxHash: previous.settleTxHash, settleAttemptAt: null },
    data: {
      onChainStatus: 'SETTLING',
      resolution: params.decision,
      resolvedBy: params.operator,
      resolvedAt: at,
      resolutionNote: params.note,
      escrowError: null,
    },
  });
  if (claimed.count === 0) {
    return refusal('SETTLEMENT_IN_PROGRESS', 'The job changed while the decision was processed; re-read it and retry');
  }
  // Only the caller that won the claim appends, so the read-modify-write cannot lose an entry.
  const entry: ReviewLogEntry = {
    at: at.toISOString(),
    by: params.operator,
    decision: params.decision,
    note: params.note,
    status: previous.status,
    onChainStatus: previous.onChainStatus,
  };
  const log = Array.isArray(previous.reviewLog) ? (previous.reviewLog as unknown as ReviewLogEntry[]) : [];
  await deps.db.job.update({ where: { id: job.id }, data: { reviewLog: [...log, entry] as unknown as Prisma.InputJsonValue } });

  let queued = true;
  try {
    await deps.settlement.add({ jobId: job.id, action: 'resolve' });
  } catch (err) {
    // The decision is recorded (SETTLING + resolution): the reconciliation /
    // payment-recovery tick re-enqueues it once the queue is back.
    queued = false;
    deps.logger.error({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 resolve recorded but could not be enqueued — recovery will retry');
  }
  deps.logger.warn(
    { adminAction: 'job_resolve', jobId: job.id, decision: params.decision, by: params.operator, note: params.note, previousStatus: previous.status, previousOnChainStatus: previous.onChainStatus },
    'ERC-8183 operator decision recorded',
  );
  return { outcome: 'scheduled', resolution: params.decision, previousStatus: previous.status, previousOnChainStatus: previous.onChainStatus, queued };
}

/**
 * C3d: alerts the operator, once per job, when a job held for review
 * (contested, or CANCELLED/FAILED while Submitted on-chain) gets within
 * `reviewAlertBeforeExpirySeconds` of `expiresAt` unresolved. Past
 * `expiresAt`, `claimRefund` is permissionless: the job ends as a full refund
 * to the requester without feedback. Runs on the payment-recovery tick.
 * Returns how many alerts were delivered; a job whose alert could not be
 * delivered is released and alerted again on the next tick.
 */
export async function alertExpiringReviews(deps: Erc8183Deps, opts: { limit?: number } = {}): Promise<number> {
  const lead = deps.config.reviewAlertBeforeExpirySeconds ?? DEFAULT_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS;
  if (lead <= 0) return 0;
  const now = nowOf(deps);
  const due = await deps.db.job.findMany({
    where: {
      escrowKind: ESCROW_KIND,
      reviewAlertedAt: null,
      expiresAt: { lte: new Date(now.getTime() + lead * 1000) },
      OR: [{ onChainStatus: 'CONTESTED' }, { onChainStatus: 'SUBMITTED', status: { in: ['CANCELLED', 'FAILED'] } }],
    },
    select: { id: true, status: true, onChainStatus: true, expiresAt: true, escrowChainId: true, contestedAt: true },
    orderBy: { expiresAt: 'asc' },
    take: opts.limit ?? 50,
  });
  let sent = 0;
  for (const job of due) {
    const claimed = await deps.db.job.updateMany({ where: { id: job.id, reviewAlertedAt: null }, data: { reviewAlertedAt: now } });
    if (claimed.count === 0) continue;
    const minutes = job.expiresAt ? Math.round((job.expiresAt.getTime() - now.getTime()) / 60_000) : null;
    const delivered = await raiseAlert(deps, {
      kind: 'review-expiring',
      jobId: job.id,
      chainId: job.escrowChainId,
      message:
        `Job ${job.id} (${job.onChainStatus === 'CONTESTED' ? 'contested' : `${job.status} while Submitted on-chain`}) is still ` +
        `waiting for an operator decision and expires at ${job.expiresAt?.toISOString() ?? '(unknown)'}` +
        `${minutes !== null ? ` (${minutes >= 0 ? `in ${minutes} min` : `${-minutes} min ago`})` : ''}. ` +
        `Decide with POST /admin/jobs/${job.id}/resolve; after expiresAt anyone can claimRefund and the job ends as a full ` +
        'refund to the requester without feedback.',
      details: { status: job.status, onChainStatus: job.onChainStatus, expiresAt: job.expiresAt?.toISOString() ?? null },
    });
    if (!delivered) {
      // C3d review P3-6: the claim is the "once per job" guard — a channel
      // outage must not swallow the only warning. Give it back (only our own
      // claim) so the next tick retries the delivery.
      await deps.db.job.updateMany({ where: { id: job.id, reviewAlertedAt: now }, data: { reviewAlertedAt: null } });
      continue;
    }
    sent++;
  }
  return sent;
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

/**
 * C3d: true once the settlement that committed the file's hash on-chain is
 * mined. The orchestrator keeps a file only while it is the one the last
 * built settlement carries (every "0x" reject and every expiry drops it), so a
 * file on a COMPLETED / REJECTED job is the committed one and can be served
 * as immutable; before that it may still be rebuilt (another decision) and is
 * served `no-store`.
 */
export function isFeedbackFileCommitted(job: { onChainStatus: string | null; feedbackFile: unknown }): boolean {
  return job.feedbackFile != null && (job.onChainStatus === 'COMPLETED' || job.onChainStatus === 'REJECTED');
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

/**
 * C3h D2: the evaluator transaction the worker waited for was replaced in its
 * nonce and viem returned the REPLACEMENT's receipt (`minedHash`; null when
 * the receipt carried no hash). Nothing is recorded from that receipt — not a
 * payment, not a refund, not a revert. The settlement is retried (BullMQ /
 * recovery) and each attempt reads `getJob` first: a terminal chain is
 * reconciled from the chain, a job still Submitted is settled again by its
 * recorded decision with a new transaction.
 */
export class SettlementReplacedError extends Error {
  constructor(
    public readonly action: SettlementAction,
    public readonly txHash: Hex,
    public readonly minedHash: Hex | null,
  ) {
    super(`ERC-8183 ${action} ${txHash} was replaced in its nonce by ${minedHash ?? 'an unknown transaction'} — its outcome is not this job's`);
    this.name = 'SettlementReplacedError';
  }
}

/**
 * C3h D2: the job's own evaluator transaction mined successfully but carries
 * no terminal event for THIS job, and the chain does not show the job
 * terminal. Never read as a rejection (the absence of `JobCompleted` proves
 * nothing); retried like any failure.
 */
export class SettlementUnprovenError extends Error {
  constructor(
    public readonly action: SettlementAction,
    public readonly txHash: Hex,
  ) {
    super(`ERC-8183 ${action} ${txHash} mined without a terminal event for this job and the chain does not show it settled — nothing recorded`);
    this.name = 'SettlementUnprovenError';
  }
}

/**
 * C3h D2: waits for the receipt of the evaluator transaction `txHash` this
 * worker sent and returns it only when it is THAT transaction's receipt and it
 * succeeded. viem's `waitForTransactionReceipt` follows a same-nonce
 * replacement (`checkReplacement`, on by default — viem 2.57.3) and resolves
 * with the replacing transaction's receipt: a 0-value cancel (no events),
 * another job's `complete` (that job's events), a speed-up. That receipt is
 * never interpreted: alerted (`evaluator-replaced`) and thrown as
 * `SettlementReplacedError` (the caller reconciles from `getJob` when the
 * chain is terminal). A nonce consumed, a hash confirmed or a transaction
 * replaced is not proof of this job's outcome. P3-6: when the replacement is
 * the recovery script's own SPEED_UP / CANCEL of this nonce, recorded in the
 * ledger (`recoveryReplacementOf`), the notice is informational
 * (`evaluator-replaced-by-recovery`, with its incident); the error and
 * everything after it are the same.
 */
async function awaitOwnReceipt(
  deps: Erc8183Deps,
  job: Pick<EscrowJobRow, 'id' | 'escrowChainId' | 'onChainJobId' | 'expiresAt'>,
  signer: EvaluatorSigner,
  txHash: Hex,
  action: SettlementAction,
): Promise<TransactionReceipt> {
  const receipt: EvaluatorReceipt = await signer.waitForTransactionReceipt(txHash);
  const minedHash = (receipt.transactionHash as Hex | undefined) ?? null;
  if (minedHash === null || minedHash.toLowerCase() !== txHash.toLowerCase()) {
    const recovery = minedHash === null ? null : await recoveryReplacementOf(deps, job.id, txHash, minedHash);
    if (recovery) {
      // P3-6: a known recovery operation (recorded before its send) — informational, with its incident.
      await raiseAlert(deps, {
        kind: 'evaluator-replaced-by-recovery',
        severity: 'info',
        jobId: job.id,
        chainId: job.escrowChainId,
        message:
          `Evaluator ${action} of job ${job.id} (on-chain job ${job.onChainJobId}) ${txHash} was replaced at nonce ${recovery.nonce} by the ` +
          `recovery script's ${recovery.kind === 'CANCEL' ? 'cancel' : 'speed-up'} ${minedHash}${receipt.replacedReason ? ` (${receipt.replacedReason})` : ''} — ` +
          `incident ${recovery.incidentId}, operator ${recovery.operator ?? '?'}, recorded in the ledger before its send: a known recovery ` +
          'operation, not an incident of its own. Nothing is recorded from the receipt this wait returned; the job keeps its state and the ' +
          'next attempt reads the job on-chain (reconciled if it is terminal, settled again by its recorded decision if it is still Submitted).',
        details: {
          action,
          txHash,
          replacedBy: minedHash,
          replacedReason: receipt.replacedReason ?? null,
          replacementStatus: receipt.status ?? null,
          onChainJobId: job.onChainJobId,
          expiresAt: job.expiresAt?.toISOString() ?? null,
          recovery,
        },
      });
      throw new SettlementReplacedError(action, txHash, minedHash);
    }
    await raiseAlert(deps, {
      kind: 'evaluator-replaced',
      jobId: job.id,
      chainId: job.escrowChainId,
      message:
        `Evaluator ${action} of job ${job.id} (on-chain job ${job.onChainJobId}) ${txHash} was replaced in its nonce by ` +
        `${minedHash ?? 'an unknown transaction'}${receipt.replacedReason ? ` (${receipt.replacedReason})` : ''} — a manual ` +
        'send with the evaluator key or a second settlement worker. Nothing is recorded from that receipt; the job keeps its ' +
        'state and the next attempt reads the job on-chain (reconciled if it is terminal, settled again by its recorded ' +
        'decision if it is still Submitted). Do not replace evaluator transactions while the worker runs.',
      details: {
        action,
        txHash,
        replacedBy: minedHash,
        replacedReason: receipt.replacedReason ?? null,
        replacementStatus: receipt.status ?? null,
        onChainJobId: job.onChainJobId,
        expiresAt: job.expiresAt?.toISOString() ?? null,
      },
    });
    throw new SettlementReplacedError(action, txHash, minedHash);
  }
  if (receipt.status !== 'success') throw new SettlementRevertedError(action, txHash);
  return receipt;
}

/**
 * P3-6: is the transaction that replaced `txHash` in its nonce the recovery script's own replacement?
 * Only a ledger row of the mined hash with origin SCRIPT, an incident, kind SPEED_UP / CANCEL, the SAME
 * nonce and evaluator key as the job's own candidate `txHash`. Anything else — no row, another origin,
 * no incident, another nonce or key, an unreadable ledger — is null: the caller keeps the incident alert.
 */
async function recoveryReplacementOf(
  deps: Erc8183Deps,
  jobId: string,
  txHash: Hex,
  minedHash: Hex,
): Promise<{ incidentId: string; operator: string | null; kind: 'SPEED_UP' | 'CANCEL'; candidateId: string; nonce: number } | null> {
  try {
    // A SCRIPT speed-up carries the job; a SCRIPT cancel carries the job of the candidate it replaces (§2.1).
    const rows = await ledgerOf(deps).candidatesForJob(jobId);
    const own = rows.find((c) => c.txHash.toLowerCase() === txHash.toLowerCase());
    const by = rows.find((c) => c.txHash.toLowerCase() === minedHash.toLowerCase());
    if (!own || !by || own.nonce === null) return null;
    if (by.origin !== 'SCRIPT' || !by.incidentId || (by.kind !== 'SPEED_UP' && by.kind !== 'CANCEL')) return null;
    if (by.nonce !== own.nonce || by.chainId !== own.chainId || by.evaluator.toLowerCase() !== own.evaluator.toLowerCase()) return null;
    return { incidentId: by.incidentId, operator: by.operator ?? null, kind: by.kind, candidateId: by.id, nonce: own.nonce };
  } catch (err) {
    deps.logger.warn({ jobId, txHash, minedHash, err: errorMessage(err) }, 'ERC-8183 replacement not matched against the ledger — alerted as unknown');
    return null;
  }
}

/**
 * C3h D2: the receipt in hand does not prove this job's outcome (a
 * replacement, or the job's own transaction without its terminal event). The
 * chain decides: terminal → mirrored by `reconcileTerminal` (`settledBy`: a
 * replacement whose receipt carries this job's terminal event is recorded as
 * the settling transaction); still open or unreadable → `err` is rethrown and
 * the job keeps its uncertain state (SETTLING, or its hold) for the retry.
 */
async function reconcileFromChainOrThrow(deps: Erc8183Deps, job: EscrowJobRow, err: Error, settledBy: Hex | null = null): Promise<SettlementResult> {
  const chain = await tryReadChainJob(deps, job);
  if (chain && chain.status >= CHAIN_JOB_STATUS.Completed) {
    try {
      const onChainStatus = await reconcileTerminal(deps, job, chain.status, { settledBy });
      return { outcome: 'reconciled', onChainStatus };
    } catch (awaiting) {
      // A1 review P2-3 (A3): terminal at latest, not yet at the proof tag — a no-op like the other A3 call
      // sites: no retry storm, no hand-back of a job the chain already settled, no "settlement-failed".
      if (awaiting instanceof SettlementAwaitingProofError) return { outcome: 'noop', reason: awaiting.message };
      throw awaiting;
    }
  }
  throw err;
}

/** C3h D2: the job's own transaction mined without this job's terminal event — reconciled from the chain, or alerted and retried. */
async function ownOutcomeUnproven(deps: Erc8183Deps, job: EscrowJobRow, action: SettlementAction, txHash: Hex): Promise<SettlementResult> {
  const err = new SettlementUnprovenError(action, txHash);
  try {
    return await reconcileFromChainOrThrow(deps, job, err);
  } catch (thrown) {
    if (thrown === err) {
      await raiseAlert(deps, {
        kind: 'settlement-unproven',
        jobId: job.id,
        chainId: job.escrowChainId,
        message:
          `Evaluator ${action} ${txHash} of job ${job.id} (on-chain job ${job.onChainJobId}) mined without a terminal event for ` +
          'this job and the chain does not show the job settled: nothing is recorded, the settlement is retried.',
        details: { action, txHash, onChainJobId: job.onChainJobId },
      });
    }
    throw thrown;
  }
}

export interface ParsedSettlementReceipt {
  completed: boolean;
  rejected: boolean;
  expired: boolean;
  refunded: boolean;
  paymentReleased: bigint | null;
  platformFee: bigint | null;
  /**
   * `written` (FeedbackWritten), `skipped:<reason>` (FeedbackSkipped — incl.
   * `not-verdict`, `payout-blocked`, `penalized`, `no-params`), `failed`
   * (FeedbackFailed) or `failed:penalized` (FeedbackFailed + AgentPenalized:
   * a verdict the registry did not record; the hook now withholds positive
   * entries for the id until the evaluator clears it). Null without a hook event.
   */
  feedbackStatus: string | null;
  /** C3d: the ERC-8004 agent id the hook rated (FeedbackWritten / AgentPenalized), as a decimal string. */
  ratedAgentId: string | null;
  /** C3d: `penalties[agentId]` after this settlement when AgentPenalized was emitted. */
  penalties: string | null;
}

export interface HookIdentityEvents {
  /** `CanonicalAgentIdSet.agentId`: the provider's first verified binding (decimal string). */
  canonicalAgentId: string | null;
  /** `AgentIdNotVerified.agentId`: the id the job carried was not confirmed by the Identity Registry. */
  notVerifiedAgentId: string | null;
}

/** C3d: decodes the hook's identity events of a provider `submit` receipt. */
export function parseHookIdentityEvents(logs: readonly Log[], hook: Address): HookIdentityEvents {
  const hookLower = hook.toLowerCase();
  const events = parseEventLogs({
    abi: REPUTATION_HOOK_ABI,
    logs: logs.filter((log) => log.address.toLowerCase() === hookLower) as Log[],
    strict: false,
  });
  const parsed: HookIdentityEvents = { canonicalAgentId: null, notVerifiedAgentId: null };
  for (const event of events) {
    if (event.eventName === 'CanonicalAgentIdSet' && event.args.agentId !== undefined) {
      parsed.canonicalAgentId = event.args.agentId.toString();
    } else if (event.eventName === 'AgentIdNotVerified' && event.args.agentId !== undefined) {
      parsed.notVerifiedAgentId = event.args.agentId.toString();
    }
  }
  return parsed;
}

/**
 * Decodes the escrow + hook events of a complete/reject/claimRefund receipt
 * that concern on-chain job `onChainJobId` ONLY (C3h D2): every escrow event
 * and every hook outcome event carries the job id, and a receipt can hold
 * another job's events — a same-nonce transaction of another job that viem's
 * receipt wait followed, or a batch. Events of other jobs are ignored, so a
 * receipt without this job's terminal event says "nothing settled THIS job".
 */
export function parseSettlementReceipt(logs: readonly Log[], escrow: Address, hook: Address | null, onChainJobId: bigint): ParsedSettlementReceipt {
  const escrowLower = escrow.toLowerCase();
  const ofThisJob = <T extends { args: unknown }>(event: T): boolean => (event.args as { jobId?: bigint }).jobId === onChainJobId;
  const escrowEvents = parseEventLogs({
    abi: AGENT_JOB_ESCROW_ABI,
    logs: logs.filter((log) => log.address.toLowerCase() === escrowLower) as Log[],
    strict: false,
  }).filter(ofThisJob);
  const hookLower = hook?.toLowerCase();
  const hookEvents = hookLower
    ? parseEventLogs({
        abi: REPUTATION_HOOK_ABI,
        logs: logs.filter((log) => log.address.toLowerCase() === hookLower) as Log[],
        strict: false,
      }).filter(ofThisJob)
    : [];

  const parsed: ParsedSettlementReceipt = {
    completed: false,
    rejected: false,
    expired: false,
    refunded: false,
    paymentReleased: null,
    platformFee: null,
    feedbackStatus: null,
    ratedAgentId: null,
    penalties: null,
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
  let penalized = false;
  for (const event of hookEvents) {
    switch (event.eventName) {
      case 'FeedbackWritten':
        parsed.feedbackStatus = 'written';
        if (event.args.agentId !== undefined) parsed.ratedAgentId = event.args.agentId.toString();
        break;
      case 'FeedbackSkipped': {
        const reason = event.args.reason ? hexToString(event.args.reason, { size: 32 }).replace(/\0+$/, '') : 'unknown';
        parsed.feedbackStatus = `skipped:${reason}`;
        break;
      }
      case 'FeedbackFailed':
        parsed.feedbackStatus = 'failed';
        break;
      case 'AgentPenalized':
        penalized = true;
        if (event.args.agentId !== undefined) parsed.ratedAgentId = event.args.agentId.toString();
        if (event.args.penalties !== undefined) parsed.penalties = event.args.penalties.toString();
        break;
      default:
        break;
    }
  }
  // A verdict the registry did not record: the hook penalized the id instead.
  if (penalized && parsed.feedbackStatus === 'failed') parsed.feedbackStatus = 'failed:penalized';
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

/**
 * C3f item 1: how long the evaluator key's lowest pending nonce may stay
 * unmined before the operator is told (the receipt wait is 180 s; a Base block
 * is 2 s — ten minutes without that nonce moving is a stuck key, not a busy one).
 */
export const EVALUATOR_STUCK_ALERT_AFTER_MS = 10 * 60_000;

export interface EvaluatorBacklog {
  chainId: number;
  evaluator: Address;
  /** The nonce every later evaluator transaction waits behind (`latest` transaction count). */
  stuckNonce: number;
  /** Evaluator transactions known to the node and not mined (`pending` − `latest`), the stuck one included. */
  queued: number;
  since: Date;
  /** A1: the live ledger candidate at `stuckNonce` (the head read from the table), when one is recorded. */
  stuckTxHash: Hex | null;
  jobId: string | null;
  /**
   * C3f review P3-1: the live escrow job of the chain that expires first (null:
   * none has an expiresAt, or it could not be read). After its expiresAt anyone
   * can claimRefund it — also a Submitted job, whose work was delivered.
   */
  earliestExpiry: { jobId: string; expiresAt: Date } | null;
  /** A1 R2-P2-5: the earliest expiresAt among the DELIVERED jobs waiting on the key (candidates in [latest, pending) or a settlement due and not signed). */
  earliestDeliveredExpiry: { jobId: string; expiresAt: Date } | null;
  /** A1 R2-P2-5: alerted at first sight because a delivered job is within T of expiresAt (vs the last block time). */
  early: boolean;
}

/**
 * C3f review P3-1: the live escrow job of `chainId` with the earliest
 * expiresAt (ties: lowest id), or null when none has one. Until then the funds
 * of the jobs blocked behind the key stay in the escrow; after it
 * `claimRefund` is permissionless and accepts a Submitted job
 * (AgentJobEscrow.sol), so anyone can refund the requester for work already
 * delivered — the date that sets the operator's urgency.
 */
async function earliestLiveExpiry(deps: Erc8183Deps, chainId: number): Promise<{ jobId: string; expiresAt: Date } | null> {
  const [first] = await deps.db.job.findMany({
    where: { escrowKind: ESCROW_KIND, escrowChainId: chainId, onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] }, expiresAt: { not: null } },
    select: { id: true, expiresAt: true },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: 1,
  });
  return first?.expiresAt instanceof Date ? { jobId: first.id, expiresAt: first.expiresAt } : null;
}

/**
 * A1 R2-P2-5 item 2: the earliest expiresAt among the delivered jobs that wait
 * on the evaluator key — those with a live candidate at a nonce ≥ `fromNonce`
 * (or without a nonce), plus the settlements due and not signed yet (deliverable
 * Submitted on-chain: SUBMITTED / SETTLING, or a CONTESTED / held job with a
 * recorded decision). Null when none (or unreadable: the caller then keeps
 * the 10-minute rule).
 */
async function earliestAffectedDeliveredExpiry(
  deps: Erc8183Deps,
  chainId: number,
  evaluator: Address,
  fromNonce: number,
): Promise<{ jobId: string; expiresAt: Date } | null> {
  try {
    const live = await ledgerOf(deps).liveCandidates(chainId, evaluator);
    const ids = [...new Set(live.filter((c) => c.jobId && (c.nonce === null || c.nonce >= fromNonce)).map((c) => c.jobId!))];
    const [first] = await deps.db.job.findMany({
      where: {
        escrowKind: ESCROW_KIND,
        escrowChainId: chainId,
        onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] },
        expiresAt: { not: null },
        OR: [
          ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
          { onChainStatus: { in: ['SUBMITTED', 'SETTLING'] } },
          { onChainStatus: 'CONTESTED', resolution: { not: null } },
        ],
      },
      select: { id: true, expiresAt: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 1,
    });
    return first?.expiresAt instanceof Date ? { jobId: first.id, expiresAt: first.expiresAt } : null;
  } catch (err) {
    deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 evaluator alert — the delivered jobs waiting on the key could not be read');
    return null;
  }
}

/** Timestamp of the latest block (R2-P3-5: deadlines are compared with the chain's clock); the process clock when unreadable. */
async function lastBlockTime(deps: Erc8183Deps, chainId: number): Promise<Date> {
  const client = deps.publicClient(chainId);
  try {
    if (client.getBlock) {
      const block = await client.getBlock({ blockTag: 'latest' });
      if (typeof block.timestamp === 'bigint') return new Date(Number(block.timestamp) * 1000);
    }
  } catch {
    // fall back to the process clock
  }
  return nowOf(deps);
}

function earlyAlertLeadMs(deps: Erc8183Deps): number {
  const seconds = a1Settings(deps).earlyAlertBeforeExpirySeconds ?? deps.config.reviewAlertBeforeExpirySeconds ?? DEFAULT_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS;
  return Math.max(0, seconds) * 1000;
}

/**
 * A1 R2-P1-3 item 3: an evaluator-key alert with its clock and its "already
 * told" mark PERSISTED (`EvaluatorChainState`): not again within `intervalMs`
 * of the last DELIVERED one, unless the condition restarted after it (`since`).
 * `recordAlertDelivered` runs only after `raiseAlert` reports the delivery, so
 * an alert that could not be delivered is tried again on the next tick.
 */
async function raiseEvaluatorKeyAlert(
  deps: Erc8183Deps,
  chainId: number,
  evaluator: Address,
  key: string,
  alert: EscrowAlert,
  opts: { intervalMs: number; since?: Date | null },
): Promise<boolean> {
  const ledger = ledgerOf(deps);
  const now = nowOf(deps);
  const state = await ledger.readChainState(chainId, evaluator);
  const last = state?.lastAlertAt[key];
  if (last && (!opts.since || last.getTime() >= opts.since.getTime()) && now.getTime() - last.getTime() < opts.intervalMs) return false;
  const delivered = await raiseAlert(deps, alert);
  if (delivered) await ledger.recordAlertDelivered(chainId, evaluator, key, now);
  return delivered;
}

/**
 * P3-9: how a reconciliation pass of the evaluator candidates reports.
 *
 * The settlement worker's pass (no options) delivers its alerts and owns their persisted clocks.
 * A DIAGNOSTIC pass — the recovery script's, run before and after its own operation, in its own process —
 * delivers no alert about a CONDITION its writes leave as it was (send-lost, rpc-node-unhealthy,
 * proof-stalled, proof-uncertain, a ledger conflict or deep reorg with nothing written): the worker's next
 * pass sees that condition again and alerts it on its own clock. Such alerts are handed, sanitized, to
 * `observe` (the script prints them) and NO alert clock is read or written for them. Alerts about a change
 * the pass itself WROTE (a latest-level outcome reorganised back to live, a nonce consumed outside the
 * ledger) are delivered and recorded as usual: the worker would never see them again. Review P3-1: of the
 * condition clocks a diagnostic pass only STARTS what is not running — the first sight of a lost head, the
 * first proof head, an `observed:` first sight — and adds its failed node reads to the count. It never clears
 * or moves them: a head not lost on its reads, a healthy read of a node, a proof head that advanced on its RPC
 * set are not written. Only the worker's pass resets them, so a dry-run can never postpone the worker's alert.
 */
export interface EvaluatorReconcileOptions {
  diagnostic?: { observe(note: EscrowAlert): void };
}

/** P3-9: a condition alert — delivered by the worker's pass (its clock), only observed by a diagnostic pass. */
async function raiseConditionAlert(
  deps: Erc8183Deps,
  pass: EvaluatorReconcileOptions,
  chainId: number,
  evaluator: Address,
  key: string,
  alert: EscrowAlert,
  opts: { intervalMs: number; since?: Date | null },
): Promise<boolean> {
  if (pass.diagnostic) {
    pass.diagnostic.observe(sanitizeAlert(alert));
    return false;
  }
  return raiseEvaluatorKeyAlert(deps, chainId, evaluator, key, alert, opts);
}

/**
 * C3f item 1 — visibility only, A1 edition. The evaluator signs with the
 * node's `pending` nonce, so one transaction that is never mined makes every
 * later evaluator transaction of the key queue behind it. Compares the key's
 * `latest` and `pending` transaction counts; the head transaction is read from
 * the candidate ledger (no `getTransaction` over the live jobs); the "since"
 * clock and the "already alerted" mark are persisted (`EvaluatorChainState`,
 * they survive a restart), and the mark is written only once the alert was
 * delivered. Alerted after EVALUATOR_STUCK_ALERT_AFTER_MS, or at FIRST SIGHT
 * when a delivered job waiting on the key is within T of its expiresAt (R2-P2-5,
 * T = `earlyAlertBeforeExpirySeconds`), then at most every
 * SETTLEMENT_FAILURE_ALERT_INTERVAL_MS. Nothing is replaced or cancelled here.
 */
export async function checkEvaluatorBacklog(deps: Erc8183Deps, chainId: number): Promise<EvaluatorBacklog | null> {
  const evaluator = deps.config.evaluatorAddress;
  const client = deps.publicClient(chainId);
  if (!evaluator || !client.getTransactionCount) return null;
  let latest: number;
  let pending: number;
  try {
    [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: evaluator, blockTag: 'latest' }),
      client.getTransactionCount({ address: evaluator, blockTag: 'pending' }),
    ]);
  } catch {
    return null;
  }
  const ledger = ledgerOf(deps);
  const nowDate = nowOf(deps);
  const now = nowDate.getTime();
  if (pending <= latest) {
    await ledger.observeHeadClock(chainId, evaluator, 'stuck', null, nowDate);
    return null;
  }
  const since = (await ledger.observeHeadClock(chainId, evaluator, 'stuck', latest, nowDate)) ?? nowDate;
  const lead = earlyAlertLeadMs(deps);
  const delivered = lead > 0 ? await earliestAffectedDeliveredExpiry(deps, chainId, evaluator, latest) : null;
  const early = delivered !== null && lead > 0 && delivered.expiresAt.getTime() - (await lastBlockTime(deps, chainId)).getTime() < lead;
  if (!early && now - since.getTime() < EVALUATOR_STUCK_ALERT_AFTER_MS) return null;
  const state = await ledger.readChainState(chainId, evaluator);
  const last = state?.lastAlertAt['evaluator-stuck'];
  if (last && last.getTime() >= since.getTime() && now - last.getTime() < SETTLEMENT_FAILURE_ALERT_INTERVAL_MS) return null;

  const head = (await ledger.candidatesAtNonce(chainId, evaluator, latest)).filter((c) => isLiveStatus(c.status));
  const stuck = head.find((c) => c.kind !== 'CANCEL') ?? head[0] ?? null;
  let expiry: { jobId: string; expiresAt: Date } | null | 'unreadable';
  try {
    expiry = await earliestLiveExpiry(deps, chainId);
  } catch (err) {
    deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 evaluator backlog alert — the earliest expiresAt of the live jobs could not be read');
    expiry = 'unreadable';
  }
  const earliest = expiry === 'unreadable' ? null : expiry;
  const backlog: EvaluatorBacklog = {
    chainId,
    evaluator,
    stuckNonce: latest,
    queued: pending - latest,
    since,
    stuckTxHash: (stuck?.txHash as Hex | undefined) ?? null,
    jobId: stuck?.jobId ?? null,
    earliestExpiry: earliest,
    earliestDeliveredExpiry: delivered,
    early,
  };
  // Review P3-1: "funds stay in the escrow" holds only until each job's expiresAt — never a made-up date.
  const deadline =
    expiry === 'unreadable'
      ? "the live jobs' expiresAt could not be read"
      : expiry === null
        ? 'no live escrow job on this chain has an expiresAt recorded'
        : `the earliest among the live escrow jobs on this chain is ${expiry.expiresAt.toISOString()} (job ${expiry.jobId}` +
          `${expiry.expiresAt.getTime() <= now ? ', already passed' : ''})`;
  const holder = stuck
    ? `${stuck.txHash}, ${stuck.jobId ? `the ${stuck.kind === 'CANCEL' ? 'cancel of a transaction' : 'settlement'} of job ${stuck.jobId}` : `a ${stuck.kind} transaction`}`
    : 'head transaction not recorded in the ledger — foreign or unknown';
  const delivered1 = await raiseAlert(deps, {
    kind: 'evaluator-stuck',
    chainId,
    ...(stuck?.jobId ? { jobId: stuck.jobId } : {}),
    message:
      `Evaluator ${evaluator} on chain ${chainId}: transaction nonce ${latest} (${holder}) ` +
      `has not been mined since ${since.toISOString()}; ${backlog.queued} evaluator transaction(s) wait behind it ` +
      '(settlements, cancellation refunds, expiry claims of every job on this chain). Funds stay in the escrow only until ' +
      `each job's expiresAt (${deadline}): after it anyone can call claimRefund and refund the requester's budget, also for ` +
      'work already delivered (a Submitted job), and the provider goes unpaid. ' +
      (early && delivered
        ? `Alerted at first sight: delivered job ${delivered.jobId} waiting on this key expires at ${delivered.expiresAt.toISOString()}. `
        : '') +
      'The backend does not replace or cancel the stuck transaction on its own: it is mined when the network fee falls back ' +
      'to its price, or the operator replaces that nonce (A1 recovery).',
    details: {
      evaluator,
      stuckNonce: latest,
      queued: backlog.queued,
      stuckTxHash: backlog.stuckTxHash,
      since: since.toISOString(),
      earliestExpiresAt: earliest?.expiresAt.toISOString() ?? null,
      earliestExpiringJobId: earliest?.jobId ?? null,
      earliestDeliveredExpiresAt: delivered?.expiresAt.toISOString() ?? null,
      earliestDeliveredJobId: delivered?.jobId ?? null,
      early,
    },
  });
  if (delivered1) await ledger.recordAlertDelivered(chainId, evaluator, 'evaluator-stuck', nowDate);
  return backlog;
}

/**
 * C3f item 1 + A1 §5.2: on the expiry-sweep cadence, for every chain with a
 * live escrow job or a live evaluator candidate: the candidate reconciliation
 * pass first, then the backlog check.
 */
async function checkEvaluatorBacklogs(deps: Erc8183Deps): Promise<void> {
  const chainIds = await evaluatorWorkChains(deps);
  if (chainIds === null) return;
  for (const chainId of chainIds) {
    try {
      await reconcileEvaluatorCandidates(deps, chainId);
    } catch (err) {
      deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 evaluator candidate reconciliation failed for a chain');
    }
    try {
      await checkEvaluatorBacklog(deps, chainId);
    } catch (err) {
      deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 evaluator backlog check failed for a chain');
    }
  }
}

/** Chains with a live escrow job or a live evaluator candidate; null (logged) when unreadable. */
async function evaluatorWorkChains(deps: Erc8183Deps): Promise<number[] | null> {
  try {
    const chains = await deps.db.job.findMany({
      where: { escrowKind: ESCROW_KIND, escrowChainId: { not: null }, onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] } },
      select: { escrowChainId: true },
      distinct: ['escrowChainId'],
    });
    let chainIds = (Array.isArray(chains) ? chains : []).map((c) => c.escrowChainId).filter((c): c is number => c !== null);
    const evaluator = deps.config.evaluatorAddress;
    if (evaluator) chainIds = [...new Set([...chainIds, ...(await ledgerOf(deps).chainsWithLiveCandidates(evaluator))])];
    return chainIds;
  } catch (err) {
    deps.logger.warn({ err: errorMessage(err) }, 'ERC-8183 evaluator checks skipped — live escrow chains could not be read');
    return null;
  }
}

/**
 * C3g-A1 §5.2: the candidate reconciliation pass of every chain with work, at
 * settlement-worker boot (`startEscrowSettlementWorker`). Never throws.
 */
export async function reconcileAllEvaluatorCandidates(deps: Erc8183Deps): Promise<EvaluatorCandidateReconcileSummary[]> {
  const out: EvaluatorCandidateReconcileSummary[] = [];
  const chainIds = await evaluatorWorkChains(deps);
  for (const chainId of chainIds ?? []) {
    try {
      out.push(await reconcileEvaluatorCandidates(deps, chainId));
    } catch (err) {
      deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 evaluator candidate reconciliation failed for a chain');
    }
  }
  return out;
}

/** Testing hook. A1: the backlog clock is persisted (`EvaluatorChainState`) — nothing in memory to reset any more. */
export function __resetEvaluatorBacklogForTests(): void {
  // kept for the existing suites; the state lives in the ledger tables (cleaned with them)
}

/**
 * Q7: an evaluator settlement refused because the on-chain configuration of
 * its chain is not verified in this process. Not a settlement failure: the
 * settlement worker reschedules the job after `retryAfterMs` without
 * consuming an attempt (`escrow-settlement.queue.ts`), nothing is alerted per
 * job (the verification runtime alerts once per chain and state change).
 */
export class EscrowConfigUnverifiedError extends Error {
  constructor(
    public readonly chainId: number,
    public readonly reason: string,
    public readonly retryAfterMs: number,
  ) {
    super(`ERC-8183 settlement deferred: ${reason}`);
    this.name = 'EscrowConfigUnverifiedError';
  }
}

/** Q7: throws `EscrowConfigUnverifiedError` unless the chain's configuration is verified now. */
function assertEscrowConfigVerified(deps: Erc8183Deps, chainId: number): void {
  const verdict = deps.configGate?.(chainId);
  if (!verdict || verdict.allowed) return;
  throw new EscrowConfigUnverifiedError(chainId, verdict.reason, verdict.retryAfterSeconds * 1000);
}

/**
 * A1 P17: the critical section (lane requested → candidate recorded) took
 * longer than allowed — nothing was recorded, nothing is broadcast. Retried.
 */
export class EvaluatorCriticalSectionError extends Error {
  constructor(
    readonly elapsedMs: number,
    readonly maxMs: number,
  ) {
    super(`Evaluator critical section took ${elapsedMs} ms (> ${maxMs} ms, plan P17): nothing recorded, nothing broadcast`);
    this.name = 'EvaluatorCriticalSectionError';
  }
}

function errorNamed(err: unknown, name: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { name?: string }).name === name) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * G1 review P3-1: does any RPC node know `hash` (pending or mined)? Every
 * candidate is asked (`deps.isKnownTransaction`); throws when none could be.
 * Without that dep (unit tests): the single read client — null when it has no
 * `getTransaction` (nothing can be told).
 */
async function isEvaluatorTxKnown(deps: Erc8183Deps, chainId: number, hash: Hex): Promise<boolean | null> {
  if (deps.isKnownTransaction) return deps.isKnownTransaction(chainId, hash);
  const client = deps.publicClient(chainId);
  if (!client.getTransaction) return null;
  try {
    await client.getTransaction({ hash });
    return true;
  } catch (err) {
    if (errorNamed(err, 'TransactionNotFoundError')) return false;
    throw err;
  }
}

/**
 * C3e item 1 + A1 §6.1 / §7.3 (replaces the in-memory `unconfirmedSends` of
 * C3f item 3): refuses (`SettlementStillPendingError`) a new evaluator
 * signature for the job while any of its ledger candidates may still mine —
 * read from the TABLE, so it holds across restarts and processes:
 *  - a candidate carrying the SAME calldata (re-signing the same decision):
 *    clear once its nonce is consumed at `latest` by consensus of every node;
 *  - any other candidate (another decision, a CANCEL): clear only at the proof
 *    depth (R2-P2-2);
 *  - a node in error or an answer missing: refused (retried later);
 *  - "not found" and elapsed time prove nothing: a SEND_UNCONFIRMED candidate
 *    stays live until its nonce is consumed.
 * A job without any candidate (pre-A1 row not yet backfilled) keeps today's
 * rule on `settleTxHash` (R2-P3-1): mined → allowed; unknown to every node →
 * allowed; pending / unreadable → refused. A LEGACY row without a nonce
 * follows the same rule (`legacyResignAllowed`).
 */
async function assertNoPendingSettlement(
  deps: Erc8183Deps,
  job: Pick<EscrowJobRow, 'id' | 'settleTxHash' | 'escrowChainId'>,
  calldataHash: string | null,
): Promise<void> {
  if (job.escrowChainId === null) return;
  const cands = await ledgerOf(deps).candidatesForJob(job.id);
  if (cands.length > 0) {
    const verdict = await jobCandidatesVerdict(deps, job.escrowChainId, cands, 'proof', calldataHash);
    if (verdict) throw new SettlementStillPendingError(verdict.txHash, verdict.state === 'uncertain' ? `cannot be told: ${verdict.reason}` : verdict.reason);
    return;
  }
  if (!job.settleTxHash) return;
  const hash = job.settleTxHash as Hex;
  const client = deps.publicClient(job.escrowChainId);
  try {
    await client.getTransactionReceipt({ hash });
    return;
  } catch (err) {
    if (!errorNamed(err, 'TransactionReceiptNotFoundError')) throw new SettlementStillPendingError(hash, 'its receipt could not be read');
  }
  let known: boolean | null;
  try {
    known = await isEvaluatorTxKnown(deps, job.escrowChainId, hash);
  } catch {
    throw new SettlementStillPendingError(hash, 'the RPC nodes cannot tell whether it is known (a node could not be asked)');
  }
  if (known) throw new SettlementStillPendingError(hash, 'no receipt yet and an RPC node still knows it');
}

/** The answer `sendEvaluatorTx` returns: the signer (for the receipt wait), the hash and its ledger row. */
interface EvaluatorSend {
  signer: EvaluatorSigner;
  txHash: Hex;
  candidateId: string;
}

/**
 * Every evaluator transaction goes through here (A1 §2.4, §7.1, R2-P2-3,
 * R2-P3-2/3):
 *  1. Q7 gate; the ledger gate (`assertNoPendingSettlement`); balance check;
 *  2. the evaluator LANE is acquired (`evaluatorLaneKey`, the same lane as any
 *     other sender of that key — the recovery script included) and held from
 *     the nonce choice to the send's answer, NEVER during the receipt wait;
 *  3. the signer simulates, prepares and picks the nonce
 *     `max(pending, highest live candidate + 1)` (never on top of a live one);
 *  4. in `onBeforeBroadcast(hash, tx)`: the Q7 gate again, the critical-section
 *     age (P17), then ONE database transaction inserts the SIGNED candidate
 *     (nonce, gas, fees, calldata, raw bytes, decision) AND writes the job's
 *     stamp conditionally (`settleTxHash` as read, SETTLING for a claim) —
 *     a lost conditional write rolls both back and nothing is sent; then
 *     `markBroadcast`;
 *  5. the signer asserts the lease IMMEDIATELY before the send.
 * The send's answer: accepted → SENT; an error → asked of every node
 * (`resolveFailedSend`): known → SENT; "not found" everywhere →
 * SEND_UNCONFIRMED (still live: nothing gives the slot back); uncertain →
 * stays SIGNED with the error. A `LeaseLostError` after the record means NOT
 * broadcast: the candidate stays SIGNED and live (identical rebroadcast by the
 * reconciliation pass, or the next transaction of the key consumes it).
 * The stamp (`settleAttemptAt`) is cleared after the answer: the ledger row is
 * the gate from then on.
 */
async function sendEvaluatorTx(
  deps: Erc8183Deps,
  job: Pick<EscrowJobRow, 'id' | 'escrowChainId' | 'settleTxHash'>,
  params: EvaluatorWriteParams,
  opts: { claimed?: boolean; intent: CandidateIntent },
): Promise<EvaluatorSend> {
  const chainId = job.escrowChainId!;
  assertEscrowConfigVerified(deps, chainId);
  const calldata = encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args as never });
  await assertNoPendingSettlement(deps, job, keccak256(calldata).toLowerCase());
  await checkEvaluatorBalance(deps, chainId);
  const signer = deps.evaluatorSigner(chainId);
  const ledger = ledgerOf(deps);
  const settings = a1Settings(deps);
  const previous = (job.settleTxHash as Hex | null) ?? null;
  // Assigned by the broadcast hook (a closure): typed so the checks below are not narrowed away.
  let recorded = null as { id: string; hash: Hex } | null;
  const lanes = (deps.evaluatorLanes ?? deps.lanes) as Partial<LeaseLock> | undefined;
  // A1 review P3-4: never sign or send an evaluator transaction outside the evaluator lane (fail closed).
  if (!lanes || typeof lanes.acquire !== 'function') {
    throw new Error('ERC-8183 evaluator send refused: no evaluator lane lock (LeaseLock) is wired — nothing is signed or sent without the lane');
  }
  const lease: LaneLease = await lanes.acquire(evaluatorLaneKey(chainId, signer.address));
  // A1 review P3-2: the critical section (P17) is measured from the moment the lane was OBTAINED, not from
  // the start of the wait (the lease's own deadline is still taken before its SET: `assertHeld` stays strict).
  const leaseObtainedAt = Date.now();
  let sendError: unknown = null;
  let sent = false;
  try {
    await signer.writeContract(params, {
      lease,
      minLeaseMs: settings.leaseMinRemainingMs,
      // R2-P2-3: never sign on top of a live candidate's nonce (a lagging `pending`).
      chooseNonce: async (pending: number) => chooseNonce(pending, await ledger.liveNonces(chainId, signer.address)),
      onBeforeBroadcast: async (signedTxHash: Hex, tx?: PreparedEvaluatorTx) => {
        // #182 review: the Q7 gate checked above may have closed while the
        // signer simulated, estimated and signed: asked again before the
        // record, so a refusal leaves nothing recorded and nothing sent.
        assertEscrowConfigVerified(deps, chainId);
        const elapsed = Date.now() - leaseObtainedAt;
        if (elapsed > settings.criticalSectionMaxMs) throw new EvaluatorCriticalSectionError(elapsed, settings.criticalSectionMaxMs);
        if (!tx) throw new Error('evaluator signer did not hand over the signed transaction — nothing may be broadcast without its ledger row');
        const { id } = await ledger.insertCandidateWithJobStamp({
          candidate: {
            chainId,
            evaluator: signer.address,
            nonce: tx.nonce,
            jobId: job.id,
            kind: 'ORIGINAL',
            action: opts.intent.action,
            decision: opts.intent.decision,
            reasonHex: opts.intent.reasonHex,
            toAddress: tx.to,
            valueWei: tx.value,
            calldata: tx.data,
            gasLimit: tx.gas,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            txHash: signedTxHash,
            rawTx: tx.raw,
            origin: 'WORKER',
          },
          job: {
            id: job.id,
            expectedSettleTxHash: previous,
            setSettleTxHash: true,
            stampAttempt: true,
            ...(opts.claimed ? { expectedOnChainStatus: 'SETTLING' } : {}),
          },
        });
        recorded = { id, hash: signedTxHash.toLowerCase() as Hex };
        await ledger.markBroadcast(id);
      },
    });
    sent = true;
  } catch (err) {
    sendError = err;
  } finally {
    // The lane covers the nonce choice up to the send's answer — never the receipt wait.
    await lease.release();
  }
  if (sendError !== null || !sent) {
    if (recorded !== null) await resolveFailedSend(deps, { jobId: job.id, chainId, hash: recorded.hash, candidateId: recorded.id, err: sendError });
    throw sendError;
  }
  if (recorded === null) {
    // A signer that broadcast without calling the hook (never the A1 signer): fail loudly.
    throw new Error(`ERC-8183 evaluator signer broadcast job ${job.id}'s transaction without recording its ledger candidate first`);
  }
  const rec = recorded as { id: string; hash: Hex };
  try {
    await ledger.markAnswered(rec.id, 'SENT');
    await deps.db.job.updateMany({ where: { id: job.id, settleTxHash: rec.hash }, data: { settleAttemptAt: null } });
  } catch (err) {
    // The candidate was recorded before the send: a lost answer write only keeps the gates refusing until the pass resolves it.
    deps.logger.warn({ jobId: job.id, txHash: rec.hash, err: errorMessage(err) }, 'ERC-8183 evaluator send answer not recorded — the ledger candidate stands');
  }
  return { signer, txHash: rec.hash, candidateId: rec.id };
}

/**
 * A1 §2.4-3 (replaces the P3-2 give-back): the send of a recorded candidate
 * threw. Nothing is given back — the candidate stays live until a chain proof:
 *  - `LeaseLostError`: the signer refused to broadcast (lease lost / margin):
 *    NOT sent; stays SIGNED (rebroadcast by the reconciliation pass);
 *  - otherwise every node is asked about the hash: known → SENT;
 *    "not found" everywhere → SEND_UNCONFIRMED; a node could not be asked →
 *    stays SIGNED with the error.
 * The job's stamp is cleared: from now on the ledger row is the gate.
 */
async function resolveFailedSend(
  deps: Erc8183Deps,
  failure: { jobId: string; chainId: number; hash: Hex; candidateId: string; err: unknown },
): Promise<void> {
  const { jobId, chainId, hash, candidateId } = failure;
  const ledger = ledgerOf(deps);
  try {
    if (errorNamed(failure.err, 'LeaseLostError')) {
      await ledger.markAnswered(candidateId, 'UNCERTAIN', `not broadcast: ${publicErrorMessage(failure.err)}`);
      deps.logger.warn(
        { jobId, txHash: hash, err: publicErrorMessage(failure.err) },
        'ERC-8183 evaluator lane lost before the broadcast — recorded candidate NOT sent; it stays live (identical rebroadcast or the next transaction of the key settles its nonce)',
      );
    } else {
      let known: boolean | null;
      try {
        known = await isEvaluatorTxKnown(deps, chainId, hash);
      } catch {
        known = null;
      }
      const outcome = known === true ? 'SENT' : known === false ? 'SEND_UNCONFIRMED' : 'UNCERTAIN';
      await ledger.markAnswered(candidateId, outcome, publicErrorMessage(failure.err));
      deps.logger.warn(
        { jobId, txHash: hash, outcome, err: publicErrorMessage(failure.err) },
        known === true
          ? 'ERC-8183 evaluator send reported an error but a node knows the transaction — in flight (SENT)'
          : known === false
            ? 'ERC-8183 evaluator send failed and no RPC node knows the transaction — SEND_UNCONFIRMED: still live until its nonce is proven consumed'
            : 'ERC-8183 evaluator send failed and the RPC nodes cannot tell whether it left — candidate stays SIGNED (may still mine)',
      );
    }
    await deps.db.job.updateMany({ where: { id: jobId, settleTxHash: hash }, data: { settleAttemptAt: null } });
  } catch (dbErr) {
    deps.logger.error({ jobId, txHash: hash, err: errorMessage(dbErr) }, 'ERC-8183 evaluator send failed and its record could not be updated — the candidate stands as recorded');
  }
}

/** Best effort: our own receipt with this job's event marks the candidate MINED at `latest` (the pass proves it deeper). */
async function markOwnMined(deps: Erc8183Deps, candidateId: string, receipt: TransactionReceipt): Promise<void> {
  try {
    const blockHash = (receipt.blockHash as string | undefined)?.toLowerCase();
    if (!blockHash || !/^0x[0-9a-f]{64}$/.test(blockHash) || receipt.blockNumber === undefined || receipt.blockNumber === null) return;
    await ledgerOf(deps).markResolved(candidateId, receipt.status === 'success' ? 'MINED_SUCCESS' : 'MINED_REVERTED', {
      level: 'latest',
      blockNumber: BigInt(receipt.blockNumber),
      blockHash,
    });
  } catch (err) {
    deps.logger.warn({ candidateId, err: errorMessage(err) }, 'ERC-8183 evaluator candidate not marked mined — the reconciliation pass will');
  }
}

// ── C3g-A1 §5.2: the candidate reconciliation pass ─────────────────────────

export interface EvaluatorCandidateReconcileSummary {
  chainId: number;
  nonces: number;
  resolved: number;
  dead: number;
  reorged: number;
  foreign: number;
  uncertain: number;
  rebroadcast: number;
  backfilled: number;
  enqueued: number;
}

/** Map a decision recorded on a candidate back to the job's idempotent settlement action. */
function actionOfCandidate(c: Pick<LedgerCandidate, 'action' | 'decision'>, job: { resolution: string | null }): EscrowSettlementJobData['action'] | { action: 'reject'; reason: CancellationReason } {
  if (c.action === 'CLAIM_REFUND') return 'claimRefund';
  if (c.decision === 'cancelled' || c.decision === 'provider-failed') return { action: 'reject', reason: c.decision };
  return job.resolution ? 'resolve' : 'settle';
}

/** Enqueues the job's own idempotent action so the existing path reconciles it (it reads `getJob` first). */
async function enqueueCandidateJob(deps: Erc8183Deps, jobId: string): Promise<boolean> {
  try {
    const job = await deps.db.job.findUnique({ where: { id: jobId }, select: { onChainStatus: true, resolution: true, escrowKind: true } });
    if (!job || job.escrowKind !== ESCROW_KIND || (FINAL_ON_CHAIN_STATUSES as readonly string[]).includes(job.onChainStatus ?? '')) return false;
    const cands = await ledgerOf(deps).candidatesForJob(jobId);
    const last = [...cands].reverse().find((c) => c.kind !== 'CANCEL' && c.kind !== 'EXTERNAL');
    const mapped = last ? actionOfCandidate(last, job) : job.resolution ? 'resolve' : 'settle';
    if (typeof mapped === 'string') await deps.settlement.add({ jobId, action: mapped });
    else await deps.settlement.add({ jobId, action: mapped.action, reason: mapped.reason });
    return true;
  } catch (err) {
    deps.logger.warn({ jobId, err: errorMessage(err) }, 'ERC-8183 evaluator candidate reconciled but its job could not be enqueued — the recovery tick will');
    return false;
  }
}

/** `simulateContract`-equivalent of a recorded candidate (same calldata, from the evaluator): `eth_call` on the read client. */
async function simulateCandidate(deps: Erc8183Deps, chainId: number, evaluator: Address, c: LedgerCandidate): Promise<boolean> {
  const client = deps.publicClient(chainId);
  if (!client.call || !c.toAddress || c.calldata === null) return false;
  try {
    await client.call({ account: evaluator, to: getAddress(c.toAddress), data: c.calldata as Hex, value: c.valueWei } as never);
    return true;
  } catch {
    return false;
  }
}

function consensusLatest(views: readonly NodeView[]): number | null {
  if (views.length === 0 || views.some((v) => !v.ok || v.nonceLatest === undefined)) return null;
  const n = views[0]!.nonceLatest!;
  return views.every((v) => v.nonceLatest === n) ? n : null;
}

/** Every node answered "not found" for the hash (not known, no receipt). Null when a node could not be read. */
function unknownEverywhere(views: readonly NodeView[], hash: string): boolean | null {
  if (views.length === 0 || views.some((v) => !v.ok)) return null;
  const h = hash.toLowerCase();
  for (const v of views) {
    const k = v.known?.[h];
    const r = v.receipts?.[h];
    if (k === undefined || r === undefined) return null;
    if (k || r !== null) return false;
  }
  return true;
}

/**
 * §4.3: the transaction of the evaluator key that consumed `nonce` without a
 * ledger row — binary search of the block where the key's nonce went from
 * `nonce` to `nonce + 1`, then that block's transaction from the key. Best
 * effort (null when the client cannot search).
 */
async function locateForeignTransaction(
  deps: Erc8183Deps,
  chainId: number,
  evaluator: Address,
  nonce: number,
): Promise<{ hash: Hex; to: Address | null; input: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex } | null> {
  const client = deps.publicClient(chainId) as EscrowPublicClient & {
    getBlock?: (args: { blockNumber: bigint; includeTransactions: true }) => Promise<{ transactions: Array<{ hash: Hex; from: Address; nonce: number; to: Address | null; input: Hex; value: bigint; gas: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }> }>;
  };
  if (!client.getBlockNumber || !client.getTransactionCount || !client.getBlock) return null;
  try {
    // D-C: never viem's per-client cached block number (cacheTime ≈ pollingInterval): a head read before the
    // foreign transaction's block would make the search give up on the pass right after it.
    const head = await client.getBlockNumber({ cacheTime: 0 });
    let lo = head > REFUND_LOOKUP_BLOCKS ? head - REFUND_LOOKUP_BLOCKS : 0n;
    let hi = head;
    const countAt = (b: bigint) => client.getTransactionCount!({ address: evaluator, blockNumber: b } as never);
    if ((await countAt(hi)) <= nonce || (await countAt(lo)) > nonce) return null;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await countAt(mid)) > nonce) hi = mid;
      else lo = mid;
    }
    const block = await client.getBlock({ blockNumber: hi, includeTransactions: true });
    const tx = block.transactions.find((t) => t.from.toLowerCase() === evaluator.toLowerCase() && Number(t.nonce) === nonce);
    if (!tx) return null;
    const receipt = await client.getTransactionReceipt({ hash: tx.hash });
    return {
      hash: tx.hash,
      to: tx.to,
      input: tx.input,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas ?? tx.gasPrice ?? 0n,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    };
  } catch {
    return null;
  }
}

/** R2-P3-10 / R2-P2-2 item 4: node health and the proof-tag head, persisted; alerted once over their thresholds. */
async function watchNodesAndProofHead(deps: Erc8183Deps, chainId: number, evaluator: Address, reads: readonly EvaluatorNodeRead[], pass: EvaluatorReconcileOptions): Promise<void> {
  const ledger = ledgerOf(deps);
  const settings = a1Settings(deps);
  const now = nowOf(deps);
  const threshold = settings.rpcUnhealthyAfterFailures ?? 5;
  for (const r of reads) {
    if (r.node.startsWith('#? ')) continue;
    try {
      // Review P3-1: a diagnostic pass never resets the worker's failure count (a healthy read on the script's
      // side is not recorded); its failed reads only move the count toward the threshold.
      if (pass.diagnostic && r.ok) continue;
      const failures = await ledger.recordNodeRead(chainId, evaluator, r.node, r.ok, now);
      if (!r.ok && failures >= threshold) {
        await raiseConditionAlert(deps, pass, chainId, evaluator, `rpc-node-unhealthy:${r.node}`, {
          kind: 'rpc-node-unhealthy',
          chainId,
          message:
            `RPC node ${r.node} of chain ${chainId} failed ${failures} consecutive evaluator reads (${r.error ?? 'error'}). ` +
            'Every A1 proof ("nonce consumed", "not found") needs EVERY node to answer: until it recovers, contests, resolves and ' +
            'new decisions of jobs with an evaluator transaction in flight are refused as unverifiable. Fix the node or remove it ' +
            'from the configured RPC candidates (RPC_URL_<chainId> / provider keys).',
          details: { node: r.node, failures, error: r.error ?? null },
        }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS });
      }
    } catch (err) {
      deps.logger.warn({ chainId, node: r.node, err: errorMessage(err) }, 'ERC-8183 evaluator node health not recorded');
    }
  }
  // Watched whenever the proof tag can stall (safe / finalized): an explicit threshold, else the stuck threshold;
  // an explicit null turns it off.
  const stallable = deps.proofTag === 'safe' || deps.proofTag === 'finalized';
  const stalledAfter =
    settings.proofStalledAlertAfterMs !== undefined ? settings.proofStalledAlertAfterMs : stallable ? EVALUATOR_STUCK_ALERT_AFTER_MS : null;
  if (!stalledAfter || reads.length === 0 || reads.some((r) => !r.ok || r.proofBlockNumber === undefined)) return;
  const block = reads.reduce((min, r) => (r.proofBlockNumber! < min ? r.proofBlockNumber! : min), reads[0]!.proofBlockNumber!);
  try {
    // Review P3-1: a diagnostic pass records the proof head only at FIRST sight (it starts the clock); an advance seen
    // on the script's side never moves the worker's `safeHeadSeenAt` (that would postpone evaluator-proof-stalled).
    let head: { advanced: boolean; seenAt: Date };
    const stored = pass.diagnostic ? await ledger.readChainState(chainId, evaluator) : null;
    if (pass.diagnostic && stored?.safeHeadBlock != null && stored.safeHeadSeenAt) {
      head = { advanced: block > BigInt(stored.safeHeadBlock), seenAt: stored.safeHeadSeenAt };
    } else {
      head = await ledger.observeSafeHead(chainId, evaluator, block, now);
    }
    if (!head.advanced && now.getTime() - head.seenAt.getTime() >= stalledAfter) {
      await raiseConditionAlert(deps, pass, chainId, evaluator, 'evaluator-proof-stalled', {
        kind: 'evaluator-proof-stalled',
        chainId,
        message:
          `The proof-tag head of chain ${chainId} has not advanced past block ${block} since ${head.seenAt.toISOString()}. ` +
          'Evaluator outcomes cannot be proven at the configured depth: contests, resolves with another decision, backend ' +
          'claimRefund / cancellation rejects of jobs with an evaluator transaction are refused (fail closed). Re-signing the ' +
          'same decision is not affected. Moving to `latest − K` is an owner decision (D-g).',
        details: { proofBlock: block.toString(), since: head.seenAt.toISOString() },
      }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS, since: head.seenAt });
    }
  } catch (err) {
    deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 evaluator proof head not recorded');
  }
}

/** §10-2: one idempotent LEGACY / BACKFILL row per in-flight job whose `settleTxHash` predates the ledger. */
async function backfillLegacyInFlight(deps: Erc8183Deps, chainId: number, evaluator: Address): Promise<number> {
  const jobs = await deps.db.job.findMany({
    where: {
      escrowKind: ESCROW_KIND,
      escrowChainId: chainId,
      settleTxHash: { not: null },
      onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] },
      evaluatorTransactions: { none: {} },
    },
    select: { id: true, settleTxHash: true, resolution: true, status: true },
    take: 100,
  });
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const client = deps.publicClient(chainId);
  const ledger = ledgerOf(deps);
  let inserted = 0;
  for (const job of jobs) {
    const hash = job.settleTxHash as Hex;
    let tx: Awaited<ReturnType<NonNullable<EscrowPublicClient['getTransaction']>>> | null = null;
    try {
      if (!client.getTransaction) continue;
      tx = await client.getTransaction({ hash });
    } catch (err) {
      if (!errorNamed(err, 'TransactionNotFoundError')) continue; // unreadable: next tick
      tx = null;
    }
    let action: CandidateIntent['action'] = 'UNKNOWN';
    const input = (tx?.input ?? null) as Hex | null;
    if (input && input.length >= 10) {
      try {
        const name = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: input }).functionName;
        action = name === 'complete' ? 'COMPLETE' : name === 'reject' ? 'REJECT' : name === 'claimRefund' ? 'CLAIM_REFUND' : 'UNKNOWN';
      } catch {
        action = 'UNKNOWN';
      }
    }
    try {
      const res = await ledger.backfillLegacyCandidate({
        chainId,
        evaluator,
        jobId: job.id,
        txHash: hash,
        action,
        decision: job.resolution ?? (job.status === 'PAYMENT_PENDING' ? 'pay' : null),
        tx:
          tx && tx.to
            ? {
                nonce: Number(tx.nonce),
                toAddress: tx.to,
                calldata: tx.input,
                gasLimit: tx.gas,
                maxFeePerGas: (tx as { maxFeePerGas?: bigint }).maxFeePerGas ?? (tx as { gasPrice?: bigint }).gasPrice ?? 0n,
                maxPriorityFeePerGas: (tx as { maxPriorityFeePerGas?: bigint }).maxPriorityFeePerGas ?? (tx as { gasPrice?: bigint }).gasPrice ?? 0n,
                valueWei: tx.value ?? 0n,
              }
            : null,
      });
      if (res.inserted) inserted++;
    } catch (err) {
      deps.logger.warn({ jobId: job.id, txHash: hash, err: errorMessage(err) }, 'ERC-8183 legacy settlement not backfilled into the candidate ledger');
    }
  }
  return inserted;
}

/**
 * C3g-A1 §5.2 — the candidate reconciliation pass of one chain (worker boot,
 * every expiry-sweep tick next to the backlog check, the start of the
 * recovery script). Idempotent; writes only with a chain proof:
 *  1. backfill of in-flight legacy jobs (§10-2);
 *  2. ONE per-node read (every RPC node) of the evaluator key and of every
 *     candidate still to watch (live, or proven only at `latest`);
 *  3. per nonce, `resolveNonceDecision`:
 *     - winner → MINED_* (+ the others DEAD) at the level proven; the job's
 *       `settleTxHash` moves to the winner (conditional write); the job's
 *       idempotent action is enqueued so the existing path reconciles it
 *       (`getJob` → `reconcileTerminal`, fee / feedback from the WINNER's
 *       receipt filtered by the job id);
 *     - consumed by a transaction outside the ledger → its candidates DEAD;
 *       the foreign transaction located (binary search) and recorded as
 *       EXTERNAL; `evaluator-nonce-foreign`; their jobs enqueued;
 *     - reorg → back to live (`evaluator-reorg`);
 *     - uncertain → nothing written (alerted on MULTIPLE_RECEIPTS / a reorg
 *       beyond the proof depth);
 *  4. the identical rebroadcast of a lost head (R2-P1-3, inside the lane, at
 *     most once per pass per candidate) and `evaluator-send-lost`;
 *  5. stamps (`settleAttemptAt`) of recorded candidates are cleared — the
 *     ledger row is the gate (§7.3).
 * Node health (`rpc-node-unhealthy`) and the proof head
 * (`evaluator-proof-stalled`) are tracked from the same read.
 * P3-9: `pass.diagnostic` (the recovery script) hands the condition alerts
 * to `observe` instead of delivering them — see `EvaluatorReconcileOptions`.
 */
export async function reconcileEvaluatorCandidates(
  deps: Erc8183Deps,
  chainId: number,
  pass: EvaluatorReconcileOptions = {},
): Promise<EvaluatorCandidateReconcileSummary> {
  const summary: EvaluatorCandidateReconcileSummary = { chainId, nonces: 0, resolved: 0, dead: 0, reorged: 0, foreign: 0, uncertain: 0, rebroadcast: 0, backfilled: 0, enqueued: 0 };
  const evaluator = deps.config.evaluatorAddress;
  if (!evaluator) return summary;
  const ledger = ledgerOf(deps);
  try {
    summary.backfilled = await backfillLegacyInFlight(deps, chainId, evaluator);
  } catch (err) {
    deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 legacy settlement backfill skipped this tick');
  }

  const nonces = await ledger.noncesToReconcile(chainId, evaluator);
  const legacy = await ledger.liveLegacyWithoutNonce(chainId, evaluator);
  summary.nonces = nonces.length;
  const rowsByNonce = new Map<number, LedgerCandidate[]>();
  for (const n of nonces) rowsByNonce.set(n, await ledger.candidatesAtNonce(chainId, evaluator, n));
  const hashes = [...[...rowsByNonce.values()].flat().map((c) => c.txHash), ...legacy.map((c) => c.txHash)];
  if (hashes.length === 0) {
    // Review P3-1: only the worker's pass clears the send-lost clock.
    if (!pass.diagnostic) await ledger.observeHeadClock(chainId, evaluator, 'sendLost', null, nowOf(deps));
    return summary;
  }
  const reads = await readEvaluatorNodes(deps, chainId, evaluator, hashes);
  await watchNodesAndProofHead(deps, chainId, evaluator, reads, pass);
  const views = toNodeViews(reads);
  const touchedJobs = new Set<string>();

  for (const nonce of nonces) {
    const rows = rowsByNonce.get(nonce) ?? [];
    const res = resolveNonceDecision(rows, views, nonce);
    switch (res.kind) {
      case 'winner': {
        const winner = rows.find((c) => c.id === res.winnerId)!;
        // A1 review P2-1 (b): a row marked DEAD at `latest` whose own receipt is now seen by consensus was
        // killed by a read that straddled a block (or a lagging node): corrected like a reorg — back to live,
        // then resolved as mined below. A row DEAD at `proof` stays immutable (alerted, nothing written).
        let corrected = false;
        if (winner.status === 'DEAD') {
          if (winner.proofLevel !== 'latest' || !(await ledger.revertForReorg(winner.id))) {
            summary.uncertain++;
            await raiseConditionAlert(deps, pass, chainId, evaluator, `evaluator-ledger-conflict:${nonce}:dead-with-receipt`, {
              kind: 'evaluator-ledger-conflict',
              chainId,
              message:
                `Evaluator nonce ${nonce} on chain ${chainId}: candidate ${winner.txHash} is recorded DEAD at the proof depth but every node ` +
                'returns its receipt — nothing is written; operator check required.',
              details: { nonce, txHash: winner.txHash, jobId: winner.jobId },
            }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS });
            break;
          }
          corrected = true;
          deps.logger.warn({ chainId, nonce, txHash: winner.txHash, jobId: winner.jobId }, 'ERC-8183 evaluator candidate recorded DEAD at latest has its receipt now — corrected to mined');
        }
        const moved = await ledger.markResolved(winner.id, res.receipt.status === 'success' ? 'MINED_SUCCESS' : 'MINED_REVERTED', {
          level: res.proofLevel,
          blockNumber: res.receipt.blockNumber,
          blockHash: res.receipt.blockHash,
        });
        const wasLive = isLiveStatus(winner.status) || corrected;
        // A3: an outcome reaching the proof depth (from live, or upgraded from `latest`) lets its job be finalized.
        const nowProven = moved && res.proofLevel === 'proof' && winner.proofLevel !== 'proof';
        if (moved && wasLive) summary.resolved++;
        for (const id of res.losers) {
          const loser = rows.find((c) => c.id === id)!;
          if (!isLiveStatus(loser.status) && !(loser.status === 'DEAD' && loser.proofLevel === 'latest')) continue;
          if ((await ledger.markResolved(id, 'DEAD', { level: res.proofLevel })) && isLiveStatus(loser.status)) {
            summary.dead++;
            if (loser.jobId && loser.jobId !== winner.jobId) touchedJobs.add(loser.jobId);
          }
        }
        if (winner.jobId && winner.kind !== 'CANCEL' && winner.kind !== 'EXTERNAL') {
          await moveSettleTxHashToWinner(deps, winner.jobId, winner.txHash);
          if ((wasLive || nowProven) && res.receipt.status === 'success') touchedJobs.add(winner.jobId);
        }
        if (winner.kind === 'CANCEL' && wasLive) for (const r of rows) if (r.jobId) touchedJobs.add(r.jobId);
        break;
      }
      case 'consumed-foreign': {
        for (const id of res.ids) {
          const row = rows.find((c) => c.id === id)!;
          if ((await ledger.markResolved(id, 'DEAD', { level: res.proofLevel })) && isLiveStatus(row.status)) {
            summary.dead++;
            if (row.jobId) touchedJobs.add(row.jobId);
          }
        }
        summary.foreign++;
        await recordForeignNonce(deps, chainId, evaluator, nonce, rows, res.proofLevel);
        break;
      }
      case 'reorg': {
        for (const id of res.ids) if (await ledger.revertForReorg(id)) summary.reorged++;
        await raiseEvaluatorKeyAlert(deps, chainId, evaluator, `evaluator-reorg:${nonce}`, {
          kind: 'evaluator-reorg',
          chainId,
          message:
            `Evaluator nonce ${nonce} on chain ${chainId}: an outcome proven only at \`latest\` was reorganised away — its ` +
            `candidate(s) are live again (${res.ids.length}) and every proof-depth gate of their jobs refuses until the chain ` +
            'settles it again. A job the DB already mirrored as terminal from that block needs an operator check.',
          details: { nonce, candidates: rows.filter((c) => res.ids.includes(c.id)).map((c) => ({ txHash: c.txHash, jobId: c.jobId })) },
        }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS });
        break;
      }
      case 'uncertain': {
        summary.uncertain++;
        if (res.reason === 'KNOWN_WITHOUT_RECEIPT') await watchKnownWithoutReceipt(deps, chainId, evaluator, nonce, res.detail ?? null, views, pass);
        if (res.reason === 'MULTIPLE_RECEIPTS' || res.reason === 'PROOF_LEVEL_REORG') {
          await raiseConditionAlert(deps, pass, chainId, evaluator, `evaluator-ledger-conflict:${nonce}:${res.reason}`, {
            kind: res.reason === 'PROOF_LEVEL_REORG' ? 'evaluator-reorg' : 'evaluator-ledger-conflict',
            chainId,
            message:
              res.reason === 'PROOF_LEVEL_REORG'
                ? `Evaluator nonce ${nonce} on chain ${chainId}: an outcome proven at the proof depth lost its block (${res.detail ?? ''}) — ` +
                  'a reorg deeper than the configured proof tag. Nothing is written; operator check required.'
                : `Evaluator nonce ${nonce} on chain ${chainId}: more than one recorded candidate has a receipt (${res.detail ?? ''}) — ` +
                  'impossible for one key and nonce (a data or node error). Nothing is written; operator check required.',
            details: { nonce, reason: res.reason, detail: res.detail ?? null },
          }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS });
        }
        break;
      }
      case 'alive':
        break;
    }
  }

  await resolveLegacyRows(deps, legacy, views);
  summary.rebroadcast = await rebroadcastLostHead(deps, chainId, evaluator, views, pass);
  await clearRecordedStamps(deps, chainId);
  for (const jobId of touchedJobs) if (await enqueueCandidateJob(deps, jobId)) summary.enqueued++;
  return summary;
}

/**
 * Rechecagem R-P3-b: a nonce consumed with no receipt while a node KNOWS our candidate is "uncertain" (a read
 * straddling a block). Normally the next pass sees the receipt; when it persists — a node keeps serving a
 * stale view, or keeps "knowing" a transaction the others do not have — the operator is told
 * (`evaluator-proof-uncertain`) once past the send-lost / stuck threshold, with the nonce, the hash and the
 * nodes that disagree. The first sight is persisted in `EvaluatorChainState.lastAlertAt` under an
 * `observed:` key (written once), so the clock survives restarts; the alert itself is marked delivered only
 * after `raiseAlert` delivered it.
 */
async function watchKnownWithoutReceipt(
  deps: Erc8183Deps,
  chainId: number,
  evaluator: Address,
  nonce: number,
  txHash: string | null,
  views: readonly NodeView[],
  pass: EvaluatorReconcileOptions,
): Promise<void> {
  try {
    const ledger = ledgerOf(deps);
    const now = nowOf(deps);
    const seenKey = `observed:evaluator-proof-uncertain:${nonce}:${(txHash ?? '').toLowerCase()}`;
    const state = await ledger.readChainState(chainId, evaluator);
    let since = state?.lastAlertAt[seenKey];
    if (!since) {
      await ledger.recordAlertDelivered(chainId, evaluator, seenKey, now);
      since = now;
    }
    const after = a1Settings(deps).sendLostAlertAfterMs ?? EVALUATOR_STUCK_ALERT_AFTER_MS;
    if (now.getTime() - since.getTime() < after) return;
    const h = (txHash ?? '').toLowerCase();
    const nodes = views.map((v) => `${v.node}: ${!v.ok ? 'error' : `latest ${v.nonceLatest ?? '?'}, ${v.known?.[h] ? 'knows it' : 'does not know it'}, ${v.receipts?.[h] ? 'receipt' : 'no receipt'}`}`);
    await raiseConditionAlert(deps, pass, chainId, evaluator, `evaluator-proof-uncertain:${nonce}`, {
      kind: 'evaluator-proof-uncertain',
      chainId,
      message:
        `Evaluator nonce ${nonce} on chain ${chainId}: consumed with no receipt for candidate ${txHash ?? '?'} while a node still KNOWS it, ` +
        `since ${since.toISOString()} — nothing is concluded (neither mined nor dead); its job's gates stay closed. Nodes: ${nodes.join(' | ')}. ` +
        'Check the RPC nodes (a lagging or inconsistent one); remove a broken node from the configured candidates.',
      details: { nonce, txHash, since: since.toISOString(), nodes },
    }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS });
  } catch (err) {
    deps.logger.warn({ chainId, nonce, err: errorMessage(err) }, 'ERC-8183 persistent uncertain nonce not tracked this tick');
  }
}

/** §5.1: `Job.settleTxHash` points to the candidate that mined (conditional on the value read). */
async function moveSettleTxHashToWinner(deps: Erc8183Deps, jobId: string, winnerHash: string): Promise<void> {
  try {
    const job = await deps.db.job.findUnique({ where: { id: jobId }, select: { settleTxHash: true } });
    if (!job || job.settleTxHash?.toLowerCase() === winnerHash.toLowerCase()) return;
    await deps.db.job.updateMany({ where: { id: jobId, settleTxHash: job.settleTxHash }, data: { settleTxHash: winnerHash } });
  } catch (err) {
    deps.logger.warn({ jobId, txHash: winnerHash, err: errorMessage(err) }, 'ERC-8183 settleTxHash not moved to the mined candidate — next pass');
  }
}

/** R2-P3-1: a live LEGACY row without a nonce: a receipt (every node) resolves it; a re-read that finds its nonce makes it a normal row. */
async function resolveLegacyRows(deps: Erc8183Deps, legacy: readonly LedgerCandidate[], views: readonly NodeView[]): Promise<void> {
  if (legacy.length === 0 || views.length === 0 || views.some((v) => !v.ok)) return;
  const ledger = ledgerOf(deps);
  for (const c of legacy) {
    const rs = receiptsOf(views, c.txHash);
    if (rs.some((r) => r === undefined)) continue;
    const first = rs[0];
    if (first && rs.every((r) => r && r.blockHash.toLowerCase() === first.blockHash.toLowerCase())) {
      await ledger.markResolved(c.id, first.status === 'success' ? 'MINED_SUCCESS' : 'MINED_REVERTED', { level: 'latest', blockNumber: first.blockNumber, blockHash: first.blockHash });
    }
  }
}

/** §7.3: once the ledger has the row, the job's send stamp is no longer the gate — cleared (stale stamps only, never a send in progress). */
async function clearRecordedStamps(deps: Erc8183Deps, chainId: number): Promise<void> {
  try {
    const settings = a1Settings(deps);
    const before = new Date(nowOf(deps).getTime() - settings.criticalSectionMaxMs - 120_000);
    const stamped = await deps.db.job.findMany({
      where: { escrowKind: ESCROW_KIND, escrowChainId: chainId, settleAttemptAt: { not: null, lt: before }, settleTxHash: { not: null } },
      select: { id: true, settleTxHash: true, settleAttemptAt: true },
      take: 100,
    });
    if (!Array.isArray(stamped)) return;
    const ledger = ledgerOf(deps);
    for (const job of stamped) {
      const cands = await ledger.candidatesForJob(job.id);
      if (!cands.some((c) => c.txHash.toLowerCase() === job.settleTxHash!.toLowerCase())) continue;
      await deps.db.job.updateMany({ where: { id: job.id, settleTxHash: job.settleTxHash, settleAttemptAt: job.settleAttemptAt }, data: { settleAttemptAt: null } });
    }
  } catch (err) {
    deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 recorded send stamps not cleared this tick');
  }
}

/** §4.3: candidates of `nonce` died to a transaction outside the ledger — locate, record EXTERNAL, alert once per nonce. */
async function recordForeignNonce(
  deps: Erc8183Deps,
  chainId: number,
  evaluator: Address,
  nonce: number,
  rows: readonly LedgerCandidate[],
  proofLevel: 'latest' | 'proof',
): Promise<void> {
  const ledger = ledgerOf(deps);
  const found = await locateForeignTransaction(deps, chainId, evaluator, nonce);
  // A1 review P2-1 (c): the transaction that consumed the nonce is one of OUR ledger rows (its receipt was
  // not visible to the read yet): no foreign transaction, no incident — the next pass records it as mined.
  if (found && rows.some((c) => c.txHash.toLowerCase() === found.hash.toLowerCase())) {
    deps.logger.warn({ chainId, nonce, txHash: found.hash }, 'ERC-8183 evaluator nonce consumed by a recorded candidate whose receipt was not visible yet — no foreign alert');
    return;
  }
  if (found && found.to) {
    try {
      await ledger.recordExternalCandidate({
        chainId,
        evaluator,
        nonce,
        toAddress: found.to,
        valueWei: found.value,
        calldata: found.input,
        gasLimit: found.gas,
        maxFeePerGas: found.maxFeePerGas,
        maxPriorityFeePerGas: found.maxPriorityFeePerGas,
        txHash: found.hash,
        status: found.status === 'success' ? 'MINED_SUCCESS' : 'MINED_REVERTED',
        proofLevel,
        blockNumber: found.blockNumber,
        blockHash: found.blockHash,
        note: 'nonce consumed outside the ledger (A1 §4.3)',
      });
    } catch (err) {
      deps.logger.warn({ chainId, nonce, err: errorMessage(err) }, 'ERC-8183 foreign evaluator transaction not recorded');
    }
  }
  const selector = found && found.input.length >= 10 ? found.input.slice(0, 10) : found ? '0x' : null;
  await raiseEvaluatorKeyAlert(deps, chainId, evaluator, `evaluator-nonce-foreign:${nonce}`, {
    kind: 'evaluator-nonce-foreign',
    chainId,
    message:
      `Evaluator ${evaluator} nonce ${nonce} on chain ${chainId} was consumed by a transaction no ledger row covers ` +
      `(${found ? `${found.hash} in block ${found.blockNumber}, to ${found.to ?? 'contract creation'}, selector ${selector}` : 'not located'}): ` +
      'a manual send with the evaluator key, another environment sharing the key, or a COMPROMISED key. The recorded ' +
      `candidate(s) of that nonce are dead (${rows.length}); their jobs go back to the normal path. Treat it as an incident ` +
      'until the sender is identified.',
    details: { nonce, txHash: found?.hash ?? null, block: found?.blockNumber?.toString() ?? null, to: found?.to ?? null, selector, candidates: rows.map((c) => c.txHash) },
  }, { intervalMs: Number.MAX_SAFE_INTEGER });
}

/**
 * Review P3-1: the send-lost clock as a DIAGNOSTIC pass may touch it — it only STARTS it. A lost head with no
 * clock running starts it (the true first observation); a running clock is read, never moved; a head not lost
 * on the script's reads (a transient error, another RPC set) or lost at another nonce writes nothing. Only the
 * worker's pass clears or restarts it. Returns the clock's start when it is running for `nonce`.
 */
async function diagnosticSendLostSince(deps: Erc8183Deps, chainId: number, evaluator: Address, nonce: number | null, now: Date): Promise<Date | null> {
  const ledger = ledgerOf(deps);
  const state = await ledger.readChainState(chainId, evaluator);
  if (nonce === null) return null;
  if (!state?.sendLostSince) return ledger.observeHeadClock(chainId, evaluator, 'sendLost', nonce, now);
  return state.sendLostNonce === nonce ? state.sendLostSince : null;
}

/**
 * R2-P1-3 — the identical rebroadcast of a lost head and `evaluator-send-lost`.
 * The head is the nonce every node reports at `latest`. When its ONLY live
 * candidate is unknown to every node, inside the evaluator lane: fresh reads,
 * `rebroadcastAllowed` (head, sole live candidate, "not found" everywhere,
 * simulation passes, Q7 open, raw bytes kept), then `sendRaw` of the SAME
 * bytes (never a replacement: same nonce, same fees, same decision). At most
 * once per pass. "already known" / accepted → SENT; "nonce too low" → the next
 * pass proves the nonce; "underpriced" → an ordinary backlog (evaluator-stuck);
 * transport → next tick; any refusal → alerted. Returns how many were sent.
 */
async function rebroadcastLostHead(deps: Erc8183Deps, chainId: number, evaluator: Address, views: readonly NodeView[], pass: EvaluatorReconcileOptions): Promise<number> {
  const ledger = ledgerOf(deps);
  const now = nowOf(deps);
  const head = consensusLatest(views);
  const headRows = head === null ? [] : (await ledger.candidatesAtNonce(chainId, evaluator, head)).filter((c) => isLiveStatus(c.status));
  const lost = headRows.length > 0 && headRows.every((c) => unknownEverywhere(views, c.txHash) === true);
  const since = pass.diagnostic
    ? await diagnosticSendLostSince(deps, chainId, evaluator, lost ? head : null, now)
    : await ledger.observeHeadClock(chainId, evaluator, 'sendLost', lost ? head : null, now);
  if (!lost || head === null) return 0;

  let refusal: string | null = null;
  let sent = 0;
  let signer: (EvaluatorSigner & Partial<Pick<EvaluatorA1Signer, 'sendRaw'>>) | null = null;
  try {
    signer = deps.evaluatorSigner(chainId) as EvaluatorSigner & Partial<Pick<EvaluatorA1Signer, 'sendRaw'>>;
  } catch (err) {
    deps.logger.warn({ chainId, err: errorMessage(err) }, 'ERC-8183 identical rebroadcast impossible — no evaluator signer in this process');
  }
  const lanes = (deps.evaluatorLanes ?? deps.lanes) as Partial<LeaseLock> | undefined;
  if (!signer) refusal = 'NO_REBROADCAST: no evaluator signer in this process';
  else if (headRows.length > 1) refusal = 'OTHER_LIVE_CANDIDATE: more than one live candidate at the head nonce — no automatic rebroadcast (the recovery script decides)';
  else if (typeof signer.sendRaw !== 'function' || !lanes || typeof lanes.acquire !== 'function') refusal = 'NO_REBROADCAST: this process has no A1 signer or no evaluator lane';
  else {
    let lease: LaneLease | null = null;
    try {
      lease = await lanes.acquire(evaluatorLaneKey(chainId, signer.address), { waitMs: 5_000 });
      // Every condition read again INSIDE the lane (R2-P1-3).
      const rowsAt = await ledger.candidatesAtNonce(chainId, evaluator, head);
      const cand = rowsAt.find((c) => c.id === headRows[0]!.id)!;
      const fresh = toNodeViews(await readEvaluatorNodes(deps, chainId, evaluator, [cand.txHash]));
      const gate = deps.configGate?.(chainId);
      const verdict = rebroadcastAllowed({
        candidate: cand,
        candidatesAtNonce: rowsAt,
        views: fresh,
        hasRawTx: !!cand.rawTx,
        simulationOk: await simulateCandidate(deps, chainId, evaluator, cand),
        gateOpen: !gate || gate.allowed,
      });
      if (!verdict.ok) {
        // NODE_ERROR / NOT_HEAD / KNOWN_OR_MINED: the situation moved; the next pass looks again.
        if (['OTHER_LIVE_CANDIDATE', 'SIMULATION_REVERTS', 'NO_RAW_TX', 'GATE_CLOSED', 'NO_NONCE'].includes(verdict.reason)) {
          refusal = `${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''}`;
        }
      } else {
        await ledger.markBroadcast(cand.id);
        const out = await signer.sendRaw!(cand.rawTx as Hex, { lease, minLeaseMs: a1Settings(deps).leaseMinRemainingMs });
        if (out.kind === 'accepted' || out.kind === 'already-known') {
          await ledger.markAnswered(cand.id, 'SENT');
          sent++;
          deps.logger.warn({ chainId, nonce: head, txHash: cand.txHash, jobId: cand.jobId, answer: out.kind }, 'ERC-8183 lost evaluator transaction rebroadcast (identical bytes)');
        } else if (out.kind === 'rejected') {
          refusal = `the node refused the identical rebroadcast: ${out.message}`;
        } else {
          deps.logger.warn({ chainId, nonce: head, txHash: cand.txHash, answer: out.kind, message: out.message }, 'ERC-8183 identical rebroadcast not accepted — next pass decides');
        }
      }
    } catch (err) {
      deps.logger.warn({ chainId, nonce: head, err: errorMessage(err) }, 'ERC-8183 identical rebroadcast skipped this pass');
    } finally {
      if (lease) await lease.release();
    }
  }
  if (sent > 0) {
    // Review P3-1: the worker's next pass clears the clock once it sees the head known; a diagnostic pass never does.
    if (!pass.diagnostic) await ledger.observeHeadClock(chainId, evaluator, 'sendLost', null, now);
    return sent;
  }
  const lostSince = since ?? now;
  const afterMs = a1Settings(deps).sendLostAlertAfterMs ?? EVALUATOR_STUCK_ALERT_AFTER_MS;
  const c = headRows[0]!;
  if (pass.diagnostic) {
    // P3-9: the recovery script's pass — the state for its output, every time the head is lost; never an alert,
    // never the worker's clock, never "run the dry-run" (the operator is running it). Before the script's own Q7
    // verification its gate is still empty: GATE_CLOSED there says nothing about the on-chain configuration.
    const why =
      refusal === null
        ? 'no node took it on this pass'
        : refusal.startsWith('GATE_CLOSED')
          ? `${refusal} — this process's Q7 gate, read before the script's own verification; the "config gate" line of the plan shows the verified state`
          : refusal;
    pass.diagnostic.observe(
      sanitizeAlert({
        kind: 'evaluator-send-lost',
        chainId,
        ...(c.jobId ? { jobId: c.jobId } : {}),
        message:
          `transaction ${c.txHash} at the head nonce ${head}${c.jobId ? ` (job ${c.jobId})` : ''} is unknown to every RPC node since ` +
          `${lostSince.toISOString()}; this pass of the recovery script did not rebroadcast it (${why}). It may still mine, so the job's ` +
          'settlement, contest and resolve stay blocked until its nonce is consumed. Whether the identical rebroadcast is allowed is the ' +
          '"rebroadcast" line of the plan (--execute rebroadcast). Not alerted from here: the settlement worker alerts it on its own clock.',
        details: { nonce: head, txHash: c.txHash, jobId: c.jobId, since: lostSince.toISOString(), refusal },
      }),
    );
    return 0;
  }
  const lead = earlyAlertLeadMs(deps);
  const delivered = lead > 0 ? await earliestAffectedDeliveredExpiry(deps, chainId, evaluator, head) : null;
  const early = delivered !== null && lead > 0 && delivered.expiresAt.getTime() - (await lastBlockTime(deps, chainId)).getTime() < lead;
  if (refusal === null && !early && now.getTime() - lostSince.getTime() < afterMs) return 0;
  await raiseEvaluatorKeyAlert(deps, chainId, evaluator, 'evaluator-send-lost', {
    kind: 'evaluator-send-lost',
    chainId,
    ...(c.jobId ? { jobId: c.jobId } : {}),
    message:
      `Evaluator ${evaluator} on chain ${chainId}: transaction ${c.txHash} at the head nonce ${head}` +
      `${c.jobId ? ` (job ${c.jobId})` : ''} is unknown to every RPC node since ${lostSince.toISOString()}` +
      `${refusal ? ` and was not rebroadcast (${refusal})` : ''}. It may still mine (it was recorded before its send), so the job's ` +
      'settlement, contest and resolve stay blocked until its nonce is consumed. ' +
      `${delivered ? `The earliest delivered job waiting on this key expires at ${delivered.expiresAt.toISOString()} (job ${delivered.jobId}). ` : ''}` +
      'After expiresAt anyone can call claimRefund on a Funded or Submitted job and refund the requester in full, also for work ' +
      'already delivered; the provider is then unpaid. Operator: run the evaluator recovery dry-run.',
    details: { nonce: head, txHash: c.txHash, jobId: c.jobId, since: lostSince.toISOString(), refusal, earliestDeliveredExpiresAt: delivered?.expiresAt.toISOString() ?? null },
  }, { intervalMs: SETTLEMENT_FAILURE_ALERT_INTERVAL_MS, since: lostSince });
  return 0;
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
    // C3f item 1: on the same cadence, tell the operator when the evaluator key is stuck behind one transaction.
    await checkEvaluatorBacklogs(deps);
    return { outcome: 'swept', enqueued };
  }

  const job = await loadEscrowJob(deps, data.jobId);
  if (!job) return { outcome: 'noop', reason: 'not an ERC-8183 job' };
  if (!job.onChainJobId || !job.escrowContract || !job.escrowChainId) {
    return { outcome: 'noop', reason: `no on-chain job id (onChainStatus=${job.onChainStatus})` };
  }

  const chain = await readChainJob(deps, job);
  if (chain.status >= CHAIN_JOB_STATUS.Completed) {
    try {
      const onChainStatus = await reconcileTerminal(deps, job, chain.status);
      return { outcome: 'reconciled', onChainStatus };
    } catch (err) {
      // A3: terminal at latest, not yet at the proof tag — nothing finalized; the candidate pass re-enqueues it once proven.
      if (err instanceof SettlementAwaitingProofError) return { outcome: 'noop', reason: err.message };
      throw err;
    }
  }

  switch (data.action) {
    case 'settle':
    case 'resolve':
      return settle(deps, job, chain.status);
    case 'reject':
      return rejectForCancellation(deps, job, chain.status, data.reason ?? 'cancelled');
    case 'claimRefund':
      return claimRefund(deps, job, chain.status);
  }
}

/**
 * `settle` (automatic, after the evaluation delay) and `resolve` (an operator
 * decision, C3d) — one body, because both claim the same row and both must
 * honour whatever decision is recorded on it:
 *
 *  - no decision, not contested → `pay` (complete);
 *  - CONTESTED without a decision → held: nothing is sent (D9: a contest is
 *    resolved by the operator, never automatically);
 *  - a decision (`Job.resolution`) → executed, whatever the DB job status
 *    (a CANCELLED/FAILED job Submitted on-chain is settled only this way).
 */
async function settle(deps: Erc8183Deps, job: EscrowJobRow, chainStatus: number): Promise<SettlementResult> {
  const decided = job.resolution != null;
  if (chainStatus !== CHAIN_JOB_STATUS.Submitted) {
    if (job.status !== 'PAYMENT_PENDING' && !decided) {
      return { outcome: 'noop', reason: `job is ${job.status}, not PAYMENT_PENDING` };
    }
    // Funded/Open while we believe it was submitted: the submit tx is not
    // mined (yet). Let BullMQ retry; payment recovery handles the long tail.
    throw new Error(`on-chain job ${job.onChainJobId} is status ${chainStatus}, expected Submitted (2)`);
  }

  if (!decided) {
    if (job.onChainStatus === 'CONTESTED') {
      return { outcome: 'noop', reason: 'contested — held for operator review (POST /admin/jobs/:id/resolve)' };
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
  }

  // Q7: checked BEFORE the claim too, so a settlement deferred for an
  // unverified configuration leaves the job SUBMITTED / CONTESTED (still
  // contestable, still resolvable) instead of parking it in SETTLING.
  // G1 review P3-3: an operator decision is claimed (SETTLING) by
  // `resolveEscrowJob` in the API process, and an earlier attempt may have
  // claimed the row too: a deferral hands such a row back to its hold.
  try {
    assertEscrowConfigVerified(deps, job.escrowChainId!);
  } catch (err) {
    if (err instanceof EscrowConfigUnverifiedError) await handBackDeferredClaim(deps, job.id);
    throw err;
  }

  // Claim the settlement (→ SETTLING). The automatic branch only takes an
  // uncontested PAYMENT_PENDING job without a decision: a contest claims the
  // same SUBMITTED row (→ CONTESTED), so exactly one of the two wins. A
  // recorded operator decision is claimed from its hold (or from a previous
  // attempt's SETTLING) whatever the job status.
  const claimed = await deps.db.job.updateMany({
    where: {
      id: job.id,
      OR: [
        { status: 'PAYMENT_PENDING', onChainStatus: { in: ['SUBMITTED', 'SETTLING'] }, contestedAt: null, resolution: null },
        { resolution: { not: null }, onChainStatus: { in: ['SUBMITTED', 'CONTESTED', 'SETTLING'] } },
      ],
    },
    data: { onChainStatus: 'SETTLING' },
  });
  if (claimed.count === 0) {
    return { outcome: 'noop', reason: `onChainStatus ${job.onChainStatus} cannot be settled` };
  }

  const fresh = await loadEscrowJob(deps, job.id);
  if (!fresh) return { outcome: 'noop', reason: 'job vanished' };
  // No decision ⇒ automatic `pay`: the claim above took either a row with a
  // recorded decision, or an UNCONTESTED one without (contestedAt: null). A
  // contest cannot land afterwards (it needs SUBMITTED; the row is SETTLING)
  // and nothing clears a decision, so a contested row never gets here
  // without one (pre-C3d contested rows are moved to CONTESTED by migration
  // 0019 — review P3-3).
  const decision = (fresh.resolution as ReviewDecision | null) ?? 'pay';
  try {
    return await executeDecision(deps, fresh, decision);
  } catch (err) {
    // The gate closed between the claim and the send (sendEvaluatorTx checks
    // it again first, before anything is stamped): back to the hold.
    if (err instanceof EscrowConfigUnverifiedError) await handBackDeferredClaim(deps, job.id);
    throw err;
  }
}

/**
 * G1 review P3-3: a settlement deferred by the Q7 gate after its row was
 * claimed (SETTLING — by `resolveEscrowJob` for an operator decision, or by
 * an earlier attempt) goes back to its hold before the deferral: CONTESTED
 * for a contested job (the recorded decision stays), SUBMITTED otherwise.
 * Parked in SETTLING for the whole outage, the operator could not change the
 * decision (resolve refuses SETTLING) and the expiry sweep skipped the job.
 * Conditional on no evaluator send having been stamped: a deferral happens
 * before any stamp, and a row another attempt is sending stays SETTLING.
 */
async function handBackDeferredClaim(deps: Erc8183Deps, jobId: string): Promise<void> {
  try {
    const contested = await deps.db.job.updateMany({
      where: { id: jobId, onChainStatus: 'SETTLING', settleAttemptAt: null, contestedAt: { not: null } },
      data: { onChainStatus: 'CONTESTED' },
    });
    const submitted = await deps.db.job.updateMany({
      where: { id: jobId, onChainStatus: 'SETTLING', settleAttemptAt: null, contestedAt: null },
      data: { onChainStatus: 'SUBMITTED' },
    });
    if (contested.count + submitted.count > 0) {
      deps.logger.warn(
        { jobId, onChainStatus: contested.count > 0 ? 'CONTESTED' : 'SUBMITTED' },
        'ERC-8183 settlement deferred (on-chain configuration unverified) — claimed job handed back to its hold',
      );
    }
  } catch (err) {
    // The deferral still happens; the job stays SETTLING until the next attempt.
    deps.logger.error({ jobId, err: errorMessage(err) }, 'ERC-8183 deferred settlement could not be handed back to its hold');
  }
}

interface SettlementPlan {
  functionName: 'complete' | 'reject';
  reason: Hex;
  /** Outcome of the ERC-8004 feedback file committed in optParams; null → `optParams = "0x"` (nothing rated). */
  feedback: FeedbackFile['outcome'] | null;
}

/** Reason of a refund without verdict: the label the on-chain JobRejected event carries. */
function refundReason(job: Pick<EscrowJobRow, 'contestedAt' | 'status'>): Hex {
  if (job.contestedAt !== null) return SETTLEMENT_REASONS.contested;
  if (job.status === 'CANCELLED') return SETTLEMENT_REASONS.cancelled;
  if (job.status === 'FAILED') return SETTLEMENT_REASONS.providerFailed;
  return SETTLEMENT_REASONS.operatorRefund;
}

export function settlementPlan(job: Pick<EscrowJobRow, 'contestedAt' | 'status'>, decision: ReviewDecision): SettlementPlan {
  switch (decision) {
    case 'pay':
      return { functionName: 'complete', reason: SETTLEMENT_REASONS.completed, feedback: 'completed' };
    case 'quality-rejected':
      return { functionName: 'reject', reason: SETTLEMENT_REASONS.qualityRejected, feedback: 'rejected' };
    case 'payout-blocked':
      return { functionName: 'reject', reason: SETTLEMENT_REASONS.payoutBlocked, feedback: null };
    case 'refund':
      return { functionName: 'reject', reason: refundReason(job), feedback: null };
  }
}

/** A1 §6.1: refuses (SettlementStillPendingError) to rebuild / drop the feedback file while a candidate of the job may still mine (proof depth). */
async function assertFeedbackFileMutable(deps: Erc8183Deps, job: EscrowJobRow): Promise<void> {
  const cands = await ledgerOf(deps).candidatesForJob(job.id);
  if (cands.length === 0 || job.escrowChainId === null) return;
  const verdict = await jobCandidatesVerdict(deps, job.escrowChainId, cands, 'proof');
  if (verdict) throw new SettlementStillPendingError(verdict.txHash, `the feedback file is not rebuilt while ${verdict.reason}`);
}

/**
 * Sends the evaluator transaction of a claimed (SETTLING) job and records the
 * outcome. Only `pay` and the `quality-rejected` verdict carry feedback
 * params; every other reject sends `"0x"`, so the hook rates nothing
 * (`skipped:no-params`) and no feedback file is published for the job.
 */
async function executeDecision(deps: Erc8183Deps, job: EscrowJobRow, decision: ReviewDecision): Promise<SettlementResult> {
  const plan = settlementPlan(job, decision);
  let optParams: Hex = '0x';
  if (plan.feedback) {
    // Generate the feedback file once per outcome. The on-chain status check
    // before the claim guarantees nothing carrying an earlier hash was mined
    // (a reverted attempt sets `settleTxHash` but changes nothing on-chain),
    // so the only reason to rebuild is a decision that changed the outcome
    // after an earlier, unmined attempt.
    let file = (job.feedbackFile ?? null) as FeedbackFile | null;
    if (!file || file.outcome !== plan.feedback) {
      // C3g-A1 §6.1: the calldata of a live candidate commits the hash of the
      // current file (a speed-up re-signs it byte for byte): never rebuilt
      // while any candidate of the job may still mine (proof depth).
      await assertFeedbackFileMutable(deps, job);
      file = await buildFeedbackFile(deps, job, plan.feedback);
      await deps.db.job.update({ where: { id: job.id }, data: { feedbackFile: file as unknown as Prisma.InputJsonValue } });
    }
    optParams = encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], [feedbackUriFor(deps.config, job.id), feedbackHashOf(file)]);
  } else if (job.feedbackFile != null) {
    // Nothing is committed by a "0x" reject: drop a file an earlier, unmined attempt generated.
    await assertFeedbackFileMutable(deps, job);
    await deps.db.job.update({ where: { id: job.id }, data: { feedbackFile: Prisma.DbNull } });
  }

  const escrow = getAddress(job.escrowContract!);
  const { signer, txHash, candidateId } = await sendEvaluatorTx(
    deps,
    job,
    {
      address: escrow,
      abi: AGENT_JOB_ESCROW_ABI,
      functionName: plan.functionName,
      args: [BigInt(job.onChainJobId!), plan.reason, optParams],
    },
    // The job was claimed (SETTLING): the hash is recorded only while it still is.
    { claimed: true, intent: { action: plan.functionName === 'complete' ? 'COMPLETE' : 'REJECT', decision, reasonHex: plan.reason } },
  );
  deps.logger.info({ jobId: job.id, action: plan.functionName, decision, resolution: job.resolution, txHash }, 'ERC-8183 settlement sent');

  const action: SettlementAction = job.resolution ? 'resolve' : 'settle';
  let receipt: TransactionReceipt;
  try {
    receipt = await awaitOwnReceipt(deps, job, signer, txHash, action);
  } catch (err) {
    // C3h D2: a replacement's receipt is not this job's outcome — the chain decides.
    if (err instanceof SettlementReplacedError) return reconcileFromChainOrThrow(deps, job, err, err.minedHash);
    throw err;
  }

  const hook = deps.config.chain(job.escrowChainId!)?.hook ?? null;
  // C3h D2: only THIS job's events count, and the outcome is read from its terminal event — never
  // "REJECTED because no JobCompleted": a receipt without this job's event settled nothing here.
  const parsed = parseSettlementReceipt(receipt.logs, escrow, hook, BigInt(job.onChainJobId!));
  if (!parsed.completed && !parsed.rejected) return ownOutcomeUnproven(deps, job, action, txHash);
  await markOwnMined(deps, candidateId, receipt);
  try {
    await assertTerminalAtProof(deps, job, parsed.completed ? CHAIN_JOB_STATUS.Completed : CHAIN_JOB_STATUS.Rejected);
  } catch (err) {
    // A3: terminal at latest only — nothing finalized; the candidate pass re-enqueues the job once proven.
    if (err instanceof SettlementAwaitingProofError) return { outcome: 'noop', reason: err.message };
    throw err;
  }
  const ratedAgentId = parsed.ratedAgentId ?? (parsed.feedbackStatus === 'skipped:penalized' ? await readCanonicalAgentId(deps, job, hook) : null);
  const onChainStatus: OnChainStatus = parsed.completed ? 'COMPLETED' : 'REJECTED';
  await deps.db.job.update({
    where: { id: job.id },
    data: {
      onChainStatus,
      settleTxHash: txHash,
      settleAttemptAt: null,
      platformFeeAmount: parsed.platformFee !== null ? parsed.platformFee.toString() : null,
      feedbackStatus: parsed.feedbackStatus,
      ...(ratedAgentId ? { ratedAgentId } : {}),
      escrowError: null,
    },
  });
  if (parsed.feedbackStatus === 'failed:penalized') {
    deps.logger.warn(
      { jobId: job.id, agentId: parsed.ratedAgentId, penalties: parsed.penalties },
      'ReputationHook could not record the verdict and penalized the agent id (no positive feedback until clearPenalties)',
    );
  }

  const label = job.resolution ? `operator decision "${job.resolution}"` : 'settlement';
  await finalizeSettled(deps, job, parsed.completed, `Rejected by evaluator (${label}) — refunded on-chain in tx ${txHash}`);
  deps.logger.info(
    { jobId: job.id, onChainStatus, txHash, decision, platformFee: parsed.platformFee?.toString() ?? null, feedbackStatus: parsed.feedbackStatus, ratedAgentId },
    'ERC-8183 settlement confirmed',
  );
  return { outcome: 'settled', action, onChainStatus, txHash, feedbackStatus: parsed.feedbackStatus };
}

/**
 * The DB side of a mined complete/reject. A PAYMENT_PENDING job goes through
 * the finalizer (reputation, reservation, USD snapshot, notifications). A
 * CANCELLED/FAILED job the operator resolved: paid → COMPLETED (the provider
 * delivered and was paid on-chain); refunded → stays as it is, reservation
 * released (idempotent).
 */
async function finalizeSettled(deps: Erc8183Deps, job: EscrowJobRow, completed: boolean, refundReasonText: string): Promise<void> {
  if (job.status === 'PAYMENT_PENDING') {
    await deps.finalize({
      jobId: job.id,
      outcome: completed ? 'CONFIRMED' : 'FAILED',
      transactionId: null,
      ...(completed ? {} : { reason: refundReasonText }),
    });
    return;
  }
  if (completed) {
    const moved = await deps.db.job.updateMany({ where: { id: job.id, status: { in: ['CANCELLED', 'FAILED'] } }, data: { status: 'COMPLETED' } });
    if (moved.count > 0) {
      deps.logger.warn({ jobId: job.id, previousStatus: job.status, resolution: job.resolution }, 'ERC-8183 job paid on-chain by an operator decision — status COMPLETED');
    }
    return;
  }
  await finalizeAfterRefund(deps, job, refundReasonText);
}

/** `ReputationHook.canonicalAgentId(provider)` as a decimal string; null when unset or unreadable. */
async function readCanonicalAgentId(deps: Erc8183Deps, job: EscrowJobRow, hook: Address | null): Promise<string | null> {
  if (!hook) return null;
  try {
    const id = (await deps.publicClient(job.escrowChainId!).readContract({
      address: hook,
      abi: REPUTATION_HOOK_ABI,
      functionName: 'canonicalAgentId',
      args: [getAddress(job.provider.safeAddress)],
    })) as bigint;
    return id > 0n ? id.toString() : null;
  } catch {
    return null;
  }
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
      `left for the operator: decide with POST /admin/jobs/${job.id}/resolve (pay | refund | refund + quality-rejected verdict) ` +
      'before expiresAt (after it the expiry sweep refunds the requester without feedback)';
    // C3d: never over an operator decision already recorded (it settles the job).
    const mirrored = await deps.db.job.updateMany({
      where: { id: job.id, resolution: null, onChainStatus: { notIn: ['SETTLING', ...FINAL_ON_CHAIN_STATUSES] } },
      data: { onChainStatus: 'SUBMITTED', escrowError: message },
    });
    if (mirrored.count === 0) {
      return { outcome: 'noop', reason: 'on-chain job is Submitted and an operator decision is recorded — cancellation reject dropped' };
    }
    await raiseAlert(deps, {
      kind: 'cancellation-refused',
      jobId: job.id,
      chainId: job.escrowChainId,
      message,
      details: { status: job.status, reason, onChainJobId: job.onChainJobId },
    });
    return { outcome: 'noop', reason: 'on-chain job is Submitted — cancellation refused' };
  }
  if (job.resolution === 'pay') {
    // C3h D1: the backend never signs a refund (cancellation reject or claimRefund) of a job whose
    // recorded operator decision is "pay" and not executed yet — the decision settles it. (A decision
    // is only recorded on a Submitted job, so this is a guard, not a path the chain normally offers.)
    deps.logger.warn({ jobId: job.id, status: job.status, onChainStatus: job.onChainStatus }, 'ERC-8183 cancellation reject dropped — the operator decision "pay" is recorded');
    return { outcome: 'noop', reason: 'the operator decision "pay" is recorded — cancellation reject dropped' };
  }
  const escrow = getAddress(job.escrowContract!);
  const rejectReason = reason === 'cancelled' ? SETTLEMENT_REASONS.cancelled : SETTLEMENT_REASONS.providerFailed;
  const { signer, txHash, candidateId } = await sendEvaluatorTx(
    deps,
    job,
    {
      address: escrow,
      abi: AGENT_JOB_ESCROW_ABI,
      functionName: 'reject',
      args: [BigInt(job.onChainJobId!), rejectReason, '0x'],
    },
    { intent: { action: 'REJECT', decision: reason, reasonHex: rejectReason } },
  );
  let receipt: TransactionReceipt;
  try {
    receipt = await awaitOwnReceipt(deps, job, signer, txHash, 'reject');
  } catch (err) {
    if (err instanceof SettlementReplacedError) return reconcileFromChainOrThrow(deps, job, err, err.minedHash);
    throw err;
  }

  const parsed = parseSettlementReceipt(receipt.logs, escrow, deps.config.chain(job.escrowChainId!)?.hook ?? null, BigInt(job.onChainJobId!));
  // C3h D2: REJECTED only from this job's JobRejected event.
  if (!parsed.rejected) return ownOutcomeUnproven(deps, job, 'reject', txHash);
  await markOwnMined(deps, candidateId, receipt);
  try {
    await assertTerminalAtProof(deps, job, CHAIN_JOB_STATUS.Rejected);
  } catch (err) {
    // A3: terminal at latest only — nothing finalized; the candidate pass re-enqueues the job once proven.
    if (err instanceof SettlementAwaitingProofError) return { outcome: 'noop', reason: err.message };
    throw err;
  }
  await deps.db.job.update({
    where: { id: job.id },
    data: {
      onChainStatus: 'REJECTED',
      settleTxHash: txHash,
      settleAttemptAt: null,
      feedbackStatus: parsed.feedbackStatus,
      escrowError: null,
      // A "0x" reject commits no feedback file (C3d: only a mined complete / verdict publishes one).
      ...(job.feedbackFile != null ? { feedbackFile: Prisma.DbNull } : {}),
    },
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
  // G1 review P2-1: a claim enqueued before the job was held (an earlier
  // sweep, an older process) or that races the delivery re-checks the hold
  // here, right before signing. C3h D1: that includes every job with a
  // recorded "pay" not executed yet (contested, CANCELLED / FAILED) — the
  // backend never signs claimRefund against it. That stops only the backend:
  // claimRefund is permissionless after expiredAt (AgentJobEscrow.sol), so a
  // third party (the requester included) can still refund it on-chain.
  const hold = await deliveryHoldReason(deps, job);
  if (hold) {
    deps.logger.warn({ jobId: job.id, reason: hold }, 'ERC-8183 claimRefund dropped — a delivery accepted in time is held for its submit / settlement');
    return { outcome: 'noop', reason: `delivery accepted in time is held: ${hold}` };
  }
  const before = reviewSnapshot(job);
  const escrow = getAddress(job.escrowContract!);
  const { signer, txHash, candidateId } = await sendEvaluatorTx(
    deps,
    job,
    {
      address: escrow,
      abi: AGENT_JOB_ESCROW_ABI,
      functionName: 'claimRefund',
      args: [BigInt(job.onChainJobId!)],
    },
    { intent: { action: 'CLAIM_REFUND', decision: 'expiry', reasonHex: null } },
  );
  let receipt: TransactionReceipt;
  try {
    receipt = await awaitOwnReceipt(deps, job, signer, txHash, 'claimRefund');
  } catch (err) {
    if (err instanceof SettlementReplacedError) return reconcileFromChainOrThrow(deps, job, err, err.minedHash);
    throw err;
  }
  // C3h D2: EXPIRED only from this job's JobExpired event.
  const parsed = parseSettlementReceipt(receipt.logs, escrow, null, BigInt(job.onChainJobId!));
  if (!parsed.expired) return ownOutcomeUnproven(deps, job, 'claimRefund', txHash);
  await markOwnMined(deps, candidateId, receipt);
  try {
    await assertTerminalAtProof(deps, job, CHAIN_JOB_STATUS.Expired);
  } catch (err) {
    // A3: terminal at latest only — nothing finalized; the candidate pass re-enqueues the job once proven.
    if (err instanceof SettlementAwaitingProofError) return { outcome: 'noop', reason: err.message };
    throw err;
  }

  await deps.db.job.update({
    where: { id: job.id },
    // claimRefund carries no feedback params: a file an earlier, unmined settlement generated was never committed.
    data: {
      onChainStatus: 'EXPIRED',
      settleTxHash: txHash,
      settleAttemptAt: null,
      escrowError: null,
      ...(job.feedbackFile != null ? { feedbackFile: Prisma.DbNull } : {}),
    },
  });
  await finalizeAfterRefund(deps, job, `Expired on-chain — budget refunded in tx ${txHash}`);
  await alertReviewExpired(deps, job, before);
  deps.logger.warn({ jobId: job.id, txHash }, 'ERC-8183 job expired — refund claimed');
  return { outcome: 'settled', action: 'claimRefund', onChainStatus: 'EXPIRED', txHash, feedbackStatus: null };
}

type ReviewSnapshot = Pick<EscrowJobRow, 'onChainStatus' | 'status' | 'resolution' | 'contestedAt' | 'settleTxHash'>;

/** The review-relevant fields of a job before a settlement path updates it. */
function reviewSnapshot(job: EscrowJobRow): ReviewSnapshot {
  return {
    onChainStatus: job.onChainStatus,
    status: job.status,
    resolution: job.resolution ?? null,
    contestedAt: job.contestedAt,
    settleTxHash: job.settleTxHash,
  };
}

/**
 * C3d: a job ended at expiry (claimRefund — full refund, no feedback) while an
 * operator decision was recorded but not executed (review P3-2:
 * `review-overridden` — a "pay" did not pay, a verdict wrote no feedback), or
 * while it was still waiting for one (`review-expired`).
 */
async function alertReviewExpired(deps: Erc8183Deps, job: EscrowJobRow, before: ReviewSnapshot): Promise<void> {
  const decision = (before.resolution ?? null) as ReviewDecision | null;
  if (decision !== null) {
    await raiseAlert(deps, {
      kind: 'review-overridden',
      jobId: job.id,
      chainId: job.escrowChainId,
      message:
        `Job ${job.id} expired on-chain before the operator decision "${decision}" was executed: the requester was refunded ` +
        `in full by claimRefund${decision === 'pay' ? ', the provider was NOT paid' : ''} and no ERC-8004 feedback was written. ` +
        'Check why the decision did not settle before expiresAt (settlement failures, evaluator gas).',
      details: { status: before.status, onChainStatus: before.onChainStatus, resolution: decision, settleTxHash: before.settleTxHash },
    });
    return;
  }
  if (!isHeldForReview(before)) return;
  await raiseAlert(deps, {
    kind: 'review-expired',
    jobId: job.id,
    chainId: job.escrowChainId,
    message:
      `Job ${job.id} (${before.onChainStatus === 'CONTESTED' ? 'contested' : `${before.status} while Submitted on-chain`}) expired ` +
      'without an operator decision: the requester was refunded in full and no ERC-8004 feedback was written.',
    details: { status: before.status, onChainStatus: before.onChainStatus, contestedAt: before.contestedAt?.toISOString() ?? null },
  });
}

/** `onChainStatus` values that mean the provider's deliverable is Submitted on-chain (a `submit` mined). */
const DELIVERED_ON_CHAIN = ['SUBMITTED', 'CONTESTED', 'SETTLING'] as const;

/**
 * C3h D3 — the "provider unpaid" condition, from the job as it was BEFORE the
 * chain's terminal state was mirrored. All three must hold:
 *  1. **delivery recorded**: the deliverable is Submitted on-chain (`submit`
 *     mined: SUBMITTED / CONTESTED / SETTLING), or — R2-c — the job is
 *     PAYMENT_PENDING + FUNDED: the API accepted the result in time (PATCH
 *     COMPLETED passed the expiry margin) and its `submit` is in flight (a
 *     submit that fails for good hands the job back to ACCEPTED);
 *  2. **decision to pay**: the operator's recorded `pay`, or no decision on an
 *     uncontested PAYMENT_PENDING job (the automatic `complete` is due). An
 *     undecided contest, a CANCELLED / FAILED job without a decision and a
 *     refund decision end refunded by policy (C3d: `review-expired` /
 *     `review-overridden`), not here;
 *  3. **financial outcome confirmed**: the chain shows the job Expired
 *     (`claimRefund`, by anyone) or Rejected — not Completed: no
 *     `JobCompleted` paid the provider.
 */
function deliveryAcceptedToPay(before: ReviewSnapshot): { delivery: string; decision: string } | null {
  const pay = before.resolution === 'pay';
  const automatic = before.resolution == null && before.status === 'PAYMENT_PENDING' && before.contestedAt === null;
  if (!pay && !automatic) return null;
  if ((DELIVERED_ON_CHAIN as readonly string[]).includes(before.onChainStatus ?? '')) {
    return { delivery: `deliverable Submitted on-chain (${before.onChainStatus})`, decision: pay ? 'the operator decision "pay" was recorded' : 'its automatic settlement (complete) was due' };
  }
  if (before.status === 'PAYMENT_PENDING' && before.onChainStatus === 'FUNDED') {
    return { delivery: 'result accepted by the API in time, its submit not mined yet (PAYMENT_PENDING + FUNDED)', decision: 'its automatic settlement was due once the submit landed' };
  }
  return null;
}

/** Blocks searched back for the refund transaction of a job (best effort; one escrow address and one job id topic). */
export const REFUND_LOOKUP_BLOCKS = 200_000n;

/**
 * C3h D3: the transaction that emitted `eventName` for this job and its
 * sender — best effort (`eth_getLogs` over the last REFUND_LOOKUP_BLOCKS
 * blocks, filtered by the escrow address and the job id); null when the
 * client cannot search or the node refuses the range.
 */
async function findTerminalTransaction(
  deps: Erc8183Deps,
  job: Pick<EscrowJobRow, 'escrowChainId' | 'escrowContract' | 'onChainJobId'>,
  eventName: 'JobExpired' | 'JobRejected',
): Promise<{ txHash: Hex; from: Address | null } | null> {
  if (job.escrowChainId === null || !job.escrowContract || !job.onChainJobId) return null;
  const client = deps.publicClient(job.escrowChainId);
  if (!client.getLogs) return null;
  try {
    const latest = client.getBlockNumber ? await client.getBlockNumber() : null;
    const fromBlock = latest !== null && latest > REFUND_LOOKUP_BLOCKS ? latest - REFUND_LOOKUP_BLOCKS : 0n;
    const logs = (await client.getLogs({
      address: getAddress(job.escrowContract),
      event: getAbiItem({ abi: AGENT_JOB_ESCROW_ABI, name: eventName }),
      args: { jobId: BigInt(job.onChainJobId) },
      fromBlock,
      toBlock: 'latest',
    } as never)) as unknown as Log[];
    const txHash = (logs[logs.length - 1]?.transactionHash ?? null) as Hex | null;
    if (!txHash) return null;
    let from: Address | null = null;
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      from = (receipt as { from?: Address }).from ?? null;
    } catch {
      // the sender stays unknown
    }
    return { txHash, from };
  } catch {
    return null;
  }
}

/**
 * C3h D3: `provider-unpaid` — a delivery accepted in time, with a decision to
 * pay, ended refunded on-chain without a payment (see
 * `deliveryAcceptedToPay`). Raised by `reconcileTerminal` only when the row
 * moves from a live to a final on-chain status (once per job; a restart, a
 * redelivered settlement or the next tick finds the row final). Actionable:
 * the job, the on-chain id and chain, who refunded with which transaction
 * (best effort), expiresAt and the decision. Sanitized like every alert. The
 * money already moved: the contract cannot reverse it; any compensation of the
 * provider is an off-chain decision.
 */
async function alertProviderUnpaid(deps: Erc8183Deps, job: EscrowJobRow, before: ReviewSnapshot, onChainStatus: OnChainStatus): Promise<void> {
  const accepted = deliveryAcceptedToPay(before);
  if (!accepted) return;
  const refundEvent = onChainStatus === 'REJECTED' ? 'JobRejected' : 'JobExpired';
  const refund = await findTerminalTransaction(deps, job, refundEvent);
  const how = onChainStatus === 'REJECTED' ? 'rejected (reject — only the evaluator key can send it)' : 'refunded by claimRefund (permissionless after expiresAt)';
  await raiseAlert(deps, {
    kind: 'provider-unpaid',
    jobId: job.id,
    chainId: job.escrowChainId,
    message:
      `Job ${job.id} (on-chain job ${job.onChainJobId}, chain ${job.escrowChainId}): the provider's delivery was accepted in time ` +
      `(${accepted.delivery}) and ${accepted.decision}, but the job was ${how} — the requester got the budget back and the ` +
      `provider was NOT paid. ${refund ? `Refund transaction ${refund.txHash}${refund.from ? ` sent by ${refund.from}` : ''}.` : 'The refund transaction could not be identified.'} ` +
      `expiresAt ${job.expiresAt?.toISOString() ?? '(unknown)'}. The DB follows the chain; the contract cannot reverse it — ` +
      'any compensation of the provider is an operator decision outside the escrow.',
    details: {
      onChainJobId: job.onChainJobId,
      onChainStatus,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      previousStatus: before.status,
      previousOnChainStatus: before.onChainStatus,
      resolution: before.resolution ?? null,
      contestedAt: before.contestedAt?.toISOString() ?? null,
      settleTxHash: before.settleTxHash,
      refundEvent,
      refundTxHash: refund?.txHash ?? null,
      refundedBy: refund?.from ?? null,
    },
  });
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

/**
 * The chain already settled/refunded this job (crash after broadcast, expiry
 * race, manual tx): mirror it, send nothing. C3d: when the chain contradicts
 * a pending or recorded operator decision (a contested job found Completed, a
 * "pay" found Rejected), the DB still follows the chain — the money moved —
 * and the operator is alerted; nothing is dropped silently.
 */
async function reconcileTerminal(
  deps: Erc8183Deps,
  job: EscrowJobRow,
  chainStatus: number,
  opts: { settledBy?: Hex | null } = {},
): Promise<OnChainStatus> {
  // A3: finalization needs the terminal status at the proof tag.
  await assertTerminalAtProof(deps, job, chainStatus);
  const onChainStatus: OnChainStatus =
    chainStatus === CHAIN_JOB_STATUS.Completed ? 'COMPLETED' : chainStatus === CHAIN_JOB_STATUS.Rejected ? 'REJECTED' : 'EXPIRED';
  const before = reviewSnapshot(job);
  // Expiry carries no feedback params: an uncommitted file must not be published as if it were.
  const data = {
    onChainStatus,
    escrowError: null,
    settleAttemptAt: null,
    ...(onChainStatus === 'EXPIRED' && job.feedbackFile != null ? { feedbackFile: Prisma.DbNull } : {}),
  };
  // C3h D3: the row's move from a live to a final on-chain status happens once (conditional
  // write); it is the persisted "already mirrored" marker that keeps the provider-unpaid alert to
  // one per job across redeliveries, ticks and restarts. A re-run on a final row rewrites as before.
  const mirrored = await deps.db.job.updateMany({ where: { id: job.id, onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] } }, data });
  if (mirrored.count === 0) await deps.db.job.update({ where: { id: job.id }, data });
  deps.logger.warn(
    { jobId: job.id, onChainJobId: job.onChainJobId, onChainStatus, jobStatus: job.status },
    'ERC-8183 job already terminal on-chain — reconciled without sending',
  );
  if (onChainStatus !== 'EXPIRED') await recordLostSettlementReceipt(deps, job, opts.settledBy ?? null);
  if (mirrored.count > 0 && onChainStatus !== 'COMPLETED') await alertProviderUnpaid(deps, job, before, onChainStatus);

  const decision = (before.resolution ?? null) as ReviewDecision | null;
  // A recorded decision the chain contradicts, or a job held for a decision
  // that the chain settled without one (no automatic path settles a held job:
  // the money moved by another hand). Expiry has its own alert below.
  const contradicted =
    onChainStatus !== 'EXPIRED' && (decision !== null ? (decision === 'pay') !== (onChainStatus === 'COMPLETED') : isHeldForReview(before));
  if (contradicted) {
    await raiseAlert(deps, {
      kind: 'review-overridden',
      jobId: job.id,
      chainId: job.escrowChainId,
      message:
        `Job ${job.id} is ${onChainStatus} on-chain although ${decision ? `the operator decided "${decision}"` : 'it was held for operator review'} — ` +
        'the DB follows the chain; check the settlement transactions of the evaluator key.',
      details: { status: before.status, onChainStatus: before.onChainStatus, resolution: decision, settleTxHash: before.settleTxHash },
    });
  }
  if (onChainStatus === 'EXPIRED') await alertReviewExpired(deps, job, before);

  if (onChainStatus === 'COMPLETED') {
    if (job.status === 'PAYMENT_PENDING' || decision === 'pay') await finalizeSettled(deps, job, true, '');
    return onChainStatus;
  }
  await finalizeAfterRefund(deps, job, `${onChainStatus.toLowerCase()} on-chain (reconciled)`);
  return onChainStatus;
}

/** A3: `reconcileTerminal`, or false (nothing written) while the terminal status is not yet at the proof tag. */
async function reconcileTerminalWhenProven(deps: Erc8183Deps, job: EscrowJobRow, chainStatus: number): Promise<boolean> {
  try {
    await reconcileTerminal(deps, job, chainStatus);
    return true;
  } catch (err) {
    if (err instanceof SettlementAwaitingProofError) return false;
    throw err;
  }
}

/**
 * C3d: a settlement whose receipt the worker never saw (timeout, crash after
 * broadcast) and that the chain shows mined: read its receipt once and record
 * what the hook did (feedbackStatus, rated agent id, fee), so the surfaced
 * outcome does not depend on which attempt observed it. Best effort.
 */
async function recordLostSettlementReceipt(deps: Erc8183Deps, job: EscrowJobRow, settledBy: Hex | null = null): Promise<void> {
  if (!job.escrowContract || !job.onChainJobId || job.escrowChainId === null || job.feedbackStatus != null) return;
  // A1 §5.1: the WINNER of the job's nonce (a speed-up, a re-sign) — the ledger's mined decision
  // candidate — not merely the last hash written to the job row.
  let winner: Hex | null = null;
  if (!settledBy) {
    try {
      const mined = (await ledgerOf(deps).candidatesForJob(job.id)).filter((c) => c.status === 'MINED_SUCCESS' && c.kind !== 'CANCEL');
      winner = (mined[mined.length - 1]?.txHash as Hex | undefined) ?? null;
    } catch {
      winner = null;
    }
  }
  const hash = settledBy ?? winner ?? (job.settleTxHash as Hex | null);
  if (!hash) return;
  try {
    const receipt = await deps.publicClient(job.escrowChainId).getTransactionReceipt({ hash });
    if (receipt.status !== 'success') return;
    // C3h D2: only this job's events — a receipt of another job's transaction records nothing here.
    const parsed = parseSettlementReceipt(receipt.logs, getAddress(job.escrowContract), deps.config.chain(job.escrowChainId)?.hook ?? null, BigInt(job.onChainJobId));
    if (!parsed.completed && !parsed.rejected) return;
    await deps.db.job.update({
      where: { id: job.id },
      data: {
        feedbackStatus: parsed.feedbackStatus,
        ...(parsed.ratedAgentId ? { ratedAgentId: parsed.ratedAgentId } : {}),
        ...(parsed.platformFee !== null ? { platformFeeAmount: parsed.platformFee.toString() } : {}),
        // A same-nonce replacement that carries this job's terminal event (a speed-up) is the settling transaction.
        ...(settledBy || winner ? { settleTxHash: hash } : {}),
      },
    });
  } catch {
    // The receipt is gone or unreadable: the terminal status above is what matters.
  }
}

/** Minimum gap between two "settlement failed" alerts for one job (the recovery tick retries every few minutes). */
export const SETTLEMENT_FAILURE_ALERT_INTERVAL_MS = 60 * 60_000;
const settlementFailureAlertAt = new Map<string, number>();

/**
 * `worker.on('failed')` handler. On the final attempt only: record the error
 * and hand a `settle` / `resolve` back from SETTLING to its hold — SUBMITTED,
 * or CONTESTED for a contested job — so the job is visible as
 * stuck-but-funded. Never refunds in the DB — the USDC is on-chain. C3d: a
 * failing complete is alerted (at most hourly per job): when the provider
 * cannot receive USDC, the operator unwinds it with the `payout-blocked`
 * decision; a recorded decision is retried by the recovery tick until a new
 * decision replaces it.
 */
export async function handleFailedSettlementJob(deps: Erc8183Deps, jobLike: SettlementJobLike | undefined, err: Error): Promise<void> {
  if (!jobLike || !isLastSettlementAttempt(jobLike)) return;
  const { jobId, action } = jobLike.data;
  if (action === 'sweep') return;
  const job = await deps.db.job.findUnique({
    where: { id: jobId },
    select: { onChainStatus: true, contestedAt: true, resolution: true, escrowChainId: true, status: true },
  });
  if (!job) return;
  const settling = (action === 'settle' || action === 'resolve') && job.onChainStatus === 'SETTLING';
  await deps.db.job.update({
    where: { id: jobId },
    data: {
      escrowError: `${action} failed after ${jobLike.attemptsMade ?? 0} attempts: ${err.message.slice(0, 400)}`,
      ...(settling ? { onChainStatus: job.contestedAt ? 'CONTESTED' : 'SUBMITTED' } : {}),
    },
  });
  deps.logger.error(
    { jobId, action, err: err.message, attempts: jobLike.attemptsMade ?? 0, resolution: job.resolution },
    'ERC-8183 settlement permanently failed — job left on hold, funds remain on-chain',
  );
  if (action === 'settle' || action === 'resolve') {
    const now = nowOf(deps).getTime();
    const last = settlementFailureAlertAt.get(jobId);
    if (last !== undefined && now - last < SETTLEMENT_FAILURE_ALERT_INTERVAL_MS) return;
    settlementFailureAlertAt.set(jobId, now);
    await raiseAlert(deps, {
      kind: 'settlement-failed',
      jobId,
      chainId: job.escrowChainId,
      message:
        `Settlement of job ${jobId} (${job.resolution ? `operator decision "${job.resolution}"` : 'automatic complete'}) failed after ` +
        // viem summary, sanitized BEFORE clipping (C3d review P2-2: err.message carries the keyed RPC URL).
        `${jobLike.attemptsMade ?? 0} attempts: ${alertText(publicErrorMessage(err))}. The recovery tick retries it. If the provider cannot ` +
        `receive USDC (complete keeps reverting), unwind it with POST /admin/jobs/${jobId}/resolve {"decision":"payout-blocked"}.`,
      details: { action, status: job.status, resolution: job.resolution },
    });
  }
}

// ── Expiry sweep + payment recovery ────────────────────────────────────────

export const EXPIRY_SWEEP_LIMIT = 50;

/**
 * `onChainStatus` of a delivery accepted in time that may still be waiting
 * for its submit (FUNDED) or for its automatic settlement (SUBMITTED).
 */
const DELIVERY_PENDING_ON_CHAIN = ['FUNDED', 'SUBMITTED'] as const;

/**
 * C3h D1: `onChainStatus` of a job whose recorded "pay" has not been executed
 * and whose deliverable is still Submitted on-chain (SETTLING: a claimed
 * attempt; the sweep leaves SETTLING to it anyway).
 */
const PAY_HELD_ON_CHAIN = ['SUBMITTED', 'CONTESTED', 'SETTLING'] as const;

type DeliveryHoldJob = Pick<EscrowJobRow, 'id' | 'status' | 'contestedAt' | 'resolution' | 'onChainStatus' | 'deferredSubmitAt'>;

/**
 * G1 review P2-1: why the backend must NOT claim the refund of this expired
 * job, or null. The provider delivered through the API in time — `PATCH
 * COMPLETED` passed the expiry-margin check, so the job is PAYMENT_PENDING
 * with its result readable by the requester — it is not contested, no
 * operator decision other than "pay" is recorded (a "pay" taken on a held
 * delivery must not be overtaken by the sweep's refund), and the delivery is
 * still on its way:
 *  - FUNDED: its `submit` is in flight — deferred behind the ERC-8004 binding,
 *    QUEUED (e.g. deferred by the Q7 gate, without limit), SUBMITTED without a
 *    receipt, or CONFIRMED but not yet mirrored;
 *  - SUBMITTED: the deliverable is on-chain and waits for its automatic
 *    settlement (deferred by the Q7 gate, or failing).
 * A refund then would leave the requester with the deliverable AND the
 * budget, and the provider unpaid (`claimRefund` is allowed on a Funded or
 * Submitted job once expired; `submit` has no expiry check and `complete` is
 * allowed after `expiredAt` while Submitted, so the deferred submit and the
 * refund race). Such a job is held for the operator: the submit lands and the
 * settlement pays the provider (the clamp gives it no delay past expiresAt),
 * or the operator decides (`POST /admin/jobs/:id/resolve` once Submitted).
 * Unchanged: no delivery (PENDING / ACCEPTED), a delivery whose submit failed
 * for good (the job is back to ACCEPTED), undecided contests and refund
 * decisions (C3d: refunded at expiry, alerted), CANCELLED / FAILED jobs
 * without a decision.
 *
 * C3h D1: a recorded operator decision "pay" that has not been executed —
 * the deliverable still Submitted on-chain (SUBMITTED / CONTESTED, or SETTLING
 * while a claimed attempt runs) — is held WHATEVER the job status (also
 * CANCELLED / FAILED) and contest: the backend never signs `claimRefund` (nor
 * the cancellation `reject`) against it. Before C3h such a job, handed back
 * from SETTLING after 3 failed attempts (`handleFailedSettlementJob`) or a Q7
 * deferral (`handBackDeferredClaim`), fell into the sweep's refund batch past
 * expiresAt and the evaluator refunded the requester against the operator's
 * decision. The recovery keeps retrying the decision (`complete` is valid
 * after expiredAt while the job is Submitted). This does NOT stop a third
 * party: `claimRefund` is permissionless after expiredAt, so the requester (or
 * anyone) can still refund the job on-chain — the contractual risk remains;
 * the backend then mirrors the chain and alerts `provider-unpaid`.
 */
async function deliveryHoldReason(deps: Erc8183Deps, job: DeliveryHoldJob): Promise<string | null> {
  if (job.resolution === 'pay' && (PAY_HELD_ON_CHAIN as readonly string[]).includes(job.onChainStatus ?? '')) {
    return (
      `the operator decision "pay" is recorded and not executed yet (${job.status}, ${job.onChainStatus}` +
      `${job.contestedAt !== null ? ', contested' : ''}): its settlement keeps being retried`
    );
  }
  if (job.status !== 'PAYMENT_PENDING' || job.contestedAt !== null) return null;
  if (job.resolution != null && job.resolution !== 'pay') return null;
  if (job.onChainStatus === 'SUBMITTED') {
    return job.resolution === 'pay'
      ? 'its deliverable is Submitted on-chain and the operator decision "pay" has not settled yet'
      : 'its deliverable is Submitted on-chain and its automatic settlement has not run yet';
  }
  if (job.onChainStatus !== 'FUNDED') return null;
  if (job.deferredSubmitAt) return "its submit is deferred behind the provider's ERC-8004 binding";
  const submit = await deps.db.transaction.findFirst({
    where: { ...intentAttemptsFilter(escrowIntentId('submit', job.id)), status: { in: [...IN_FLIGHT_TX] as never } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (!submit) return null;
  return `its submit transaction ${submit.id} is ${submit.status === 'QUEUED' ? 'QUEUED (not broadcast yet)' : submit.status === 'SUBMITTED' ? 'broadcast without a receipt' : submit.status}`;
}

/**
 * P2-1: one operator alert per held job (the `reviewAlertedAt` claim, shared
 * with the review-expiring reminder — a held delivery is never one of those
 * jobs). A delivery the channel refuses releases the claim for the next tick.
 */
async function alertDeliveryHeld(
  deps: Erc8183Deps,
  job: DeliveryHoldJob & Pick<EscrowJobRow, 'expiresAt' | 'escrowChainId' | 'onChainJobId' | 'reviewAlertedAt'>,
  reason: string,
  now: Date,
): Promise<void> {
  if (job.reviewAlertedAt) return;
  const claimed = await deps.db.job.updateMany({ where: { id: job.id, reviewAlertedAt: null }, data: { reviewAlertedAt: now } });
  if (claimed.count === 0) return;
  const delivered = await raiseAlert(deps, {
    kind: 'delivery-held',
    jobId: job.id,
    chainId: job.escrowChainId,
    message:
      `Job ${job.id} passed expiresAt ${job.expiresAt?.toISOString() ?? '(unknown)'} with its provider's delivery accepted in time but not ` +
      `settled: ${reason}. The backend does NOT claim the refund (the requester would keep the deliverable AND the budget): when the ` +
      'submit lands the automatic settlement pays the provider, or decide with ' +
      `POST /admin/jobs/${job.id}/resolve once the deliverable is Submitted on-chain. Residual: claimRefund is permissionless after ` +
      'expiresAt — anyone (the requester included) can still refund it on-chain, which the reconciliation then mirrors.',
    details: { status: job.status, onChainStatus: job.onChainStatus, expiresAt: job.expiresAt?.toISOString() ?? null, onChainJobId: job.onChainJobId },
  });
  if (!delivered) await deps.db.job.updateMany({ where: { id: job.id, reviewAlertedAt: now }, data: { reviewAlertedAt: null } });
}

/** C3h D1: per job, when its "pay held past expiresAt" alert was last delivered (in-process). */
const payHoldAlertAt = new Map<string, number>();

/**
 * C3h D1: the `delivery-held` alert of a job whose recorded "pay" is held
 * past expiresAt — at most every SETTLEMENT_FAILURE_ALERT_INTERVAL_MS per job
 * while it lasts (the exposure lasts: anyone can claimRefund it at any time).
 * Not the `reviewAlertedAt` claim (review R2-a): a contested job usually spent
 * it on `review-expiring` a day before, which would have swallowed this one.
 * In memory, without a new column: a restart repeats it once, which is
 * acceptable for an alert that repeats hourly anyway. Undelivered → retried
 * on the next tick.
 */
async function alertPayHeld(
  deps: Erc8183Deps,
  job: DeliveryHoldJob & Pick<EscrowJobRow, 'expiresAt' | 'escrowChainId' | 'onChainJobId'>,
  reason: string,
  now: Date,
): Promise<void> {
  const last = payHoldAlertAt.get(job.id);
  if (last !== undefined && now.getTime() - last < SETTLEMENT_FAILURE_ALERT_INTERVAL_MS) return;
  const delivered = await raiseAlert(deps, {
    kind: 'delivery-held',
    jobId: job.id,
    chainId: job.escrowChainId,
    message:
      `Job ${job.id} (on-chain job ${job.onChainJobId}) passed expiresAt ${job.expiresAt?.toISOString() ?? '(unknown)'} with the ` +
      `operator decision "pay" recorded and not executed: ${reason}. The backend does NOT sign claimRefund (nor a cancellation ` +
      'reject) for it; the recovery keeps retrying the decision (complete is still valid after expiresAt while the job is ' +
      'Submitted) — check why it does not settle (settlement-failed / evaluator-stuck alerts, evaluator gas, RPC). Residual: ' +
      'claimRefund is permissionless after expiresAt — the requester or anyone can still refund it on-chain at any moment; ' +
      'the backend then mirrors the chain and alerts provider-unpaid.',
    details: {
      status: job.status,
      onChainStatus: job.onChainStatus,
      resolution: job.resolution,
      contested: job.contestedAt !== null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      onChainJobId: job.onChainJobId,
    },
  });
  if (delivered) payHoldAlertAt.set(job.id, now.getTime());
}

/**
 * Enqueues `claimRefund` for every escrow job that exists on-chain, is past
 * `expiresAt` and is not final in the DB (C3c: whatever the DB thinks the
 * last step was — a `fund` whose monitor was lost leaves the DB at APPROVED
 * while the budget is locked). The claimRefund action reads the chain:
 * Funded/Submitted → refund; Open → closed as EXPIRED_UNFUNDED; terminal →
 * mirrored. SETTLING is left to the settlement in flight. Least recently
 * touched first, so a job whose claim keeps failing cannot starve the rest.
 *
 * G1 review P2-1: a delivery accepted in time whose submit or settlement is
 * still on its way is held instead (`deliveryHoldReason`) and alerted once;
 * those candidates are read by a separate query, so held jobs never fill the
 * refund batch. Returns how many refunds were enqueued.
 *
 * C3h D1: every job with a recorded "pay" not executed yet (deliverable still
 * Submitted on-chain) is held the same way, whatever its status and contest —
 * never in the refund batch, alerted at most hourly (`alertPayHeld`). The hold
 * binds the backend only: claimRefund stays permissionless on-chain.
 */
export async function sweepExpiredEscrows(deps: Erc8183Deps): Promise<number> {
  const now = nowOf(deps);
  const expired = {
    escrowKind: ESCROW_KIND,
    onChainJobId: { not: null },
    onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES, 'SETTLING'] },
    expiresAt: { lt: now },
  } satisfies Prisma.JobWhereInput;
  const refundable = await deps.db.job.findMany({
    where: {
      ...expired,
      AND: [
        {
          // Everything but an uncontested PAYMENT_PENDING job still FUNDED / SUBMITTED without a refund decision …
          OR: [
            { status: { not: 'PAYMENT_PENDING' } },
            { contestedAt: { not: null } },
            { resolution: { in: REVIEW_DECISIONS.filter((d) => d !== 'pay') } },
            { onChainStatus: { notIn: [...DELIVERY_PENDING_ON_CHAIN] } },
          ],
        },
        {
          // … and (C3h D1) never a recorded "pay" whose deliverable is still Submitted on-chain.
          OR: [{ resolution: null }, { resolution: { not: 'pay' } }, { onChainStatus: { notIn: [...PAY_HELD_ON_CHAIN] } }],
        },
      ],
    },
    select: { id: true },
    take: EXPIRY_SWEEP_LIMIT,
    orderBy: { updatedAt: 'asc' },
  });
  const deliveries = await deps.db.job.findMany({
    where: {
      ...expired,
      OR: [
        { status: 'PAYMENT_PENDING', contestedAt: null, OR: [{ resolution: null }, { resolution: 'pay' }], onChainStatus: { in: [...DELIVERY_PENDING_ON_CHAIN] } },
        // C3h D1: a recorded "pay" not executed, whatever the status (CANCELLED / FAILED) and contest.
        { resolution: 'pay', onChainStatus: { in: [...PAY_HELD_ON_CHAIN] } },
      ],
    },
    select: {
      id: true,
      status: true,
      contestedAt: true,
      resolution: true,
      onChainStatus: true,
      deferredSubmitAt: true,
      expiresAt: true,
      escrowChainId: true,
      onChainJobId: true,
      reviewAlertedAt: true,
    },
    take: EXPIRY_SWEEP_LIMIT,
    orderBy: { updatedAt: 'asc' },
  });

  const toRefund = refundable.map(({ id }) => id);
  let held = 0;
  for (const job of deliveries) {
    const reason = await deliveryHoldReason(deps, job);
    if (!reason) {
      // PAYMENT_PENDING + FUNDED with no submit left in flight: the delivery failed for good.
      toRefund.push(job.id);
      continue;
    }
    held++;
    if (job.resolution === 'pay') await alertPayHeld(deps, job, reason, now);
    else await alertDeliveryHeld(deps, job, reason, now);
  }
  for (const jobId of toRefund) {
    await deps.settlement.add({ jobId, action: 'claimRefund' });
  }
  if (toRefund.length > 0) {
    deps.logger.warn({ count: toRefund.length }, 'ERC-8183 expiry sweep — claimRefund enqueued');
  }
  if (held > 0) {
    deps.logger.warn({ held }, 'ERC-8183 expiry sweep — deliveries accepted in time held (no refund claimed): submit or settlement still on its way');
  }
  return toRefund.length;
}

export type Erc8183RecoveryOutcome =
  | 'resettled'
  | 'returnedToAccepted'
  | 'inFlight'
  | 'awaitingBinding'
  | 'submitReleased'
  | 'reconciled'
  | 'chainUnreadable'
  | 'heldForReview'
  | 'awaitingEvaluation';

/**
 * Payment-recovery branch for a stale PAYMENT_PENDING escrow job. Never
 * finalizes as FAILED: the budget is on-chain, so the only safe moves are to
 * re-run the (idempotent) settlement or to let the provider retry `submit`.
 *
 * C3d: a CONTESTED job is held for the operator (`heldForReview`) — unless an
 * operator decision is recorded on it (its settlement failed earlier), which
 * is retried. A SUBMITTED job inside its evaluation window waits for its
 * delayed settle (`awaitingEvaluation`, review P3-4).
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
      if (!(await reconcileTerminalWhenProven(deps, full, chain.status))) return 'inFlight';
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
  if (job.onChainStatus === 'CONTESTED') {
    const row = await deps.db.job.findUnique({ where: { id: job.id }, select: { resolution: true } });
    if (!row?.resolution) return 'heldForReview';
    await deps.settlement.add({ jobId: job.id, action: 'resolve' });
    return 'resettled';
  }
  if (job.onChainStatus === 'SUBMITTED' && (await awaitingEvaluation(deps, job.id))) return 'awaitingEvaluation';
  await deps.settlement.add({ jobId: job.id, action: 'settle' });
  return 'resettled';
}

/**
 * C3d review P3-4: an undecided SUBMITTED job whose evaluation window
 * (ESCROW_EVALUATION_DELAY_SECONDS from the submit confirmation, clamped
 * before expiry like the original schedule) is still open is not stuck — its
 * settle is a delayed queue entry. Re-adds it with the REMAINING delay (a
 * no-op while queued; restores a lost one without shortening the contest
 * window — an immediate settle here would close it early) and bumps
 * `updatedAt` so the job leaves the head of the oldest-first scan until the
 * window has passed. The anchor is the submit transaction, never `updatedAt`
 * (bumping it must not slide the window).
 */
async function awaitingEvaluation(deps: Erc8183Deps, jobId: string): Promise<boolean> {
  if (deps.config.evaluationDelaySeconds <= 0) return false;
  const row = await deps.db.job.findUnique({ where: { id: jobId }, select: { resolution: true, contestedAt: true, expiresAt: true, status: true } });
  if (!row || row.resolution != null || row.contestedAt !== null || row.status !== 'PAYMENT_PENDING') return false;
  const submit = await deps.db.transaction.findFirst({
    where: { ...intentAttemptsFilter(escrowIntentId('submit', jobId)), status: 'CONFIRMED' },
    orderBy: { createdAt: 'desc' },
    select: { confirmedAt: true, updatedAt: true },
  });
  const submittedAt = submit?.confirmedAt ?? submit?.updatedAt ?? null;
  if (!submittedAt) return false;
  const now = nowOf(deps);
  const remainingMs = submittedAt.getTime() + settlementDelay(deps.config, row.expiresAt, submittedAt).delayMs - now.getTime();
  if (remainingMs <= 0) return false;
  await deps.settlement.add({ jobId, action: 'settle' }, { delayMs: remainingMs });
  await deps.db.job.updateMany({ where: { id: jobId, status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' }, data: { updatedAt: now } });
  return true;
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
  | 'heldForReview'
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

  if (!live && job.onChainStatus === 'FAILED') {
    // Funding was unwound. Only a `fund` that was broadcast and then
    // declared dropped (FAILED with a hash) can still lock the budget; a
    // reverted one has a receipt, one that never left has no hash.
    const fundTx = await latestStepTx(deps, 'fund', job.id);
    if (!fundTx || fundTx.status !== 'FAILED' || !fundTx.txHash) return 'unchanged';
  }

  const chain = await tryReadChainJob(deps, job);
  if (!chain) return 'chainUnreadable';

  if (chain.status >= CHAIN_JOB_STATUS.Completed) {
    if (!(await reconcileTerminalWhenProven(deps, job, chain.status))) return 'inFlight';
    return 'reconciled';
  }

  if (chain.status === CHAIN_JOB_STATUS.Submitted) {
    // C3d: a recorded operator decision settles the job (its earlier attempt
    // failed, or it was never enqueued); an undecided contest stays on hold.
    if (job.resolution != null && ['SUBMITTED', 'CONTESTED', 'SETTLING'].includes(job.onChainStatus ?? '')) {
      await deps.settlement.add({ jobId: job.id, action: 'resolve' });
      return 'advanced';
    }
    if (job.onChainStatus === 'CONTESTED') return 'heldForReview';
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

/**
 * C3d review P3-1: READ-ONLY reconciliation of a job held for an operator
 * decision with none recorded (CONTESTED, or CANCELLED/FAILED while Submitted
 * on-chain). Nothing is sent or enqueued — the hold is the operator's. When
 * the chain moved on without the operator (another settlement path, a manual
 * evaluator transaction, an expiry claimed by anyone), the DB mirrors it and
 * the operator is alerted (`review-overridden`, or `review-expired` for a
 * claimRefund). Still Submitted → `heldForReview` (quiet: the pass bumps
 * `updatedAt`, so held jobs rotate instead of starving the pick).
 */
export async function reconcileHeldReview(deps: Erc8183Deps, jobId: string): Promise<ReconcileOutcome> {
  const job = await loadEscrowJob(deps, jobId);
  if (!job || job.resolution != null || !isHeldForReview(job)) return 'skipped';
  const chain = await tryReadChainJob(deps, job);
  if (!chain) return 'chainUnreadable';
  if (chain.status >= CHAIN_JOB_STATUS.Completed) {
    if (!(await reconcileTerminalWhenProven(deps, job, chain.status))) return 'inFlight';
    return 'reconciled';
  }
  return chain.status === CHAIN_JOB_STATUS.Submitted ? 'heldForReview' : 'unchanged';
}

const QUIET_OUTCOMES = new Set<ReconcileOutcome>(['unchanged', 'inFlight', 'waitingForLane', 'chainUnreadable', 'skipped', 'heldForReview']);

export interface ReconcileSummary {
  stalledFunding: number;
  lostRejects: number;
  unsubmittedDeliverables: number;
  stalledBindings: number;
  /** C3d: operator decisions on CANCELLED/FAILED jobs whose settlement is not running (queue outage, failed attempt). */
  stalledDecisions: number;
  /** C3d review P3-1: undecided jobs held for review, checked read-only against the chain. */
  heldReviews: number;
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
 *  - jobs whose ERC-8004 binding has been BINDING for `staleBefore`;
 *  - C3d: CANCELLED/FAILED jobs with an operator decision recorded whose
 *    settlement is not running (re-enqueued as `resolve`);
 *  - C3d review P3-1: undecided jobs held for review (CONTESTED, or
 *    CANCELLED/FAILED while SUBMITTED) — read-only (`reconcileHeldReview`):
 *    a chain that settled without the operator is mirrored and alerted.
 * Stale PAYMENT_PENDING jobs keep their own branch (`recoverErc8183Job`).
 */
export async function reconcileEscrowJobs(deps: Erc8183Deps, opts: { staleBefore: Date; limit: number }): Promise<ReconcileSummary> {
  const base = { escrowKind: ESCROW_KIND, updatedAt: { lt: opts.staleBefore } };
  const pick = (where: Prisma.JobWhereInput) =>
    deps.db.job.findMany({ where: { ...base, ...where }, select: { id: true }, orderBy: { updatedAt: 'asc' }, take: opts.limit });

  const [stalledFunding, lostRejects, unsubmitted, stalledBindings, stalledDecisions, heldReviews] = await Promise.all([
    pick({ status: { in: [...LIVE_JOB_STATUS_LIST] }, onChainStatus: { in: ['CREATING', 'OPEN', 'BUDGET_SET', 'APPROVED'] } }),
    pick({
      status: { in: ['CANCELLED', 'FAILED'] },
      onChainJobId: { not: null },
      OR: [
        { onChainStatus: { in: ['APPROVED', 'FUNDED'] } },
        // Funding unwound after a `fund` was declared dropped: it can still
        // mine until expiresAt (reconcileEscrowJob only reads the chain when
        // the latest fund attempt is such a dropped broadcast).
        { onChainStatus: 'FAILED', expiresAt: { gt: nowOf(deps) } },
      ],
    }),
    pick({ status: 'ACCEPTED', onChainStatus: 'FUNDED', deliverableHash: { not: null } }),
    pick({ status: { in: ['PENDING', 'ACCEPTED', 'PAYMENT_PENDING'] }, providerAgentIdStatus: 'BINDING' }),
    pick({ status: { in: ['CANCELLED', 'FAILED'] }, resolution: { not: null }, onChainStatus: { in: ['SUBMITTED', 'SETTLING'] } }),
    pick({
      resolution: null,
      OR: [{ onChainStatus: 'CONTESTED' }, { onChainStatus: 'SUBMITTED', status: { in: ['CANCELLED', 'FAILED'] } }],
    }),
  ]);

  const summary: ReconcileSummary = {
    stalledFunding: stalledFunding.length,
    lostRejects: lostRejects.length,
    unsubmittedDeliverables: unsubmitted.length,
    stalledBindings: stalledBindings.length,
    stalledDecisions: stalledDecisions.length,
    heldReviews: heldReviews.length,
    outcomes: {},
  };
  const held = new Set(heldReviews.map(({ id }) => id));
  const seen = new Set<string>();
  for (const { id } of [...stalledFunding, ...lostRejects, ...unsubmitted, ...stalledBindings, ...stalledDecisions, ...heldReviews]) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const outcome = held.has(id) ? await reconcileHeldReview(deps, id) : await reconcileEscrowJob(deps, id);
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
  /** C3d: the operator decision on a job held for review: pay | refund | quality-rejected | payout-blocked. */
  resolution: string | null;
  resolvedAt: Date | null;
  /** C3d: the ERC-8004 agent id the ReputationHook rated (its canonical id for the provider address). */
  ratedAgentId: string | null;
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
  'settleAttemptAt',
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
  // C3d: exposed in `escrow` (resolution, resolvedAt, ratedAgentId) or operator-only (admin routes).
  'resolution',
  'resolvedBy',
  'resolvedAt',
  'resolutionNote',
  'reviewLog',
  'reviewAlertedAt',
  'ratedAgentId',
] as const;

/**
 * API shape: the raw escrow columns are folded into one `escrow` object (null
 * for legacy/free jobs) and the feedback file is never inlined — it has its
 * own public endpoint. `escrowError` and `providerAgentIdError` are stored
 * from worker `err.message` (a viem message carries the keyed RPC URL), so
 * they are sanitized on the way out (S5); the DB keeps the full text. C3d:
 * who decided a review, the note and the review log stay operator-only.
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
          resolution: (job['resolution'] as string | null) ?? null,
          resolvedAt: (job['resolvedAt'] as Date | null) ?? null,
          ratedAgentId: (job['ratedAgentId'] as string | null) ?? null,
        }
      : null;
  return { ...(rest as Omit<T, (typeof ESCROW_COLUMNS)[number]>), escrow };
}
