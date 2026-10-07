/**
 * Unit tests — backend error sanitizer (api/errors/sanitize.ts, S5).
 *
 * The shared text rules are covered by the MCP server's suite and kept in
 * sync by errors.sanitize.sync.test.ts; this file covers what is specific to
 * the backend: the context built from the backend's env (every secret the
 * operator configures), viem / Zod / network classification, and the route
 * helpers (publicErrorMessage, sanitizeStoredError, sanitizeErrorFields).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HttpRequestError } from 'viem';
import { z } from 'zod';
import {
  describeError,
  newTraceId,
  publicErrorMessage,
  sanitizeContextFromEnv,
  sanitizeErrorFields,
  sanitizeStoredError,
  sanitizeText,
} from '../api/errors/sanitize.js';

const ALCHEMY_KEY = 'Zq8mN3pL5vR7tX9wB2cD4fG6hJ1kM0aS';
const ALCHEMY_URL = `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const TX_HASH = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  ALCHEMY_API_KEY: ALCHEMY_KEY,
  INFURA_API_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  TENDERLY_ACCESS_KEY: 'tenderly-access-key-0123456789',
  TURNKEY_API_PRIVATE_KEY: 'turnkey-private-key-value-1234567890',
  ESCROW_EVALUATOR_PRIVATE_KEY: '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  API_SECRET: 'operator-api-secret-at-least-32-chars',
  ADMIN_SECRET: 'operator-admin-secret-at-least-32-chars',
  DATABASE_URL: 'postgresql://agentfi:db-password-123@db.prod-cluster.example.com:5432/agentfi',
  REDIS_URL: 'redis://default:redis-password-456@redis:6379',
  RPC_URL_8453: 'https://base-mainnet.example-rpc.com/k/abcdefabcdef0123',
  API_BASE_URL: 'http://agentfi-api.railway.internal:8080',
  ADMIN_AUTH_LOCKOUT_MS: '86400000',
  TURNKEY_ORGANIZATION_ID: 'test',
  OPERATOR_FEE_WALLET: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

const savedAlchemyKey = process.env['ALCHEMY_API_KEY'];
afterEach(() => {
  if (savedAlchemyKey === undefined) delete process.env['ALCHEMY_API_KEY'];
  else process.env['ALCHEMY_API_KEY'] = savedAlchemyKey;
});

function viemRpcError(): HttpRequestError {
  return new HttpRequestError({
    url: ALCHEMY_URL,
    status: 401,
    body: { method: 'eth_call', params: [{ to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }] },
    details: 'Must be authenticated!',
  });
}

describe('sanitizeContextFromEnv (backend env)', () => {
  const ctx = sanitizeContextFromEnv(ENV);

  it('collects every secret-named value the operator configures, longest first', () => {
    for (const name of [
      'ALCHEMY_API_KEY',
      'INFURA_API_KEY',
      'TENDERLY_ACCESS_KEY',
      'TURNKEY_API_PRIVATE_KEY',
      'ESCROW_EVALUATOR_PRIVATE_KEY',
      'API_SECRET',
      'ADMIN_SECRET',
      'DATABASE_URL',
      'REDIS_URL',
      'RPC_URL_8453',
    ]) {
      expect(ctx.secrets, name).toContain(ENV[name]);
    }
    const lengths = ctx.secrets.map((s) => s.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('also redacts the password inside a URL-valued secret', () => {
    expect(ctx.secrets).toContain('db-password-123');
    expect(ctx.secrets).toContain('redis-password-456');
  });

  it('ignores short, digits-only and non-secret values', () => {
    expect(ctx.secrets).not.toContain('test');
    expect(ctx.secrets).not.toContain('86400000');
    expect(ctx.secrets).not.toContain('production');
    expect(ctx.secrets).not.toContain(ENV['OPERATOR_FEE_WALLET']);
  });

  it('treats the database, Redis and API_BASE_URL hosts as internal (dotted names only)', () => {
    expect(ctx.internalHosts).toEqual(
      expect.arrayContaining(['db.prod-cluster.example.com', 'agentfi-api.railway.internal']),
    );
    expect(ctx.internalHosts).not.toContain('redis');
    expect(ctx.internalOrigins).toContain('http://agentfi-api.railway.internal:8080');
  });

  it('redacts each of them from a message', () => {
    const message = [
      `rpc ${ALCHEMY_URL}`,
      `infura ${ENV['INFURA_API_KEY']}`,
      `tenderly X-Access-Key ${ENV['TENDERLY_ACCESS_KEY']}`,
      `turnkey ${ENV['TURNKEY_API_PRIVATE_KEY']}`,
      `admin ${ENV['ADMIN_SECRET']} api ${ENV['API_SECRET']}`,
      `prisma ${ENV['DATABASE_URL']}`,
      "Can't reach database server at `db.prod-cluster.example.com`:`5432`",
      `redis NOAUTH redis-password-456`,
      `custom rpc ${ENV['RPC_URL_8453']} failed`,
    ].join('\n');
    const out = sanitizeText(message, ctx);
    for (const leaked of [
      ALCHEMY_KEY,
      ENV['INFURA_API_KEY']!,
      ENV['TENDERLY_ACCESS_KEY']!,
      ENV['TURNKEY_API_PRIVATE_KEY']!,
      ENV['ADMIN_SECRET']!,
      ENV['API_SECRET']!,
      'db-password-123',
      'db.prod-cluster.example.com',
      'redis-password-456',
      'abcdefabcdef0123',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('https://base-sepolia.g.alchemy.com/v2/[redacted]');
  });
});

describe('describeError (backend)', () => {
  it("summarises a viem error with shortMessage + details — no RPC URL, request body or viem version", () => {
    const err = viemRpcError();
    expect(err.message).toContain(ALCHEMY_KEY); // the raw viem message does carry the key
    const described = describeError(err);
    expect(described.message).toBe('HTTP request failed. (Must be authenticated!)');
  });

  it('formats a ZodError as INVALID_INPUT with its issues', () => {
    const result = z.object({ chainId: z.number() }).safeParse({ chainId: 'x' });
    expect(result.success).toBe(false);
    const described = describeError(result.success ? null : result.error);
    expect(described.code).toBe('INVALID_INPUT');
    expect(described.message).toMatch(/^Invalid input: chainId: Expected number/);
  });

  it('classifies network failures without echoing the target', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8545'), { code: 'ECONNREFUSED' }),
    });
    expect(describeError(err)).toEqual({
      message: 'Network error: could not reach an upstream service (ECONNREFUSED).',
      code: 'UPSTREAM_UNREACHABLE',
    });
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(describeError(abort)).toEqual({ message: 'Upstream request timed out.', code: 'UPSTREAM_TIMEOUT' });
  });

  it('handles non-Error throwables', () => {
    expect(describeError('plain failure').message).toBe('plain failure');
    expect(describeError(42).message).toBe('Non-Error thrown: 42');
    expect(describeError(null).message).toBe('Unknown error (no details)');
  });
});

describe('publicErrorMessage', () => {
  it('never returns the Alchemy key of a viem error, even from the default (process.env) context', () => {
    process.env['ALCHEMY_API_KEY'] = ALCHEMY_KEY;
    expect(publicErrorMessage(viemRpcError())).toBe('HTTP request failed. (Must be authenticated!)');
    const plain = new Error(`request to ${ALCHEMY_URL} failed`);
    const out = publicErrorMessage(plain);
    expect(out).not.toContain(ALCHEMY_KEY);
    expect(out).toBe('request to https://base-sepolia.g.alchemy.com/v2/[redacted] failed');
  });

  it('redacts a keyed RPC path even when the key is not in the env', () => {
    const ctx = sanitizeContextFromEnv({});
    expect(publicErrorMessage(new Error(`RPC ${ALCHEMY_URL} down`), {}, ctx)).toBe(
      'RPC https://base-sepolia.g.alchemy.com/[redacted] down',
    );
  });

  it('keeps business messages, revert reasons and tx hashes intact', () => {
    const ctx = sanitizeContextFromEnv(ENV);
    for (const message of [
      'Requester has reached monthly transaction limit',
      'Policy check failed: Daily volume limit exceeded',
      'rpc down',
      `Transaction ${TX_HASH} reverted: ERC20: transfer amount exceeds balance`,
      'Jobs on chain 84532 are escrowed in USDC; set reward.token to "USDC" or 0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    ]) {
      expect(publicErrorMessage(new Error(message), {}, ctx)).toBe(message);
    }
  });

  it('removes stack frames and file paths', () => {
    const ctx = sanitizeContextFromEnv(ENV);
    const err = new Error(
      'Invalid `prisma.job.update()` invocation in\n/app/packages/backend/dist/api/routes/jobs.js:185:11\n    at handler (/app/x.js:1:1)',
    );
    expect(publicErrorMessage(err, {}, ctx)).toBe('Invalid `prisma.job.update()` invocation in\n[path]');
  });
});

describe('sanitizeStoredError', () => {
  it('passes null through and strips a stored viem message', () => {
    expect(sanitizeStoredError(null)).toBeNull();
    expect(sanitizeStoredError(undefined)).toBeNull();
    const stored = viemRpcError().message.slice(0, 500);
    const out = sanitizeStoredError(stored, sanitizeContextFromEnv({}));
    expect(out).not.toContain(ALCHEMY_KEY);
    expect(out).toContain('HTTP request failed.');
  });
});

describe('sanitizeErrorFields', () => {
  const ctx = sanitizeContextFromEnv(ENV);

  it('sanitizes only error-text fields and keeps everything else as it is', () => {
    const createdAt = new Date('2026-10-07T12:00:00.000Z');
    const body = {
      error: `x402 payment failed via ${ALCHEMY_URL}`,
      code: 'PAYMENT_FAILED',
      paymentId: 'quote_2026-10-06_0001',
      payment: {
        id: 'cl0000000000000000000pay01',
        url: 'https://api.example.com/v1/quotes/abc123def456ghi789jkl0',
        error: `transport failed at ${ENV['API_BASE_URL']}/x`,
        createdAt,
        authorizationNonce: TX_HASH,
      },
      offered: [{ amount: '500000', payTo: '0x2222222222222222222222222222222222222222' }],
      details: [{ path: ['url'], message: `bad ${ALCHEMY_URL}` }],
    };
    const out = sanitizeErrorFields(body, {}, ctx);
    expect(out.error).toBe('x402 payment failed via https://base-sepolia.g.alchemy.com/v2/[redacted]');
    expect(out.payment.error).toBe('transport failed at [internal-url]');
    expect(out.details).toEqual([{ path: ['url'], message: 'bad https://base-sepolia.g.alchemy.com/v2/[redacted]' }]);
    expect(out.code).toBe('PAYMENT_FAILED');
    expect(out.paymentId).toBe(body.paymentId);
    expect(out.payment.url).toBe(body.payment.url);
    expect(out.payment.createdAt).toBe(createdAt);
    expect(out.payment.authorizationNonce).toBe(TX_HASH);
    expect(out.offered).toEqual(body.offered);
  });

  it('keepNetworkLocations keeps the agent\'s own private target in the message, secrets still go', () => {
    const body = {
      error: 'url must not point at a private, loopback, link-local or reserved host (10.0.0.5)',
      code: 'INVALID_URL',
      hostname: '10.0.0.5',
    };
    expect(sanitizeErrorFields(body, { keepNetworkLocations: true }, ctx)).toEqual(body);
    expect(sanitizeErrorFields(body, {}, ctx).error).toContain('[internal-host]');
  });
});

describe('newTraceId', () => {
  it('generates distinct 12-hex-char ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTraceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});
