/**
 * Unit tests — Q7 verification state machine (`config/escrow-verification.ts`)
 * and the eth_chainId check added to `checkEscrowDeployments`. Pure: no env,
 * no RPC, no clock (times are passed in).
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { checkEscrowDeployments, type EscrowChainExpectation } from '../config/escrow-boot-check.js';
import {
  escrowGateVerdict,
  expectationFingerprint,
  stateAfterCheck,
  verificationView,
  type EscrowVerificationState,
} from '../config/escrow-verification.js';

const T0 = new Date('2026-10-14T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const SETTINGS = { ttlSeconds: 600, recheckSeconds: 120 };

const EXPECTATION: EscrowChainExpectation = {
  chainId: 84532,
  escrow: '0x00000000000000000000000000000000000E5C20' as Address,
  hook: '0x000000000000000000000000000000000000400C' as Address,
  evaluator: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address,
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address,
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address,
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
};
const OK = { problems: [], unreadable: null };
const DOWN = { problems: [], unreadable: 'timed out after 10000 ms' };
const WRONG = { problems: ['chain 84532: hook.acp() is 0x1111…, not AGENT_JOB_ESCROW_ADDRESS_84532'], unreadable: null };

function gate(state: EscrowVerificationState | undefined, now: Date, expectation: EscrowChainExpectation | null = EXPECTATION) {
  return escrowGateVerdict({ chainId: 84532, state, expectation, now, settings: SETTINGS });
}

describe('expectationFingerprint', () => {
  it('is stable across address case and changes with any field', () => {
    const fp = expectationFingerprint(EXPECTATION);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(expectationFingerprint({ ...EXPECTATION, escrow: EXPECTATION.escrow.toLowerCase() as Address })).toBe(fp);
    for (const field of ['escrow', 'hook', 'evaluator', 'identityRegistry', 'reputationRegistry', 'usdc'] as const) {
      expect(expectationFingerprint({ ...EXPECTATION, [field]: '0x1111111111111111111111111111111111111111' }), field).not.toBe(fp);
    }
    expect(expectationFingerprint({ ...EXPECTATION, hook: null })).not.toBe(fp);
    expect(expectationFingerprint({ ...EXPECTATION, chainId: 8453 })).not.toBe(fp);
  });
});

describe('stateAfterCheck + escrowGateVerdict', () => {
  it('no state yet → refused (not-verified-yet), with the re-check interval as Retry-After', () => {
    expect(gate(undefined, T0)).toEqual({
      allowed: false,
      chainId: 84532,
      block: 'not-verified-yet',
      reason: expect.stringContaining('has not been verified yet'),
      retryAfterSeconds: 120,
    });
  });

  it('a success authorises for exactly the TTL, then expires', () => {
    const verified = stateAfterCheck(undefined, OK, EXPECTATION, T0);
    expect(verified).toEqual({ kind: 'verified', at: T0, fingerprint: expectationFingerprint(EXPECTATION) });
    expect(gate(verified, at(0))).toMatchObject({ allowed: true, verifiedAt: T0, validUntil: at(600) });
    expect(gate(verified, at(599)).allowed).toBe(true);
    expect(gate(verified, at(600))).toMatchObject({ allowed: false, block: 'expired', reason: expect.stringMatching(/expired at 2026-10-14T10:10:00.000Z/) });
  });

  it('a failed read after a success revokes it at once — the earlier success never survives a later failure', () => {
    const verified = stateAfterCheck(undefined, OK, EXPECTATION, T0);
    const down = stateAfterCheck(verified, DOWN, EXPECTATION, at(120));
    expect(down).toEqual({ kind: 'unverified', reason: 'the chain could not be read: timed out after 10000 ms', since: at(120) });
    expect(gate(down, at(121))).toMatchObject({ allowed: false, block: 'unverified' }); // well inside the old TTL
    // An ongoing outage keeps its start; a success starts a new verification.
    expect(stateAfterCheck(down, DOWN, EXPECTATION, at(240))).toMatchObject({ kind: 'unverified', since: at(120) });
    const again = stateAfterCheck(down, OK, EXPECTATION, at(360));
    expect(gate(again, at(361))).toMatchObject({ allowed: true, verifiedAt: at(360) });
  });

  it('a mismatch blocks (and keeps its start); mismatch → read failure → unverified', () => {
    const wrong = stateAfterCheck(undefined, WRONG, EXPECTATION, T0);
    expect(wrong).toMatchObject({ kind: 'mismatch', since: T0 });
    expect(gate(wrong, at(1))).toMatchObject({ allowed: false, block: 'mismatch', reason: expect.stringContaining('hook.acp()') });
    expect(stateAfterCheck(wrong, WRONG, EXPECTATION, at(120))).toMatchObject({ kind: 'mismatch', since: T0 });
    expect(stateAfterCheck(wrong, DOWN, EXPECTATION, at(240))).toMatchObject({ kind: 'unverified', since: at(240) });
  });

  it('a verification of another expectation (config changed) is not a verification of this one', () => {
    const verified = stateAfterCheck(undefined, OK, EXPECTATION, T0);
    const changed = { ...EXPECTATION, evaluator: '0x2222222222222222222222222222222222222222' as Address };
    expect(gate(verified, at(1), changed)).toMatchObject({ allowed: false, block: 'config-changed' });
  });

  it('a chain without an escrow in this process is refused (not-configured)', () => {
    expect(gate(stateAfterCheck(undefined, OK, EXPECTATION, T0), at(1), null)).toMatchObject({ allowed: false, block: 'not-configured' });
  });

  it('verificationView: the public view has no reason; the operator view does', () => {
    const down = stateAfterCheck(undefined, DOWN, EXPECTATION, T0);
    const verdict = gate(down, at(5));
    expect(verificationView(down, verdict, { withReason: false })).toEqual({
      chainId: 84532,
      state: 'unverified',
      allowed: false,
      verifiedAt: null,
      validUntil: null,
      since: T0.toISOString(),
    });
    expect(verificationView(down, verdict, { withReason: true }).reason).toMatch(/timed out/);
    const ok = stateAfterCheck(undefined, OK, EXPECTATION, T0);
    expect(verificationView(ok, gate(ok, at(5)), { withReason: true })).toEqual({
      chainId: 84532,
      state: 'verified',
      allowed: true,
      verifiedAt: T0.toISOString(),
      validUntil: at(600).toISOString(),
      since: null,
    });
  });
});

describe('checkEscrowDeployments — eth_chainId (Q7)', () => {
  const values: Record<string, string> = {
    token: EXPECTATION.usdc!,
    acp: EXPECTATION.escrow,
    trustedEvaluator: EXPECTATION.evaluator!,
    identityRegistry: EXPECTATION.identityRegistry!,
    reputationRegistry: EXPECTATION.reputationRegistry!,
  };
  const reader = () => async ({ functionName }: { functionName: string }) => values[functionName];

  it('the RPC serving the configured chain verifies', async () => {
    const [check] = await checkEscrowDeployments({ chains: [EXPECTATION], reader, chainIdReader: () => async () => 84532 });
    expect(check).toMatchObject({ problems: [], unreadable: null });
  });

  it('an RPC serving another network is a mismatch (never "unreadable")', async () => {
    const [check] = await checkEscrowDeployments({ chains: [EXPECTATION], reader, chainIdReader: () => async () => 8453 });
    expect(check!.unreadable).toBeNull();
    expect(check!.problems).toEqual([expect.stringMatching(/chain 84532: the RPC answers eth_chainId 8453, not 84532/)]);
  });

  it('eth_chainId failing to answer is a transport error: unreadable', async () => {
    const [check] = await checkEscrowDeployments({
      chains: [EXPECTATION],
      reader,
      chainIdReader: () => async () => {
        throw new Error('fetch failed');
      },
      attempts: 1,
    });
    expect(check).toMatchObject({ problems: [], unreadable: 'fetch failed' });
  });
});
