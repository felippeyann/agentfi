/**
 * Unit tests — X402ClientService (task P1, hardened in review R3)
 *
 * Harness: a real x402 v2 resource server (`@x402/core/server` +
 * `@x402/evm/exact/server`, driven from a raw `node:http` server the same way
 * `@x402/express` drives Express) and a real x402 client, with ephemeral
 * local keys and a FAKE facilitator. Follows the approach of the
 * maintainer's September lab (`~/agentfi-lab/baseline.mjs`). A few cases
 * use a hand-built 402 (`fake402`) where the server fixture cannot express
 * the offer (`upto`, an 18-decimal asset).
 *
 * What the fake facilitator does NOT prove
 * ----------------------------------------
 *  - `verify()` accepts every authorization: no signature, balance, nonce,
 *    validity-window or on-chain replay check is performed.
 *  - `settle()` returns a synthetic transaction hash: no USDC moves, no RPC
 *    is called, no block is awaited. `txHash` in the results is fabricated.
 *  - The idempotency cache lives in the test server only; the protocol's
 *    `payment-identifier` extension carries an id but does not deduplicate
 *    by itself, and the client signs a fresh authorization on every call.
 *  - Receipts are signed by an ephemeral seller key with no trust anchor:
 *    `receiptVerified: true` means "signed by whoever signed the offer and
 *    bound to it", not "a key we have any reason to trust".
 *  - No real facilitator auth (CDP key), rate limits or
 *    `settlement_pending` outcomes are exercised.
 *
 * Passing means the client-side control flow behaves as specified under
 * those assumptions, nothing more.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { generatePaymentId } from '@x402/extensions/payment-identifier';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  BudgetExceededError,
  MAX_AUTHORIZATION_WINDOW_SECONDS,
  NoAcceptableSchemeError,
  PaymentFailedError,
  X402ClientService,
  X402PaymentError,
  type AuthorizationInfo,
  type SelectedPaymentOption,
} from '../services/payments/x402-client.service.js';
import {
  BASE_MAINNET,
  MEGAETH,
  MEGA_USD,
  NETWORK,
  NONCE_32,
  USDC_BASE_SEPOLIA,
  accountSigner,
  failAfterSigning,
  fake402,
  loopbackOnly,
  neverFetch,
  rejection,
  startResourceServer,
  withoutPaymentResponse,
  type FixtureOptions,
} from './helpers/x402-fixture.js';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('X402ClientService', () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const signer = accountSigner(buyer);
  const open: Array<() => Promise<void>> = [];

  async function fixture(options?: FixtureOptions, serviceOptions: ConstructorParameters<typeof X402ClientService>[0] = {}) {
    const server = await startResourceServer(options);
    open.push(server.close);
    const service = new X402ClientService({ fetch: loopbackOnly(server.base), ...serviceOptions });
    return { ...server, service };
  }

  /** Default job: $1 cap on Base Sepolia. */
  const job = { signer, maxAmountUsd: '$1', allowedNetworks: [NETWORK] };

  beforeEach(() => {
    signer.signatures = 0;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  describe('non-402 responses', () => {
    it('returns a free resource untouched with paid: false and no signing', async () => {
      const f = await fixture();
      const result = await f.service.payResource({ ...job, url: `${f.base}/free` });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(false);
      expect(result.payment).toBeUndefined();
      expect(JSON.parse(result.body)).toEqual({ free: true });
      expect(result.headers['content-type']).toBe('application/json');
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('returns (never throws on) a non-402 error status', async () => {
      const f = await fixture();
      const result = await f.service.payResource({ ...job, url: `${f.base}/boom` });

      expect(result.status).toBe(500);
      expect(result.paid).toBe(false);
      expect(result.body).toBe('kaboom');
      expect(f.counts.verify).toBe(0);
    });
  });

  describe('priced resource within the cap', () => {
    it('pays, reports the settled amount, payer, (fake) tx hash and the signed authorization', async () => {
      const f = await fixture({ price: '$0.40' });
      const before = Math.floor(Date.now() / 1000);
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(true);
      expect(JSON.parse(result.body)).toEqual({ quote: 42, sequence: 1 });
      expect(result.headers['payment-response']).toBeTruthy();

      const payment = result.payment!;
      expect(payment.paymentId).toMatch(/^agentfi_[0-9a-f]{32}$/);
      expect(payment.paymentIdSent).toBe(true);
      expect(payment.network).toBe(NETWORK);
      expect(payment.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
      expect(payment.amount).toBe('400000'); // $0.40 in 6-decimal USDC
      expect(payment.payer.toLowerCase()).toBe(buyer.address.toLowerCase());
      expect(payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(payment.receipt).toBeUndefined();
      expect(payment.receiptVerified).toBeUndefined();

      // The authorization the server now holds: nonce + window, bounded by
      // the route's maxTimeoutSeconds (server default 300 ≤ our 600 limit).
      const auth = payment.authorization!;
      expect(auth).toMatchObject({ scheme: 'exact', method: 'eip3009', validAfter: '0' });
      expect(auth.nonce).toMatch(NONCE_32);
      expect(Number(auth.validBefore)).toBeGreaterThan(before);
      expect(Number(auth.validBefore)).toBeLessThanOrEqual(before + 300 + 5);
      expect(Number(auth.validBefore)).toBeLessThanOrEqual(before + MAX_AUTHORIZATION_WINDOW_SECONDS + 5);

      expect(signer.signatures).toBe(1);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('accepts a price exactly at the cap and plain-decimal caps', async () => {
      const f = await fixture({ price: '$0.50' });
      const result = await f.service.payResource({ ...job, url: f.url, maxAmountUsd: '0.50' });

      expect(result.paid).toBe(true);
      expect(result.payment?.amount).toBe('500000');
    });

    it('uses a caller-supplied paymentId', async () => {
      const f = await fixture();
      const paymentId = generatePaymentId('job_');
      const result = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(result.payment?.paymentId).toBe(paymentId);
      expect(result.payment?.paymentIdSent).toBe(true);
    });

    it('reports paymentIdSent: false when the 402 does not declare payment-identifier', async () => {
      const f = await fixture({ paymentIdentifier: false });
      const paymentId = generatePaymentId('job_');
      const result = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(result.paid).toBe(true);
      expect(result.payment?.paymentId).toBe(paymentId);
      expect(result.payment?.paymentIdSent).toBe(false);
    });
  });

  describe('spend controls (gate 1: preflight on the raw 402)', () => {
    it('refuses a price above maxAmountUsd before signing; the facilitator is never called', async () => {
      const f = await fixture({ price: '$0.60' });
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );

      expect(error.code).toBe('BUDGET_EXCEEDED');
      expect(error).toBeInstanceOf(X402PaymentError);
      expect(error.details['maxAmountUsd']).toBe('$0.50');
      expect(error.details['cheapest']).toMatchObject({ usd: '0.6', amount: '600000', network: NETWORK });
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('refuses a network outside allowedNetworks with NoAcceptableScheme; nothing is signed', async () => {
      const f = await fixture();
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, allowedNetworks: [BASE_MAINNET] }),
        NoAcceptableSchemeError,
      );

      expect(error.code).toBe('NO_ACCEPTABLE_SCHEME');
      expect(error.details['allowedNetworks']).toEqual([BASE_MAINNET]);
      expect(error.details['offered']).toEqual([expect.objectContaining({ network: NETWORK, scheme: 'exact' })]);
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('pays only on the allowed network when the server offers several (mainnet listed first)', async () => {
      const f = await fixture({ alsoAccept: [BASE_MAINNET] });

      const testnet = await f.service.payResource({ ...job, url: f.url, allowedNetworks: [NETWORK] });
      expect(testnet.paid).toBe(true);
      expect(testnet.payment?.network).toBe(NETWORK);
      expect(testnet.payment?.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());

      const mainnet = await f.service.payResource({ ...job, url: f.url, allowedNetworks: [BASE_MAINNET] });
      expect(mainnet.paid).toBe(true);
      expect(mainnet.payment?.network).toBe(BASE_MAINNET);
    });

    it('requires allowedNetworks and rejects wildcards unless allowWildcardNetworks is passed, before any request', async () => {
      const service = new X402ClientService({ fetch: neverFetch() });
      const base = { signer, url: 'http://127.0.0.1:1/paid', maxAmountUsd: '$1' };

      await expect(
        service.payResource({ ...base } as unknown as Parameters<typeof service.payResource>[0]),
      ).rejects.toThrow(/allowedNetworks is required/);
      await expect(service.payResource({ ...base, allowedNetworks: [] })).rejects.toThrow(/allowedNetworks is required/);
      await expect(service.payResource({ ...base, allowedNetworks: ['eip155:*'] })).rejects.toThrow(/wildcard/);
      await expect(service.payResource({ ...base, allowedNetworks: [NETWORK, 'eip155:*'] })).rejects.toThrow(/wildcard/);
      expect(signer.signatures).toBe(0);
    });

    it('honours a wildcard only with allowWildcardNetworks: true', async () => {
      const f = await fixture();
      const result = await f.service.payResource({
        ...job,
        url: f.url,
        allowedNetworks: ['eip155:*'],
        allowWildcardNetworks: true,
      });
      expect(result.paid).toBe(true);
      expect(result.payment?.network).toBe(NETWORK);
    });

    it('refuses an authorization window longer than MAX_AUTHORIZATION_WINDOW_SECONDS before signing', async () => {
      const f = await fixture({ maxTimeoutSeconds: 1e9 });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), NoAcceptableSchemeError);

      expect(error.code).toBe('NO_ACCEPTABLE_SCHEME');
      expect(error.details['maxAuthorizationWindowSeconds']).toBe(600);
      expect(error.details['rejected']).toEqual([
        expect.objectContaining({
          network: NETWORK,
          maxTimeoutSeconds: 1e9,
          reason: expect.stringMatching(/longer than the 600s limit/),
        }),
      ]);
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('lets the caller widen the window explicitly (per call or per service)', async () => {
      const f = await fixture({ maxTimeoutSeconds: 900 });

      await rejection(f.service.payResource({ ...job, url: f.url }), NoAcceptableSchemeError);
      const perCall = await f.service.payResource({ ...job, url: f.url, maxAuthorizationWindowSeconds: 1000 });
      expect(perCall.paid).toBe(true);

      const wide = new X402ClientService({ fetch: loopbackOnly(f.base), maxAuthorizationWindowSeconds: 1000 });
      const perService = await wide.payResource({ ...job, url: f.url });
      expect(perService.paid).toBe(true);
    });

    it('rejects malformed caps, networks, payment ids and timeouts before any request', async () => {
      const service = new X402ClientService({ fetch: neverFetch() });
      const base = { ...job, url: 'http://127.0.0.1:1/paid' };

      await expect(service.payResource({ ...base, maxAmountUsd: '1 USDT' })).rejects.toThrow(/plain USD amount/);
      await expect(service.payResource({ ...base, maxAmountUsd: '$0' })).rejects.toThrow(/positive/);
      await expect(service.payResource({ ...base, allowedNetworks: ['base'] })).rejects.toThrow(/CAIP-2/);
      await expect(service.payResource({ ...base, paymentId: 'short' })).rejects.toThrow(/paymentId/);
      await expect(service.payResource({ ...base, requestTimeoutMs: 0 })).rejects.toThrow(/requestTimeoutMs/);
      await expect(service.payResource({ ...base, maxAuthorizationWindowSeconds: -1 })).rejects.toThrow(
        /maxAuthorizationWindowSeconds/,
      );
      expect(() => new X402ClientService({ requestTimeoutMs: Number.NaN })).toThrow(/requestTimeoutMs/);
    });

    it('rejects an `upto` offer (only `exact` is supported) without signing', async () => {
      const url = 'http://127.0.0.1:1/upto';
      const service = new X402ClientService({
        fetch: fake402(url, [
          {
            scheme: 'upto',
            network: NETWORK,
            asset: USDC_BASE_SEPOLIA,
            amount: '400000',
            payTo: buyer.address,
            maxTimeoutSeconds: 300,
            extra: { name: 'USDC', version: '2' },
          },
        ]),
      });
      const error = await rejection(service.payResource({ ...job, url }), NoAcceptableSchemeError);

      expect(error.message).toMatch(/scheme "exact"/);
      expect(error.details['offered']).toEqual([expect.objectContaining({ scheme: 'upto' })]);
      expect(signer.signatures).toBe(0);
    });

    it('converts the cap with the asset decimals (18-decimal MegaUSD), not a hard-coded 6', async () => {
      const url = 'http://127.0.0.1:1/mega';
      const sixTenthsOfADollar: PaymentRequirements = {
        scheme: 'exact',
        network: MEGAETH,
        asset: MEGA_USD,
        amount: '600000000000000000', // 0.6 × 10^18
        payTo: buyer.address,
        maxTimeoutSeconds: 300,
        extra: { name: 'MegaUSD', version: '1', assetTransferMethod: 'permit2' },
      };
      const service = new X402ClientService({ fetch: fake402(url, [sixTenthsOfADollar]) });
      const mega = { signer, url, allowedNetworks: [MEGAETH] };

      // Priced as 0.6 MegaUSD: above a $0.50 cap …
      const tooExpensive = await rejection(service.payResource({ ...mega, maxAmountUsd: '$0.50' }), BudgetExceededError);
      expect(tooExpensive.details['cheapest']).toMatchObject({ usd: '0.6', amount: sixTenthsOfADollar.amount });
      expect(signer.signatures).toBe(0);

      // … and within a $1 cap (6-decimal math would read it as $600 000 000 000).
      const paid = await service.payResource({ ...mega, maxAmountUsd: '$1' });
      expect(signer.signatures).toBe(1);
      expect(paid.paid).toBe(false); // bare 200, no PAYMENT-RESPONSE
      expect(paid.payment).toMatchObject({ amount: sixTenthsOfADollar.amount, network: MEGAETH });
      expect(paid.payment?.authorization).toMatchObject({ method: 'permit2' });
      expect(paid.payment?.authorization?.nonce).toMatch(/^\d+$/);
    });
  });

  describe('spend controls (gates 2 and 3, with gate 1 disabled through the test-only hook)', () => {
    it('gate 2 (x402 spendControls) refuses an over-cap option before signing when preflight is skipped', async () => {
      const f = await fixture({ price: '$0.60' }, { __testOnlyGates: { skipPreflight: true } });
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, maxAmountUsd: '$0.50' }),
        X402PaymentError,
      );

      expect(error.details['authorizationSent']).toBe(false);
      expect(error.details['stage']).toBe('payment-creation');
      expect(String(error.details['cause'])).toMatch(/spendControls/);
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('gate 3 (onBeforePaymentCreation re-check) aborts the signature when gates 1 and 2 are skipped', async () => {
      const f = await fixture(
        { price: '$0.60' },
        { __testOnlyGates: { skipPreflight: true, skipSpendControls: true } },
      );
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );

      expect(error.message).toMatch(/Refusing to sign/);
      expect(error.details['selected']).toMatchObject({ amount: '600000', network: NETWORK });
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('gate 3 also refuses an over-long window the library would otherwise sign', async () => {
      const f = await fixture(
        { maxTimeoutSeconds: 1e9 },
        { __testOnlyGates: { skipPreflight: true, skipSpendControls: true } },
      );
      // The window policy (gate 2) filters the option out first; the hook
      // never runs. Either way nothing is signed.
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), X402PaymentError);
      expect(error.details['authorizationSent']).toBe(false);
      expect(signer.signatures).toBe(0);
    });

    it('the test-only hook is refused when NODE_ENV=production', () => {
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(() => new X402ClientService({ __testOnlyGates: { skipPreflight: true } })).toThrow(/production/);
      } finally {
        process.env['NODE_ENV'] = previous;
      }
    });
  });

  describe('payment-identifier: the server may deduplicate, the client always re-signs', () => {
    it('signs a fresh authorization on every call; a server cache keyed by paymentId prevents the second settlement', async () => {
      const f = await fixture({ idempotencyCache: true });
      const paymentId = generatePaymentId('job_');

      const first = await f.service.payResource({ ...job, url: f.url, paymentId });
      const second = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(first.paid).toBe(true);
      expect(second.paid).toBe(true);
      expect(second.body).toBe(first.body);
      expect(second.payment?.txHash).toBe(first.payment?.txHash);
      expect(first.payment?.paymentIdSent).toBe(true);
      expect(second.payment?.paymentIdSent).toBe(true);

      // The id is only visible to the server inside a signed payment, so the
      // cache cannot short-circuit before the second signature exists: two
      // live authorizations, one settlement.
      expect(signer.signatures).toBe(2);
      expect(second.payment?.authorization?.nonce).not.toBe(first.payment?.authorization?.nonce);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('documents that the extension alone does not deduplicate (no server cache → settled twice)', async () => {
      const f = await fixture({ idempotencyCache: false });
      const paymentId = generatePaymentId('job_');

      const first = await f.service.payResource({ ...job, url: f.url, paymentId });
      const second = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(signer.signatures).toBe(2);
      expect(second.payment?.authorization?.nonce).not.toBe(first.payment?.authorization?.nonce);
      expect(f.counts.settle).toBe(2);
    });
  });

  describe('failures after signing carry the authorization', () => {
    it('throws PaymentFailed when the facilitator rejects verification', async () => {
      const f = await fixture({ facilitator: 'reject-verify' });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.code).toBe('PAYMENT_FAILED');
      expect(error.details['status']).toBe(402);
      expect(error.details['authorizationSent']).toBe(true);
      expect(error.details['paymentIdSent']).toBe(true);
      expect(error.details['reason']).toContain('insufficient_funds');
      expect(error.details['authorization']).toMatchObject({ method: 'eip3009' });
      expect((error.details['authorization'] as { nonce: string }).nonce).toMatch(NONCE_32);
      expect(f.counts).toEqual({ verify: 1, settle: 0, deliver: 0 });
    });

    it('throws PaymentFailed with the nonce when settlement fails after delivery', async () => {
      const f = await fixture({ facilitator: 'fail-settle' });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.details['authorizationSent']).toBe(true);
      expect(String(error.details['reason'])).toContain('settle_failed');
      const auth = error.details['authorization'] as { nonce: string; validBefore: string };
      expect(auth.nonce).toMatch(NONCE_32);
      expect(Number(auth.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('a transport failure after signing is PaymentFailed with authorizationSent: true', async () => {
      const f = await fixture();
      const service = new X402ClientService({ fetch: failAfterSigning(loopbackOnly(f.base)) });
      const error = await rejection(service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.message).toMatch(/during paid-request/);
      expect(error.details['stage']).toBe('paid-request');
      expect(error.details['authorizationSent']).toBe(true);
      expect(error.details['timedOut']).toBe(false);
      expect((error.details['authorization'] as { nonce: string }).nonce).toMatch(NONCE_32);
      expect(signer.signatures).toBe(1);
      expect(f.counts.verify).toBe(0);
    });

    it('a 2xx without PAYMENT-RESPONSE is paid: false with the payment (and authorization) attached', async () => {
      const f = await fixture();
      const service = new X402ClientService({ fetch: withoutPaymentResponse(loopbackOnly(f.base)) });
      const result = await service.payResource({ ...job, url: f.url });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(false);
      expect(result.payment).toMatchObject({ amount: '400000', network: NETWORK, paymentIdSent: true });
      expect(result.payment?.txHash).toBeUndefined();
      expect(result.payment?.authorization?.nonce).toMatch(NONCE_32);
      // The server did settle; only its report was lost in transit.
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });
  });

  describe('request timeouts', () => {
    it('times out the plain request: PaymentFailed, timedOut, nothing signed', async () => {
      const f = await fixture({ stall: 'first' }, { requestTimeoutMs: 250 });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.message).toMatch(/timed out after 250ms/);
      expect(error.details['timedOut']).toBe(true);
      expect(error.details['stage']).toBe('request');
      expect(error.details['authorizationSent']).toBe(false);
      expect(signer.signatures).toBe(0);
    });

    it('times out the paid request: authorizationSent: true with the nonce (per-call override)', async () => {
      const f = await fixture({ stall: 'paid' });
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, requestTimeoutMs: 250 }),
        PaymentFailedError,
      );

      expect(error.message).toMatch(/timed out after 250ms with a signed authorization already sent/);
      expect(error.details['timedOut']).toBe(true);
      expect(error.details['stage']).toBe('paid-request');
      expect(error.details['authorizationSent']).toBe(true);
      expect((error.details['authorization'] as { nonce: string }).nonce).toMatch(NONCE_32);
      expect(signer.signatures).toBe(1);
    });
  });

  describe('error-message hygiene', () => {
    it('keeps query strings out of messages (full URL only in details)', async () => {
      const f = await fixture({ price: '$0.60', facilitator: 'reject-verify' });
      const url = `${f.url}?api_key=SECRET123&x=1`;

      const budget = await rejection(
        f.service.payResource({ ...job, url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );
      expect(budget.message).not.toContain('SECRET123');
      expect(budget.message).toContain(f.url);
      expect(budget.details['url']).toBe(url);

      const scheme = await rejection(
        f.service.payResource({ ...job, url, allowedNetworks: [BASE_MAINNET] }),
        NoAcceptableSchemeError,
      );
      expect(scheme.message).not.toContain('SECRET123');

      const failed = await rejection(f.service.payResource({ ...job, url }), PaymentFailedError);
      expect(failed.message).not.toContain('SECRET123');
      expect(failed.details['url']).toBe(url);

      const transport = await rejection(
        new X402ClientService({ fetch: neverFetch() }).payResource({ ...job, url }),
        PaymentFailedError,
      );
      expect(transport.message).not.toContain('SECRET123');
    });

    it('caps server-supplied reasons at 200 characters', async () => {
      const f = await fixture({ facilitator: 'reject-verify', rejectReason: 'x'.repeat(5000) });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.message.length).toBeLessThan(400);
      expect(error.message).toMatch(/x{200}…$/);
      expect(String(error.details['reason']).length).toBe(201);
    });
  });

  describe('signed offer / receipt (offer-receipt extension)', () => {
    it('verifies a receipt signed by the offer issuer and bound to offer, payer and tx', async () => {
      const f = await fixture({ receipts: 'valid' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toMatchObject({
        format: 'eip712',
        payload: {
          resourceUrl: f.url,
          network: NETWORK,
          transaction: result.payment?.txHash,
        },
      });
      expect(result.payment?.receiptVerified).toBe(true);
    });

    it('marks a receipt altered after signing as unverified without failing the payment', async () => {
      const f = await fixture({ receipts: 'tampered' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toBeDefined();
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a validly signed receipt that names a different tx as unverified', async () => {
      const f = await fixture({ receipts: 'wrong-tx' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.txHash).not.toBe(`0x${'ff'.repeat(32)}`);
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a receipt signed by a key other than the offer signer as unverified (payer untouched)', async () => {
      const f = await fixture({ receipts: 'foreign-key' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toMatchObject({ payload: { payer: buyer.address } });
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a receipt bound to an offer for a different resource than the 402 named as unverified', async () => {
      const f = await fixture({ receipts: 'wrong-resource' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toMatchObject({ payload: { resourceUrl: expect.stringContaining('/other') } });
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a receipt bound to an offer that had expired before signing as unverified', async () => {
      const f = await fixture({ receipts: 'expired-offer' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toBeDefined();
      expect(result.payment?.receiptVerified).toBe(false);
    });
  });

  describe('ledger hooks (P2/P5): onBeforeSign and onAuthorizationSigned', () => {
    it('onBeforeSign sees the priced option and may refuse before any signature; its error is rethrown unchanged', async () => {
      const f = await fixture({ price: '$0.40' });
      class LedgerRefusal extends Error {}
      let seen: SelectedPaymentOption | undefined;

      const error = await rejection(
        f.service.payResource({
          ...job,
          url: f.url,
          onBeforeSign: (selected) => {
            seen = selected;
            throw new LedgerRefusal('budget reserved elsewhere');
          },
        }),
        LedgerRefusal,
      );

      expect(error.message).toBe('budget reserved elsewhere');
      expect(seen).toMatchObject({
        scheme: 'exact',
        network: NETWORK,
        amount: '400000',
        maxTimeoutSeconds: 300,
        symbol: 'USDC',
        decimals: 6,
        usd: '0.4',
      });
      expect(seen?.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
      expect(seen?.payTo.toLowerCase()).toBe(f.seller.address.toLowerCase());
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('onAuthorizationSigned runs after signing and before sending; a throw keeps the signed payload in-process', async () => {
      const f = await fixture();
      const order: string[] = [];
      let auth: AuthorizationInfo | undefined;

      const paid = await f.service.payResource({
        ...job,
        url: f.url,
        onBeforeSign: () => {
          order.push('before');
        },
        onAuthorizationSigned: (authorization, selected) => {
          order.push('signed');
          auth = authorization;
          expect(selected.amount).toBe('400000');
        },
      });
      expect(paid.paid).toBe(true);
      expect(order).toEqual(['before', 'signed']);
      expect(auth?.nonce).toMatch(NONCE_32);
      expect(auth?.nonce).toBe(paid.payment?.authorization?.nonce);

      class LedgerDown extends Error {}
      const error = await rejection(
        f.service.payResource({
          ...job,
          url: f.url,
          onAuthorizationSigned: () => {
            throw new LedgerDown('db unavailable');
          },
        }),
        LedgerDown,
      );
      expect(error.message).toBe('db unavailable');
      // Signed a second time …
      expect(signer.signatures).toBe(2);
      // … but that payload never reached the server.
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });
  });
});
