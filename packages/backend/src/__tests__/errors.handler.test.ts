/**
 * Fastify error handler (api/errors/handler.ts, S5).
 *
 *  - an unhandled error → 500 { error: 'Internal error', code: 'INTERNAL_ERROR', traceId }
 *    with no message; the full error is logged at `error` level with the same traceId
 *  - an RPC error carrying https://…alchemy.com/v2/<key> never reaches the body
 *  - a thrown ZodError → 400 VALIDATION_FAILED (the shape routes use for safeParse)
 *  - Fastify's own 4xx keep their status and shape (malformed JSON, 415, 404,
 *    an error with a 4xx statusCode), message sanitized
 *  - the rate limiter's body keeps its 429 (it used to become a 500)
 */
import { vi } from 'vitest';

const { ALCHEMY_KEY } = vi.hoisted(() => {
  const key = 'Zq8mN3pL5vR7tX9wB2cD4fG6hJ1kM0aS';
  const g = globalThis as { __s5SavedEnv?: Record<string, string | undefined> };
  g.__s5SavedEnv = { ALCHEMY_API_KEY: process.env['ALCHEMY_API_KEY'] };
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
  // A realistic operator key: the handler must keep it out of every body.
  process.env['ALCHEMY_API_KEY'] = key;
  return { ALCHEMY_KEY: key };
});

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { z } from 'zod';
import { registerErrorHandler } from '../api/errors/handler.js';
import { registerJsonBodyParser } from '../api/middleware/json-body.js';
import { rateLimitErrorResponse } from '../api/middleware/rateLimit.js';
import { SimulationUnavailableError } from '../services/transaction/simulation-guard.js';

const ALCHEMY_URL = `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`;

afterAll(() => {
  const saved = (globalThis as { __s5SavedEnv?: Record<string, string | undefined> }).__s5SavedEnv ?? {};
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface LogLine {
  level: number;
  msg?: string;
  traceId?: string;
  err?: { message?: string; stack?: string; type?: string };
}

async function buildApp(): Promise<{ app: FastifyInstance; logs: LogLine[] }> {
  const logs: LogLine[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: { write: (line: string) => logs.push(JSON.parse(line) as LogLine) },
    },
  });
  registerJsonBodyParser(app);
  registerErrorHandler(app);
  await app.register(async (scope) => {
    scope.get('/rpc-failure', async () => {
      // What viem throws when Alchemy refuses a call: the message carries the
      // keyed URL, and `status: 429` is the PROVIDER's answer — it must not
      // become this API's status (Fastify's default handler honoured `status`).
      throw new HttpRequestError({
        url: ALCHEMY_URL,
        status: 429,
        body: { method: 'eth_getBalance', params: ['0x1111111111111111111111111111111111111111', 'latest'] },
        details: 'Your app has exceeded its compute units per second capacity.',
      });
    });
    scope.get('/plain-failure', async () => {
      throw new Error(`readContract failed: ${ALCHEMY_URL} at /app/packages/backend/dist/index.js:1:1`);
    });
    scope.get('/string-thrown', async () => {
      throw `raw ${ALCHEMY_URL}`; // eslint-disable-line no-throw-literal
    });
    scope.get('/simulation-unavailable', async () => {
      throw new SimulationUnavailableError();
    });
    scope.get('/conflict', async () => {
      throw Object.assign(new Error(`Agent paused (see ${ALCHEMY_URL})`), { statusCode: 409, code: 'AGENT_PAUSED' });
    });
    scope.post('/parse', async (request) => {
      const body = z.object({ amount: z.string(), chainId: z.number() }).parse(request.body);
      return { ok: true, body };
    });
    scope.post('/echo', async (request) => ({ received: request.body }));
  });
  return { app, logs };
}

function expectNoLeak(payload: string) {
  expect(payload).not.toContain(ALCHEMY_KEY);
  expect(payload).not.toContain('/app/packages');
}

describe('unhandled errors', () => {
  it.each(['/rpc-failure', '/plain-failure', '/string-thrown'])(
    '%s → 500 { error: "Internal error", code: "INTERNAL_ERROR", traceId } and nothing else',
    async (url) => {
      const { app } = await buildApp();
      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toContain('application/json');
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['code', 'error', 'traceId']);
      expect(body).toMatchObject({ error: 'Internal error', code: 'INTERNAL_ERROR' });
      expect(body.traceId).toMatch(/^[0-9a-f]{12}$/);
      expectNoLeak(res.payload);
      await app.close();
    },
  );

  it('logs the full original error once, at error level, under the same traceId', async () => {
    const { app, logs } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/rpc-failure' });
    const { traceId } = res.json();

    const errorLines = logs.filter((line) => line.level === 50);
    expect(errorLines).toHaveLength(1);
    const [line] = errorLines;
    expect(line?.traceId).toBe(traceId);
    expect(line?.msg).toBe('Unhandled error');
    expect(line?.err?.type).toBe('HttpRequestError');
    expect(line?.err?.message).toContain('HTTP request failed.');
    expect(line?.err?.stack).toBeTruthy();
    await app.close();
  });

  it('gives every failure its own traceId', async () => {
    const { app } = await buildApp();
    const a = (await app.inject({ method: 'GET', url: '/plain-failure' })).json();
    const b = (await app.inject({ method: 'GET', url: '/plain-failure' })).json();
    expect(a.traceId).not.toBe(b.traceId);
    await app.close();
  });

  it('keeps an explicit 5xx status (503) with the same opaque body', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/simulation-unavailable' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR', traceId: expect.stringMatching(/^[0-9a-f]{12}$/) });
    await app.close();
  });
});

describe('validation errors', () => {
  it('a thrown ZodError is 400 VALIDATION_FAILED with the issues (not a 500)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/parse', payload: { amount: 5 } });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({ error: 'Validation failed', code: 'VALIDATION_FAILED' });
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['amount'], code: 'invalid_type' }),
        expect.objectContaining({ path: ['chainId'], code: 'invalid_type' }),
      ]),
    );
    expect(body).not.toHaveProperty('traceId');
    await app.close();
  });
});

describe("Fastify's own 4xx keep their meaning", () => {
  it('malformed JSON is 400 (it used to become a 500)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"amount": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(typeof res.json().message).toBe('string');
    await app.close();
  });

  it('valid JSON still parses', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: { a: 1 } });
    await app.close();
  });

  it('unsupported media type stays 415 with its Fastify code', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/x-agentfi' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', error: 'Unsupported Media Type' });
    await app.close();
  });

  it('an unknown route stays the default 404', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Route GET:/nope not found', error: 'Not Found', statusCode: 404 });
    await app.close();
  });

  it('an error with a 4xx statusCode keeps status and code; its message is sanitized', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/conflict' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      statusCode: 409,
      code: 'AGENT_PAUSED',
      error: 'Conflict',
      message: 'Agent paused (see https://base-sepolia.g.alchemy.com/v2/[redacted])',
    });
    expectNoLeak(res.payload);
    await app.close();
  });
});

describe('rate limiting', () => {
  it('answers 429 with the rate-limit body (it used to be a 500)', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(rateLimit, { global: true, max: 1, timeWindow: 60_000, errorResponseBuilder: rateLimitErrorResponse });
    app.get('/limited', async () => ({ ok: true }));

    expect((await app.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/limited' });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      statusCode: 429,
      error: expect.stringMatching(/^Rate limit exceeded\. Retry after /),
      tier: 'Upgrade your plan for higher limits.',
    });
    expect(res.headers['retry-after']).toBeDefined();
    await app.close();
  });
});
