/**
 * ResourcePaymentService — job-scoped x402 payments (execution plan task P2,
 * with the P5 ledger state machine).
 *
 * Who pays: the job's PROVIDER — the agent doing the work — from its own
 * wallet, through `X402ClientService`. The requester cannot call this. The
 * job must be `ACCEPTED` and the payer active with a non-paused policy.
 *
 * Budget: the job reward must be denominated in USDC on the job's chain.
 *   remaining = reward − Σ amount of this job's rows in
 *               (reserved, pending, settled, unknown)
 * `remaining`, lowered by the caller's optional `maxAmount`, is the
 * per-payment cap handed to `X402ClientService`, which refuses an above-cap
 * price BEFORE anything is signed. The reservation re-checks the budget
 * inside a transaction holding a row lock on the Job, so two concurrent
 * payments cannot both pass on the same remaining amount.
 *
 * State machine, durable in `ResourcePayment.status`:
 *
 *   reserved ──► pending ──► settled  2xx + settlement report (receipt
 *                      │              verified, or marked unverified)
 *                      ├──► unknown  timeout / transport error AFTER
 *                      │             signing: money may have moved. NO
 *                      │             automatic retry; surfaced to the
 *                      │             caller (502) and the operator (log).
 *                      └──► refused  server answered 4xx/5xx after signing,
 *                                    no settlement.
 *   failed_before_signing             402 parse / budget / scheme error
 *                                     before any signature.
 *
 * Terminal states never change. `unknown → settled` is reserved for the
 * reconciliation task (out of scope here — see the TODO at the bottom): the
 * stored `authorizationNonce` and the authorization window are what it
 * needs to match an on-chain USDC transfer or to cancel the authorization.
 *
 * Idempotency: `(jobId, paymentId)` is unique. A retry with the same id
 * returns the existing row WITHOUT a second payment when it is `pending`,
 * `settled` or `unknown`; a `reserved` row means an attempt is in flight
 * (409); only `refused` / `failed_before_signing` rows may be retried, and
 * the retry reuses the same row. The id also travels to the server inside
 * the x402 `payment-identifier` extension so a cache-enabled server can
 * deduplicate on its side (the client itself re-signs on every attempt —
 * see docs/architecture/x402-payments.md §3).
 *
 * Outbound target (S4, `outbound-target.ts`): the URL is an agent-chosen
 * destination the backend connects to, so before the fetch the hostname is
 * resolved and refused if it is, or resolves to, a private / loopback /
 * link-local / reserved address (`400 INVALID_URL`); the connection is then
 * pinned to the resolved addresses through a per-request undici Agent; and
 * redirects are never followed — any 3xx is `400 REDIRECT_REFUSED`. The
 * range refusal is unconditional unless `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS`
 * is `true` (development / test only; boot refuses it in production).
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, ResourcePayment, ResourcePaymentStatus } from '@prisma/client';
import type { Agent } from 'undici';
import { formatUnits, parseUnits } from 'viem';
import { logger } from '../../api/middleware/logger.js';
import { env } from '../../config/env.js';
import { chainIdToNetwork } from '../../config/x402.js';
import {
  getKnownTokenByAddress,
  getKnownTokenBySymbol,
  type KnownToken,
} from '../transaction/token-registry.js';
import { toClientSigner, type TypedDataSigner } from '../wallet/signer.js';
import {
  OutboundTargetError,
  assertPublicTarget,
  createPinnedDispatcher,
  type OutboundTargetPolicy,
  type ValidatedTarget,
} from './outbound-target.js';
import {
  BudgetExceededError,
  NoAcceptableSchemeError,
  PaymentFailedError,
  X402ClientService,
  type AuthorizationInfo,
  type PayResourceResult,
  type SelectedPaymentOption,
  type TransportRequestInit,
} from './x402-client.service.js';

// ── Errors ──────────────────────────────────────────────────────────────────

export type ResourcePaymentErrorCode =
  | 'JOB_NOT_FOUND'
  | 'NOT_PROVIDER'
  | 'JOB_NOT_ACTIVE'
  | 'AGENT_INACTIVE'
  | 'POLICY_PAUSED'
  | 'INVALID_URL'
  | 'REDIRECT_REFUSED'
  | 'INVALID_BUDGET'
  | 'UNSUPPORTED_BUDGET_TOKEN'
  | 'UNSUPPORTED_ASSET'
  | 'BUDGET_EXCEEDED'
  | 'PAYMENT_IN_PROGRESS'
  | 'PAYMENT_ID_CONFLICT'
  | 'PAYMENT_REFUSED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_OUTCOME_UNKNOWN'
  | 'LEDGER_ERROR';

/** Typed failure; the route maps `httpStatus` + `code` + `details` to the response body. */
export class ResourcePaymentError extends Error {
  readonly code: ResourcePaymentErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ResourcePaymentErrorCode,
    httpStatus: number,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ResourcePaymentError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// ── Public types ────────────────────────────────────────────────────────────

export interface PayForResourceInput {
  jobId: string;
  /** The caller; must be the job's provider. */
  agentId: string;
  url: string;
  method: 'GET' | 'POST';
  /** JSON body for POST. */
  body?: unknown;
  /** Caller's own cap in USDC human units (e.g. `"0.50"`); the lower of this and the remaining budget applies. */
  maxAmount?: string;
  /** Idempotency key, unique per job. Server-generated UUID when omitted. */
  paymentId?: string;
}

export interface RemainingBudget {
  /** USDC contract on the job's chain. */
  asset: string;
  symbol: string;
  decimals: number;
  /** CAIP-2 network of the job's chain. */
  network: string;
  /** Base units. */
  total: string;
  spent: string;
  remaining: string;
  /** Human units, e.g. `"0.6"`. */
  remainingFormatted: string;
}

export interface ResourceSnapshot {
  status: number;
  /** Whitelisted response headers only. */
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON and fits the cap; otherwise text. */
  body: unknown;
  /** True when the body exceeded `MAX_RESOURCE_BODY_BYTES` and was cut. */
  truncated?: boolean;
}

export interface PayForResourceOutcome {
  /** `null` when the resource never asked for payment (free, or a non-402 error). */
  payment: ResourcePayment | null;
  remainingBudget: RemainingBudget;
  /** `null` on an idempotent replay: the resource is not fetched again. */
  resource: ResourceSnapshot | null;
  /** True when an existing `pending` / `settled` / `unknown` row was returned without a new payment. */
  replayed?: boolean;
  warning?: string;
}

export interface ResourcePaymentServiceDeps {
  db: PrismaClient;
  /** Wallet provider (`getWalletService()`); only `getWalletAddress` + `signTypedData` are used. */
  wallet: TypedDataSigner;
  client: X402ClientService;
  /**
   * Outbound target policy overrides (tests inject a resolver). Defaults:
   * `allowPrivateHosts` from `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS`, the
   * system resolver.
   */
  targetPolicy?: OutboundTargetPolicy;
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Statuses that count against the budget: money reserved, in flight, moved, or possibly moved. */
const COUNTED_STATUSES: ResourcePaymentStatus[] = ['reserved', 'pending', 'settled', 'unknown'];
/** A retry with the same id returns these rows as-is — never pay twice. */
const REPLAYABLE_STATUSES: ReadonlySet<ResourcePaymentStatus> = new Set(['pending', 'settled', 'unknown']);

/** Resource bodies returned to the caller are cut at this many bytes. */
export const MAX_RESOURCE_BODY_BYTES = 64 * 1024;

const RESPONSE_HEADER_WHITELIST = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'date',
  'x-request-id',
] as const;

const MAX_STORED_ERROR_LENGTH = 500;

const UNKNOWN_OUTCOME_WARNING =
  'Payment outcome is UNKNOWN: a signed authorization reached the server but no settlement was confirmed. ' +
  'The amount stays reserved against the job budget until an operator reconciles it; do not retry with a new paymentId.';

interface JobBudget {
  chainId: number;
  network: string;
  usdc: KnownToken;
  /** Base units. */
  total: bigint;
}

interface Target {
  /** Parsed request URL; its hostname is what the outbound target policy validates. */
  url: URL;
  /** Sent as-is (query strings may carry the resource's API key). */
  requestUrl: string;
  /** Origin + path only — what gets stored and logged. */
  storedUrl: string;
}

interface AttemptContext {
  jobId: string;
  agentId: string;
  paymentId: string;
  target: Target;
  method: 'GET' | 'POST';
  budget: JobBudget;
  /** Remaining budget at the time the request started (base units). */
  remaining: bigint;
  /** Effective per-payment cap (base units). */
  cap: bigint;
  /** A `refused` / `failed_before_signing` row being retried. */
  retryRowId?: string;
}

interface AttemptState {
  row?: ResourcePayment;
  selected?: SelectedPaymentOption;
}

/** The subset of a payment option the ledger stores. */
interface StoredOption {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

function clip(text: string, max = MAX_STORED_ERROR_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function sumAmounts(rows: Array<{ amount: string }>): bigint {
  let total = 0n;
  for (const row of rows) {
    if (/^\d+$/.test(row.amount)) total += BigInt(row.amount);
  }
  return total;
}

function optionFrom(value: unknown): StoredOption | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const { network, asset, amount, payTo } = candidate;
  if (
    typeof network === 'string' &&
    typeof asset === 'string' &&
    typeof amount === 'string' &&
    typeof payTo === 'string'
  ) {
    return { network, asset, amount, payTo };
  }
  return undefined;
}

function firstOption(value: unknown): StoredOption | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const option = optionFrom(entry);
    if (option) return option;
  }
  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Transaction hash named by an EIP-712 receipt payload, if any. */
function receiptTransaction(receipt: unknown): string | undefined {
  if (typeof receipt !== 'object' || receipt === null) return undefined;
  const payload = (receipt as { payload?: { transaction?: unknown } }).payload;
  const tx = payload?.transaction;
  return typeof tx === 'string' && tx.length > 0 ? tx : undefined;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** `Location` resolved against the request URL, stripped like `storedUrl`; `null` when absent or unparseable. */
function redirectLocation(result: PayResourceResult, requestUrl: string): string | null {
  const raw = result.headers['location'];
  if (!raw) return null;
  try {
    const resolved = new URL(raw, requestUrl);
    resolved.search = '';
    resolved.hash = '';
    resolved.username = '';
    resolved.password = '';
    return clip(resolved.toString());
  } catch {
    return null;
  }
}

/** Tears down the per-request pinned Agent; the response body has been read by then. */
async function destroyDispatcher(dispatcher: Agent): Promise<void> {
  try {
    await dispatcher.destroy();
  } catch (error) {
    logger.debug({ err: error }, 'Could not destroy the pinned resource-payment dispatcher');
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
}

// ── Service ─────────────────────────────────────────────────────────────────

export class ResourcePaymentService {
  private readonly db: PrismaClient;
  private readonly wallet: TypedDataSigner;
  private readonly client: X402ClientService;
  private readonly targetPolicy: OutboundTargetPolicy;

  constructor(deps: ResourcePaymentServiceDeps) {
    this.db = deps.db;
    this.wallet = deps.wallet;
    this.client = deps.client;
    this.targetPolicy = {
      allowPrivateHosts: env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS === 'true',
      ...deps.targetPolicy,
    };
  }

  async payForResource(input: PayForResourceInput): Promise<PayForResourceOutcome> {
    const target = this.parseUrl(input.url);

    const job = await this.db.job.findUnique({
      where: { id: input.jobId },
      select: { id: true, providerId: true, requesterId: true, status: true, reward: true },
    });
    if (!job) throw new ResourcePaymentError('JOB_NOT_FOUND', 404, 'Job not found');
    if (job.providerId !== input.agentId) {
      const who = job.requesterId === input.agentId ? 'the requester' : 'not involved in this job';
      throw new ResourcePaymentError(
        'NOT_PROVIDER',
        403,
        `Only the job's provider can pay for resources from its budget; the caller is ${who}`,
      );
    }
    if (job.status !== 'ACCEPTED') {
      throw new ResourcePaymentError(
        'JOB_NOT_ACTIVE',
        409,
        `Job is ${job.status}; resources can only be paid for while the job is ACCEPTED`,
        { status: job.status },
      );
    }

    const agent = await this.db.agent.findUnique({
      where: { id: input.agentId },
      select: { id: true, active: true, walletId: true, policy: { select: { active: true, expiresAt: true } } },
    });
    if (!agent || !agent.active) {
      throw new ResourcePaymentError('AGENT_INACTIVE', 403, 'Agent is deactivated');
    }
    if (agent.policy && !agent.policy.active) {
      throw new ResourcePaymentError('POLICY_PAUSED', 403, 'Agent policy is paused (kill switch active)');
    }
    if (agent.policy?.expiresAt && agent.policy.expiresAt < new Date()) {
      throw new ResourcePaymentError(
        'POLICY_PAUSED',
        403,
        `Agent policy expired at ${agent.policy.expiresAt.toISOString()}. Update the policy to continue.`,
      );
    }

    const budget = this.resolveBudget(job.reward);
    const paymentId = input.paymentId ?? randomUUID();

    // Idempotency: one row per (job, paymentId).
    const existing = await this.db.resourcePayment.findUnique({
      where: { jobId_paymentId: { jobId: job.id, paymentId } },
    });
    if (existing) {
      if (existing.url !== target.storedUrl || existing.method !== input.method) {
        throw new ResourcePaymentError(
          'PAYMENT_ID_CONFLICT',
          409,
          'paymentId was already used for a different resource on this job',
          { paymentId, url: existing.url, method: existing.method },
        );
      }
      if (REPLAYABLE_STATUSES.has(existing.status)) {
        logger.info(
          { jobId: job.id, paymentId, status: existing.status, url: existing.url },
          'Resource payment replayed from the ledger (no new payment)',
        );
        return {
          payment: existing,
          remainingBudget: await this.remainingBudget(job.id, budget),
          resource: null,
          replayed: true,
          ...(existing.status === 'unknown' ? { warning: UNKNOWN_OUTCOME_WARNING } : {}),
        };
      }
      if (existing.status === 'reserved') {
        throw new ResourcePaymentError(
          'PAYMENT_IN_PROGRESS',
          409,
          'A payment with this paymentId is already in progress on this job',
          { paymentId },
        );
      }
      // refused / failed_before_signing: a fresh attempt on the same row.
    }

    const spent = await this.spent(job.id);
    const remaining = budget.total - spent;
    let cap = remaining;
    if (input.maxAmount !== undefined) {
      const max = parseUnits(input.maxAmount, budget.usdc.decimals);
      if (max < cap) cap = max;
    }
    if (cap <= 0n) {
      throw new ResourcePaymentError(
        'BUDGET_EXCEEDED',
        402,
        remaining <= 0n
          ? 'The job budget is exhausted'
          : 'maxAmount leaves nothing to spend from the job budget',
        {
          paymentId,
          price: null,
          ...this.budgetDetails(budget, remaining, cap),
          payment: null,
        },
      );
    }

    // Resolve before you connect: refuse a private / loopback / reserved
    // destination (literal or resolved), and keep the addresses to pin to.
    const validated = await this.validateTarget(target, paymentId);

    const signer = await toClientSigner(this.wallet, agent.walletId);
    const ctx: AttemptContext = {
      jobId: job.id,
      agentId: input.agentId,
      paymentId,
      target,
      method: input.method,
      budget,
      remaining,
      cap,
      ...(existing ? { retryRowId: existing.id } : {}),
    };
    const attempt: AttemptState = {};

    // Pin what you validated: every socket of this exchange (plain request
    // and paid request alike) can only reach the resolved addresses.
    const dispatcher = createPinnedDispatcher(validated);

    let result: PayResourceResult;
    try {
      result = await this.client.payResource({
        signer,
        url: target.requestUrl,
        init: this.buildInit(input.method, input.body, dispatcher),
        maxAmountUsd: formatUnits(cap, budget.usdc.decimals),
        allowedNetworks: [budget.network],
        paymentId,
        // Before any signature: USDC-only check, then the durable reservation
        // (re-checks the budget under a Job row lock).
        onBeforeSign: async (selected) => {
          attempt.selected = selected;
          this.assertUsdc(selected, budget);
          attempt.row = await this.reserve(ctx, selected);
        },
        // After signing, before sending: record the nonce. If this write
        // fails the signed payload never leaves the process.
        onAuthorizationSigned: async (authorization) => {
          attempt.row = await this.markPending(attempt.row, authorization);
        },
      });
    } catch (error) {
      throw await this.recordFailure(error, ctx, attempt);
    } finally {
      await destroyDispatcher(dispatcher);
    }

    return this.recordOutcome(result, ctx, attempt);
  }

  // ── Outcome recording ─────────────────────────────────────────────────────

  private async recordOutcome(
    result: PayResourceResult,
    ctx: AttemptContext,
    attempt: AttemptState,
  ): Promise<PayForResourceOutcome> {
    // A redirect is never followed and never delivered as the resource (S4).
    if (isRedirect(result.status)) return this.refuseRedirect(result, ctx, attempt);

    const resource = this.snapshot(result);

    if (!result.payment) {
      // Never saw a 402: free resource or a non-payment error. Nothing to record.
      return { payment: null, remainingBudget: await this.remainingBudget(ctx.jobId, ctx.budget), resource };
    }

    const row = this.requireRow(attempt, ctx);
    const payment = result.payment;

    if (result.paid) {
      const settled = await this.markSettled(row, result, payment, ctx);
      return { payment: settled, remainingBudget: await this.remainingBudget(ctx.jobId, ctx.budget), resource };
    }

    if (result.status < 400) {
      // 2xx without a settlement report: the server accepted the paid request
      // but told us nothing about the money. Treat as unknown-until-reconciled.
      const unknown = await this.db.resourcePayment.update({
        where: { id: row.id },
        data: {
          status: 'unknown',
          responseStatus: result.status,
          error: 'Server accepted the paid request without reporting a settlement (no PAYMENT-RESPONSE header)',
        },
      });
      this.logUnknown(ctx, unknown, payment.authorization);
      return {
        payment: unknown,
        remainingBudget: await this.remainingBudget(ctx.jobId, ctx.budget),
        resource,
        warning: UNKNOWN_OUTCOME_WARNING,
      };
    }

    // 4xx/5xx after signing with no settlement report: refused.
    const refused = await this.db.resourcePayment.update({
      where: { id: row.id },
      data: {
        status: 'refused',
        responseStatus: result.status,
        error: `HTTP ${result.status} after signing, no settlement reported`,
      },
    });
    throw new ResourcePaymentError(
      'PAYMENT_REFUSED',
      402,
      `The resource server answered HTTP ${result.status} to the signed payment without settling it`,
      { paymentId: ctx.paymentId, responseStatus: result.status, payment: refused, resource },
    );
  }

  /**
   * A 3xx from a paid resource is refused (`400 REDIRECT_REFUSED`), before or
   * after signing. It was not followed (`redirect: 'manual'`): following
   * would send the request — and after signing the `PAYMENT-SIGNATURE` — to
   * an origin that never went through the target policy. The ledger records
   * what the money did: nothing signed → no row; signed without a settlement
   * report → `refused` (like any non-2xx after signing); signed and reported
   * settled → `settled`, because the amount is spent even though the resource
   * was not delivered.
   */
  private async refuseRedirect(
    result: PayResourceResult,
    ctx: AttemptContext,
    attempt: AttemptState,
  ): Promise<never> {
    const location = redirectLocation(result, ctx.target.requestUrl);
    const where = location ? ` to ${location}` : '';
    const details = { paymentId: ctx.paymentId, responseStatus: result.status, location };

    if (!result.payment) {
      throw new ResourcePaymentError(
        'REDIRECT_REFUSED',
        400,
        `The resource answered HTTP ${result.status} (redirect${where}); redirects are not followed for paid resources. Nothing was signed.`,
        { ...details, payment: null },
      );
    }

    const row = this.requireRow(attempt, ctx);
    if (result.paid) {
      const settled = await this.markSettled(
        row,
        result,
        result.payment,
        ctx,
        `Settled, but the resource answered HTTP ${result.status} (redirect${where}), which was not followed`,
      );
      throw new ResourcePaymentError(
        'REDIRECT_REFUSED',
        400,
        `The resource server reported the payment settled but answered HTTP ${result.status} (redirect${where}) instead of the resource; redirects are not followed. The amount is spent — do not retry with a new paymentId.`,
        { ...details, payment: settled },
      );
    }

    const refused = await this.db.resourcePayment.update({
      where: { id: row.id },
      data: {
        status: 'refused',
        responseStatus: result.status,
        error: clip(`HTTP ${result.status} redirect${where} after signing, not followed; no settlement reported`),
      },
    });
    logger.warn(
      { jobId: ctx.jobId, paymentId: ctx.paymentId, agentId: ctx.agentId, url: ctx.target.storedUrl, location, status: result.status },
      'Paid resource answered a signed payment with a redirect — not followed, recorded as refused',
    );
    throw new ResourcePaymentError(
      'REDIRECT_REFUSED',
      400,
      `The resource server answered the signed payment with HTTP ${result.status} (redirect${where}) without settling it; redirects are not followed for paid resources`,
      { ...details, payment: refused },
    );
  }

  /** The client only reports `payment` after the signing hooks ran, so a row must exist. */
  private requireRow(attempt: AttemptState, ctx: AttemptContext): ResourcePayment {
    if (!attempt.row) {
      throw new ResourcePaymentError('LEDGER_ERROR', 500, 'Payment reported without a ledger row', {
        paymentId: ctx.paymentId,
      });
    }
    return attempt.row;
  }

  private async markSettled(
    row: ResourcePayment,
    result: PayResourceResult,
    payment: NonNullable<PayResourceResult['payment']>,
    ctx: AttemptContext,
    note?: string,
  ): Promise<ResourcePayment> {
    const receiptUnverified = payment.receipt !== undefined && payment.receiptVerified === false;
    const settled = await this.db.resourcePayment.update({
      where: { id: row.id },
      data: {
        status: 'settled',
        settlementTxHash: payment.txHash ?? receiptTransaction(payment.receipt) ?? null,
        ...(payment.receipt !== undefined ? { receipt: payment.receipt as Prisma.InputJsonValue } : {}),
        receiptVerified: payment.receiptVerified ?? null,
        responseStatus: result.status,
        error: note ? clip(note) : null,
      },
    });
    const log = {
      jobId: ctx.jobId,
      paymentId: ctx.paymentId,
      agentId: ctx.agentId,
      url: ctx.target.storedUrl,
      amount: payment.amount,
      network: payment.network,
      txHash: settled.settlementTxHash,
      receiptVerified: settled.receiptVerified,
    };
    if (note) {
      logger.warn({ ...log, status: result.status }, `Resource payment settled without delivering the resource: ${note}`);
    } else if (receiptUnverified) {
      logger.warn(log, 'Resource payment settled but the offer-receipt did not verify against the offer — marked unverified');
    } else {
      logger.info(log, 'Resource payment settled');
    }
    return settled;
  }

  /** Records what the ledger can about a failed attempt and returns the error to throw. */
  private async recordFailure(error: unknown, ctx: AttemptContext, attempt: AttemptState): Promise<Error> {
    const { paymentId } = ctx;

    if (error instanceof ResourcePaymentError) {
      if (error.code === 'UNSUPPORTED_ASSET' || error.code === 'BUDGET_EXCEEDED') {
        // Raised by our own pre-signing hook; the selected option is known.
        const row = attempt.selected ? await this.recordRefusalBeforeSigning(ctx, attempt.selected, error.message) : null;
        return new ResourcePaymentError(error.code, error.httpStatus, error.message, { ...error.details, payment: row });
      }
      if (error.code === 'PAYMENT_IN_PROGRESS') return error;
      // LEDGER_ERROR from `markPending`: signed, but the payload never left.
      if (attempt.row) {
        await this.safeUpdate(attempt.row.id, { status: 'failed_before_signing', error: clip(error.message) });
      }
      return error;
    }

    if (error instanceof BudgetExceededError) {
      const option = optionFrom(error.details['cheapest']) ?? optionFrom(error.details['selected']);
      const row = option ? await this.recordRefusalBeforeSigning(ctx, option, error.message) : null;
      return new ResourcePaymentError('BUDGET_EXCEEDED', 402, error.message, {
        paymentId,
        price: option?.amount ?? null,
        ...(option ? { priceFormatted: formatUnits(BigInt(option.amount), ctx.budget.usdc.decimals) } : {}),
        ...this.budgetDetails(ctx.budget, ctx.remaining, ctx.cap),
        payment: row,
      });
    }

    if (error instanceof NoAcceptableSchemeError) {
      const offered = error.details['offered'] ?? error.details['rejected'];
      const option = firstOption(offered);
      const row = option ? await this.recordRefusalBeforeSigning(ctx, option, error.message) : null;
      return new ResourcePaymentError(
        'UNSUPPORTED_ASSET',
        400,
        `The resource does not accept USDC on ${ctx.budget.network} within the allowed authorization window: ${error.message}`,
        {
          paymentId,
          required: { network: ctx.budget.network, asset: ctx.budget.usdc.address, symbol: 'USDC' },
          offered: Array.isArray(offered) ? offered : [],
          payment: row,
        },
      );
    }

    if (error instanceof PaymentFailedError) {
      const details = error.details;
      if (details['authorizationSent'] !== true) {
        // 402 unparseable, library refused to create the payment, or the plain
        // request failed / timed out: nothing was signed.
        let row: ResourcePayment | null = attempt.row ?? null;
        if (row) row = await this.safeUpdate(row.id, { status: 'failed_before_signing', error: clip(error.message) });
        return new ResourcePaymentError('PAYMENT_FAILED', 502, error.message, {
          paymentId,
          stage: details['stage'],
          timedOut: details['timedOut'] === true,
          payment: row,
        });
      }

      const authorization = details['authorization'] as AuthorizationInfo | undefined;
      let row: ResourcePayment | null = attempt.row ?? null;
      if (!row && attempt.selected) {
        // Defensive: a signature left the process but the ledger has no row.
        row = await this.recordRefusalBeforeSigning(ctx, attempt.selected, 'signed without a reservation');
      }

      if (typeof details['status'] === 'number') {
        // The server answered the signed payment: rejected at verification or
        // settlement failed. No settlement happened.
        const reason = typeof details['reason'] === 'string' ? details['reason'] : error.message;
        if (row) {
          row = await this.safeUpdate(row.id, {
            status: 'refused',
            responseStatus: details['status'],
            ...(authorization ? { authorizationNonce: authorization.nonce } : {}),
            error: clip(reason),
          });
        }
        return new ResourcePaymentError('PAYMENT_REFUSED', 402, error.message, {
          paymentId,
          responseStatus: details['status'],
          reason,
          payment: row,
        });
      }

      // Transport failure or timeout after the signed payload left: unknown.
      if (row) {
        row = await this.safeUpdate(row.id, {
          status: 'unknown',
          ...(authorization ? { authorizationNonce: authorization.nonce } : {}),
          error: clip(error.message),
        });
        this.logUnknown(ctx, row, authorization);
      }
      return new ResourcePaymentError(
        'PAYMENT_OUTCOME_UNKNOWN',
        502,
        `${error.message}. The server may still settle the authorization; the amount stays reserved until reconciled. Do not retry with a new paymentId.`,
        {
          paymentId,
          timedOut: details['timedOut'] === true,
          ...(authorization
            ? {
                authorization: {
                  method: authorization.method,
                  nonce: authorization.nonce,
                  validAfter: authorization.validAfter,
                  validBefore: authorization.validBefore,
                },
              }
            : {}),
          payment: row,
        },
      );
    }

    // Anything else (signer failure, DB error, library bug).
    if (attempt.row) {
      const next: ResourcePaymentStatus = attempt.row.status === 'pending' ? 'unknown' : 'failed_before_signing';
      const row = await this.safeUpdate(attempt.row.id, {
        status: next,
        error: clip(error instanceof Error ? error.message : String(error)),
      });
      if (next === 'unknown') this.logUnknown(ctx, row, undefined);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  // ── Ledger writes ─────────────────────────────────────────────────────────

  /**
   * Creates (or, on a retry, resets) the row as `reserved`, re-checking the
   * budget under a row lock on the Job so concurrent reservations serialize.
   */
  private async reserve(ctx: AttemptContext, selected: SelectedPaymentOption): Promise<ResourcePayment> {
    const price = BigInt(selected.amount);
    const decimals = ctx.budget.usdc.decimals;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${ctx.jobId} FOR UPDATE`;
        const rows = await tx.resourcePayment.findMany({
          where: { jobId: ctx.jobId, status: { in: COUNTED_STATUSES } },
          select: { amount: true },
        });
        const remaining = ctx.budget.total - sumAmounts(rows);
        if (price > remaining) {
          throw new ResourcePaymentError(
            'BUDGET_EXCEEDED',
            402,
            `The resource costs ${formatUnits(price, decimals)} USDC but only ${formatUnits(remaining, decimals)} USDC of the job budget remains`,
            {
              paymentId: ctx.paymentId,
              price: selected.amount,
              priceFormatted: formatUnits(price, decimals),
              ...this.budgetDetails(ctx.budget, remaining, ctx.cap < remaining ? ctx.cap : remaining),
            },
          );
        }
        const data = {
          status: 'reserved' as const,
          url: ctx.target.storedUrl,
          method: ctx.method,
          network: selected.network,
          asset: selected.asset,
          amount: selected.amount,
          payTo: selected.payTo,
          authorizationNonce: null,
          receiptVerified: null,
          settlementTxHash: null,
          responseStatus: null,
          error: null,
        };
        if (ctx.retryRowId) {
          return tx.resourcePayment.update({ where: { id: ctx.retryRowId }, data });
        }
        return tx.resourcePayment.create({
          data: { jobId: ctx.jobId, agentId: ctx.agentId, paymentId: ctx.paymentId, ...data },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ResourcePaymentError(
          'PAYMENT_IN_PROGRESS',
          409,
          'A payment with this paymentId is already in progress on this job',
          { paymentId: ctx.paymentId },
        );
      }
      throw error;
    }
  }

  private async markPending(
    row: ResourcePayment | undefined,
    authorization: AuthorizationInfo,
  ): Promise<ResourcePayment> {
    if (!row) {
      throw new ResourcePaymentError('LEDGER_ERROR', 500, 'Authorization signed without a reservation', {});
    }
    try {
      return await this.db.resourcePayment.update({
        where: { id: row.id },
        data: { status: 'pending', authorizationNonce: authorization.nonce },
      });
    } catch (error) {
      throw new ResourcePaymentError(
        'LEDGER_ERROR',
        500,
        `Could not record the signed authorization; the payment was not sent: ${clip(error instanceof Error ? error.message : String(error), 200)}`,
        {},
      );
    }
  }

  /** Best-effort `failed_before_signing` row for a refusal where the price is known. */
  private async recordRefusalBeforeSigning(
    ctx: AttemptContext,
    option: StoredOption,
    error: string,
  ): Promise<ResourcePayment | null> {
    const fields = {
      url: ctx.target.storedUrl,
      method: ctx.method,
      network: option.network,
      asset: option.asset,
      amount: option.amount,
      payTo: option.payTo,
      status: 'failed_before_signing' as const,
      authorizationNonce: null,
      receiptVerified: null,
      settlementTxHash: null,
      responseStatus: null,
      error: clip(error),
    };
    try {
      return await this.db.resourcePayment.upsert({
        where: { jobId_paymentId: { jobId: ctx.jobId, paymentId: ctx.paymentId } },
        create: { jobId: ctx.jobId, agentId: ctx.agentId, paymentId: ctx.paymentId, ...fields },
        update: fields,
      });
    } catch (dbError) {
      logger.error(
        { jobId: ctx.jobId, paymentId: ctx.paymentId, err: dbError },
        'Could not record a refused resource payment (nothing was signed)',
      );
      return null;
    }
  }

  private async safeUpdate(id: string, data: Prisma.ResourcePaymentUpdateInput): Promise<ResourcePayment | null> {
    try {
      return await this.db.resourcePayment.update({ where: { id }, data });
    } catch (error) {
      logger.error({ resourcePaymentId: id, data, err: error }, 'Could not update the resource payment ledger row');
      return null;
    }
  }

  private logUnknown(ctx: AttemptContext, row: ResourcePayment | null, authorization: AuthorizationInfo | undefined): void {
    // Operator signal. TODO(P5 reconciliation): a worker should match the
    // nonce against on-chain USDC `AuthorizationUsed` events / transfers to
    // `payTo` before `validBefore`, flip `unknown → settled` with the tx hash,
    // or cancel the authorization once the window has passed.
    logger.error(
      {
        jobId: ctx.jobId,
        paymentId: ctx.paymentId,
        agentId: ctx.agentId,
        resourcePaymentId: row?.id,
        url: ctx.target.storedUrl,
        amount: row?.amount,
        network: row?.network,
        payTo: row?.payTo,
        nonce: authorization?.nonce ?? row?.authorizationNonce,
        validBefore: authorization?.validBefore,
      },
      'Resource payment outcome UNKNOWN after signing — amount stays reserved; manual reconciliation required (no automatic retry)',
    );
  }

  // ── Budget ────────────────────────────────────────────────────────────────

  /** The job reward must be USDC on the job's chain; anything else cannot be converted without an oracle. */
  private resolveBudget(reward: unknown): JobBudget {
    const r = (typeof reward === 'object' && reward !== null ? reward : {}) as {
      amount?: unknown;
      token?: unknown;
      chainId?: unknown;
    };
    if (typeof r.amount !== 'string' || !/^\d+(\.\d+)?$/.test(r.amount) || !(Number(r.amount) > 0)) {
      throw new ResourcePaymentError('INVALID_BUDGET', 400, 'The job has no positive reward amount to pay resources from');
    }
    const chainId = typeof r.chainId === 'number' && Number.isInteger(r.chainId) && r.chainId > 0 ? r.chainId : 1;
    const token = typeof r.token === 'string' ? r.token : 'ETH';
    const usdc = getKnownTokenBySymbol('USDC', chainId);
    if (!usdc) {
      throw new ResourcePaymentError(
        'UNSUPPORTED_BUDGET_TOKEN',
        400,
        `No USDC is known on chain ${chainId}; resource payments need a USDC-denominated job on a supported chain`,
        { chainId, token },
      );
    }
    const isUsdc =
      token.toUpperCase() === 'USDC' || getKnownTokenByAddress(token, chainId)?.symbol === 'USDC';
    if (!isUsdc) {
      throw new ResourcePaymentError(
        'UNSUPPORTED_BUDGET_TOKEN',
        400,
        `The job reward is denominated in ${token}; resource payments are only supported for USDC-denominated jobs (no oracle conversion)`,
        { chainId, token },
      );
    }
    return {
      chainId,
      network: chainIdToNetwork(chainId),
      usdc,
      total: parseUnits(r.amount, usdc.decimals),
    };
  }

  private assertUsdc(selected: SelectedPaymentOption, budget: JobBudget): void {
    if (
      selected.network !== budget.network ||
      selected.asset.toLowerCase() !== budget.usdc.address.toLowerCase()
    ) {
      throw new ResourcePaymentError(
        'UNSUPPORTED_ASSET',
        400,
        `The resource asks for ${selected.symbol} (${selected.asset}) on ${selected.network}; only USDC on ${budget.network} can be paid from this job`,
        { required: { network: budget.network, asset: budget.usdc.address, symbol: 'USDC' }, offered: [selected] },
      );
    }
  }

  private async spent(jobId: string): Promise<bigint> {
    const rows = await this.db.resourcePayment.findMany({
      where: { jobId, status: { in: COUNTED_STATUSES } },
      select: { amount: true },
    });
    return sumAmounts(rows);
  }

  private async remainingBudget(jobId: string, budget: JobBudget): Promise<RemainingBudget> {
    const spent = await this.spent(jobId);
    const remaining = budget.total - spent;
    return {
      asset: budget.usdc.address,
      symbol: 'USDC',
      decimals: budget.usdc.decimals,
      network: budget.network,
      total: budget.total.toString(),
      spent: spent.toString(),
      remaining: remaining.toString(),
      remainingFormatted: formatUnits(remaining, budget.usdc.decimals),
    };
  }

  private budgetDetails(budget: JobBudget, remaining: bigint, cap: bigint) {
    const decimals = budget.usdc.decimals;
    return {
      remaining: remaining.toString(),
      remainingFormatted: formatUnits(remaining, decimals),
      cap: cap.toString(),
      capFormatted: formatUnits(cap, decimals),
      asset: budget.usdc.address,
      network: budget.network,
    };
  }

  // ── Request / response shaping ────────────────────────────────────────────

  private parseUrl(raw: string): Target {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ResourcePaymentError('INVALID_URL', 400, 'url must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ResourcePaymentError('INVALID_URL', 400, 'url must use http or https');
    }
    // Where the URL may point is decided by `validateTarget` (resolved
    // addresses, every environment), not here.
    const stored = new URL(parsed.toString());
    stored.search = '';
    stored.hash = '';
    stored.username = '';
    stored.password = '';
    return { url: parsed, requestUrl: parsed.toString(), storedUrl: stored.toString() };
  }

  /**
   * Outbound target policy (S4): refuse a private / loopback / link-local /
   * reserved destination — literal, or any address the hostname resolves to
   * — and return the addresses the connection will be pinned to. Refusals
   * are `400 INVALID_URL` with `refusal`, `hostname` and (for a resolved
   * address) `address`; a transient resolver failure is `502 PAYMENT_FAILED`
   * with `stage: "resolve"`. Nothing is recorded or signed either way.
   */
  private async validateTarget(target: Target, paymentId: string): Promise<ValidatedTarget> {
    try {
      return await assertPublicTarget(target.url, this.targetPolicy);
    } catch (error) {
      if (!(error instanceof OutboundTargetError)) throw error;
      logger.warn(
        { paymentId, url: target.storedUrl, refusal: error.refusal, hostname: error.hostname, address: error.address },
        'Resource payment target refused by the outbound target policy',
      );
      if (error.refusal === 'resolver-failed') {
        throw new ResourcePaymentError('PAYMENT_FAILED', 502, error.message, {
          paymentId,
          stage: 'resolve',
          timedOut: false,
          payment: null,
        });
      }
      throw new ResourcePaymentError('INVALID_URL', 400, error.message, {
        refusal: error.refusal,
        hostname: error.hostname,
        ...(error.address !== undefined ? { address: error.address } : {}),
      });
    }
  }

  private buildInit(method: 'GET' | 'POST', body: unknown, dispatcher: Agent): TransportRequestInit {
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
    // `redirect: 'manual'`: a 3xx comes back to `recordOutcome` and is refused.
    const transport = { redirect: 'manual' as const, dispatcher };
    if (method === 'POST' && body !== undefined) {
      headers['content-type'] = 'application/json';
      return { method, headers, body: JSON.stringify(body), ...transport };
    }
    return { method, headers, ...transport };
  }

  private snapshot(result: PayResourceResult): ResourceSnapshot {
    const headers: Record<string, string> = {};
    for (const name of RESPONSE_HEADER_WHITELIST) {
      const value = result.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    let text = result.body;
    let truncated = false;
    if (Buffer.byteLength(text, 'utf8') > MAX_RESOURCE_BODY_BYTES) {
      text = truncateUtf8(text, MAX_RESOURCE_BODY_BYTES);
      truncated = true;
    }
    let body: unknown = text;
    if (!truncated && /json/i.test(result.headers['content-type'] ?? '')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: result.status, headers, body, ...(truncated ? { truncated: true } : {}) };
  }
}
