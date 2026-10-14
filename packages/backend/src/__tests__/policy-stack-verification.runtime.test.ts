/**
 * Unit tests — S9 per-process verification state and gate of the
 * AgentExecutor / AgentPolicyModule (`config/policy-stack-verification.runtime.ts`):
 * the Q7 lifecycle (TTL, revocation by any failed read, fingerprint) applied
 * to the executor / module. env and the contract table are mocked; the reads
 * against real deployments (incl. RPC down → recovered) run on Anvil.
 */
import { vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { OPERATOR_FEE_WALLET: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', ESCROW_CONFIG_VERIFIED_TTL_SECONDS: 600, ESCROW_CONFIG_RECHECK_SECONDS: 120 },
}));
vi.mock('../config/contracts.js', () => {
  const table: Record<number, { executor?: string; policyModule?: string }> = {
    84532: { executor: '0x00000000000000000000000000000000000E0E0E', policyModule: '0x00000000000000000000000000000000000A0D01' },
    8453: {},
  };
  return { CONTRACT_ADDRESSES: table, getContracts: (chainId: number) => table[chainId] ?? {}, resolveExecutorAddress: () => ({ address: null, legacy: null }) };
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPolicyStackVerificationForTests,
  policyStackExpectations,
  policyStackFingerprint,
  policyStackGate,
  policyStackSnapshot,
  recordPolicyStackChecks,
} from '../config/policy-stack-verification.runtime.js';

const T0 = new Date('2026-10-14T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const base = { chainId: 84532, executor: '0x00000000000000000000000000000000000E0E0E' as const, policyModule: '0x00000000000000000000000000000000000A0D01' as const, notes: [] };
const OK = { ...base, problems: [], unreadable: null };
const DOWN = { ...base, problems: [], unreadable: 'fetch failed' };
const BAD = { ...base, problems: ['chain 84532: EXECUTOR_ADDRESS_84532=0x… is not this build’s AgentExecutor'], unreadable: null };

beforeEach(() => {
  __resetPolicyStackVerificationForTests();
  process.env['POLICY_OPERATOR_ADDRESS_84532'] = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
});
afterEach(() => {
  delete process.env['POLICY_OPERATOR_ADDRESS_84532'];
});

describe('policy stack gate', () => {
  it('expectations: only chains with an executor or a module; bindings from the env', () => {
    const [expectation, ...rest] = policyStackExpectations();
    expect(rest).toEqual([]);
    expect(expectation).toMatchObject({
      chainId: 84532,
      operator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      feeWallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      feeBps: 30n,
    });
  });

  it('nothing read yet → not-verified-yet; an unconfigured chain → not-configured', () => {
    expect(policyStackGate(84532, T0)).toMatchObject({ allowed: false, block: 'not-verified-yet', retryAfterSeconds: 120 });
    expect(policyStackGate(8453, T0)).toMatchObject({ allowed: false, block: 'not-configured' });
  });

  it('a verified read authorises for the TTL, a failed read revokes it at once, a later success restores it (recovery)', () => {
    const expectations = policyStackExpectations();
    expect(recordPolicyStackChecks([OK], expectations, T0)).toEqual([expect.objectContaining({ chainId: 84532, current: expect.objectContaining({ kind: 'verified' }) })]);
    expect(policyStackGate(84532, at(599))).toMatchObject({ allowed: true });
    expect(policyStackGate(84532, at(600))).toMatchObject({ allowed: false, block: 'expired' });

    recordPolicyStackChecks([DOWN], expectations, at(120));
    expect(policyStackGate(84532, at(121))).toMatchObject({ allowed: false, block: 'unverified', reason: expect.stringContaining('fetch failed') });

    recordPolicyStackChecks([OK], expectations, at(240));
    expect(policyStackGate(84532, at(241))).toMatchObject({ allowed: true });
  });

  it('a mismatch blocks with its problems; it is not lifted by time', () => {
    recordPolicyStackChecks([BAD], policyStackExpectations(), T0);
    expect(policyStackGate(84532, at(1))).toMatchObject({ allowed: false, block: 'mismatch', reason: expect.stringContaining('not this build') });
    expect(policyStackGate(84532, at(10_000))).toMatchObject({ allowed: false, block: 'mismatch' });
  });

  it('a verification is bound to the configuration: changing the expected operator invalidates it (config-changed)', () => {
    const before = policyStackExpectations();
    recordPolicyStackChecks([OK], before, T0);
    expect(policyStackGate(84532, at(1)).allowed).toBe(true);
    process.env['POLICY_OPERATOR_ADDRESS_84532'] = '0x1111111111111111111111111111111111111111';
    expect(policyStackFingerprint(policyStackExpectations()[0]!)).not.toBe(policyStackFingerprint(before[0]!));
    expect(policyStackGate(84532, at(1))).toMatchObject({ allowed: false, block: 'config-changed' });
  });

  it('snapshot: reasons only when asked', () => {
    recordPolicyStackChecks([BAD], policyStackExpectations(), T0);
    expect(policyStackSnapshot({ withReason: false }, at(1))).toEqual([
      { chainId: 84532, state: 'mismatch', allowed: false, verifiedAt: null, validUntil: null, since: T0.toISOString() },
    ]);
    expect(policyStackSnapshot({ withReason: true }, at(1))[0]).toHaveProperty('reason');
  });
});
