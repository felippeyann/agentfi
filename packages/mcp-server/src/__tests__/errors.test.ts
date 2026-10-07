import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api-error.js';
import {
  buildToolErrorPayload,
  describeError,
  newTraceId,
  sanitizeContextFromEnv,
  sanitizeText,
  sanitizeValue,
  toolErrorResult,
  type SanitizeContext,
} from '../errors.js';

const API_URL = 'http://agentfi-backend.test-net:3000';
const API_KEY = 'agfi_live_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const TURNKEY_KEY = 'turnkey-private-key-value-1234567890';
const TX_HASH = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

const ctx: SanitizeContext = sanitizeContextFromEnv({
  AGENTFI_API_URL: API_URL,
  AGENTFI_API_KEY: API_KEY,
  TURNKEY_API_PRIVATE_KEY: TURNKEY_KEY,
  NODE_ENV: 'production', // not secret-named: must not be redacted
});

function payloadOf(result: { content: Array<{ type: string; text?: string }> }) {
  const first = result.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sanitizeText — stripping rules', () => {
  it('replaces the configured backend base URL', () => {
    const out = sanitizeText(`request to ${API_URL}/v1/jobs/abc failed`, ctx);
    expect(out).toBe('request to [internal-url] failed');
    expect(out).not.toContain('agentfi-backend.test-net');
  });

  it('replaces a bare mention of the backend host', () => {
    expect(sanitizeText('connect ECONNREFUSED agentfi-backend.test-net:3000', ctx)).toBe(
      'connect ECONNREFUSED [internal-host]',
    );
  });

  it('keeps the origin but drops an RPC URL whose path carries an API key (viem error format)', () => {
    const message =
      'HTTP request failed.\n\nStatus: 401\nURL: https://eth-mainnet.g.alchemy.com/v2/AbCdEf1234567890XyZ_kEy-0987\nVersion: viem@2.48.8';
    const out = sanitizeText(message, ctx);
    expect(out).toContain('URL: https://eth-mainnet.g.alchemy.com/[redacted]');
    expect(out).not.toContain('AbCdEf1234567890XyZ_kEy-0987');
    expect(out).toContain('Status: 401');
  });

  it('drops the query string and fragment of a URL', () => {
    const out = sanitizeText('GET https://api.coingecko.com/api/v3/simple/price?ids=eth&x_cg_demo_api_key=CG-123', ctx);
    expect(out).toBe('GET https://api.coingecko.com/[redacted]');
  });

  it('redacts any URL that carries credentials, whatever the scheme', () => {
    expect(sanitizeText('cannot reach https://admin:hunter2@rpc.example.com/x', ctx)).toBe(
      'cannot reach [redacted-url]',
    );
    expect(sanitizeText('prisma: postgresql://agentfi:s3cret@db.example.com:5432/agentfi', ctx)).toBe(
      'prisma: [redacted-url]',
    );
  });

  it('keeps a public URL with no credentials, query or key-like path (e.g. an x402 resource)', () => {
    const msg = 'x402 resource https://api.example.com/v1/data returned 500.';
    expect(sanitizeText(msg, ctx)).toBe(msg);
  });

  it('replaces private, loopback and internal-suffix hosts', () => {
    expect(sanitizeText('connect ECONNREFUSED 127.0.0.1:3000', ctx)).toBe('connect ECONNREFUSED [internal-host]');
    expect(sanitizeText('redis at 10.0.4.12:6379 timed out', ctx)).toBe('redis at [internal-host] timed out');
    expect(sanitizeText("Can't reach database server at db.internal:5432", ctx)).toBe(
      "Can't reach database server at [internal-host]",
    );
    expect(sanitizeText('upstream http://backend:3000/v1/x failed', ctx)).toBe('upstream [internal-url] failed');
    expect(sanitizeText('listening on localhost:8080', ctx)).toBe('listening on [internal-host]');
  });

  it('removes stack-trace frames', () => {
    const message = [
      'Error: boom',
      '    at handler (file:///app/packages/backend/dist/api/routes/jobs.js:120:11)',
      '    at async Promise.all (index 0)',
      '    at Object.<anonymous> (C:\\agentfi\\src\\x.ts:3:9)',
    ].join('\n');
    expect(sanitizeText(message, ctx)).toBe('Error: boom');
  });

  it('replaces filesystem paths but keeps API routes', () => {
    const prisma =
      'Invalid `prisma.agent.findUnique()` invocation in\n/app/packages/backend/dist/api/routes/agents.js:291:36';
    expect(sanitizeText(prisma, ctx)).toBe('Invalid `prisma.agent.findUnique()` invocation in\n[path]');
    expect(sanitizeText('loaded file:///srv/agentfi/dist/index.js', ctx)).toBe('loaded [path]');
    expect(sanitizeText('ENOENT: C:\\Users\\dev\\agentfi\\.env missing', ctx)).toBe('ENOENT: [path] missing');
    expect(sanitizeText('cannot find /home/node/app/node_modules/viem/index.js', ctx)).toBe('cannot find [path]');
    expect(sanitizeText('Route PATCH:/v1/jobs/abc/pay-resource not found', ctx)).toBe(
      'Route PATCH:/v1/jobs/abc/pay-resource not found',
    );
    expect(sanitizeText('call /v1/jobs/abc/pay-resource first', ctx)).toBe('call /v1/jobs/abc/pay-resource first');
  });

  it('redacts secret env values verbatim, but not ordinary env values', () => {
    const out = sanitizeText(`turnkey rejected key ${TURNKEY_KEY} in production`, ctx);
    expect(out).toBe('turnkey rejected key [redacted] in production');
  });

  it("never echoes the agent's own AGENTFI_API_KEY, nor any other agfi_ key", () => {
    expect(sanitizeText(`invalid key ${API_KEY}`, ctx)).toBe('invalid key [redacted]');
    expect(sanitizeText('other key agfi_live_deadbeefdeadbeefdeadbeef', ctx)).toBe('other key [redacted-api-key]');
    expect(sanitizeText(`${API_URL}/v1/x?apiKey=${API_KEY}`, ctx)).toBe('[internal-url]');
  });

  it('redacts bearer tokens and labelled credentials', () => {
    expect(sanitizeText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', ctx)).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(sanitizeText('x-api-key: abc123def456', ctx)).toBe('x-api-key: [redacted]');
    expect(sanitizeText('{"password":"hunter22","user":"bob"}', ctx)).toBe('{"password":"[redacted]","user":"bob"}');
    expect(sanitizeText('client_secret=s3cr3t-value&grant=x', ctx)).toBe('client_secret=[redacted]&grant=x');
  });

  it('does not treat an ERC-20 "token" label as a secret', () => {
    const msg = 'Unsupported token: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(sanitizeText(msg, ctx)).toBe(msg);
  });

  it('redacts 32-byte hex only when a key-ish word precedes it', () => {
    expect(sanitizeText(`invalid private key ${PRIVATE_KEY}`, ctx)).toBe('invalid private key [redacted-key]');
    expect(sanitizeText(`signer key: ${PRIVATE_KEY.slice(2)}`, ctx)).toBe('signer key: [redacted-key]');
    expect(sanitizeText(`secret=${PRIVATE_KEY}`, ctx)).toBe('secret=[redacted]');
  });

  it('keeps a transaction hash (same shape as a private key) in an error message', () => {
    const msg = `Transaction ${TX_HASH} reverted on chain 8453`;
    expect(sanitizeText(msg, ctx)).toBe(msg);
    const msg2 = `deliverableHash ${TX_HASH} does not match`;
    expect(sanitizeText(msg2, ctx)).toBe(msg2);
  });

  it('caps very long messages', () => {
    const out = sanitizeText('x'.repeat(10_000), ctx);
    expect(out.length).toBeLessThan(4_100);
    expect(out.endsWith('[truncated]')).toBe(true);
  });

  it('reads the API key and URL from the environment by default', () => {
    expect(process.env['AGENTFI_API_KEY']).toBe(API_KEY);
    expect(sanitizeText(`key ${API_KEY} at ${API_URL}/v1`)).toBe('key [redacted] at [internal-url]');
  });
});

describe('sanitizeValue', () => {
  it('sanitizes nested strings, drops stack fields and redacts secret-named keys', () => {
    const out = sanitizeValue(
      {
        escrowError: 'submit failed: https://base-mainnet.g.alchemy.com/v2/AbCdEf1234567890XyZ_kEy-0987',
        nested: { list: ['ok', `at ${API_URL}/x`], apiKey: 'whatever', privateKey: PRIVATE_KEY },
        stack: 'Error\n    at x (/app/a.js:1:1)',
        token: 'USDC',
        txHash: TX_HASH,
        price: '0.50',
        count: 3,
        flag: false,
        none: null,
      },
      ctx,
    );
    expect(out).toEqual({
      escrowError: 'submit failed: https://base-mainnet.g.alchemy.com/[redacted]',
      nested: { list: ['ok', 'at [internal-url]'], apiKey: '[redacted]', privateKey: '[redacted]' },
      token: 'USDC',
      txHash: TX_HASH,
      price: '0.50',
      count: 3,
      flag: false,
      none: null,
    });
  });
});

describe('describeError', () => {
  it('keeps ApiError status, code, message and body (Zod validation details)', () => {
    const err = new ApiError(400, {
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: [{ code: 'invalid_string', path: ['url'], message: 'Invalid url' }],
    });
    expect(describeError(err)).toEqual({
      message: 'AgentFi API error 400: Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { details: [{ code: 'invalid_string', path: ['url'], message: 'Invalid url' }] },
    });
  });

  it('takes the code from `error` when the backend puts it there (ESCROW_NOT_FUNDED)', () => {
    const err = new ApiError(409, {
      error: 'ESCROW_NOT_FUNDED',
      message: 'Job is not funded on-chain yet (onChainStatus=CREATED)',
      onChainStatus: 'CREATED',
    });
    const described = describeError(err);
    expect(described.code).toBe('ESCROW_NOT_FUNDED');
    expect(described.details).toEqual({
      message: 'Job is not funded on-chain yet (onChainStatus=CREATED)',
      onChainStatus: 'CREATED',
    });
  });

  it('formats Zod input errors as INVALID_INPUT with the issues', () => {
    const zodLike = Object.assign(new Error('[...]'), {
      name: 'ZodError',
      issues: [{ path: ['payment_id'], message: 'must be 16-128 chars', code: 'invalid_string' }],
    });
    expect(describeError(zodLike)).toEqual({
      message: 'Invalid input: payment_id: must be 16-128 chars',
      code: 'INVALID_INPUT',
      details: { issues: [{ path: 'payment_id', message: 'must be 16-128 chars', code: 'invalid_string' }] },
    });
  });

  it('classifies network failures without echoing the target', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    expect(describeError(err)).toEqual({
      message: 'Network error: could not reach an upstream service (ECONNREFUSED).',
      code: 'UPSTREAM_UNREACHABLE',
    });
  });

  it('handles non-Error throwables', () => {
    expect(describeError('plain string failure').message).toBe('plain string failure');
    expect(describeError(42).message).toBe('Non-Error thrown: 42');
    expect(describeError({ reason: 'nope' }).message).toBe('Non-Error thrown: {"reason":"nope"}');
    expect(describeError(null).message).toBe('Unknown error (no details)');
    expect(describeError(undefined).message).toBe('Unknown error (no details)');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(describeError(circular).message).toBe('Non-Error thrown: [object Object]');
  });
});

describe('toolErrorResult', () => {
  it('returns an isError result with sanitized error, code, status, details, tool and traceId', () => {
    const log = vi.fn();
    const err = new ApiError(503, {
      error: 'ERC8183_START_FAILED',
      jobId: 'job_1',
      reason: `RPC https://arb-mainnet.g.alchemy.com/v2/AbCdEf1234567890XyZ_kEy-0987 via ${API_URL} with key ${API_KEY}`,
    });
    const result = toolErrorResult(err, { tool: 'post_job', log, context: ctx });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({
      error: 'AgentFi API error 503: ERC8183_START_FAILED',
      code: 'ERC8183_START_FAILED',
      status: 503,
      details: {
        jobId: 'job_1',
        reason: 'RPC https://arb-mainnet.g.alchemy.com/[redacted] via [internal-url] with key [redacted]',
      },
      tool: 'post_job',
    });
    expect(payload['traceId']).toMatch(/^[0-9a-f]{12}$/);
    expect(String(payload['recommendation'])).toContain(String(payload['traceId']));
    const text = JSON.stringify(payload);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('agentfi-backend.test-net');
    expect(text).not.toContain('AbCdEf1234567890XyZ_kEy-0987');
  });

  it('logs the full original error with the same traceId, on stderr only', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error(`boom at ${API_URL}`);
    const result = toolErrorResult(err, { tool: 'get_policy', context: ctx });
    const payload = payloadOf(result);
    expect(stderr).toHaveBeenCalledTimes(1);
    const [line, logged] = stderr.mock.calls[0] ?? [];
    expect(String(line)).toContain(`traceId=${String(payload['traceId'])}`);
    expect(String(line)).toContain('tool=get_policy');
    expect(logged).toBe(err); // unsanitized original, stack included
    expect(stdout).not.toHaveBeenCalled();
    expect(payload['error']).toBe('boom at [internal-url]');
  });

  it('accepts an injected logger and a fixed traceId', () => {
    const log = vi.fn();
    const err = new Error('x');
    const payload = payloadOf(toolErrorResult(err, { tool: 't', log, traceId: 'abc123abc123', context: ctx }));
    expect(payload['traceId']).toBe('abc123abc123');
    expect(log).toHaveBeenCalledWith('abc123abc123', 't', err);
  });

  it('survives a throwing logger', () => {
    const result = toolErrorResult(new Error('x'), {
      tool: 't',
      context: ctx,
      log: () => {
        throw new Error('logger down');
      },
    });
    expect(result.isError).toBe(true);
  });

  it('keeps a tx hash and a validation message the agent needs', () => {
    const payload = buildToolErrorPayload(new Error(`Transaction ${TX_HASH} reverted: insufficient balance`), {
      tool: 'transfer_token',
      context: ctx,
    });
    expect(payload.error).toBe(`Transaction ${TX_HASH} reverted: insufficient balance`);
  });

  it('gives a fix-the-input recommendation for validation errors and no traceId hint', () => {
    const payload = buildToolErrorPayload(new ApiError(400, { error: 'Validation failed' }), {
      tool: 'pay_for_resource',
      context: ctx,
      traceId: 'aaaaaaaaaaaa',
    });
    expect(payload.recommendation).toMatch(/Fix the input/);
  });

  it('generates distinct short trace ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTraceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});
