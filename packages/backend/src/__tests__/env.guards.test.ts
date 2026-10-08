/**
 * Regression (S6, second adversarial review 2026-10-08): unsafe environment
 * combinations that still booted.
 *
 * The reviewer's proof (`zz-review.env-guards.test.ts`) booted `config/env.ts`
 * with each combination and printed which ones came up: the `.env.example`
 * `API_SECRET` placeholder in production, staging with the admin placeholder
 * and with `WALLET_PROVIDER=local`, `RPC_URL_<id>=http://…` in production,
 * and an unset `NODE_ENV` (→ development, every guard off). This file boots
 * the real module the same way and pins the new verdicts, plus unit tests of
 * the pure rules in `config/env-guards.ts` and `config/trust-proxy.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Container marker files are faked per test so the verdicts do not depend on where CI runs. */
const fakeFs = vi.hoisted(() => ({ containerFiles: new Set<string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: import('node:fs').PathLike) =>
    p === '/.dockerenv' || p === '/run/.containerenv' ? fakeFs.containerFiles.has(String(p)) : actual.existsSync(p);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

import {
  CONTAINER_ENV_MARKERS,
  PLACEHOLDER_CHECKED_KEYS,
  detectContainer,
  isLoopbackOrPrivateHost,
  isPlaceholderValue,
  nodeEnvUnsetVerdict,
  productionSignals,
  rpcUrlProblem,
} from '../config/env-guards.js';
import { parseTrustProxy } from '../config/trust-proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');

/** Same values the Backend Tests job exports in `.github/workflows/ci.yml` (not placeholders). */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  ADMIN_SECRET: 'test-admin-secret-min-32-chars-long',
  API_SECRET: 'test-secret-min-32-chars-long-here',
  OPERATOR_FEE_WALLET: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  ALCHEMY_API_KEY: 'test',
  TURNKEY_API_PUBLIC_KEY: 't',
  TURNKEY_API_PRIVATE_KEY: 't',
  TURNKEY_ORGANIZATION_ID: 't',
};
const saved = { ...process.env };

interface BootResult {
  booted: boolean;
  nodeEnv?: string;
  trustProxy?: unknown;
  errors: string;
  warnings: string;
}

/** Boots config/env.ts with exactly BASE + `extra` (undefined deletes) and reports what happened. */
async function boot(extra: Record<string, string | undefined>, containerFiles: string[] = []): Promise<BootResult> {
  vi.resetModules();
  fakeFs.containerFiles = new Set(containerFiles);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, { PATH: saved['PATH'] ?? '' }, BASE);
  // Never read a stray packages/backend/.env.
  process.env['DOTENV_CONFIG_PATH'] = path.join(here, 'no-such-dotenv-file');
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`EXIT ${code}`);
  }) as never);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const text = (spy: typeof err) => spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  try {
    const m = await import('../config/env.js');
    return { booted: true, nodeEnv: m.env.NODE_ENV, trustProxy: m.trustProxySetting, errors: text(err), warnings: text(warn) };
  } catch (e) {
    if (!/^EXIT /.test((e as Error).message)) throw e;
    return { booted: false, errors: text(err), warnings: text(warn) };
  } finally {
    exit.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  }
}

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
  fakeFs.containerFiles = new Set();
});

describe("the reviewer's env-guard report, now", () => {
  it('every unsafe combination it found booting is refused', async () => {
    const out = {
      prodApiSecretPlaceholder: await boot({ NODE_ENV: 'production', API_SECRET: 'your-api-secret-min-32-chars-here' }),
      prodAdminSecretPlaceholder: await boot({ NODE_ENV: 'production', ADMIN_SECRET: 'your-admin-secret-min-32-chars-here' }),
      stagingAdminSecretPlaceholder: await boot({ NODE_ENV: 'staging', ADMIN_SECRET: 'your-admin-secret-min-32-chars-here' }),
      stagingLocalWallet: await boot({ NODE_ENV: 'staging', WALLET_PROVIDER: 'local' }),
      prodPlainHttpRpc: await boot({ NODE_ENV: 'production', RPC_URL_8453: 'http://203.0.113.10:8545' }),
      prodPrivateHosts: await boot({ NODE_ENV: 'production', RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true' }),
    };
    for (const [name, result] of Object.entries(out)) {
      expect(result.booted, `${name} booted:\n${result.errors}`).toBe(false);
      expect(result.errors, name).toMatch(/FATAL/);
    }
  });

  it('NODE_ENV unset still boots outside a container (development), but never silently', async () => {
    const result = await boot({ NODE_ENV: undefined, RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true' });
    expect(result.booted).toBe(true);
    expect(result.nodeEnv).toBe('development');
    expect(result.warnings).toMatch(/NODE_ENV is not set — running as NODE_ENV=development\. Every production guard is OFF/);
  });
});

describe('placeholder secrets are FATAL in production and staging', () => {
  const cases: Array<[string, string]> = [
    ['API_SECRET', 'your-api-secret-min-32-chars-here'],
    ['ADMIN_SECRET', 'your-admin-secret-min-32-chars-here'],
    ['API_SECRET', 'dev-api-secret-min-32-chars-long-xxxxx'],
    ['ADMIN_SECRET', 'dev-admin-secret-min-32-chars-long-yyyy'],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_your-stripe-webhook-secret-here'],
    ['STRIPE_SECRET_KEY', 'sk_test_your-stripe-secret-key-here'],
    ['TURNKEY_API_PRIVATE_KEY', 'your-turnkey-api-private-key-here'],
    ['ALCHEMY_API_KEY', 'your-alchemy-api-key-here'],
  ];

  for (const NODE_ENV of ['production', 'staging']) {
    it.each(cases)(`%s=%s with NODE_ENV=${NODE_ENV}`, async (key, value) => {
      const result = await boot({ NODE_ENV, [key]: value });
      expect(result.booted).toBe(false);
      expect(result.errors).toContain(`FATAL: ${key} is set to a placeholder value`);
      expect(result.errors).toContain(`NODE_ENV=${NODE_ENV}`);
      // The secret value itself is not echoed.
      expect(result.errors).not.toContain(value);
    });
  }

  it('lists every placeholder at once', async () => {
    const result = await boot({
      NODE_ENV: 'production',
      API_SECRET: 'your-api-secret-min-32-chars-here',
      ADMIN_SECRET: 'your-admin-secret-min-32-chars-here',
    });
    expect(result.errors).toContain('FATAL: API_SECRET, ADMIN_SECRET are set to a placeholder value');
  });

  it.each(['development', 'test'])('placeholders still boot with NODE_ENV=%s (local use)', async (NODE_ENV) => {
    const result = await boot({ NODE_ENV, API_SECRET: 'your-api-secret-min-32-chars-here', ADMIN_SECRET: 'dev-admin-secret-min-32-chars-long-yyyy' });
    expect(result.booted).toBe(true);
  });

  it('real secrets boot in production and staging', async () => {
    for (const NODE_ENV of ['production', 'staging']) {
      const result = await boot({ NODE_ENV });
      expect(result.booted, result.errors).toBe(true);
    }
  });
});

describe('staging is as strict as production for wallets', () => {
  it.each(['production', 'staging'])('WALLET_PROVIDER=local is FATAL with NODE_ENV=%s', async (NODE_ENV) => {
    const result = await boot({ NODE_ENV, WALLET_PROVIDER: 'local' });
    expect(result.booted).toBe(false);
    expect(result.errors).toContain(`FATAL: WALLET_PROVIDER=local is development-only and cannot run with NODE_ENV=${NODE_ENV}`);
  });

  it('WALLET_PROVIDER=local boots in development', async () => {
    expect((await boot({ NODE_ENV: 'development', WALLET_PROVIDER: 'local' })).booted).toBe(true);
  });
});

describe('RPC_URL_<chainId>: https in production-like envs, http only to loopback / private hosts elsewhere', () => {
  it.each([
    ['production', 'http://203.0.113.10:8545'],
    ['production', 'http://10.0.0.5:8545'],
    ['staging', 'http://rpc.internal.example.org'],
    ['staging', 'http://127.0.0.1:8545'],
  ])('NODE_ENV=%s refuses %s', async (NODE_ENV, url) => {
    const result = await boot({ NODE_ENV, RPC_URL_8453: url });
    expect(result.booted).toBe(false);
    expect(result.errors).toContain(`FATAL: RPC_URL_8453 must use https with NODE_ENV=${NODE_ENV}`);
  });

  it.each(['production', 'staging'])('NODE_ENV=%s accepts https', async (NODE_ENV) => {
    const result = await boot({ NODE_ENV, RPC_URL_8453: 'https://base.example.org/rpc' });
    expect(result.booted, result.errors).toBe(true);
  });

  it.each([
    'http://127.0.0.1:8546',
    'http://localhost:8545',
    'http://anvil:8545',
    'http://192.168.1.20:8545',
    'http://[::1]:8545',
    'http://node.home.arpa:8545',
  ])('development accepts %s', async (url) => {
    const result = await boot({ NODE_ENV: 'development', RPC_URL_84532: url });
    expect(result.booted, result.errors).toBe(true);
  });

  it.each(['http://203.0.113.10:8545', 'http://rpc.example.org'])('development refuses plain http to a public host: %s', async (url) => {
    const result = await boot({ NODE_ENV: 'development', RPC_URL_84532: url });
    expect(result.booted).toBe(false);
    expect(result.errors).toMatch(/FATAL: RPC_URL_84532 uses plain http to a public host/);
  });
});

describe('NODE_ENV unset (rule: WARN always; FATAL in a container with a production-looking config)', () => {
  it('in a container (KUBERNETES_SERVICE_HOST) with the default Turnkey provider → FATAL', async () => {
    const result = await boot({ NODE_ENV: undefined, KUBERNETES_SERVICE_HOST: '10.96.0.1' });
    expect(result.booted).toBe(false);
    expect(result.errors).toMatch(/FATAL: NODE_ENV is not set, the process runs in a container .*KUBERNETES_SERVICE_HOST/);
    expect(result.errors).toContain('WALLET_PROVIDER=turnkey (real MPC keys)');
  });

  it('in a Docker container (/.dockerenv) with a mainnet executor → FATAL', async () => {
    const result = await boot(
      { NODE_ENV: undefined, WALLET_PROVIDER: 'local', EXECUTOR_ADDRESS_8453: '0x1111111111111111111111111111111111111111' },
      ['/.dockerenv'],
    );
    expect(result.booted).toBe(false);
    expect(result.errors).toMatch(/\/\.dockerenv.*EXECUTOR_ADDRESS_8453 is set \(mainnet\)/);
  });

  it('in a container with a development-only config (local wallet, nothing public) → boots with the WARN', async () => {
    const result = await boot({ NODE_ENV: undefined, WALLET_PROVIDER: 'local', FLY_APP_NAME: 'agentfi-dev' });
    expect(result.booted).toBe(true);
    expect(result.nodeEnv).toBe('development');
    expect(result.warnings).toMatch(/NODE_ENV is not set/);
  });

  it('outside a container with the Turnkey provider → boots with the WARN (local development)', async () => {
    const result = await boot({ NODE_ENV: undefined });
    expect(result.booted).toBe(true);
    expect(result.warnings).toMatch(/NODE_ENV is not set/);
  });

  it('an explicit NODE_ENV=development in a container boots without the WARN', async () => {
    const result = await boot({ NODE_ENV: 'development', KUBERNETES_SERVICE_HOST: '10.96.0.1' });
    expect(result.booted).toBe(true);
    expect(result.warnings).not.toMatch(/NODE_ENV is not set/);
  });
});

describe('TRUST_PROXY', () => {
  it('defaults to false', async () => {
    expect((await boot({ NODE_ENV: 'development' })).trustProxy).toBe(false);
  });

  it('accepts a hop count and an address list', async () => {
    expect((await boot({ NODE_ENV: 'development', TRUST_PROXY: '1' })).trustProxy).toBe(1);
    expect((await boot({ NODE_ENV: 'development', TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' })).trustProxy).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });

  it('refuses garbage', async () => {
    const result = await boot({ NODE_ENV: 'development', TRUST_PROXY: 'yes please' });
    expect(result.booted).toBe(false);
  });

  it('warns about true in production', async () => {
    const result = await boot({ NODE_ENV: 'production', TRUST_PROXY: 'true' });
    expect(result.booted).toBe(true);
    expect(result.trustProxy).toBe(true);
    expect(result.warnings).toMatch(/TRUST_PROXY=true trusts every X-Forwarded-For hop/);
  });
});

describe('env-guards rules (unit)', () => {
  it('every placeholder shipped in .env.example and docker-compose.dev.yml is recognised (drift guard)', () => {
    const example = parse(readFileSync(path.join(REPO, '.env.example'), 'utf8'));
    for (const key of PLACEHOLDER_CHECKED_KEYS) {
      const value = example[key];
      if (value) expect(isPlaceholderValue(key, value), `${key}=${value}`).toBe(true);
    }
    const compose = readFileSync(path.join(REPO, 'docker-compose.dev.yml'), 'utf8');
    const shipped = [...compose.matchAll(/^\s+(API_SECRET|ADMIN_SECRET|ALCHEMY_API_KEY):\s*(\S+)\s*$/gm)];
    expect(shipped.length).toBeGreaterThanOrEqual(3);
    for (const [, key, value] of shipped) expect(isPlaceholderValue(key!, value!), `${key}=${value}`).toBe(true);
  });

  it('does not flag real-looking secrets', () => {
    expect(isPlaceholderValue('API_SECRET', 'a3f1c9e0b7d24c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6')).toBe(false);
    expect(isPlaceholderValue('STRIPE_WEBHOOK_SECRET', 'whsec_3kJ8sP2q')).toBe(false);
    expect(isPlaceholderValue('API_SECRET', undefined)).toBe(false);
  });

  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.10', true],
    ['169.254.169.254', true],
    ['::1', true],
    ['[::1]', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['2001:db8::1', false],
    ['anvil', true],
    ['geth.internal', true],
    ['node.local', true],
    ['203.0.113.10', false],
    ['8.8.8.8', false],
    ['rpc.example.org', false],
    ['eth-mainnet.g.alchemy.com', false],
  ])('isLoopbackOrPrivateHost(%s) = %s', (host, expected) => {
    expect(isLoopbackOrPrivateHost(host)).toBe(expected);
  });

  it('rpcUrlProblem', () => {
    expect(rpcUrlProblem('https://x.example', 'production')).toBeNull();
    expect(rpcUrlProblem('http://127.0.0.1:8545', 'test')).toBeNull();
    expect(rpcUrlProblem('http://127.0.0.1:8545', 'production')).toMatch(/must use https/);
    expect(rpcUrlProblem('http://1.2.3.4', 'development')).toMatch(/public host/);
  });

  it('detectContainer: marker files first, then platform variables', () => {
    expect(detectContainer({}, () => false)).toBeNull();
    expect(detectContainer({}, (p) => p === '/.dockerenv')).toBe('/.dockerenv');
    expect(detectContainer({}, (p) => p === '/run/.containerenv')).toBe('/run/.containerenv');
    for (const marker of CONTAINER_ENV_MARKERS) {
      expect(detectContainer({ [marker]: 'x' }, () => false)).toBe(marker);
    }
  });

  it('productionSignals', () => {
    expect(productionSignals({ WALLET_PROVIDER: 'local' })).toEqual([]);
    expect(productionSignals({ WALLET_PROVIDER: 'local', BACKEND_PUBLIC_URL: 'http://localhost:3000' })).toEqual([]);
    expect(productionSignals({})).toEqual(['WALLET_PROVIDER=turnkey (real MPC keys)']);
    expect(productionSignals({ WALLET_PROVIDER: 'local', AGENT_JOB_ESCROW_ADDRESS_84532: '0x1' })).toEqual([]); // testnet
    expect(productionSignals({ WALLET_PROVIDER: 'local', STRIPE_SECRET_KEY: 'sk_live_abc' })).toEqual(['STRIPE_SECRET_KEY is a live key']);
    expect(productionSignals({ WALLET_PROVIDER: 'local', ADMIN_ALLOW_REMOTE: 'true' })).toEqual(['ADMIN_ALLOW_REMOTE=true']);
    expect(productionSignals({ WALLET_PROVIDER: 'local', BACKEND_PUBLIC_URL: 'https://api.agentfi.example' })).toEqual([
      'BACKEND_PUBLIC_URL is public (https://api.agentfi.example)',
    ]);
  });

  it('nodeEnvUnsetVerdict is null when NODE_ENV is set, even to an invalid value', () => {
    expect(nodeEnvUnsetVerdict({ NODE_ENV: 'production' }, () => true)).toBeNull();
    expect(nodeEnvUnsetVerdict({ NODE_ENV: '' }, () => true)).toBeNull();
  });

  it('parseTrustProxy', () => {
    expect(parseTrustProxy(undefined)).toEqual({ value: false });
    expect(parseTrustProxy('')).toEqual({ value: false });
    expect(parseTrustProxy('false')).toEqual({ value: false });
    expect(parseTrustProxy('true')).toEqual({ value: true });
    expect(parseTrustProxy('2')).toEqual({ value: 2 });
    expect(parseTrustProxy('0')).toHaveProperty('error');
    expect(parseTrustProxy('11')).toHaveProperty('error');
    expect(parseTrustProxy('::1, 10.0.0.0/8')).toEqual({ value: ['::1', '10.0.0.0/8'] });
    expect(parseTrustProxy('10.0.0.0/33')).toHaveProperty('error');
    expect(parseTrustProxy('proxy.example')).toHaveProperty('error');
  });
});
