/**
 * Boot test — `.env.example` must load through `config/env.ts` as shipped.
 *
 * The documented first run is `cp .env.example .env` and fill in the
 * required secrets. dotenv (and docker `env_file`) deliver every `KEY=`
 * line as the empty string, so an optional variable with a format
 * constraint — e.g. `z.string().url().optional()` — rejects "" and the
 * backend `process.exit(1)`s before serving a request. This test replays
 * exactly that path: parse the example, export it into `process.env` the
 * way dotenv does, fill the required values with the CI dummies from
 * `.github/workflows/ci.yml`, and import the real schema module.
 *
 * Any future blank `KEY=` in `.env.example` whose schema rejects "" fails
 * here instead of at an operator's first boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_FILE = path.resolve(here, '../../../../.env.example');

/** Same values the Backend Tests job exports in `.github/workflows/ci.yml`. */
const CI_REQUIRED = {
  DATABASE_URL: 'postgresql://agentfi:agentfi@localhost:5432/agentfi_test',
  REDIS_URL: 'redis://localhost:6379',
  API_SECRET: 'test-secret-min-32-chars-long-here',
  ADMIN_SECRET: 'test-admin-secret-min-32-chars-long',
  OPERATOR_FEE_WALLET: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  ALCHEMY_API_KEY: 'test',
  TURNKEY_API_PUBLIC_KEY: 'test',
  TURNKEY_API_PRIVATE_KEY: 'test',
  TURNKEY_ORGANIZATION_ID: 'test',
} as const;

const savedEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

/** Exports `values` as dotenv would (blank stays "", never undefined) and imports a fresh env module. */
async function bootWith(values: Record<string, string>) {
  restoreEnv();
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  Object.assign(process.env, CI_REQUIRED);

  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${String(code)})`);
  }) as never);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  try {
    const mod = await import('../config/env.js');
    return { env: mod.env, exit, consoleError };
  } catch (error) {
    const logged = consoleError.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    throw new Error(`${String(error)}\n${logged}`);
  }
}

describe('.env.example boots through config/env.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it('loads as shipped once the required secrets are filled in', async () => {
    const example = parse(readFileSync(EXAMPLE_FILE, 'utf8'));
    expect(Object.keys(example).length).toBeGreaterThan(10);

    const { env, exit, consoleError } = await bootWith(example);

    expect(exit).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(env.API_SECRET).toBe(CI_REQUIRED.API_SECRET);
    // Shipped commented out, so it is simply absent.
    expect(example['X402_FACILITATOR_URL']).toBeUndefined();
    expect(env.X402_FACILITATOR_URL).toBeUndefined();
  });

  it('treats a blank X402_FACILITATOR_URL= as unset instead of exiting', async () => {
    const example = parse(readFileSync(EXAMPLE_FILE, 'utf8'));
    const { env, exit } = await bootWith({ ...example, X402_FACILITATOR_URL: '' });

    expect(exit).not.toHaveBeenCalled();
    expect(env.X402_FACILITATOR_URL).toBeUndefined();
  });

  it('still rejects a non-URL X402_FACILITATOR_URL', async () => {
    const example = parse(readFileSync(EXAMPLE_FILE, 'utf8'));
    await expect(bootWith({ ...example, X402_FACILITATOR_URL: 'not a url' })).rejects.toThrow(/process\.exit\(1\)/);
  });
});

describe('RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS (S4 development override)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  function example(): Record<string, string> {
    return parse(readFileSync(EXAMPLE_FILE, 'utf8'));
  }

  it('ships as false and defaults to false when unset or blank', async () => {
    expect(example()['RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS']).toBe('false');

    const shipped = await bootWith(example());
    expect(shipped.env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS).toBe('false');

    const { RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: _omit, ...unset } = example();
    const absent = await bootWith(unset);
    expect(absent.env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS).toBe('false');

    const blank = await bootWith({ ...example(), RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: '' });
    expect(blank.env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS).toBe('false');
    expect(blank.exit).not.toHaveBeenCalled();
  });

  it('may be true in development and test', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const { env, exit } = await bootWith({ ...example(), NODE_ENV, RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true' });
      expect(exit).not.toHaveBeenCalled();
      expect(env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS).toBe('true');
    }
  });

  it.each(['production', 'staging'])('refuses to boot with true when NODE_ENV=%s (FATAL)', async (NODE_ENV) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      bootWith({ ...example(), NODE_ENV, WALLET_PROVIDER: 'turnkey', RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true' }),
    ).rejects.toThrow(
      new RegExp(`process\\.exit\\(1\\)[\\s\\S]*FATAL: RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true cannot run with NODE_ENV=${NODE_ENV}`),
    );
  });

  it.each(['production', 'staging'])('boots with false when NODE_ENV=%s', async (NODE_ENV) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, exit } = await bootWith({
      ...example(),
      NODE_ENV,
      WALLET_PROVIDER: 'turnkey',
      RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'false',
    });
    expect(exit).not.toHaveBeenCalled();
    expect(env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS).toBe('false');
  });

  it('rejects anything but true / false', async () => {
    await expect(bootWith({ ...example(), RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'yes' })).rejects.toThrow(
      /process\.exit\(1\)/,
    );
  });
});

describe('RESOURCE_PAYMENT_ALLOWED_PORTS (P6 port policy)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  function example(): Record<string, string> {
    return parse(readFileSync(EXAMPLE_FILE, 'utf8'));
  }

  it('ships commented out (unset), and a blank value is unset too', async () => {
    expect(example()['RESOURCE_PAYMENT_ALLOWED_PORTS']).toBeUndefined();
    expect(readFileSync(EXAMPLE_FILE, 'utf8')).toMatch(/^# RESOURCE_PAYMENT_ALLOWED_PORTS=80,443$/m);
    const blank = await bootWith({ ...example(), RESOURCE_PAYMENT_ALLOWED_PORTS: '' });
    expect(blank.exit).not.toHaveBeenCalled();
    expect(blank.env.RESOURCE_PAYMENT_ALLOWED_PORTS).toBeUndefined();
  });

  it('accepts a comma-separated port list', async () => {
    const { env, exit } = await bootWith({ ...example(), RESOURCE_PAYMENT_ALLOWED_PORTS: '80, 443,8443' });
    expect(exit).not.toHaveBeenCalled();
    expect(env.RESOURCE_PAYMENT_ALLOWED_PORTS).toBe('80, 443,8443');
  });

  it.each(['80;443', 'https', '0', '70000', '80,'])('refuses to boot with %j', async (value) => {
    await expect(bootWith({ ...example(), RESOURCE_PAYMENT_ALLOWED_PORTS: value })).rejects.toThrow(/process\.exit\(1\)/);
  });
});

describe('RPC_URL_<chainId> (per-chain RPC override, C5a)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  function example(): Record<string, string> {
    return parse(readFileSync(EXAMPLE_FILE, 'utf8'));
  }

  it('ships blank for Base Sepolia and boots as unset', async () => {
    expect(example()['RPC_URL_84532']).toBe('');
    const { env, exit } = await bootWith(example());
    expect(exit).not.toHaveBeenCalled();
    expect(env.RPC_URL_84532).toBeUndefined();
  });

  it('accepts an http(s) URL on every supported chain and trims it', async () => {
    const { env, exit } = await bootWith({
      ...example(),
      RPC_URL_84532: ' http://127.0.0.1:8546 ',
      RPC_URL_8453: 'https://base.example.org/rpc',
    });
    expect(exit).not.toHaveBeenCalled();
    expect(env.RPC_URL_84532).toBe('http://127.0.0.1:8546');
    expect(env.RPC_URL_8453).toBe('https://base.example.org/rpc');
  });

  it.each(['not a url', 'ws://127.0.0.1:8546'])('refuses to boot with RPC_URL_84532=%s', async (value) => {
    // The example itself boots (test above), so the override is what fails.
    await expect(bootWith({ ...example(), RPC_URL_84532: value })).rejects.toThrow(/process\.exit\(1\)/);
  });
});
