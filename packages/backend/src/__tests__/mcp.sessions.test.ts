/**
 * The backend's hosted MCP over SSE (`GET /mcp/sse` + `POST /mcp/messages`)
 * — S6 hardening, second adversarial review 2026-10-08:
 *
 *   - `?apiKey=` is refused (it put agent keys in access logs); header only;
 *   - a session only answers the API key that opened it (before, anyone who
 *     learned a session id drove it with the opener's key);
 *   - sessions are capped globally and per key, and evicted when idle (the
 *     map was unbounded);
 *   - `transactionId` is validated before it is interpolated into a path;
 *   - the request log serializer redacts credential-like query parameters.
 *
 * Driven over a real HTTP listener (SSE needs a streaming response).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import {
  McpSessionRegistry,
  buildProxyTools,
  mcpRoutes,
  mcpSessionLimitsFromEnv,
  type McpSessionLimits,
} from '../api/routes/mcp.js';
import { redactUrl, requestSerializer } from '../api/middleware/log-serializers.js';

const KEY_A = 'agfi_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'agfi_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let app: FastifyInstance;
let base: string;
let registry: McpSessionRegistry;
let clock: number;
const openStreams: AbortController[] = [];

async function start(limits: Partial<McpSessionLimits> = {}, logStream?: Writable) {
  clock = 1_000_000;
  registry = new McpSessionRegistry({ maxSessions: 3, maxPerKey: 2, idleTimeoutMs: 60_000, ...limits }, () => clock);
  app = Fastify(
    logStream
      ? { logger: { level: 'info', stream: logStream, serializers: { req: requestSerializer } } }
      : { logger: false },
  );
  await app.register(mcpRoutes, { registry });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
}

/** Opens an SSE session; resolves with the status and, on 200, the session id from the `endpoint` event. */
async function openSession(headers: Record<string, string> = {}, query = ''): Promise<{ status: number; sessionId?: string; body?: unknown }> {
  const controller = new AbortController();
  const res = await fetch(`${base}/mcp/sse${query}`, { headers, signal: controller.signal });
  if (res.status !== 200) {
    const body = await res.json();
    return { status: res.status, body };
  }
  openStreams.push(controller);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE stream ended before the endpoint event');
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/sessionId=([0-9a-f-]+)/);
    if (match) return { status: 200, sessionId: match[1]! };
  }
}

async function postMessage(sessionId: string, headers: Record<string, string> = {}, query = '') {
  return fetch(`${base}/mcp/messages?sessionId=${sessionId}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  openStreams.length = 0;
});

afterEach(async () => {
  for (const controller of openStreams) controller.abort();
  await app?.close();
});

describe('GET /mcp/sse: API key in the header only', () => {
  it.each(['?apiKey=', '?api_key=', '?x-api-key=', '?key='])('refuses %s… with 400 and opens no session', async (param) => {
    await start();
    const res = await openSession({}, `${param}${KEY_A}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'API_KEY_IN_QUERY' });
    expect(registry.size).toBe(0);
  });

  it('opens a session with the x-api-key header', async () => {
    await start();
    const res = await openSession({ 'x-api-key': KEY_A });
    expect(res.status).toBe(200);
    expect(registry.size).toBe(1);
  });

  it('the request log never carries the key, even for the refused query-string form', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    await start({}, stream);
    await openSession({}, `?apiKey=${KEY_A}`);
    await waitFor(() => lines.some((line) => line.includes('/mcp/sse')));
    const log = lines.join('');
    expect(log).toContain('/mcp/sse?apiKey=[redacted]');
    expect(log).not.toContain(KEY_A);
  });
});

describe('POST /mcp/messages: a session answers only the key that opened it', () => {
  it('same key → accepted; another key, no key, or a query-string key → refused', async () => {
    await start();
    const { sessionId } = await openSession({ 'x-api-key': KEY_A });

    expect((await postMessage(sessionId!, { 'x-api-key': KEY_B })).status).toBe(403);
    const noKey = await postMessage(sessionId!);
    expect(noKey.status).toBe(403);
    expect(await noKey.json()).toMatchObject({ code: 'MCP_SESSION_KEY_MISMATCH' });
    expect((await postMessage(sessionId!, {}, `&apiKey=${KEY_A}`)).status).toBe(400);
    expect((await postMessage(sessionId!, { 'x-api-key': KEY_A })).status).toBe(202);
  });

  it('a keyless discovery session is driven only without a key', async () => {
    await start();
    const { sessionId } = await openSession();
    expect((await postMessage(sessionId!, { 'x-api-key': KEY_A })).status).toBe(403);
    expect((await postMessage(sessionId!)).status).toBe(202);
  });

  it('an unknown session is 404', async () => {
    await start();
    expect((await postMessage('00000000-0000-4000-8000-000000000000', { 'x-api-key': KEY_A })).status).toBe(404);
  });
});

describe('session caps and idle eviction', () => {
  it('per key: the third session of the same key is 429; another key still opens', async () => {
    await start({ maxPerKey: 2, maxSessions: 10 });
    expect((await openSession({ 'x-api-key': KEY_A })).status).toBe(200);
    expect((await openSession({ 'x-api-key': KEY_A })).status).toBe(200);
    const third = await openSession({ 'x-api-key': KEY_A });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ code: 'MCP_SESSION_LIMIT' });
    expect((await openSession({ 'x-api-key': KEY_B })).status).toBe(200);
    expect(registry.size).toBe(3);
  });

  it('global: past maxSessions every new session is 503 with Retry-After', async () => {
    await start({ maxPerKey: 5, maxSessions: 2 });
    await openSession({ 'x-api-key': KEY_A });
    await openSession({ 'x-api-key': KEY_B });
    const res = await fetch(`${base}/mcp/sse`, { headers: { 'x-api-key': KEY_A } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toMatchObject({ code: 'MCP_SESSIONS_FULL' });
  });

  it('a closed stream frees its slot', async () => {
    await start({ maxPerKey: 1 });
    await openSession({ 'x-api-key': KEY_A });
    expect((await openSession({ 'x-api-key': KEY_A })).status).toBe(429);
    openStreams.shift()!.abort();
    await waitFor(() => registry.size === 0);
    expect((await openSession({ 'x-api-key': KEY_A })).status).toBe(200);
  });

  it('idle sessions are evicted; activity keeps a session alive', async () => {
    await start({ idleTimeoutMs: 60_000 });
    const idle = await openSession({ 'x-api-key': KEY_A });
    const active = await openSession({ 'x-api-key': KEY_B });

    clock += 45_000;
    expect((await postMessage(active.sessionId!, { 'x-api-key': KEY_B })).status).toBe(202);
    clock += 30_000; // idle: 75 s without a message; active: 30 s since its last one

    expect(await registry.evictIdle()).toBe(1);
    expect(registry.get(idle.sessionId!)).toBeUndefined();
    expect(registry.get(active.sessionId!)).toBeDefined();
    expect((await postMessage(idle.sessionId!, { 'x-api-key': KEY_A })).status).toBe(404);
  });

  it('keyless sessions are capped per client IP', async () => {
    await start({ maxPerKey: 1, maxSessions: 10 });
    expect((await openSession()).status).toBe(200);
    expect((await openSession()).status).toBe(429);
  });

  it('limits come from MCP_SSE_* with safe defaults', () => {
    expect(mcpSessionLimitsFromEnv({})).toEqual({ maxSessions: 200, maxPerKey: 5, idleTimeoutMs: 900_000 });
    expect(
      mcpSessionLimitsFromEnv({ MCP_SSE_MAX_SESSIONS: '10', MCP_SSE_MAX_SESSIONS_PER_KEY: '2', MCP_SSE_IDLE_TIMEOUT_SECONDS: '60' }),
    ).toEqual({ maxSessions: 10, maxPerKey: 2, idleTimeoutMs: 60_000 });
    expect(mcpSessionLimitsFromEnv({ MCP_SSE_MAX_SESSIONS: 'lots' }).maxSessions).toBe(200);
  });
});

describe('ids interpolated into a path', () => {
  it('get_transaction_status refuses a transactionId that would leave /v1/transactions/:id', () => {
    const tool = buildProxyTools('http://127.0.0.1:1', KEY_A).find((t) => t.name === 'get_transaction_status')!;
    for (const id of ['../agents/me', 'x/../../agents/me/sign-handshake', 'x?apiKey=1', 'x#y', '%2e%2e', '', 'x'.repeat(129)]) {
      expect(tool.inputSchema.safeParse({ transactionId: id }).success, id).toBe(false);
    }
    expect(tool.inputSchema.safeParse({ transactionId: 'cm1x2y3z40000abcdtx000001' }).success).toBe(true);
  });
});

describe('redactUrl', () => {
  it.each([
    ['/mcp/sse?apiKey=agfi_live_x', '/mcp/sse?apiKey=[redacted]'],
    ['/mcp/sse?api_key=agfi_live_x&foo=1', '/mcp/sse?api_key=[redacted]&foo=1'],
    ['/x?token=t&secret=s&password=p&key=k&sig=0x1', '/x?token=[redacted]&secret=[redacted]&password=[redacted]&key=[redacted]&sig=[redacted]'],
    ['/mcp/messages?sessionId=abc', '/mcp/messages?sessionId=abc'],
    ['/v1/agents/me', '/v1/agents/me'],
    ['/x?%61piKey=v', '/x?%61piKey=[redacted]'],
  ])('%s → %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});
