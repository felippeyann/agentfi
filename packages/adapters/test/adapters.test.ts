import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentFiClient, DEFAULT_API_URL } from '../src/client.js';
import { getAgentFiTools, handleAgentFiToolCall } from '../src/openai.js';
import { AgentFiToolkit } from '../src/langchain.js';
import { enabledTools } from '../src/tools.js';
import { payForResource } from '../src/pay-resource.js';

type Hit = { method: string; path: string; headers: http.IncomingHttpHeaders; body: any };

/** A tiny local API: replies with whatever `reply` returns, records every request. */
let server: http.Server;
let hits: Hit[];
let reply: (hit: Hit) => { status: number; body: unknown; delayMs?: number };
let apiUrl: string;

beforeEach(async () => {
  hits = [];
  reply = () => ({ status: 200, body: {} });
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const hit: Hit = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      hits.push(hit);
      const r = reply(hit);
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cfg = () => ({ apiKey: 'agfi_stub_not_a_secret', apiUrl });
const PAY_ID = 'pay-0123456789abcdef';

describe('tool surface', () => {
  it('default set is payer-safe: pay_for_resource + two read-only tools, nothing administrative', () => {
    const names = getAgentFiTools().map((t) => t.function.name).sort();
    expect(names).toEqual(['agentfi_get_job', 'agentfi_get_wallet_info', 'agentfi_pay_for_resource']);
    for (const n of names) expect(n).not.toMatch(/admin|approve|reject|policy|pause|resume|resolve|reconcile|register|budget/i);
  });

  it('legacy DeFi tools exist only behind legacyDefi, and are labelled', () => {
    const legacy = getAgentFiTools({ legacyDefi: true }).filter((t) => !getAgentFiTools().some((a) => a.function.name === t.function.name));
    expect(legacy.map((t) => t.function.name)).toContain('agentfi_execute_swap');
    for (const t of legacy) expect(t.function.description).toMatch(/LEGACY/);
  });

  it('the pay tool description forbids retrying an uncertain payment with a new id', () => {
    const pay = getAgentFiTools().find((t) => t.function.name === 'agentfi_pay_for_resource')!;
    expect(pay.function.description).toMatch(/do NOT use a new payment_id/);
    expect(pay.function.parameters.required).toEqual(['job_id', 'url']);
  });

  it('a disabled legacy tool is refused without any request', async () => {
    const out = JSON.parse(await handleAgentFiToolCall('agentfi_transfer_token', JSON.stringify({ token: 'ETH', to: '0x' + '1'.repeat(40), amount: '1' }), cfg()));
    expect(out.error).toMatch(/Unknown or disabled/);
    expect(hits).toHaveLength(0);
  });
});

describe('client', () => {
  it('defaults to localhost, never the decommissioned fly.dev host', () => {
    expect(DEFAULT_API_URL).toBe('http://localhost:3000');
    expect(new AgentFiClient({ apiKey: 'k' }).apiUrl).toBe('http://localhost:3000');
  });
  it('requires an api key', () => {
    expect(() => new AgentFiClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });
});

describe('agentfi_pay_for_resource', () => {
  it('maps 1:1 onto POST /v1/jobs/{id}/pay-resource and passes the paymentId, x-api-key and cap through', async () => {
    reply = () => ({ status: 200, body: { payment: { status: 'settled' }, remainingBudget: {}, resource: { status: 200, body: {} } } });
    const out = JSON.parse(await handleAgentFiToolCall('agentfi_pay_for_resource', JSON.stringify({ job_id: 'job_1', url: 'https://seller.example/report', max_amount: '0.50', payment_id: PAY_ID }), cfg()));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: 'POST', path: '/v1/jobs/job_1/pay-resource' });
    expect(hits[0]!.headers['x-api-key']).toBe('agfi_stub_not_a_secret');
    expect(hits[0]!.body).toEqual({ url: 'https://seller.example/report', method: 'GET', maxAmount: '0.50', paymentId: PAY_ID });
    expect(out.httpStatus).toBe(200);
    expect(out.paymentId).toBe(PAY_ID);
  });

  it('generates a valid paymentId when none is given and echoes it', async () => {
    const out = JSON.parse(await handleAgentFiToolCall('agentfi_pay_for_resource', JSON.stringify({ job_id: 'job_1', url: 'https://seller.example/r' }), cfg()));
    expect(hits[0]!.body.paymentId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(out.paymentId).toBe(hits[0]!.body.paymentId);
  });

  it('computes nothing: it never sends a budget or amount of its own', async () => {
    await payForResource(new AgentFiClient(cfg()), { job_id: 'job_1', url: 'https://seller.example/r' });
    expect(Object.keys(hits[0]!.body).sort()).toEqual(['method', 'paymentId', 'url']);
  });

  it('PAYMENT_OUTCOME_UNKNOWN (502): one request only, state verbatim, explicit do-not-retry guidance', async () => {
    reply = () => ({ status: 502, body: { error: 'Payment outcome unknown', code: 'PAYMENT_OUTCOME_UNKNOWN', payment: { status: 'unknown' } } });
    const out = await payForResource(new AgentFiClient(cfg()), { job_id: 'job_1', url: 'https://seller.example/r', payment_id: PAY_ID });
    expect(hits).toHaveLength(1);
    expect(out['httpStatus']).toBe(502);
    expect(out['code']).toBe('PAYMENT_OUTCOME_UNKNOWN');
    expect((out['payment'] as any).status).toBe('unknown');
    expect(String(out['guidance'])).toMatch(/Do NOT retry with a new payment_id/);
  });

  it('a bare 5xx is treated as uncertain too (no retry, same-id guidance)', async () => {
    reply = () => ({ status: 503, body: { error: 'unavailable' } });
    const out = await payForResource(new AgentFiClient(cfg()), { job_id: 'job_1', url: 'https://seller.example/r' });
    expect(hits).toHaveLength(1);
    expect(String(out['guidance'])).toMatch(/SAME payment_id/);
  });

  it('a client-side timeout is NOT a failure: one request, CLIENT_OUTCOME_UNKNOWN, the paymentId to reuse', async () => {
    reply = () => ({ status: 200, body: {}, delayMs: 400 });
    const out = await payForResource(new AgentFiClient({ ...cfg(), timeoutMs: 50 }), { job_id: 'job_1', url: 'https://seller.example/r', payment_id: PAY_ID });
    expect(hits).toHaveLength(1);
    expect(out['httpStatus']).toBeNull();
    expect(out['code']).toBe('CLIENT_OUTCOME_UNKNOWN');
    expect(out['paymentId']).toBe(PAY_ID);
    expect(String(out['guidance'])).toMatch(/NOT known whether a payment was signed/);
  });

  it.each([
    [402, 'BUDGET_EXCEEDED'],
    [403, 'POLICY_VIOLATION'],
    [409, 'PAYMENT_IN_PROGRESS'],
    [409, 'OUTSTANDING_AUTHORIZATION'],
    [402, 'PAYMENT_REFUSED'],
  ])('%i %s is returned verbatim with guidance, no retry', async (status, code) => {
    reply = () => ({ status, body: { error: 'x', code, rule: 'maxValuePerTxUsd', remaining: '700000' } });
    const out = await payForResource(new AgentFiClient(cfg()), { job_id: 'job_1', url: 'https://seller.example/r' });
    expect(hits).toHaveLength(1);
    expect(out['httpStatus']).toBe(status);
    expect(out['code']).toBe(code);
    expect(out['rule']).toBe('maxValuePerTxUsd');
    expect(typeof out['guidance']).toBe('string');
  });

  it('replayed:true is explained (nothing paid again, resource not re-fetched)', async () => {
    reply = () => ({ status: 200, body: { payment: { status: 'settled' }, replayed: true, resource: null, remainingBudget: {} } });
    const out = await payForResource(new AgentFiClient(cfg()), { job_id: 'job_1', url: 'https://seller.example/r', payment_id: PAY_ID });
    expect(String(out['guidance'])).toMatch(/Nothing was paid again/);
  });

  it('settled with a truncated resource keeps payment and delivery apart, unmodified', async () => {
    reply = () => ({ status: 200, body: { payment: { status: 'settled' }, resource: { status: 200, truncated: true, body: 'x' }, remainingBudget: {} } });
    const out = await payForResource(new AgentFiClient(cfg()), { job_id: 'job_1', url: 'https://seller.example/r' });
    expect((out['payment'] as any).status).toBe('settled');
    expect((out['resource'] as any).truncated).toBe(true);
  });

  it('rejects malformed input locally, before any request', async () => {
    const c = new AgentFiClient(cfg());
    for (const bad of [
      { job_id: '../x', url: 'https://a.example' },
      { job_id: 'j', url: '' },
      { job_id: 'j', url: 'https://a.example', max_amount: '1e3' },
      { job_id: 'j', url: 'https://a.example', payment_id: 'short' },
      { job_id: 'j', url: 'https://a.example', method: 'DELETE' as 'GET' },
    ]) {
      const out = await payForResource(c, bad);
      expect(out['code']).toBe('ADAPTER_INVALID_INPUT');
    }
    expect(hits).toHaveLength(0);
  });
});

describe('read-only tools and LangChain shape', () => {
  it('get_job and get_wallet_info are GETs', async () => {
    await handleAgentFiToolCall('agentfi_get_job', JSON.stringify({ job_id: 'job_1' }), cfg());
    await handleAgentFiToolCall('agentfi_get_wallet_info', JSON.stringify({ chain_id: 84532 }), cfg());
    expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual(['GET /v1/jobs/job_1', 'GET /v1/wallet/balance?chainId=84532']);
  });

  it('LangChain fields mirror the catalog, with a JSON Schema and a func that calls the API', async () => {
    const fields = new AgentFiToolkit(cfg()).getToolFields();
    expect(fields.map((f) => f.name)).toEqual(enabledTools().map((t) => t.name));
    const pay = fields.find((f) => f.name === 'agentfi_pay_for_resource')!;
    expect(pay.schema.required).toEqual(['job_id', 'url']);
    reply = () => ({ status: 200, body: { payment: null, resource: { status: 200 }, remainingBudget: {} } });
    const out = JSON.parse(await pay.func({ job_id: 'job_1', url: 'https://seller.example/free' }));
    expect(out.httpStatus).toBe(200);
    expect(hits).toHaveLength(1);
  });

  it('the legacy duck-typed getTools() still works', async () => {
    const tool = new AgentFiToolkit(cfg()).getTools().find((t) => t.name === 'agentfi_get_job')!;
    await tool.call(JSON.stringify({ job_id: 'job_9' }));
    expect(hits[0]!.path).toBe('/v1/jobs/job_9');
  });
});
