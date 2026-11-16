#!/usr/bin/env node
/**
 * STUB of the AgentFi API, for the interoperability examples only.
 *
 *   *** THIS IS NOT AGENTFI. NOTHING HERE SIGNS, PAYS OR TOUCHES A CHAIN. ***
 *
 * It replays responses shaped like the ones documented in docs/api/openapi.yaml
 * (POST /v1/jobs/{id}/pay-resource and its ResourcePaymentError). The shapes
 * were checked against the OpenAPI and the backend's x402 demo
 * (packages/backend/src/__tests__/e2e/x402-spend.demo.ts); the money, budget,
 * policy and ledger are NOT implemented: the outcome is chosen by the PATH of
 * the `url` you ask it to "pay":
 *
 *   /settled      200  payment.status = settled, resource delivered
 *   /partial      200  settled, resource.truncated = true (64 KiB read cap)
 *   /delivery-failed 200 settled but resource.status 502 (paid, NOT delivered)
 *   /free         200  payment = null (the resource never asked for payment)
 *   /budget       402  BUDGET_EXCEEDED          (refused before signing)
 *   /policy       403  POLICY_VIOLATION         (refused before signing)
 *   /in-progress  409  PAYMENT_IN_PROGRESS
 *   /outstanding  409  OUTSTANDING_AUTHORIZATION
 *   /unknown      502  PAYMENT_OUTCOME_UNKNOWN  (signed, no answer)
 *   /refused      402  PAYMENT_REFUSED
 *
 * Like the real backend, the same `paymentId` is idempotent: asking again
 * after a settled/unknown outcome returns 200 with `replayed: true` and
 * `resource: null`, and the stub counts `paidRequests` per path so a client
 * can prove it never paid twice.
 *
 * Auth: `x-api-key` must be the documented dummy key (not a secret).
 *
 * Usage:  node stub-api.mjs [--port 3000]        (default 3000, or $PORT)
 *         GET /__stub/stats  -> { paidRequests: { "/settled": 1, ... } }
 */
import http from 'node:http';

export const STUB_API_KEY = 'agfi_stub_not_a_secret';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // public USDC address on Base Sepolia
const PAY_TO = '0x000000000000000000000000000000000000dEaD'; // burn address, a placeholder payee
const NETWORK = 'eip155:84532';
const TOTAL = 1_000_000n; // job reward 1.00 USDC (base units)

function fmt(units) {
  const s = units.toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function budget(spent) {
  const remaining = TOTAL - spent;
  return {
    asset: ASSET, symbol: 'USDC', decimals: 6, network: NETWORK,
    total: TOTAL.toString(), spent: spent.toString(), remaining: remaining.toString(),
    remainingFormatted: fmt(remaining),
  };
}

function ledgerRow(jobId, paymentId, url, status, amount, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: `stub-row-${paymentId.slice(0, 8)}`, jobId, agentId: 'stub-provider-agent',
    url, method: 'GET', network: NETWORK, asset: ASSET, amount: amount.toString(), payTo: PAY_TO,
    paymentId,
    authorizationNonce: '0x' + 'ab'.repeat(32),
    authorizationValidBefore: new Date(Date.now() + 10 * 60_000).toISOString(),
    reservedAt: now, status, receipt: null, receiptVerified: null,
    settlementTxHash: null, responseStatus: status === 'unknown' ? null : 200, error: null,
    createdAt: now, updatedAt: now, ...extra,
  };
}

/** Starts the stub; resolves to { port, close(), stats() }. */
export function startStub({ port = 0 } = {}) {
  const paidRequests = {};
  const byPaymentId = new Map(); // `${jobId}:${paymentId}` -> { path, status, amount }
  let spent = 0n;

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method === 'GET' && url.pathname === '/__stub/stats') return send(res, 200, { paidRequests, spent: spent.toString() });
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', stub: true });
    if (req.headers['x-api-key'] !== STUB_API_KEY) {
      return send(res, 401, { error: 'Missing or invalid API key', code: 'UNAUTHORIZED' });
    }

    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/))) {
      return send(res, 200, {
        id: m[1], requesterId: 'stub-requester-agent', providerId: 'stub-provider-agent', status: 'ACCEPTED',
        payload: { task: 'stub job' }, reward: { amount: fmt(TOTAL), token: ASSET, chainId: 84532 },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/agents/me') {
      return send(res, 200, { id: 'stub-provider-agent', name: 'stub-provider', isActive: true, chainIds: [84532] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/wallet/balance') {
      return send(res, 200, { address: PAY_TO, balances: [] });
    }

    if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/pay-resource$/))) {
      const jobId = m[1];
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON', code: 'VALIDATION_FAILED' }); }
        if (typeof body.url !== 'string') return send(res, 400, { error: 'url is required', code: 'VALIDATION_FAILED' });
        const paymentId = body.paymentId ?? `stub-${Math.random().toString(16).slice(2)}-generated`;
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(paymentId)) {
          return send(res, 400, { error: 'paymentId must be 16-128 chars of [A-Za-z0-9_-]', code: 'VALIDATION_FAILED' });
        }
        const path = new URL(body.url, 'http://x').pathname;
        const price = 300_000n; // 0.30 USDC, like the demo seller
        const key = `${jobId}:${paymentId}`;

        // Idempotent replay: pending/settled/unknown rows are returned, nothing is paid again.
        const prior = byPaymentId.get(key);
        if (prior) {
          if (prior.path !== path) return send(res, 409, { error: 'paymentId reused with another URL', code: 'PAYMENT_ID_CONFLICT', paymentId });
          return send(res, 200, {
            payment: ledgerRow(jobId, paymentId, body.url, prior.status, price),
            remainingBudget: budget(spent), resource: null, replayed: true,
            ...(prior.status === 'unknown' ? { warning: 'Payment outcome unknown: the amount stays reserved until reconciled; do not retry with a new paymentId.' } : {}),
          });
        }

        const refuse = (status, errBody) => send(res, status, { paymentId, ...errBody });
        switch (path) {
          case '/free':
            return send(res, 200, { payment: null, remainingBudget: budget(spent), resource: { status: 200, headers: { 'content-type': 'application/json' }, body: { free: true } } });
          case '/budget':
            return refuse(402, { error: 'Price exceeds the remaining job budget', code: 'BUDGET_EXCEEDED', price: '5000000', priceFormatted: '5', remaining: (TOTAL - spent).toString(), remainingFormatted: fmt(TOTAL - spent), cap: (TOTAL - spent).toString(), capFormatted: fmt(TOTAL - spent) });
          case '/policy':
            return refuse(403, { error: 'Payment refused by the agent policy', code: 'POLICY_VIOLATION', rule: 'maxValuePerTxUsd', limit: '0.5', price: '600000' });
          case '/in-progress':
            return refuse(409, { error: 'A payment with this paymentId is in progress', code: 'PAYMENT_IN_PROGRESS' });
          case '/outstanding':
            return refuse(409, { error: 'A refused payment to the same payee still has a live authorization', code: 'OUTSTANDING_AUTHORIZATION', payTo: PAY_TO, outstandingPaymentId: 'stub-outstanding-0000-abcdef', validBefore: new Date(Date.now() + 5 * 60_000).toISOString() });
          case '/refused': {
            const validBefore = new Date(Date.now() + 5 * 60_000).toISOString();
            return refuse(402, { error: 'The server refused the signed payment', code: 'PAYMENT_REFUSED', reason: 'verification rejected', countedUntil: validBefore, payment: ledgerRow(jobId, paymentId, body.url, 'refused', price, { responseStatus: 402 }) });
          }
          case '/unknown': {
            paidRequests[path] = (paidRequests[path] ?? 0) + 1;
            byPaymentId.set(key, { path, status: 'unknown' });
            spent += price;
            return refuse(502, { error: 'Payment outcome unknown', code: 'PAYMENT_OUTCOME_UNKNOWN', payment: ledgerRow(jobId, paymentId, body.url, 'unknown', price), timedOut: true, authorization: { method: 'eip3009', nonce: '0x' + 'ab'.repeat(32), validBefore: new Date(Date.now() + 10 * 60_000).toISOString() } });
          }
          case '/partial':
          case '/delivery-failed':
          case '/settled': {
            paidRequests[path] = (paidRequests[path] ?? 0) + 1;
            byPaymentId.set(key, { path, status: 'settled' });
            spent += price;
            const truncated = path === '/partial';
            const deliveryFailed = path === '/delivery-failed'; // seller took the money, answered HTTP 502
            return send(res, 200, {
              payment: ledgerRow(jobId, paymentId, body.url, 'settled', price, { receiptVerified: true }),
              remainingBudget: budget(spent),
              resource: {
                status: deliveryFailed ? 502 : 200, headers: { 'content-type': truncated ? 'text/plain' : 'application/json' },
                body: truncated ? 'x'.repeat(256) + ' ...[stub: real cap is 64 KiB]' : deliveryFailed ? { error: 'seller error' } : { report: 'stub report', rows: 3 },
                ...(truncated ? { truncated: true } : {}),
              },
            });
          }
          default:
            return send(res, 404, { error: `stub has no scenario for path ${path}`, code: 'STUB_NO_SCENARIO' });
        }
      });
      return;
    }
    return send(res, 404, { error: `stub does not implement ${req.method} ${url.pathname}`, code: 'STUB_NOT_IMPLEMENTED' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)), stats: () => ({ paidRequests, spent }) });
    });
  });
}

// Run as a script.
if (process.argv[1] && /stub-api.mjs$/.test(process.argv[1])) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT ?? 3000);
  const s = await startStub({ port });
  console.error(`[STUB] AgentFi API stub on http://127.0.0.1:${s.port} (key: ${STUB_API_KEY}). Not AgentFi: nothing is paid.`);
}
