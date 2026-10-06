/**
 * X402ClientService — pays HTTP 402 resources with x402 (v2 line) under
 * explicit spend controls.
 *
 * Flow per call (`payResource`):
 *   1. Plain request. Non-402 → returned as-is, `paid: false`, nothing signed.
 *   2. 402 → decode `PAYMENT-REQUIRED`. Before anything is signed, the
 *      offered options are checked against `allowedNetworks` and
 *      `maxAmountUsd` by *this* service (typed errors) — the x402 client's
 *      own `spendControls` filter runs after that as a second gate, and the
 *      `onBeforePaymentCreation` hook re-checks the finally selected option
 *      (third gate; aborts the signature if it disagrees).
 *   3. Sign an EIP-3009 / Permit2 authorization with the agent's wallet
 *      signer, resend with `PAYMENT-SIGNATURE`, decode `PAYMENT-RESPONSE`.
 *   4. If the server returned a signed offer/receipt, verify the receipt
 *      signature and that it is bound to the accepted offer and our payer.
 *
 * The buyer never contacts a facilitator: the resource server does. What
 * this service proves is therefore "the server told us it settled", not
 * "USDC moved on-chain" — see docs/architecture/x402-payments.md.
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
  generatePaymentId,
  isPaymentIdentifierExtension,
  isValidPaymentId,
} from '@x402/extensions/payment-identifier';
import { wrapFetchWithPayment } from '@x402/fetch';
import { formatUnits } from 'viem';
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

/** No offered option is `exact` on an allowed network with a USD-pegged asset. Nothing was signed. */
export class NoAcceptableSchemeError extends X402PaymentError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('NO_ACCEPTABLE_SCHEME', message, details);
    this.name = 'NoAcceptableSchemeError';
  }
}

/**
 * The 402 could not be parsed, the server rejected the signed payment, the
 * settlement failed, or the paid request failed in transit. Check
 * `details.authorizationSent`: when true a signed authorization left this
 * process and the outcome is unknown until reconciled.
 */
export class PaymentFailedError extends X402PaymentError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PAYMENT_FAILED', message, details);
    this.name = 'PaymentFailedError';
  }
}

// ── Public types ────────────────────────────────────────────────────────────

export interface PayResourceParams {
  /** Wallet-backed signer (`toClientSigner(...)`) or any `{ address, signTypedData }`. */
  signer: ClientSigner;
  url: string;
  init?: RequestInit;
  /** Per-payment USD cap, e.g. `"$1"`, `"0.50"`. Required — no implicit default. */
  maxAmountUsd: string;
  /** CAIP-2 networks the payment may settle on, e.g. `["eip155:84532"]`. Default: any `eip155:*`. */
  allowedNetworks?: string[];
  /** Idempotency key sent via the `payment-identifier` extension. Generated when omitted. */
  paymentId?: string;
}

export interface ResourcePaymentInfo {
  paymentId: string;
  network: string;
  asset: string;
  /** Atomic units (e.g. `"400000"` = 0.40 USDC). */
  amount: string;
  payer: string;
  /** Settlement transaction hash as reported by the server's facilitator. */
  txHash?: string;
  /** Raw signed receipt from the `offer-receipt` extension, when provided. */
  receipt?: unknown;
  /** True only when the receipt signature verifies and binds offer + payer + tx. */
  receiptVerified?: boolean;
}

export interface PayResourceResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** True when the server reported a successful settlement in `PAYMENT-RESPONSE`. */
  paid: boolean;
  /** Present whenever a signed authorization was sent, even if `paid` is false. */
  payment?: ResourcePaymentInfo;
}

export interface X402ClientServiceOptions {
  /** Transport override (tests, loopback restriction). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

// ── Internals ───────────────────────────────────────────────────────────────

const DEFAULT_NETWORKS: Network[] = ['eip155:*'];
const PAYMENT_ID_PREFIX = 'agentfi_';

interface AttemptState {
  paymentRequired?: PaymentRequired;
  offers: DecodedOffer[];
  selected?: PaymentRequirements;
  paymentPayload?: PaymentPayload;
  abort?: X402PaymentError;
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
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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

function parseNetworks(allowedNetworks: string[] | undefined): Network[] {
  if (!allowedNetworks || allowedNetworks.length === 0) return DEFAULT_NETWORKS;
  return allowedNetworks.map((network) => {
    if (!/^[^:\s]+:[^:\s]+$/.test(network)) {
      throw new Error(`allowedNetworks entries must be CAIP-2 ids like "eip155:84532"; got ${JSON.stringify(network)}`);
    }
    return network as Network;
  });
}

// ── Service ─────────────────────────────────────────────────────────────────

export class X402ClientService {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: X402ClientServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async payResource(params: PayResourceParams): Promise<PayResourceResult> {
    const { signer, url, init } = params;
    const capUsd = parseCapUsd(params.maxAmountUsd);
    const networks = parseNetworks(params.allowedNetworks);
    const paymentId = params.paymentId ?? generatePaymentId(PAYMENT_ID_PREFIX);
    if (!isValidPaymentId(paymentId)) {
      throw new Error(
        `paymentId must be 16-128 chars of [A-Za-z0-9_-]; got ${JSON.stringify(paymentId)}`,
      );
    }

    const scheme = new ExactEvmScheme(signer);
    const state: AttemptState = { offers: [] };

    // One client per call: caps and networks come from the job, not from
    // process-wide configuration.
    const client = x402Client.fromConfig({
      schemes: networks.map((network) => ({ network, client: scheme })),
      spendControls: { maxAmountPerPayment: `$${capUsd}` },
    });

    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      // (a) Idempotency key, only when the server declared the extension.
      const extensions = paymentRequired.extensions;
      if (extensions && isPaymentIdentifierExtension(extensions[PAYMENT_IDENTIFIER])) {
        appendPaymentIdentifierToExtensions(extensions, paymentId);
      }

      // (b) Defense in depth: re-check the option the library selected
      // against our own cap before any signature exists.
      const priced = this.price(selectedRequirements, scheme);
      if (!priced || !this.withinCap(priced, capUsd)) {
        const reason = priced
          ? `selected option costs ${priced.usd} ${priced.symbol}, above the cap of $${capUsd}`
          : `selected option uses asset ${selectedRequirements.asset} which is not a recognised USD stablecoin`;
        state.abort = new BudgetExceededError(`Refusing to sign payment for ${url}: ${reason}`, {
          url,
          maxAmountUsd: params.maxAmountUsd,
          selected: summarize(selectedRequirements),
        });
        return { abort: true, reason };
      }

      state.selected = selectedRequirements;
    });

    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      state.paymentPayload = paymentPayload;
    });

    const httpClient = new x402HTTPClient(client);

    // The first 402 is inspected here, before @x402/fetch creates a payment.
    // Typed errors thrown from this shim propagate untouched (the wrapper
    // does not catch errors from the transport).
    const inspectingFetch: typeof globalThis.fetch = async (input, requestInit) => {
      const request =
        input instanceof Request && requestInit === undefined ? input : new Request(input, requestInit);
      const response = await this.fetchImpl(request);
      if (response.status === 402 && !hasPaymentHeader(request)) {
        const paymentRequired = await this.decodePaymentRequired(httpClient, response.clone(), url);
        state.paymentRequired = paymentRequired;
        state.offers = this.decodeOffers(paymentRequired);
        this.preflight(paymentRequired, { url, networks, capUsd, maxAmountUsd: params.maxAmountUsd, scheme });
      }
      return response;
    };

    const fetchWithPayment = wrapFetchWithPayment(inspectingFetch, client);

    let response: Response;
    try {
      response = await fetchWithPayment(url, init);
    } catch (error) {
      if (error instanceof X402PaymentError) throw error;
      if (state.abort) throw state.abort;
      const message = error instanceof Error ? error.message : String(error);
      throw new PaymentFailedError(`x402 request to ${url} failed: ${message}`, {
        url,
        paymentId,
        authorizationSent: state.paymentPayload !== undefined,
        cause: message,
      });
    }

    const body = await response.text();
    const headers = headersToRecord(response.headers);

    if (!state.paymentRequired) {
      // Never saw a 402: free resource, or a non-payment error. Return as-is.
      return { status: response.status, body, headers, paid: false };
    }

    const selected = state.selected;
    if (!selected || !state.paymentPayload) {
      // The wrapper returned without creating a payment (a hook supplied
      // headers that satisfied the server). Not something we configure.
      return { status: response.status, body, headers, paid: false };
    }

    const settle = this.decodeSettle(response);

    // A failed settlement comes back as 402 + PAYMENT-RESPONSE{success:false};
    // check it before the generic "rejected" branch so the reason survives.
    if (settle && !settle.success) {
      const reason = settle.errorReason ?? settle.errorMessage ?? 'unknown';
      throw new PaymentFailedError(`Settlement failed for ${url}: ${reason}`, {
        url,
        status: response.status,
        paymentId,
        reason,
        authorizationSent: true,
        selected: summarize(selected),
        settle,
      });
    }

    if (response.status === 402) {
      const reason = this.rejectionReason(response, body);
      throw new PaymentFailedError(`Server rejected the signed payment for ${url}: ${reason}`, {
        url,
        status: 402,
        paymentId,
        reason,
        authorizationSent: true,
        selected: summarize(selected),
      });
    }

    const payment: ResourcePaymentInfo = {
      paymentId,
      network: settle?.network ?? selected.network,
      asset: selected.asset,
      amount: settle?.amount ?? selected.amount,
      payer: settle?.payer ?? signer.address,
    };
    if (settle?.transaction) payment.txHash = settle.transaction;

    if (settle) {
      const receipt = await this.verifyReceipt(settle, state.offers, selected, signer.address);
      if (receipt !== undefined) {
        payment.receipt = receipt.receipt;
        payment.receiptVerified = receipt.verified;
      }
    }

    return {
      status: response.status,
      body,
      headers,
      // No PAYMENT-RESPONSE on a 2xx means the server accepted the request
      // without reporting a settlement: treat as unpaid-until-reconciled.
      paid: settle?.success === true,
      payment,
    };
  }

  // ── 402 inspection ────────────────────────────────────────────────────────

  private async decodePaymentRequired(
    httpClient: x402HTTPClient,
    response: Response,
    url: string,
  ): Promise<PaymentRequired> {
    let body: unknown;
    try {
      const text = await response.text();
      if (text) body = JSON.parse(text);
    } catch {
      // v2 carries requirements in the header; a non-JSON body is fine.
    }
    try {
      return httpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PaymentFailedError(`402 from ${url} carries no usable x402 payment requirements: ${message}`, {
        url,
        status: 402,
        authorizationSent: false,
      });
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
  private preflight(
    paymentRequired: PaymentRequired,
    ctx: { url: string; networks: Network[]; capUsd: string; maxAmountUsd: string; scheme: ExactEvmScheme },
  ): void {
    const offered = paymentRequired.accepts;
    const onAllowedNetwork = offered.filter(
      (requirement) =>
        requirement.scheme === 'exact' &&
        ctx.networks.some((pattern) => networkMatchesPattern(pattern, requirement.network)),
    );
    if (onAllowedNetwork.length === 0) {
      throw new NoAcceptableSchemeError(
        `No payment option on ${ctx.url} uses scheme "exact" on an allowed network (${ctx.networks.join(', ')})`,
        { url: ctx.url, allowedNetworks: ctx.networks, offered: offered.map(summarize) },
      );
    }

    const priced = onAllowedNetwork
      .map((requirement) => this.price(requirement, ctx.scheme))
      .filter((option): option is PricedOption => option !== undefined);
    if (priced.length === 0) {
      throw new NoAcceptableSchemeError(
        `No payment option on ${ctx.url} is priced in a recognised USD stablecoin`,
        { url: ctx.url, allowedNetworks: ctx.networks, offered: onAllowedNetwork.map(summarize) },
      );
    }

    const affordable = priced.filter((option) => this.withinCap(option, ctx.capUsd));
    if (affordable.length === 0) {
      const cheapest = priced.reduce((min, option) =>
        Number(option.usd) < Number(min.usd) ? option : min,
      );
      throw new BudgetExceededError(
        `Cheapest acceptable option on ${ctx.url} costs ${cheapest.usd} ${cheapest.symbol}, above the cap of $${ctx.capUsd}`,
        {
          url: ctx.url,
          maxAmountUsd: ctx.maxAmountUsd,
          cheapest: { ...summarize(cheapest.requirement), usd: cheapest.usd },
          offered: priced.map((option) => ({ ...summarize(option.requirement), usd: option.usd })),
        },
      );
    }
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
   *   - both are EIP-712 signed by the same key (JWS receipts need DID
   *     resolution and are reported unverified for now),
   *   - the receipt's resource URL / network / payer match the offer and us,
   *     and it was issued recently (library check),
   *   - a transaction hash in the receipt equals the settlement's.
   */
  private async verifyReceipt(
    settle: SettleResponse,
    offers: DecodedOffer[],
    selected: PaymentRequirements,
    payer: string,
  ): Promise<{ receipt: unknown; verified: boolean } | undefined> {
    const extension = settle.extensions?.[OFFER_RECEIPT] as { info?: { receipt?: unknown } } | undefined;
    const receipt = extension?.info?.receipt;
    if (receipt === undefined) return undefined;

    const offer = offers.find(
      (candidate) =>
        candidate.scheme === selected.scheme &&
        candidate.network === selected.network &&
        sameAddress(candidate.asset, selected.asset) &&
        sameAddress(candidate.payTo, selected.payTo) &&
        candidate.amount === selected.amount,
    );

    return { receipt, verified: await this.receiptIsBound(receipt, offer, payer, settle) };
  }

  private async receiptIsBound(
    receipt: unknown,
    offer: DecodedOffer | undefined,
    payer: string,
    settle: SettleResponse,
  ): Promise<boolean> {
    if (!offer || !isSignedReceipt(receipt)) return false;
    if (!isEIP712SignedReceipt(receipt) || !isEIP712SignedOffer(offer.signedOffer)) return false;
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
