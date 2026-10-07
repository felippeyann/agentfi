/**
 * The backend's own MCP surface (`/mcp/sse`, api/routes/mcp.ts) — tool errors
 * (S5). Before S5 a failed proxy call returned `{ error: err.message, tool }`
 * verbatim: the backend's internal API_BASE_URL, an RPC URL with the
 * operator's key, file paths. Now the result is the same shape as
 * @agent_fi/mcp-server's (S2): sanitized `error`, `code`, `details`, `tool`,
 * `traceId`, `recommendation`; the full error is logged under the traceId.
 *
 * Driven through a real MCP client over an in-memory transport; `fetch` (the
 * proxy's call to the REST API) is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpRequestError } from 'viem';
import { createMcpServer, proxyToolErrorResult, type ProxyErrorLogger } from '../api/routes/mcp.js';

const ALCHEMY_KEY = 'Zq8mN3pL5vR7tX9wB2cD4fG6hJ1kM0aS';
const ALCHEMY_URL = `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const INTERNAL_API = 'http://agentfi-api.railway.internal:8080';
const AGENT_KEY = 'agfi_live_0123456789abcdef0123456789abcdef';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ['API_BASE_URL', 'ALCHEMY_API_KEY']) saved[name] = process.env[name];
  process.env['API_BASE_URL'] = INTERNAL_API;
  process.env['ALCHEMY_API_KEY'] = ALCHEMY_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface ToolPayload {
  error: string;
  code?: string;
  details?: unknown;
  tool: string;
  traceId: string;
  recommendation: string;
}

async function callTool(name: string, args: Record<string, unknown>, logError: ProxyErrorLogger) {
  const server = createMcpServer(AGENT_KEY, { logError });
  const client = new Client({ name: 'backend-mcp-errors-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError, text: content[0]?.text ?? '' };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('/mcp/sse tool errors (S5)', () => {
  it('an RPC error with the keyed Alchemy URL never reaches the tool result; the full error is logged under the traceId', async () => {
    const thrown = new HttpRequestError({ url: ALCHEMY_URL, status: 401, details: 'Must be authenticated!' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(thrown));
    const logError = vi.fn<Parameters<ProxyErrorLogger>, void>();

    const { isError, text } = await callTool('get_balance', { chainId: 84532 }, logError);

    expect(isError).toBe(true);
    expect(text).not.toContain(ALCHEMY_KEY);
    const payload = JSON.parse(text) as ToolPayload;
    expect(payload).toMatchObject({ error: 'HTTP request failed. (Must be authenticated!)', tool: 'get_balance' });
    expect(payload.traceId).toMatch(/^[0-9a-f]{12}$/);
    expect(payload.recommendation).toContain(payload.traceId);
    expect(logError).toHaveBeenCalledWith(payload.traceId, 'get_balance', thrown);
  });

  it("the backend's internal API_BASE_URL is not echoed when the proxy's own call fails", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`request to ${INTERNAL_API}/v1/wallet/address failed, x-api-key ${AGENT_KEY}`)),
    );

    const { text } = await callTool('get_wallet', {}, vi.fn());

    const payload = JSON.parse(text) as ToolPayload;
    expect(payload.error).toBe('request to [internal-url] failed, x-api-key [redacted-api-key]');
    expect(text).not.toContain('railway.internal');
    expect(text).not.toContain(AGENT_KEY);
  });

  it('a connection failure is classified, not echoed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:8080'), { code: 'ECONNREFUSED' }) }),
      ),
    );

    const { text } = await callTool('list_transactions', {}, vi.fn());

    expect(JSON.parse(text)).toMatchObject({
      error: 'Network error: could not reach an upstream service (ECONNREFUSED).',
      code: 'UPSTREAM_UNREACHABLE',
      tool: 'list_transactions',
    });
  });

  it('invalid arguments keep the validation message (INVALID_INPUT) and never call the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { isError, text } = await callTool('simulate_swap', { fromToken: '0x1' }, vi.fn());

    expect(isError).toBe(true);
    const payload = JSON.parse(text) as ToolPayload;
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.error).toMatch(/^Invalid input: toToken: Required/);
    expect(payload.details).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: 'amountIn' })]) });
    expect(payload.recommendation).toMatch(/Fix the input/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a throwing logger', () => {
    const result = proxyToolErrorResult(new Error('x'), 't', () => {
      throw new Error('logger down');
    });
    expect(result.isError).toBe(true);
  });
});
