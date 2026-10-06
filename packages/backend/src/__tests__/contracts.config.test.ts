/**
 * Unit tests — config/contracts.ts legacy-deployment helpers.
 *
 * `findLegacyContractConfig` / `resolveExecutorAddress` take an injectable
 * env so they are tested without touching `process.env`; `getContracts` is
 * checked once with env set before the module is imported (it reads env at
 * load time) to prove a legacy executor never reaches `contracts.executor`.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const LEGACY_EXECUTOR_8453 = '0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3';
const LEGACY_POLICY_84532 = '0x771444Ff5483ef3A62b492a816Cb439e4f017203';
const LEGACY_EXECUTOR_84532 = '0x1fE2A4e79899A9cB03bED301f978d2Ce2F91Fc5d';
const FRESH_EXECUTOR = '0x00000000000000000000000000000000000000E1';

// `CONTRACT_ADDRESSES` is computed from process.env when the module loads.
const { previousEnv } = vi.hoisted(() => {
  const keys = ['EXECUTOR_ADDRESS_84532', 'EXECUTOR_ADDRESS_137'] as const;
  const previousEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env['EXECUTOR_ADDRESS_84532'] = '0x1fE2A4e79899A9cB03bED301f978d2Ce2F91Fc5d'; // legacy
  process.env['EXECUTOR_ADDRESS_137'] = '0x00000000000000000000000000000000000000E1'; // current
  return { previousEnv };
});

import {
  contractEnvVar,
  describeLegacyContract,
  findLegacyContractConfig,
  getContracts,
  isLegacyContractAddress,
  resolveExecutorAddress,
} from '../config/contracts.js';

afterAll(() => {
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('isLegacyContractAddress', () => {
  it('matches known deployments per chain, case-insensitively', () => {
    expect(isLegacyContractAddress(8453, LEGACY_EXECUTOR_8453)).toBe(true);
    expect(isLegacyContractAddress(8453, LEGACY_EXECUTOR_8453.toLowerCase())).toBe(true);
    expect(isLegacyContractAddress(84532, LEGACY_POLICY_84532)).toBe(true);
  });

  it('is chain-scoped: the Base legacy executor is not legacy on Base Sepolia', () => {
    expect(isLegacyContractAddress(84532, LEGACY_EXECUTOR_8453)).toBe(false);
    expect(isLegacyContractAddress(8453, FRESH_EXECUTOR)).toBe(false);
  });
});

describe('findLegacyContractConfig', () => {
  it('returns nothing for an empty or current-only configuration', () => {
    expect(findLegacyContractConfig({})).toEqual([]);
    expect(findLegacyContractConfig({ EXECUTOR_ADDRESS_8453: FRESH_EXECUTOR })).toEqual([]);
  });

  it('reports a configured legacy executor with its chain and env var', () => {
    const hits = findLegacyContractConfig({ EXECUTOR_ADDRESS_8453: LEGACY_EXECUTOR_8453 });
    expect(hits).toEqual([{ chainId: 8453, contract: 'executor', address: LEGACY_EXECUTOR_8453 }]);
    expect(contractEnvVar(hits[0]!.chainId, hits[0]!.contract)).toBe('EXECUTOR_ADDRESS_8453');
  });

  it('reports both halves of a legacy pair, policy module first', () => {
    const hits = findLegacyContractConfig({
      POLICY_MODULE_ADDRESS_84532: LEGACY_POLICY_84532,
      EXECUTOR_ADDRESS_84532: LEGACY_EXECUTOR_84532.toLowerCase(),
    });
    expect(hits.map((h) => `${h.chainId}:${h.contract}`)).toEqual([
      '84532:policyModule',
      '84532:executor',
    ]);
  });

  it('reads the raw env, so it still names a legacy executor that getContracts() hides', () => {
    expect(findLegacyContractConfig(process.env)).toContainEqual({
      chainId: 84532,
      contract: 'executor',
      address: LEGACY_EXECUTOR_84532,
    });
  });
});

describe('resolveExecutorAddress', () => {
  it('not configured → null, no legacy hit', () => {
    expect(resolveExecutorAddress(8453, {})).toEqual({ address: null, legacy: null });
  });

  it('current deployment → the address', () => {
    expect(resolveExecutorAddress(8453, { EXECUTOR_ADDRESS_8453: FRESH_EXECUTOR })).toEqual({
      address: FRESH_EXECUTOR,
      legacy: null,
    });
  });

  it('legacy deployment → treated as not configured, legacy hit reported', () => {
    expect(resolveExecutorAddress(8453, { EXECUTOR_ADDRESS_8453: LEGACY_EXECUTOR_8453 })).toEqual({
      address: null,
      legacy: { chainId: 8453, contract: 'executor', address: LEGACY_EXECUTOR_8453 },
    });
  });
});

describe('getContracts (env read at module load)', () => {
  it('drops a legacy executor and keeps a current one', () => {
    expect(getContracts(84532).executor).toBeUndefined();
    expect(getContracts(137).executor).toBe(FRESH_EXECUTOR);
  });
});

describe('describeLegacyContract', () => {
  it('names the env var, the address and the runbook section', () => {
    const msg = describeLegacyContract({
      chainId: 8453,
      contract: 'executor',
      address: LEGACY_EXECUTOR_8453,
    });
    expect(msg).toContain(`EXECUTOR_ADDRESS_8453=${LEGACY_EXECUTOR_8453}`);
    expect(msg).toMatch(/WILL revert/);
    expect(msg).toMatch(/ABI versioning/);
  });

  it('describes a legacy policy module as paired, not as reverting', () => {
    const msg = describeLegacyContract({
      chainId: 84532,
      contract: 'policyModule',
      address: LEGACY_POLICY_84532,
    });
    expect(msg).toContain('POLICY_MODULE_ADDRESS_84532=');
    expect(msg).toMatch(/paired with a legacy executor/);
    expect(msg).not.toMatch(/WILL revert/);
  });
});
