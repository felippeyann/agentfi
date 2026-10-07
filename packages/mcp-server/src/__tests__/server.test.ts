/**
 * tools/call through the real dispatcher, with the backend replaced by a
 * stubbed fetch: errors from any tool come back sanitized with a traceId,
 * and pay_for_resource's typed refusals stay structured output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { callTool } from '../server.js';

const API_KEY = process.env['AGENTFI_API_KEY'] ?? '';
const API_HOST = 'agentfi-backend.test-net';
const TX_HASH = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

const log = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  log.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('tools/call error sanitizing', () => {
  it('keeps a backend validation error (message, code, details) and adds a traceId', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(400, {
        error: 'Validation failed',
        code: 'VALIDATION_FAILED',
        details: [{ code: 'invalid_string', path: ['url'], message: 'Invalid url' }],
      }),
    );
    const result = await callTool(
      'pay_for_resource',
      { job_id: 'job_1', url: 'https://api.example.com/data' },
      { log },
    );
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({
      error: 'AgentFi API error 400: Validation failed',
      code: 'VALIDATION_FAILED',
      status: 400,
      details: { details: [{ code: 'invalid_string', path: ['url'], message: 'Invalid url' }] },
      tool: 'pay_for_resource',
    });
    expect(payload['traceId']).toMatch(/^[0-9a-f]{12}$/);
    expect(log).toHaveBeenCalledWith(payload['traceId'], 'pay_for_resource', expect.any(Error));
  });

  it('keeps a business refusal code such as ESCROW_NOT_FUNDED', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(409, {
        error: 'ESCROW_NOT_FUNDED',
        message: 'Job is not funded on-chain yet (onChainStatus=CREATED)',
        onChainStatus: 'CREATED',
        escrowError: null,
      }),
    );
    const payload = payloadOf(await callTool('update_job_status', { job_id: 'job_1', status: 'ACCEPTED' }, { log }));
    expect(payload).toMatchObject({
      code: 'ESCROW_NOT_FUNDED',
      status: 409,
      details: { message: 'Job is not funded on-chain yet (onChainStatus=CREATED)', onChainStatus: 'CREATED' },
    });
  });

  it('strips RPC keys, internal URLs, paths and stack frames from a backend 500', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(500, {
        statusCode: 500,
        error: 'Internal Server Error',
        message:
          'HTTP request failed.\nURL: https://base-mainnet.g.alchemy.com/v2/AbCdEf1234567890XyZ_kEy-0987\n' +
          '    at request (/app/node_modules/viem/_esm/utils/rpc/http.js:118:23)\n' +
          `while calling http://${API_HOST}:3000/v1/internal from /app/packages/backend/dist/index.js:12:3`,
      }),
    );
    const result = await callTool('get_wallet_info', {}, { log });
    const text = JSON.stringify(payloadOf(result));
    expect(text).not.toContain('AbCdEf1234567890XyZ_kEy-0987');
    expect(text).not.toContain(API_HOST);
    expect(text).not.toContain('/app/');
    expect(text).not.toContain('    at ');
    expect(payloadOf(result)['details']).toEqual({
      statusCode: 500,
      message:
        'HTTP request failed.\nURL: https://base-mainnet.g.alchemy.com/[redacted]\nwhile calling [internal-url] from [path]',
    });
  });

  it('turns a network failure into UPSTREAM_UNREACHABLE without echoing the backend address', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${API_HOST}:3000`), { code: 'ECONNREFUSED' }),
      }),
    );
    const payload = payloadOf(await callTool('get_policy', {}, { log }));
    expect(payload).toMatchObject({ code: 'UPSTREAM_UNREACHABLE', tool: 'get_policy' });
    expect(JSON.stringify(payload)).not.toContain(API_HOST);
  });

  it('reports invalid tool input as INVALID_INPUT with the Zod issues', async () => {
    const payload = payloadOf(
      await callTool('pay_for_resource', { job_id: 'job_1', url: 'not a url', payment_id: 'short' }, { log }),
    );
    expect(payload['code']).toBe('INVALID_INPUT');
    const issues = (payload['details'] as { issues: Array<{ path: string }> }).issues.map((i) => i.path).sort();
    expect(issues).toEqual(['payment_id', 'url']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps tool-side validation messages (unsupported token symbol)', async () => {
    const payload = payloadOf(
      await callTool('simulate_swap', { from_token: 'DOGE', to_token: 'USDC', amount_in: '1', chain_id: 1 }, { log }),
    );
    expect(payload['error']).toBe('Unsupported token symbol DOGE on chain 1. Use a token contract address.');
  });

  it('never returns the agent API key even if the backend echoes it', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: `Invalid API key ${API_KEY}`, presented: API_KEY }));
    const payload = payloadOf(await callTool('get_my_agent_profile', {}, { log }));
    expect(API_KEY.length).toBeGreaterThan(10);
    expect(JSON.stringify(payload)).not.toContain(API_KEY);
    expect(payload['error']).toBe('AgentFi API error 401: Invalid API key [redacted]');
  });

  it('keeps a tx hash in a failure message', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(422, { error: `Transaction ${TX_HASH} reverted` }));
    const payload = payloadOf(
      await callTool('transfer_token', { token: 'ETH', to: '0x0000000000000000000000000000000000000001', amount: '1' }, { log }),
    );
    expect(payload['error']).toBe(`AgentFi API error 422: Transaction ${TX_HASH} reverted`);
  });

  it('writes nothing to stdout when a tool fails with the default logger', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => jsonResponse(500, { error: 'Internal Server Error' }));
    const result = await callTool('get_policy', {});
    expect(result.isError).toBe(true);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('still reports an unknown tool', async () => {
    const result = await callTool('nope', {}, { log });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toEqual({ error: 'Unknown tool: nope' });
  });
});

describe('pay_for_resource typed refusals (unchanged)', () => {
  it('returns BUDGET_EXCEEDED as structured, non-error output', async () => {
    const body = {
      error: 'Resource price 2.00 exceeds the remaining job budget 0.50',
      code: 'BUDGET_EXCEEDED',
      price: '2.00',
      remaining: '0.50',
    };
    fetchMock.mockImplementation(async () => jsonResponse(409, body));
    const result = await callTool(
      'pay_for_resource',
      { job_id: 'job_1', url: 'https://api.example.com/data', payment_id: 'pay_0123456789abcdef' },
      { log },
    );
    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toEqual({ paid: false, httpStatus: 409, ...body });
    expect(log).not.toHaveBeenCalled();
  });

  it('returns PAYMENT_OUTCOME_UNKNOWN as structured output too', async () => {
    const body = { error: 'Settlement not confirmed', code: 'PAYMENT_OUTCOME_UNKNOWN', paymentId: 'pay_0123456789abcdef' };
    fetchMock.mockImplementation(async () => jsonResponse(502, body));
    const result = await callTool(
      'pay_for_resource',
      { job_id: 'job_1', url: 'https://api.example.com/data' },
      { log },
    );
    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toEqual({ paid: false, httpStatus: 502, ...body });
  });
});
