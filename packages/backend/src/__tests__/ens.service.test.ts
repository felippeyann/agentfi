/**
 * Unit tests — EnsService
 *
 * Exercises the pure helpers (label normalization, candidate building)
 * and the registration flow with a mocked wallet/public client so we
 * don't touch the chain.
 */
import { vi } from 'vitest';

// config/env.ts calls process.exit() on missing required env vars at
// module load time. Stub the ones the logger transitively requires so
// this test file can import the service under test.
vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
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
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EnsService,
  normalizeEnsLabel,
  buildSubdomainCandidate,
  readEnsConfig,
  type EnsConfig,
} from '../services/identity/ens.service.js';

// ── normalizeEnsLabel ──────────────────────────────────────────────────────

describe('normalizeEnsLabel', () => {
  it('lowercases and slugifies spaces', () => {
    expect(normalizeEnsLabel('Alice Bot')).toBe('alice-bot');
  });

  it('strips disallowed characters', () => {
    expect(normalizeEnsLabel("O'Neil Trader #1")).toBe('o-neil-trader-1');
  });

  it('collapses repeated dashes and trims edges', () => {
    expect(normalizeEnsLabel('---trade___bot---')).toBe('trade-bot');
  });

  it('returns null when the label is shorter than 3 chars', () => {
    expect(normalizeEnsLabel('ab')).toBeNull();
    expect(normalizeEnsLabel('🤖🤖')).toBeNull();
  });

  it('returns null when slug is over 63 chars', () => {
    const tooLong = 'a'.repeat(64);
    expect(normalizeEnsLabel(tooLong)).toBeNull();
  });
});

// ── buildSubdomainCandidate ────────────────────────────────────────────────

describe('buildSubdomainCandidate', () => {
  it('appends a stable id suffix to disambiguate name collisions', () => {
    const a = buildSubdomainCandidate({
      name: 'Trader',
      agentId: 'ckabcdef123456',
      parentDomain: 'agentfi.eth',
    });
    const b = buildSubdomainCandidate({
      name: 'Trader',
      agentId: 'ckabcdef999999',
      parentDomain: 'agentfi.eth',
    });
    expect(a?.label).not.toBe(b?.label);
    expect(a?.fullName).toMatch(/^trader-[a-z0-9]{6}\.agentfi\.eth$/);
  });

  it('returns null when the name does not yield a usable label', () => {
    const result = buildSubdomainCandidate({
      name: 'x',
      agentId: 'ckabcdef123456',
      parentDomain: 'agentfi.eth',
    });
    expect(result).toBeNull();
  });

  it('caps the label at 63 chars even for very long names', () => {
    const longName = 'a'.repeat(80);
    const result = buildSubdomainCandidate({
      name: longName,
      agentId: 'ckabcdef123456',
      parentDomain: 'agentfi.eth',
    });
    // 'a' * 80 normalises to an 80-char slug → rejected by normalizeEnsLabel
    expect(result).toBeNull();

    const usable = buildSubdomainCandidate({
      name: 'a'.repeat(60),
      agentId: 'ckabcdef123456',
      parentDomain: 'agentfi.eth',
    });
    expect(usable).not.toBeNull();
    expect(usable!.label.length).toBeLessThanOrEqual(63);
  });
});

// ── readEnsConfig ──────────────────────────────────────────────────────────

describe('readEnsConfig', () => {
  const PK = '0x' + '11'.repeat(32);

  beforeEach(() => {
    delete process.env['ENS_PARENT_DOMAIN'];
    delete process.env['ENS_CONTROLLER_PRIVATE_KEY'];
    delete process.env['ENS_CHAIN_ID'];
    delete process.env['ENS_PUBLIC_RESOLVER'];
  });

  it('returns null when parent domain is missing', () => {
    process.env['ENS_CONTROLLER_PRIVATE_KEY'] = PK;
    expect(readEnsConfig()).toBeNull();
  });

  it('returns null when controller key is missing', () => {
    process.env['ENS_PARENT_DOMAIN'] = 'agentfi.eth';
    expect(readEnsConfig()).toBeNull();
  });

  it('returns config with mainnet defaults when both are set', () => {
    process.env['ENS_PARENT_DOMAIN'] = 'agentfi.eth';
    process.env['ENS_CONTROLLER_PRIVATE_KEY'] = PK;
    const cfg = readEnsConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.parentDomain).toBe('agentfi.eth');
    expect(cfg!.chainId).toBe(1);
    expect(cfg!.publicResolver).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('accepts private key without 0x prefix', () => {
    process.env['ENS_PARENT_DOMAIN'] = 'agentfi.eth';
    process.env['ENS_CONTROLLER_PRIVATE_KEY'] = '11'.repeat(32);
    const cfg = readEnsConfig();
    expect(cfg!.controllerPrivateKey.startsWith('0x')).toBe(true);
  });

  it('returns null on chains with no default resolver unless override is set', () => {
    process.env['ENS_PARENT_DOMAIN'] = 'agentfi.eth';
    process.env['ENS_CONTROLLER_PRIVATE_KEY'] = PK;
    process.env['ENS_CHAIN_ID'] = '8453'; // Base — no default resolver
    expect(readEnsConfig()).toBeNull();

    process.env['ENS_PUBLIC_RESOLVER'] =
      '0x0000000000000000000000000000000000000042';
    const cfg = readEnsConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.publicResolver).toBe(
      '0x0000000000000000000000000000000000000042',
    );
  });
});

// ── EnsService.registerSubdomain ───────────────────────────────────────────

describe('EnsService.registerSubdomain', () => {
  function makeConfig(): EnsConfig {
    return {
      parentDomain: 'agentfi.eth',
      controllerPrivateKey: ('0x' + '22'.repeat(32)) as `0x${string}`,
      chainId: 1,
      publicResolver: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
    };
  }

  it('is a no-op and returns null when unconfigured', async () => {
    const svc = new EnsService(null);
    expect(svc.isConfigured()).toBe(false);
    const result = await svc.registerSubdomain({
      name: 'alice',
      agentId: 'ckabc123456',
      targetAddress: '0x0000000000000000000000000000000000000001',
    });
    expect(result).toBeNull();
  });

  it('returns null when the name does not yield a usable label', async () => {
    const svc = new EnsService(makeConfig());
    const result = await svc.registerSubdomain({
      name: 'x',
      agentId: 'ckabc123456',
      targetAddress: '0x0000000000000000000000000000000000000001',
    });
    expect(result).toBeNull();
  });

  it('returns null when target is not a valid address', async () => {
    const svc = new EnsService(makeConfig());
    const result = await svc.registerSubdomain({
      name: 'alice',
      agentId: 'ckabc123456',
      targetAddress: 'not-an-address',
    });
    expect(result).toBeNull();
  });

  it('submits setSubnodeRecord + setAddr and returns the full name on success', async () => {
    const svc = new EnsService(makeConfig());
    // Inject mocked clients — this test exercises the success path end-to-end
    // without touching the chain.
    const writeContract = vi
      .fn()
      .mockResolvedValueOnce('0xaaaa' as `0x${string}`)
      .mockResolvedValueOnce('0xbbbb' as `0x${string}`);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });

    (svc as unknown as { walletClient: unknown }).walletClient = {
      writeContract,
      account: { address: '0x0000000000000000000000000000000000000099' },
      chain: { id: 1 },
    };
    (svc as unknown as { publicClient: unknown }).publicClient = {
      waitForTransactionReceipt,
    };

    const result = await svc.registerSubdomain({
      name: 'Alice Bot',
      agentId: 'ckabcdef123456',
      targetAddress: '0x0000000000000000000000000000000000000001',
    });

    expect(result).not.toBeNull();
    expect(result!.fullName).toMatch(/^alice-bot-[a-z0-9]{6}\.agentfi\.eth$/);
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);

    // First call targets the ENS registry (setSubnodeRecord)
    const firstCall = writeContract.mock.calls[0]![0];
    expect(firstCall.functionName).toBe('setSubnodeRecord');
    // Second call targets the public resolver (setAddr)
    const secondCall = writeContract.mock.calls[1]![0];
    expect(secondCall.functionName).toBe('setAddr');
  });

  it('swallows on-chain errors and returns null (does not block registration)', async () => {
    const svc = new EnsService(makeConfig());
    const writeContract = vi
      .fn()
      .mockRejectedValue(new Error('rpc failure'));
    (svc as unknown as { walletClient: unknown }).walletClient = {
      writeContract,
      account: { address: '0x0000000000000000000000000000000000000099' },
      chain: { id: 1 },
    };

    const result = await svc.registerSubdomain({
      name: 'alice',
      agentId: 'ckabcdef123456',
      targetAddress: '0x0000000000000000000000000000000000000001',
    });
    expect(result).toBeNull();
  });
});
