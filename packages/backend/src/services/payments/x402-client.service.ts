/**
 * X402ClientService — pays HTTP 402 resources with x402 (v2 line) under
 * explicit spend controls.
 *
 * Flow per call (`payResource`):
 *   1. Plain request. Non-402 → returned as-is, `paid: false`, nothing signed.
 *   2. 402 → decode `PAYMENT-REQUIRED`. Before anything is signed, the
 *      offered options are checked against `allowedNetworks`, the longest
 *      authorization validity window we accept and `maxAmountUsd` by *this*
 *      service (typed errors) — the x402 client's own `spendControls` filter
 *      and a window policy run after that as a second gate, and the
 *      `onBeforePaymentCreation` hook re-checks the finally selected option
 *      (third gate; aborts the signature if it disagrees).
 *   3. Sign an EIP-3009 / Permit2 authorization with the agent's wallet
 *      signer, resend with `PAYMENT-SIGNATURE`, decode `PAYMENT-RESPONSE`.
 *      The authorization's nonce and validity window are surfaced on the
 *      result — and on every failure after signing — so the caller can
 *      cancel or reconcile it.
 *   4. If the server returned a signed offer/receipt, verify the receipt
 *      signature and that it is bound to the accepted offer and our payer.
 *
 * Every call signs a fresh authorization (new nonce). `paymentId` only lets
 * the resource server deduplicate; it never prevents a second signature.
 *
 * The buyer never contacts a facilitator: the resource server does. What
 * this service proves is therefore "the server told us it settled", not
 * "USDC moved on-chain" — see docs/architecture/x402-payments.md.
 *
 * Transport: `init.redirect` defaults to `'manual'` — a 3xx comes back as-is
 * and is never followed, because following would re-send the signed
 * `PAYMENT-SIGNATURE` to whatever origin `Location` names. `init.dispatcher`
 * (undici) is forwarded explicitly on every transport call so a caller can
 * pin the connection to addresses it validated (S4 — see
 * `outbound-target.ts`); `@x402/fetch` only hands this service `Request`
 * objects, so the init is not available to the transport by itself. The
 * default transport is the `undici` package's own `fetch`
 * (`undiciTransport`), never Node's built-in one, so a dispatcher built from
 * that package is always driven by the same undici copy whatever the Node
 * version bundles.
 *
 * Bounded reads (P6): no response body is ever read whole. The final
 * response body is read up to `maxBodyBytes` (default 64 KiB) and the
 * transfer is aborted beyond it (`bodyTruncated: true`); the body of a plain
 * 402 is read up to `maxPaymentRequiredBytes` (default 16 KiB) and a larger
 * one is refused before anything is signed. A provider can therefore not
 * make the backend buffer an unbounded answer.
 */

import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { convertToTokenAmount, networkMatchesPattern, parseMoney } from '@x402/core/utils';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import {
  OFFER_RECEIPT,
  decodeSignedOffers,
  extractOffersFromPaymentRequired,
  isEIP712SignedOffer,
  isEIP712SignedReceipt,
  verifyOfferSignatureEIP712,
  verifyReceiptMatchesOffer,
  verifyReceiptSignatureEIP712,
  type DecodedOffer,
  type SignedReceipt,
} from '@x402/extensions/offer-receipt';
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  extractPaymentIdentifier,
  generatePaymentId,
  isPaymentIdentifierExtension,
  isValidPaymentId,
} from '@x402/extensions/payment-identifier';
import { wrapFetchWithPayment } from '@x402/fetch';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { formatUnits } from 'viem';
import { sanitizeContextFromEnv, sanitizeText } from '../../api/errors/sanitize.js';
import type { ClientSigner } from '../wallet/signer.js';

// ── Errors ──────────────────────────────────────────────────────────────────

export type X402ErrorCode = 'BUDGET_EXCEEDED' | 'NO_ACCEPTABLE_SCHEME' | 'PAYMENT_FAILED';

export class X402PaymentError extends Error {
  readonly code: X402ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: X402ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'X402PaymentError';
    this.code = code;
    this.details = details;
  }
}

/** Every offered option costs more than `maxAmountUsd`. Nothing was signed. */
export class BudgetExceededError extends X402PaymentError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('BUDGET_EXCEEDED', message, details);
    this.name = 'BudgetExceededError';
  }
}

/**
 * No offered option is `exact` on an allowed network with a USD-pegged asset
 * and an authorization window within `maxAuthorizationWindowSeconds`.
 * Nothing was signed.
 */
export class NoAcceptableSchemeError extends X402PaymentError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('NO_ACCEPTABLE_SCHEME', message, details);
    this.name = 'NoAcceptableSchemeError';
  }
}

/**
 * The 402 could not be parsed, the library refused to create a payment, the
 * server rejected the signed payment, the settlement failed, or a request
 * failed or timed out in transit. Check `details.authorizationSent`: when
 * true a signed authorization left this process and the outcome is unknown
 * until reconciled — `details.authorization` carries its nonce and window.
 */
export class PaymentFailedError extends X402PaymentError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PAYMENT_FAILED', message, details);
    this.name = 'PaymentFailedError';
  }
}

// ── Public types ────────────────────────────────────────────────────────────

/**
 * `RequestInit` plus undici's `dispatcher`: the Agent the transport must use
 * (e.g. one pinned to validated addresses). Not part of the DOM typing, but
 * Node's `fetch` reads it on every call.
 */
export interface TransportRequestInit extends RequestInit {
  dispatcher?: Dispatcher;
}

export interface PayResourceParams {
  /** Wallet-backed signer (`toClientSigner(...)`) or any `{ address, signTypedData }`. */
  signer: ClientSigner;
  url: string;
  /** `redirect` defaults to `'manual'` (3xx returned, never followed); `dispatcher` is forwarded to every transport call. */
  init?: TransportRequestInit;
  /** Per-payment USD cap, e.g. `"$1"`, `"0.50"`. Required — no implicit default. */
  maxAmountUsd: string;
  /**
   * CAIP-2 networks the payment may settle on, e.g. `["eip155:84532"]`.
   * Required and non-empty; there is no "any network" default. Exact ids
   * only unless `allowWildcardNetworks` is set.
   */
  allowedNetworks: string[];
  /** Opt in to wildcard patterns such as `"eip155:*"` in `allowedNetworks`. Default `false`. */
  allowWildcardNetworks?: boolean;
  /** Idempotency key sent via the `payment-identifier` extension. Generated when omitted. */
  paymentId?: string;
  /** Per-phase transport timeout in milliseconds. Overrides the service default (30 000). */
  requestTimeoutMs?: number;
  /** Longest final response body read, in bytes; the transfer is aborted beyond it. Overrides the service default. */
  maxBodyBytes?: number;
  /**
   * Longest authorization validity window (seconds from signing) this call
   * accepts. Options whose `maxTimeoutSeconds` exceeds it are not acceptable.
   * Overrides the service default (`MAX_AUTHORIZATION_WINDOW_SECONDS`).
   */
  maxAuthorizationWindowSeconds?: number;
  /**
   * Called once an option has passed every spend gate and **before anything
   * is signed**. A durable ledger (P2/P5) reserves the amount here. Throwing
   * aborts the payment: nothing is signed and the thrown error is rethrown
   * unchanged by `payResource`.
   */
  onBeforeSign?: (selected: SelectedPaymentOption) => Promise<void> | void;
  /**
   * Called right after the authorization is signed and **before the paid
   * request leaves the process**. The ledger records the nonce here. Throwing
   * aborts the send — the signature exists but never reaches the server —
   * and the thrown error is rethrown unchanged by `payResource`.
   */
  onAuthorizationSigned?: (
    authorization: AuthorizationInfo,
    selected: SelectedPaymentOption,
  ) => Promise<void> | void;
}

/** The payment option the client is about to sign for, priced in USD. */
export interface SelectedPaymentOption {
  scheme: string;
  /** CAIP-2 id, e.g. `"eip155:84532"`. */
  network: string;
  /** Token contract address. */
  asset: string;
  /** Atomic units. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** Asset symbol from the default-asset registry (e.g. `"USDC"`). */
  symbol: string;
  decimals: number;
  /** Human-readable USD view of `amount` using the asset's decimals. */
  usd: string;
}

/**
 * What was signed. Needed to `cancelAuthorization` an EIP-3009 transfer or
 * to reconcile an unknown outcome: until `validBefore` passes, anyone holding
 * the signature can still settle it.
 */
export interface AuthorizationInfo {
  /** x402 scheme of the accepted option (`"exact"`). */
  scheme: string;
  /** Signature kind: EIP-3009 `transferWithAuthorization` or Permit2 `PermitWitnessTransferFrom`. */
  method: 'eip3009' | 'permit2';
  /** EIP-3009 `nonce` (bytes32) or Permit2 `nonce` (uint256 as decimal string). */
  nonce: string;
  /** Unix seconds; `"0"` means immediately. */
  validAfter: string;
  /** Unix seconds: EIP-3009 `validBefore` or Permit2 `deadline`. */
  validBefore: string;
}

export interface ResourcePaymentInfo {
  paymentId: string;
  /**
   * True only when the 402 declared the `payment-identifier` extension and
   * `paymentId` was appended to the payload that was sent. When false the
   * server never saw the id and cannot deduplicate on it.
   */
  paymentIdSent: boolean;
  network: string;
  asset: string;
  /** Atomic units (e.g. `"400000"` = 0.40 USDC). */
  amount: string;
  payer: string;
  /** Nonce and validity window of the signed authorization. */
  authorization?: AuthorizationInfo;
  /** Settlement transaction hash as reported by the server's facilitator. */
  txHash?: string;
  /** Raw signed receipt from the `offer-receipt` extension, when provided. */
  receipt?: unknown;
  /**
   * True only when the receipt signature verifies, the offer it binds to is
   * the one we accepted for the resource the 402 named (and had not expired
   * when we signed), the payer is us, and — when the receipt names one — the
   * transaction equals the settlement's. 2.28.0 servers usually omit it.
   */
  receiptVerified?: boolean;
}

export interface PayResourceResult {
  status: number;
  /** At most `maxBodyBytes` of the body, decoded as UTF-8 (an incomplete trailing character of a cut body is dropped). */
  body: string;
  /** True when the body was longer than `maxBodyBytes`: the read stopped there and the transfer was aborted. */
  bodyTruncated: boolean;
  headers: Record<string, string>;
  /** True when the server reported a successful settlement in `PAYMENT-RESPONSE`. */
  paid: boolean;
  /** Present whenever a signed authorization was sent, even if `paid` is false. */
  payment?: ResourcePaymentInfo;
}

/**
 * TEST ONLY. Disables the first (and optionally the second) spend gate so
 * tests can prove the remaining gates refuse on their own. Refused when
 * `NODE_ENV=production`. Never set this from application code.
 */
export interface TestOnlyGates {
  /** Skip the service's own 402 preflight (gate 1). */
  skipPreflight?: boolean;
  /** Pass `spendControls: false` to the x402 client (gate 2). */
  skipSpendControls?: boolean;
}

export interface X402ClientServiceOptions {
  /**
   * Transport override (tests, loopback restriction). Called as
   * `fetch(request, { dispatcher })` — honour the second argument. Defaults
   * to `undiciTransport`.
   */
  fetch?: typeof globalThis.fetch;
  /** Default per-phase transport timeout in milliseconds. Default `DEFAULT_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
  /** Default longest authorization window in seconds. Default `MAX_AUTHORIZATION_WINDOW_SECONDS`. */
  maxAuthorizationWindowSeconds?: number;
  /** Default longest final response body read, in bytes. Default `DEFAULT_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** Longest body of a plain 402 read before refusing it, in bytes. Default `MAX_PAYMENT_REQUIRED_BYTES`. */
  maxPaymentRequiredBytes?: number;
  /** TEST ONLY — see {@link TestOnlyGates}. */
  __testOnlyGates?: TestOnlyGates;
}

// ── Internals ───────────────────────────────────────────────────────────────

const PAYMENT_ID_PREFIX = 'agentfi_';

/**
 * Longest `validBefore` / `deadline` window (seconds from signing) accepted
 * by default. `@x402/evm` signs `now + maxTimeoutSeconds` as dictated by the
 * server; without this bound a server could obtain an authorization that
 * stays settleable for years.
 */
export const MAX_AUTHORIZATION_WINDOW_SECONDS = 600;

/** Default timeout applied to each request phase (plain request, paid request, body read). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default cap on the final response body (P6): read this much, abort the transfer beyond it. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Cap on the body of a plain 402 (P6). v2 carries the requirements in the
 * `PAYMENT-REQUIRED` header; the body is only a v1 fallback and never needs
 * to be large. A larger one is refused before anything is signed.
 */
export const MAX_PAYMENT_REQUIRED_BYTES = 16 * 1024;

/** Server-supplied reasons are clipped to this length in error messages and `details.reason`. */
const MAX_REASON_LENGTH = 200;

type Stage = 'request' | 'payment-creation' | 'paid-request';

interface AttemptState {
  paymentRequired?: PaymentRequired;
  offers: DecodedOffer[];
  selected?: PaymentRequirements;
  paymentPayload?: PaymentPayload;
  authorization?: AuthorizationInfo | undefined;
  /** Unix seconds at which the authorization was created. */
  signedAt?: number;
  paymentIdSent: boolean;
  /** Error to surface instead of the library's generic one (gate 3 refusal or a ledger hook throw). */
  abort?: Error;
}

interface PreflightContext {
  url: string;
  safeUrl: string;
  networks: Network[];
  capUsd: string;
  maxAmountUsd: string;
  maxWindowSeconds: number;
  scheme: ExactEvmScheme;
}

interface PricedOption {
  requirement: PaymentRequirements;
  symbol: string;
  decimals: number;
  usd: string;
}

function summarize(requirement: PaymentRequirements) {
  return {
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset,
    amount: requirement.amount,
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isSignedReceipt(value: unknown): value is SignedReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { format?: unknown; signature?: unknown };
  return (
    (candidate.format === 'jws' || candidate.format === 'eip712') &&
    typeof candidate.signature === 'string'
  );
}

function hasPaymentHeader(request: Request): boolean {
  return request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('X-PAYMENT');
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * URL form safe for error messages and logs: no query string, fragment or
 * userinfo, where API keys tend to travel. The full URL stays in `details`.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[unparseable url]';
  }
}

/**
 * Bounds server-controlled or upstream text before it reaches an error
 * message. Sanitized FIRST (P6): clipping first could cut a secret (an RPC
 * key, a token in a URL) at the boundary and leave a prefix the API's
 * sanitizer no longer recognises.
 */
function clip(text: string, max = MAX_REASON_LENGTH): string {
  const flat = sanitizeText(text, sanitizeContextFromEnv()).replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Reads at most `maxBytes` of `response`'s body. When more arrives the read
 * stops there and the body is cancelled, which aborts the transfer — the rest
 * is never received or buffered.
 */
export async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const stream = response.body;
  if (!stream) return { bytes: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    if (value.byteLength > room) {
      if (room > 0) {
        chunks.push(value.subarray(0, room));
        size += room;
      }
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** UTF-8 text of a body read by `readBodyLimited`; a cut body drops an incomplete trailing character. */
function decodeBody(bytes: Uint8Array, truncated: boolean): string {
  return new TextDecoder('utf-8').decode(bytes, truncated ? { stream: true } : undefined);
}

/** Cancels an unread body so its connection is released; never throws. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // already consumed or errored
  }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

/** Adds a per-request deadline on top of whatever signal the request already carries. */
function withTimeout(request: Request, timeoutMs: number): Request {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
  return new Request(request, { signal });
}

/**
 * Never follow redirects unless the caller explicitly asks: `fetch` would
 * replay the request — signed `PAYMENT-SIGNATURE` included — against whatever
 * origin `Location` names. The caller sees the 3xx and decides.
 */
function withTransportDefaults(init: TransportRequestInit | undefined): TransportRequestInit {
  return { ...init, redirect: init?.redirect ?? 'manual' };
}

/**
 * Default transport: the `undici` package's `fetch`, i.e. the same copy as
 * the `Agent` a caller passes as `init.dispatcher` (Node's global `fetch`
 * bundles its own undici — 6.x on Node 22, 7.x on Node 24 — and mixing an
 * Agent from one major with the fetch of another is not supported). The
 * `Request` built by `@x402/fetch` is a global one, which undici's `fetch`
 * does not accept as input, so it is unpacked into URL + init; the body is
 * buffered (resource bodies here are small JSON) and `redirect` / `signal`
 * carry over unchanged.
 */
export const undiciTransport: typeof globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const dispatcher = (init as TransportRequestInit | undefined)?.dispatcher;
  const headers: Array<[string, string]> = [];
  request.headers.forEach((value, key) => {
    headers.push([key, value]);
  });
  const body = request.body ? await request.arrayBuffer() : undefined;
  const response = await undiciFetch(request.url, {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(body !== undefined ? { body } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  });
  return response as unknown as Response;
};

function positiveNumber(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number; got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Validates the USD cap and returns its plain decimal form (`"$1"` → `"1"`). */
function parseCapUsd(maxAmountUsd: string): string {
  const parsed = parseMoney(maxAmountUsd);
  if (parsed.symbol !== undefined) {
    throw new Error(
      `maxAmountUsd must be a plain USD amount such as "$1" or "0.50"; got ${JSON.stringify(maxAmountUsd)}`,
    );
  }
  if (!(Number(parsed.amount) > 0)) {
    throw new Error(`maxAmountUsd must be positive; got ${JSON.stringify(maxAmountUsd)}`);
  }
  return parsed.amount;
}

function parseNetworks(allowedNetworks: unknown, allowWildcards: boolean): Network[] {
  if (!Array.isArray(allowedNetworks) || allowedNetworks.length === 0) {
    throw new Error(
      'allowedNetworks is required: list the exact CAIP-2 ids the payment may settle on, e.g. ["eip155:84532"]',
    );
  }
  return allowedNetworks.map((network: unknown) => {
    if (typeof network !== 'string' || !/^[^:\s]+:[^:\s]+$/.test(network)) {
      throw new Error(`allowedNetworks entries must be CAIP-2 ids like "eip155:84532"; got ${JSON.stringify(network)}`);
    }
    if (network.includes('*') && !allowWildcards) {
      throw new Error(
        `allowedNetworks entry ${JSON.stringify(network)} is a wildcard; list exact CAIP-2 ids, or pass allowWildcardNetworks: true explicitly`,
      );
    }
    return network as Network;
  });
}

function windowAcceptable(requirement: PaymentRequirements, maxWindowSeconds: number): boolean {
  const window = requirement.maxTimeoutSeconds;
  return typeof window === 'number' && Number.isFinite(window) && window > 0 && window <= maxWindowSeconds;
}

function windowReason(requirement: PaymentRequirements, maxWindowSeconds: number): string {
  return `maxTimeoutSeconds ${String(requirement.maxTimeoutSeconds)} would keep the authorization settleable for longer than the ${maxWindowSeconds}s limit`;
}

/** Reads nonce and window out of the payload `ExactEvmScheme` produced (EIP-3009 or Permit2). */
function describeAuthorization(payload: PaymentPayload): AuthorizationInfo | undefined {
  const inner = payload.payload as {
    authorization?: { nonce?: unknown; validAfter?: unknown; validBefore?: unknown };
    permit2Authorization?: { nonce?: unknown; deadline?: unknown; witness?: { validAfter?: unknown } };
  };
  const scheme = payload.accepted.scheme;
  const eip3009 = inner.authorization;
  if (eip3009 && typeof eip3009.nonce === 'string' && typeof eip3009.validBefore === 'string') {
    return {
      scheme,
      method: 'eip3009',
      nonce: eip3009.nonce,
      validAfter: typeof eip3009.validAfter === 'string' ? eip3009.validAfter : '0',
      validBefore: eip3009.validBefore,
    };
  }
  const permit2 = inner.permit2Authorization;
  if (permit2 && typeof permit2.nonce === 'string' && typeof permit2.deadline === 'string') {
    const validAfter = permit2.witness?.validAfter;
    return {
      scheme,
      method: 'permit2',
      nonce: permit2.nonce,
      validAfter: typeof validAfter === 'string' ? validAfter : '0',
      validBefore: permit2.deadline,
    };
  }
  return undefined;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class X402ClientService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxAuthorizationWindowSeconds: number;
  private readonly maxBodyBytes: number;
  private readonly maxPaymentRequiredBytes: number;
  private readonly testGates: TestOnlyGates;

  constructor(options: X402ClientServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? undiciTransport;
    this.requestTimeoutMs = positiveNumber('requestTimeoutMs', options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxAuthorizationWindowSeconds = positiveNumber(
      'maxAuthorizationWindowSeconds',
      options.maxAuthorizationWindowSeconds,
      MAX_AUTHORIZATION_WINDOW_SECONDS,
    );
    this.maxBodyBytes = positiveNumber('maxBodyBytes', options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
    this.maxPaymentRequiredBytes = positiveNumber(
      'maxPaymentRequiredBytes',
      options.maxPaymentRequiredBytes,
      MAX_PAYMENT_REQUIRED_BYTES,
    );
    const gates = options.__testOnlyGates ?? {};
    if ((gates.skipPreflight || gates.skipSpendControls) && process.env['NODE_ENV'] === 'production') {
      throw new Error('X402ClientService: __testOnlyGates cannot be enabled when NODE_ENV=production');
    }
    this.testGates = gates;
  }

  async payResource(params: PayResourceParams): Promise<PayResourceResult> {
    const { signer, url } = params;
    const init = withTransportDefaults(params.init);
    // `@x402/fetch` turns `init` into a Request and only ever hands us
    // Request objects (and clones), so the dispatcher must be re-attached on
    // every transport call — Node's fetch reads `init.dispatcher` each time.
    const transportInit = init.dispatcher ? ({ dispatcher: init.dispatcher } as RequestInit) : undefined;
    const safeUrl = redactUrl(url);
    const capUsd = parseCapUsd(params.maxAmountUsd);
    const networks = parseNetworks(params.allowedNetworks, params.allowWildcardNetworks === true);
    const maxWindowSeconds = positiveNumber(
      'maxAuthorizationWindowSeconds',
      params.maxAuthorizationWindowSeconds,
      this.maxAuthorizationWindowSeconds,
    );
    const timeoutMs = positiveNumber('requestTimeoutMs', params.requestTimeoutMs, this.requestTimeoutMs);
    const maxBodyBytes = positiveNumber('maxBodyBytes', params.maxBodyBytes, this.maxBodyBytes);
    const paymentId = params.paymentId ?? generatePaymentId(PAYMENT_ID_PREFIX);
    if (!isValidPaymentId(paymentId)) {
      throw new Error(
        `paymentId must be 16-128 chars of [A-Za-z0-9_-]; got ${JSON.stringify(paymentId)}`,
      );
    }

    const scheme = new ExactEvmScheme(signer);
    const state: AttemptState = { offers: [], paymentIdSent: false };
    const ctx: PreflightContext = {
      url,
      safeUrl,
      networks,
      capUsd,
      maxAmountUsd: params.maxAmountUsd,
      maxWindowSeconds,
      scheme,
    };

    // One client per call: caps, networks and the window come from the job,
    // not from process-wide configuration.
    const client = x402Client.fromConfig({
      schemes: networks.map((network) => ({ network, client: scheme })),
      spendControls: this.testGates.skipSpendControls ? false : { maxAmountPerPayment: `$${capUsd}` },
      // Second gate, window half: the library's selector never sees an
      // option whose authorization would outlive our limit.
      policies: [
        (_x402Version, requirements) =>
          requirements.filter((requirement) => windowAcceptable(requirement, maxWindowSeconds)),
      ],
    });

    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      // (a) Idempotency key, only when the server declared the extension.
      const extensions = paymentRequired.extensions;
      if (extensions && isPaymentIdentifierExtension(extensions[PAYMENT_IDENTIFIER])) {
        appendPaymentIdentifierToExtensions(extensions, paymentId);
      }

      // (b) Third gate: re-check the option the library selected against
      // our own window and cap before any signature exists.
      const refusal = this.recheck(selectedRequirements, ctx);
      if (refusal) {
        state.abort = refusal;
        return { abort: true, reason: refusal.message };
      }

      // (c) Ledger hook: the caller may reserve the amount (and refuse) here,
      // while nothing has been signed. Its error is surfaced unchanged.
      if (params.onBeforeSign) {
        try {
          await params.onBeforeSign(this.describeSelected(selectedRequirements, ctx));
        } catch (error) {
          state.abort = error instanceof Error ? error : new Error(String(error));
          return { abort: true, reason: state.abort.message };
        }
      }

      state.selected = selectedRequirements;
    });

    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      state.paymentPayload = paymentPayload;
      state.signedAt = nowSeconds();
      state.authorization = describeAuthorization(paymentPayload);
      state.paymentIdSent = extractPaymentIdentifier(paymentPayload) === paymentId;

      // Ledger hook: record the nonce before the signed payload can leave.
      // A throw here propagates out of the library's createPaymentPayload,
      // so the paid request is never sent; `inspectingFetch` guards too.
      if (params.onAuthorizationSigned && state.authorization && state.selected) {
        try {
          await params.onAuthorizationSigned(state.authorization, this.describeSelected(state.selected, ctx));
        } catch (error) {
          state.abort = error instanceof Error ? error : new Error(String(error));
          throw state.abort;
        }
      }
    });

    const httpClient = new x402HTTPClient(client);

    // The first 402 is inspected here, before @x402/fetch creates a payment.
    // Typed errors thrown from this shim propagate untouched (the wrapper
    // does not catch errors from the transport).
    const inspectingFetch: typeof globalThis.fetch = async (input, requestInit) => {
      const request = withTimeout(
        input instanceof Request && requestInit === undefined ? input : new Request(input, requestInit),
        timeoutMs,
      );
      // A ledger hook refused after signing: the signed payload must not leave.
      if (state.abort && hasPaymentHeader(request)) throw state.abort;
      const response = await this.fetchImpl(request, transportInit);
      if (response.status === 402 && !hasPaymentHeader(request)) {
        // Bounded read of the 402 body (P6). `@x402/fetch` would read the
        // body it is handed in full, so it gets a replay of the bytes read
        // here instead of the live stream.
        const text = await this.readPaymentRequiredBody(response, ctx);
        const paymentRequired = this.decodePaymentRequired(httpClient, response.headers, text, ctx);
        state.paymentRequired = paymentRequired;
        state.offers = this.decodeOffers(paymentRequired);
        if (!this.testGates.skipPreflight) this.preflight(paymentRequired, ctx);
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return response;
    };

    const fetchWithPayment = wrapFetchWithPayment(inspectingFetch, client);

    let response: Response;
    let body: string;
    let bodyTruncated: boolean;
    try {
      response = await fetchWithPayment(url, init);
      // The body read is covered by the same deadline as the request itself,
      // and bounded (P6): beyond `maxBodyBytes` the transfer is aborted.
      const read = await readBodyLimited(response, maxBodyBytes);
      body = decodeBody(read.bytes, read.truncated);
      bodyTruncated = read.truncated;
    } catch (error) {
      if (error instanceof X402PaymentError) throw error;
      if (state.abort) throw state.abort;
      throw this.transportFailure(error, state, { url, safeUrl, paymentId, timeoutMs });
    }

    const headers = headersToRecord(response.headers);

    if (!state.paymentRequired) {
      // Never saw a 402: free resource, or a non-payment error. Return as-is.
      return { status: response.status, body, bodyTruncated, headers, paid: false };
    }

    const selected = state.selected;
    if (!selected || !state.paymentPayload) {
      // The wrapper returned without creating a payment (a hook supplied
      // headers that satisfied the server). Not something we configure.
      return { status: response.status, body, bodyTruncated, headers, paid: false };
    }

    const sent = this.sentDetails(state, paymentId);
    const settle = this.decodeSettle(response);

    // A failed settlement comes back as 402 + PAYMENT-RESPONSE{success:false};
    // check it before the generic "rejected" branch so the reason survives.
    if (settle && !settle.success) {
      const reason = clip(settle.errorReason ?? settle.errorMessage ?? 'unknown');
      throw new PaymentFailedError(`Settlement failed for ${safeUrl}: ${reason}`, {
        url,
        status: response.status,
        ...sent,
        reason,
        selected: summarize(selected),
        settle,
      });
    }

    if (response.status === 402) {
      const reason = clip(this.rejectionReason(response, body));
      throw new PaymentFailedError(`Server rejected the signed payment for ${safeUrl}: ${reason}`, {
        url,
        status: 402,
        ...sent,
        reason,
        selected: summarize(selected),
      });
    }

    const payment: ResourcePaymentInfo = {
      paymentId,
      paymentIdSent: state.paymentIdSent,
      network: settle?.network ?? selected.network,
      asset: selected.asset,
      amount: settle?.amount ?? selected.amount,
      payer: settle?.payer ?? signer.address,
    };
    if (state.authorization) payment.authorization = state.authorization;
    if (settle?.transaction) payment.txHash = settle.transaction;

    if (settle) {
      const receipt = await this.verifyReceipt(settle, state, selected, signer.address);
      if (receipt !== undefined) {
        payment.receipt = receipt.receipt;
        payment.receiptVerified = receipt.verified;
      }
    }

    return {
      status: response.status,
      body,
      bodyTruncated,
      headers,
      // No PAYMENT-RESPONSE on a 2xx means the server accepted the request
      // without reporting a settlement: treat as unpaid-until-reconciled.
      paid: settle?.success === true,
      payment,
    };
  }

  // ── Failure shaping ───────────────────────────────────────────────────────

  private sentDetails(state: AttemptState, paymentId: string) {
    return {
      paymentId,
      paymentIdSent: state.paymentIdSent,
      authorizationSent: state.paymentPayload !== undefined,
      ...(state.authorization ? { authorization: state.authorization } : {}),
    };
  }

  private transportFailure(
    error: unknown,
    state: AttemptState,
    ctx: { url: string; safeUrl: string; paymentId: string; timeoutMs: number },
  ): PaymentFailedError {
    const raw = error instanceof Error ? error.message : String(error);
    const sent = this.sentDetails(state, ctx.paymentId);
    const stage: Stage = !state.paymentRequired
      ? 'request'
      : !state.paymentPayload
        ? 'payment-creation'
        : 'paid-request';
    const timedOut = isTimeout(error);
    const message = timedOut
      ? `x402 request to ${ctx.safeUrl} timed out after ${ctx.timeoutMs}ms` +
        (sent.authorizationSent ? ' with a signed authorization already sent' : '')
      : `x402 request to ${ctx.safeUrl} failed during ${stage}: ${clip(raw.split(ctx.url).join(ctx.safeUrl))}`;
    return new PaymentFailedError(message, {
      url: ctx.url,
      ...sent,
      stage,
      timedOut,
      cause: raw,
    });
  }

  // ── 402 inspection ────────────────────────────────────────────────────────

  /**
   * The body of a plain 402, read up to `maxPaymentRequiredBytes`. A declared
   * or actual body above that is refused before anything is signed (P6) and
   * the transfer aborted.
   */
  private async readPaymentRequiredBody(response: Response, ctx: PreflightContext): Promise<string> {
    const limit = this.maxPaymentRequiredBytes;
    const refuse = (): PaymentFailedError =>
      new PaymentFailedError(
        `402 from ${ctx.safeUrl} has a body larger than ${limit} bytes; refusing it before anything is signed`,
        {
          url: ctx.url,
          status: 402,
          stage: 'request',
          timedOut: false,
          authorizationSent: false,
          paymentIdSent: false,
          maxPaymentRequiredBytes: limit,
        },
      );
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limit) {
      await discardBody(response);
      throw refuse();
    }
    const read = await readBodyLimited(response, limit);
    if (read.truncated) throw refuse();
    return decodeBody(read.bytes, false);
  }

  private decodePaymentRequired(
    httpClient: x402HTTPClient,
    headers: Headers,
    text: string,
    ctx: PreflightContext,
  ): PaymentRequired {
    let body: unknown;
    try {
      if (text) body = JSON.parse(text);
    } catch {
      // v2 carries requirements in the header; a non-JSON body is fine.
    }
    try {
      return httpClient.getPaymentRequiredResponse((name) => headers.get(name), body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PaymentFailedError(
        `402 from ${ctx.safeUrl} carries no usable x402 payment requirements: ${clip(message)}`,
        { url: ctx.url, status: 402, authorizationSent: false, paymentIdSent: false },
      );
    }
  }

  private decodeOffers(paymentRequired: PaymentRequired): DecodedOffer[] {
    try {
      return decodeSignedOffers(extractOffersFromPaymentRequired(paymentRequired));
    } catch {
      return [];
    }
  }

  /**
   * First gate, before any signature: typed errors for "nothing we can pay
   * with" versus "everything we could pay with is too expensive".
   */
  private preflight(paymentRequired: PaymentRequired, ctx: PreflightContext): void {
    const offered = paymentRequired.accepts;
    const onAllowedNetwork = offered.filter(
      (requirement) =>
        requirement.scheme === 'exact' &&
        ctx.networks.some((pattern) => networkMatchesPattern(pattern, requirement.network)),
    );
    if (onAllowedNetwork.length === 0) {
      throw new NoAcceptableSchemeError(
        `No payment option on ${ctx.safeUrl} uses scheme "exact" on an allowed network (${ctx.networks.join(', ')})`,
        { url: ctx.url, allowedNetworks: ctx.networks, offered: offered.map(summarize) },
      );
    }

    const withinWindow = onAllowedNetwork.filter((requirement) =>
      windowAcceptable(requirement, ctx.maxWindowSeconds),
    );
    if (withinWindow.length === 0) {
      throw new NoAcceptableSchemeError(
        `Every acceptable payment option on ${ctx.safeUrl} asks for an authorization window longer than ${ctx.maxWindowSeconds}s`,
        {
          url: ctx.url,
          maxAuthorizationWindowSeconds: ctx.maxWindowSeconds,
          rejected: onAllowedNetwork.map((requirement) => ({
            ...summarize(requirement),
            reason: windowReason(requirement, ctx.maxWindowSeconds),
          })),
        },
      );
    }

    const priced = withinWindow
      .map((requirement) => this.price(requirement, ctx.scheme))
      .filter((option): option is PricedOption => option !== undefined);
    if (priced.length === 0) {
      throw new NoAcceptableSchemeError(
        `No payment option on ${ctx.safeUrl} is priced in a recognised USD stablecoin`,
        { url: ctx.url, allowedNetworks: ctx.networks, offered: withinWindow.map(summarize) },
      );
    }

    const affordable = priced.filter((option) => this.withinCap(option, ctx.capUsd));
    if (affordable.length === 0) {
      const cheapest = priced.reduce((min, option) =>
        Number(option.usd) < Number(min.usd) ? option : min,
      );
      throw new BudgetExceededError(
        `Cheapest acceptable option on ${ctx.safeUrl} costs ${cheapest.usd} ${cheapest.symbol}, above the cap of $${ctx.capUsd}`,
        {
          url: ctx.url,
          maxAmountUsd: ctx.maxAmountUsd,
          cheapest: { ...summarize(cheapest.requirement), usd: cheapest.usd },
          offered: priced.map((option) => ({ ...summarize(option.requirement), usd: option.usd })),
        },
      );
    }
  }

  /** Third gate: the option the library selected must still pass our window and cap. */
  private recheck(selected: PaymentRequirements, ctx: PreflightContext): X402PaymentError | undefined {
    if (!windowAcceptable(selected, ctx.maxWindowSeconds)) {
      return new NoAcceptableSchemeError(
        `Refusing to sign payment for ${ctx.safeUrl}: ${windowReason(selected, ctx.maxWindowSeconds)}`,
        { url: ctx.url, maxAuthorizationWindowSeconds: ctx.maxWindowSeconds, selected: summarize(selected) },
      );
    }
    const priced = this.price(selected, ctx.scheme);
    if (!priced || !this.withinCap(priced, ctx.capUsd)) {
      const reason = priced
        ? `selected option costs ${priced.usd} ${priced.symbol}, above the cap of $${ctx.capUsd}`
        : `selected option uses asset ${selected.asset} which is not a recognised USD stablecoin`;
      return new BudgetExceededError(`Refusing to sign payment for ${ctx.safeUrl}: ${reason}`, {
        url: ctx.url,
        maxAmountUsd: ctx.maxAmountUsd,
        selected: summarize(selected),
      });
    }
    return undefined;
  }

  /**
   * Public view of the option about to be signed for, handed to the ledger
   * hooks. Only called after `recheck` passed, so the asset is a known
   * stablecoin and `price` cannot be undefined; the fallback keeps the type
   * honest if that invariant ever changes.
   */
  private describeSelected(selected: PaymentRequirements, ctx: PreflightContext): SelectedPaymentOption {
    const priced = this.price(selected, ctx.scheme);
    return {
      ...summarize(selected),
      maxTimeoutSeconds: typeof selected.maxTimeoutSeconds === 'number' ? selected.maxTimeoutSeconds : 0,
      symbol: priced?.symbol ?? 'UNKNOWN',
      decimals: priced?.decimals ?? 0,
      usd: priced?.usd ?? '0',
    };
  }

  /** USD view of a requirement, or undefined when the asset is not a known stablecoin. */
  private price(requirement: PaymentRequirements, scheme: ExactEvmScheme): PricedOption | undefined {
    const asset = scheme.findDefaultAsset(requirement.asset, requirement.network);
    if (!asset || !/^\d+$/.test(requirement.amount)) return undefined;
    return {
      requirement,
      symbol: asset.symbol,
      decimals: asset.decimals,
      usd: formatUnits(BigInt(requirement.amount), asset.decimals),
    };
  }

  private withinCap(option: PricedOption, capUsd: string): boolean {
    const capAtomic = BigInt(convertToTokenAmount(capUsd, option.decimals));
    return BigInt(option.requirement.amount) <= capAtomic;
  }

  // ── Settlement + receipt ──────────────────────────────────────────────────

  private decodeSettle(response: Response): SettleResponse | undefined {
    const header =
      response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
    if (!header) return undefined;
    try {
      return decodePaymentResponseHeader(header);
    } catch {
      return undefined;
    }
  }

  private rejectionReason(response: Response, body: string): string {
    const header = response.headers.get('PAYMENT-REQUIRED');
    if (header) {
      try {
        const declared = decodePaymentRequiredHeader(header);
        if (declared.error) return declared.error;
      } catch {
        // fall through to the body
      }
    }
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      // not JSON
    }
    return 'no reason given';
  }

  /**
   * A receipt counts as verified only when, with the offer we accepted:
   *   - the offer names the resource the 402 was issued for and had not
   *     expired (`validUntil`) when we signed,
   *   - both are EIP-712 signed by the same key (JWS receipts need DID
   *     resolution and are reported unverified for now),
   *   - the receipt's resource URL / network / payer match the offer and us,
   *     and it was issued recently (library check),
   *   - when the receipt names a transaction hash, it equals the settlement's.
   */
  private async verifyReceipt(
    settle: SettleResponse,
    state: AttemptState,
    selected: PaymentRequirements,
    payer: string,
  ): Promise<{ receipt: unknown; verified: boolean } | undefined> {
    const extension = settle.extensions?.[OFFER_RECEIPT] as { info?: { receipt?: unknown } } | undefined;
    const receipt = extension?.info?.receipt;
    if (receipt === undefined) return undefined;

    const offer = state.offers.find(
      (candidate) =>
        candidate.scheme === selected.scheme &&
        candidate.network === selected.network &&
        sameAddress(candidate.asset, selected.asset) &&
        sameAddress(candidate.payTo, selected.payTo) &&
        candidate.amount === selected.amount,
    );

    return { receipt, verified: await this.receiptIsBound(receipt, offer, payer, settle, state) };
  }

  private async receiptIsBound(
    receipt: unknown,
    offer: DecodedOffer | undefined,
    payer: string,
    settle: SettleResponse,
    state: AttemptState,
  ): Promise<boolean> {
    if (!offer || !isSignedReceipt(receipt)) return false;
    if (!isEIP712SignedReceipt(receipt) || !isEIP712SignedOffer(offer.signedOffer)) return false;

    // The offer must be for the resource the 402 named — a receipt bound to
    // an offer for some other URL proves nothing about this payment — and
    // must not have expired before we signed against it.
    const declaredUrl = state.paymentRequired?.resource?.url;
    if (!declaredUrl || offer.resourceUrl !== declaredUrl) return false;
    if (
      typeof offer.validUntil === 'number' &&
      offer.validUntil > 0 &&
      state.signedAt !== undefined &&
      offer.validUntil < state.signedAt
    ) {
      return false;
    }

    try {
      const [offerSignature, receiptSignature] = await Promise.all([
        verifyOfferSignatureEIP712(offer.signedOffer),
        verifyReceiptSignatureEIP712(receipt),
      ]);
      if (!sameAddress(offerSignature.signer, receiptSignature.signer)) return false;
      if (!verifyReceiptMatchesOffer(receipt, offer, [payer])) return false;
      const receiptTx = receiptSignature.payload.transaction;
      if (receiptTx && settle.transaction && !sameAddress(receiptTx, settle.transaction)) return false;
      return true;
    } catch {
      return false;
    }
  }
}
