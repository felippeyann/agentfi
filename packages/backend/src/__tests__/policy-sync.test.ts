/**
 * Unit tests — S8 on-chain policy sync planning (`services/policy/policy-sync.ts`)
 * and the pre-submit guard's handling of sync rows.
 *
 * The same logic runs against the real AgentPolicyModule on Anvil and real
 * Postgres in `policy-sync.routes.anvil.ts`; here every rule is pinned
 * without a chain.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { decodeFunctionData, getAddress, isAddress, type Address } from 'viem';

const { settleVolumeMock, stopStampedMock, contractsGate } = vi.hoisted(() => ({
  settleVolumeMock: vi.fn(),
  stopStampedMock: vi.fn(),
  contractsGate: vi.fn(),
}));
// S9: the executor / module verification the guard consults for sync rows.
vi.mock('../config/policy-stack-verification.runtime.js', () => ({ policyStackGate: contractsGate }));
vi.mock('../services/policy/daily-volume.js', () => ({
  settleVolumeAfterFailure: settleVolumeMock,
  stopStampedTransaction: stopStampedMock,
}));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ onEscrowTxOutcome: vi.fn(), vetBindBeforeBroadcast: vi.fn() }));
vi.mock('../config/escrow-verification.runtime.js', () => ({ escrowConfigGate: () => ({ allowed: true }) }));
vi.mock('../config/contracts.js', () => ({
  getContracts: () => ({ policyModule: '0x00000000000000000000000000000000000000A9' }),
}));

import {
  POLICY_MODULE_ABI,
  desiredOnChainPolicy,
  encodeSetPolicy,
  ethDecimalToWei,
  planPolicySync,
  policySyncMetadataOf,
  readOnChainPolicy,
  supersededReason,
  syncHistory,
  type DesiredOnChainPolicy,
  type OnChainPolicyReading,
  type PolicySyncMetadata,
} from '../services/policy/policy-sync.js';
import { POLICY_SYNC_SUPERSEDED, preSubmitGuard } from '../services/transaction/pre-submit-guard.js';

const SAFE = getAddress('0x00000000000000000000000000000000000005a1');
const MODULE = getAddress('0x00000000000000000000000000000000000000a9');
const C1 = getAddress('0x00000000000000000000000000000000000c0001');
const C2 = getAddress('0x00000000000000000000000000000000000c0002');
const T1 = getAddress('0x00000000000000000000000000000000000e0001');

function policy(overrides: Partial<{ maxValuePerTxEth: string; cooldownSeconds: number; active: boolean; expiresAt: Date | null; allowedContracts: string[]; allowedTokens: string[] }> = {}) {
  return { maxValuePerTxEth: '0.5', cooldownSeconds: 0, active: true, expiresAt: null, allowedContracts: [], allowedTokens: [], ...overrides };
}

function desired(overrides: Parameters<typeof policy>[0] = {}, agentActive = true): DesiredOnChainPolicy {
  const result = desiredOnChainPolicy({ safeAddress: SAFE, agentActive, policy: policy(overrides) });
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.desired;
}

function reading(overrides: Partial<OnChainPolicyReading> = {}): OnChainPolicyReading {
  return {
    hasPolicy: true,
    core: { maxValuePerTxWei: 500_000_000_000_000_000n, cooldownSeconds: 0n, active: true, expiresAt: 0n },
    contracts: { count: 0n, members: new Map() },
    tokens: { count: 0n, members: new Map() },
    ...overrides,
  };
}

describe('desiredOnChainPolicy — DB → module, never rounded', () => {
  it('maps the stored policy exactly', () => {
    const expiresAt = new Date('2027-01-05T00:00:00.000Z');
    const d = desired({ maxValuePerTxEth: '1.25', cooldownSeconds: 30, expiresAt, allowedContracts: [C1.toLowerCase(), C1, C2], allowedTokens: [T1] });
    expect(d).toEqual({
      safe: SAFE,
      maxValuePerTxWei: 1_250_000_000_000_000_000n,
      cooldownSeconds: 30n,
      active: true,
      expiresAt: BigInt(expiresAt.getTime() / 1000),
      allowedContracts: [C1, C2], // de-duplicated case-insensitively
      allowedTokens: [T1],
    });
  });

  it('active on-chain = agent.active AND policy.active', () => {
    expect(desired({}, false).active).toBe(false);
    expect(desired({ active: false }, true).active).toBe(false);
    expect(desired({}, true).active).toBe(true);
  });

  it('refuses what the module cannot hold: "0", > 18 decimals, non-decimals, bad addresses, negative cooldown', () => {
    const problems = (p: Parameters<typeof policy>[0]) => {
      const r = desiredOnChainPolicy({ safeAddress: SAFE, agentActive: true, policy: policy(p) });
      return r.ok ? [] : r.problems;
    };
    expect(problems({ maxValuePerTxEth: '0' }).join()).toMatch(/InvalidPolicy/);
    expect(problems({ maxValuePerTxEth: '0.0' })).toHaveLength(1);
    expect(problems({ maxValuePerTxEth: '1.0000000000000000001' }).join()).toMatch(/at most 18 decimals/);
    expect(problems({ maxValuePerTxEth: '1e3' })).toHaveLength(1);
    expect(problems({ allowedContracts: ['not-an-address'] }).join()).toMatch(/not an address/);
    expect(problems({ allowedTokens: ['0x123'] })).toHaveLength(1);
    expect(problems({ cooldownSeconds: -1 })).toHaveLength(1);
    expect(problems({ cooldownSeconds: 1.5 })).toHaveLength(1);
  });

  it('#179 review P2-1: a plain decimal larger than uint256 is not representable (it used to pass, then encodeFunctionData threw → 500)', () => {
    const maxWei = 2n ** 256n - 1n;
    const tooBig = `${(maxWei / 10n ** 18n + 1n).toString()}`; // whole ETH just above the uint256 range
    const r = desiredOnChainPolicy({ safeAddress: SAFE, agentActive: true, policy: policy({ maxValuePerTxEth: tooBig }) });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problems.join()).toMatch(/uint256/);
    // The largest representable value is accepted and encodes.
    const atMax = `${maxWei / 10n ** 18n}.${(maxWei % 10n ** 18n).toString().padStart(18, '0')}`;
    const ok = desiredOnChainPolicy({ safeAddress: SAFE, agentActive: true, policy: policy({ maxValuePerTxEth: atMax }) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(() => encodeSetPolicy(ok.desired)).not.toThrow();
  });

  it('a stored entry with a broken EIP-55 checksum still names the same 20 bytes', () => {
    // Flip the case of the first letter of a mixed-case checksummed address: same bytes, invalid EIP-55.
    const good = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    const broken = `0x${good.slice(2).replace(/[a-fA-F]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))}`;
    expect(isAddress(broken)).toBe(false); // strict EIP-55 check
    expect(desired({ allowedContracts: [broken] }).allowedContracts).toEqual([good]);
  });

  it('ethDecimalToWei is exact', () => {
    expect(ethDecimalToWei('1')).toBe(10n ** 18n);
    expect(ethDecimalToWei('0.000000000000000001')).toBe(1n);
    expect(ethDecimalToWei('0.0000000000000000001')).toBeNull();
    expect(ethDecimalToWei('')).toBeNull();
  });
});

describe('planPolicySync', () => {
  it('no policy on-chain → setPolicy with the full stored core', () => {
    const plan = planPolicySync(desired(), reading({ hasPolicy: false, core: null, contracts: { count: null, members: new Map() } }));
    expect(plan.calls.map((c) => c.name)).toEqual(['setPolicy']);
    expect(decodeFunctionData({ abi: POLICY_MODULE_ABI, data: plan.calls[0]!.data })).toEqual({
      functionName: 'setPolicy',
      args: [SAFE, { maxValuePerTx: 500_000_000_000_000_000n, cooldownBetweenTx: 0n, active: true }, 0n],
    });
  });

  it('in sync → no call, no difference', () => {
    expect(planPolicySync(desired(), reading())).toEqual({ calls: [], differences: [], unknownExtras: { contracts: 0n, tokens: 0n } });
  });

  it('only the active flag differs → the module’s own emergencyPause / resume, not setPolicy', () => {
    const pause = planPolicySync(desired({ active: false }), reading());
    expect(pause.calls.map((c) => c.name)).toEqual(['emergencyPause']);
    expect(decodeFunctionData({ abi: POLICY_MODULE_ABI, data: pause.calls[0]!.data }).args).toEqual([SAFE]);
    const resume = planPolicySync(desired(), reading({ core: { maxValuePerTxWei: 500_000_000_000_000_000n, cooldownSeconds: 0n, active: false, expiresAt: 0n } }));
    expect(resume.calls.map((c) => c.name)).toEqual(['resume']);
  });

  it('any other core field differs → setPolicy (which also carries active)', () => {
    const plan = planPolicySync(desired({ cooldownSeconds: 60, active: false }), reading());
    expect(plan.calls.map((c) => c.name)).toEqual(['setPolicy']);
    expect(plan.differences.join(' ')).toMatch(/cooldown: DB 60 s, on-chain 0 s/);
  });

  it('whitelists: adds what the DB lists and REMOVES what an earlier sync added and the DB dropped — in one call', () => {
    const r = reading({ contracts: { count: 2n, members: new Map([[C1.toLowerCase(), true], [C2.toLowerCase(), true]]) } });
    const plan = planPolicySync(desired({ allowedContracts: [C1] }), r, { contracts: [C1, C2], tokens: [] });
    expect(plan.calls.map((c) => c.name)).toEqual(['updateContractWhitelist']);
    expect(decodeFunctionData({ abi: POLICY_MODULE_ABI, data: plan.calls[0]!.data }).args).toEqual([SAFE, [C2], [false]]);

    const add = planPolicySync(desired({ allowedTokens: [T1] }), reading({ tokens: { count: 0n, members: new Map([[T1.toLowerCase(), false]]) } }));
    expect(add.calls.map((c) => c.name)).toEqual(['updateTokenWhitelist']);
    expect(decodeFunctionData({ abi: POLICY_MODULE_ABI, data: add.calls[0]!.data }).args).toEqual([SAFE, [T1], [true]]);
  });

  it('entries on-chain the backend cannot name are reported, never guessed', () => {
    const r = reading({ contracts: { count: 3n, members: new Map([[C1.toLowerCase(), true]]) } });
    const plan = planPolicySync(desired({ allowedContracts: [C1] }), r);
    expect(plan.calls).toEqual([]);
    expect(plan.unknownExtras.contracts).toBe(2n);
    expect(plan.differences.join(' ')).toMatch(/2 contract\(s\) whitelisted on-chain that the backend cannot name/);
  });
});

describe('readOnChainPolicy — raw membership, not the module’s "empty list = everything" view', () => {
  it('with a policy: counts from getPolicy, membership per candidate', async () => {
    const calls: string[] = [];
    const read = vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      calls.push(`${functionName}(${(args as string[]).join(',')})`);
      if (functionName === 'hasPolicy') return true;
      if (functionName === 'getPolicy') {
        return { maxValuePerTx: 7n, cooldownBetweenTx: 1n, active: true, policyExpiresAt: 0n, numAllowedContracts: 1n, numAllowedTokens: 0n };
      }
      if (functionName === 'isContractAllowed') return (args[1] as string).toLowerCase() === C1.toLowerCase();
      throw new Error(`unexpected ${functionName}`);
    });
    const r = await readOnChainPolicy(read as never, MODULE, SAFE, { contracts: [C1, C2], tokens: [T1] });
    expect(r.core).toEqual({ maxValuePerTxWei: 7n, cooldownSeconds: 1n, active: true, expiresAt: 0n });
    expect([...r.contracts.members]).toEqual([[C1.toLowerCase(), true], [C2.toLowerCase(), false]]);
    // Token count 0: the view would answer true for every address — membership is false without asking.
    expect([...r.tokens.members]).toEqual([[T1.toLowerCase(), false]]);
    expect(calls.some((c) => c.startsWith('isTokenAllowed'))).toBe(false);
  });

  it('without a policy: the zero-address probe tells an empty list from a non-empty one', async () => {
    const read = vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'hasPolicy') return false;
      if (functionName === 'isContractAllowed') return (args[1] as string) === '0x0000000000000000000000000000000000000000' ? false : (args[1] as string) === C1;
      if (functionName === 'isTokenAllowed') return true; // empty list
      throw new Error(`unexpected ${functionName}`);
    });
    const r = await readOnChainPolicy(read as never, MODULE, SAFE, { contracts: [C1], tokens: [T1] });
    expect(r.hasPolicy).toBe(false);
    expect(r.contracts).toEqual({ count: null, members: new Map([[C1.toLowerCase(), true]]) });
    expect(r.tokens.members.get(T1.toLowerCase())).toBe(false);
  });
});

describe('supersededReason — the guard re-derives a queued call from the policy stored now', () => {
  const meta = (call: PolicySyncMetadata['call'], params: PolicySyncMetadata['params']): PolicySyncMetadata => ({ call, module: MODULE, safe: SAFE, params });

  it('setPolicy: identical parameters pass, any change supersedes', () => {
    expect(supersededReason(meta('setPolicy', encodeSetPolicy(desired()).params), desired())).toBeNull();
    expect(supersededReason(meta('setPolicy', encodeSetPolicy(desired()).params), desired({ maxValuePerTxEth: '0.1' }))).toMatch(/changed/);
    expect(supersededReason(meta('setPolicy', encodeSetPolicy(desired()).params), desired({}, false))).toMatch(/changed/);
  });

  it('emergencyPause only while the DB is paused; resume only while it is active', () => {
    expect(supersededReason(meta('emergencyPause', {}), desired({ active: false }))).toBeNull();
    expect(supersededReason(meta('emergencyPause', {}), desired())).toMatch(/active again/);
    expect(supersededReason(meta('resume', {}), desired())).toBeNull();
    expect(supersededReason(meta('resume', {}), desired({ active: false }))).toMatch(/paused now/);
  });

  it('whitelist entries must still agree with the DB list', () => {
    const add = meta('updateContractWhitelist', { addresses: [C1], allowed: [true] });
    expect(supersededReason(add, desired({ allowedContracts: [C1] }))).toBeNull();
    expect(supersededReason(add, desired({ allowedContracts: [] }))).toMatch(/no longer/);
    const remove = meta('updateContractWhitelist', { addresses: [C2], allowed: [false] });
    expect(supersededReason(remove, desired({ allowedContracts: [C1] }))).toBeNull();
    expect(supersededReason(remove, desired({ allowedContracts: [C2] }))).toMatch(/now/);
  });

  it('another wallet supersedes everything', () => {
    expect(supersededReason({ ...meta('resume', {}), safe: C1 }, desired())).toMatch(/queued for wallet/);
  });
});

describe('metadata helpers', () => {
  it('policySyncMetadataOf recognises only well-formed sync metadata', () => {
    expect(policySyncMetadataOf(null)).toBeNull();
    expect(policySyncMetadataOf({ admin: true })).toBeNull();
    expect(policySyncMetadataOf({ policySync: { call: 'resume' } })).toBeNull();
    expect(policySyncMetadataOf({ policySync: { call: 'resume', module: MODULE, safe: SAFE, params: {} } })).toMatchObject({ call: 'resume' });
  });

  it('syncHistory collects every address an earlier whitelist sync sent', () => {
    const rows = [
      { metadata: { policySync: { call: 'updateContractWhitelist', module: MODULE, safe: SAFE, params: { addresses: [C1, C2.toLowerCase()], allowed: [true, false] } } } },
      { metadata: { policySync: { call: 'updateTokenWhitelist', module: MODULE, safe: SAFE, params: { addresses: [T1], allowed: [true] } } } },
      { metadata: { policySync: { call: 'setPolicy', module: MODULE, safe: SAFE, params: {} } } },
      { metadata: null },
    ];
    expect(syncHistory(rows)).toEqual({ contracts: [C1, C2], tokens: [T1] });
  });
});

describe('pre-submit guard — policy-sync rows (S8)', () => {
  type AgentState = { safeAddress: string; active: boolean; policy: ReturnType<typeof policy> | null };
  let agent: AgentState;

  function db(metadata: Record<string, unknown>) {
    const findUnique = vi.fn(async ({ select }: { select: Record<string, unknown> }) => {
      if ('status' in select) {
        return {
          status: 'QUEUED',
          txHash: null,
          chainId: 84532,
          metadata,
          agent: { active: agent.active, policy: agent.policy ? { active: agent.policy.active, expiresAt: agent.policy.expiresAt } : null },
        };
      }
      return { agent };
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    return { client: { transaction: { findUnique, updateMany } } as unknown as PrismaClient, updateMany };
  }

  const syncMeta = (call: PolicySyncMetadata['call'], params: PolicySyncMetadata['params'], module: Address = MODULE) => ({
    kind: 'policy-sync',
    policySync: { call, module, safe: SAFE, params },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    settleVolumeMock.mockResolvedValue('none');
    contractsGate.mockImplementation((chainId: number) => ({ allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }));
    agent = { safeAddress: SAFE, active: true, policy: policy() };
  });

  it('an emergencyPause is signed WHILE the agent is paused (an ordinary tx would be FAILED)', async () => {
    agent = { safeAddress: SAFE, active: false, policy: policy({ active: false }) };
    const { client, updateMany } = db(syncMeta('emergencyPause', {}));
    await expect(preSubmitGuard(client, 'tx-1')).resolves.toEqual({ action: 'proceed' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('a queued resume is FAILED as superseded once the operator paused the agent again', async () => {
    agent = { safeAddress: SAFE, active: false, policy: policy({ active: false }) };
    const { client, updateMany } = db(syncMeta('resume', {}));
    const decision = await preSubmitGuard(client, 'tx-1');
    expect(decision).toMatchObject({ action: 'fail' });
    expect((decision as { reason: string }).reason).toMatch(new RegExp(`^${POLICY_SYNC_SUPERSEDED}`));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'QUEUED', broadcastAttemptedAt: null }) }));
  });

  it('a queued setPolicy is FAILED as superseded when the stored limits changed', async () => {
    const queued = encodeSetPolicy(desired()).params;
    agent.policy = policy({ maxValuePerTxEth: '0.1' });
    const decision = await preSubmitGuard(db(syncMeta('setPolicy', queued)).client, 'tx-1');
    expect((decision as { reason: string }).reason).toMatch(/changed after this setPolicy was queued/);
  });

  it('a call queued for another module than the one configured now is never signed', async () => {
    const decision = await preSubmitGuard(db(syncMeta('resume', {}, C1)).client, 'tx-1');
    expect((decision as { reason: string }).reason).toMatch(/the configured module is now/);
  });

  it('a consistent setPolicy proceeds; an expired DB policy does not block it either', async () => {
    agent.policy = policy({ expiresAt: new Date(Date.now() - 60_000) });
    const queued = encodeSetPolicy(desired({ expiresAt: agent.policy.expiresAt })).params;
    await expect(preSubmitGuard(db(syncMeta('setPolicy', queued)).client, 'tx-1')).resolves.toEqual({ action: 'proceed' });
  });

  it('S9: a consistent sync call WAITS (defer, nothing written) while the executor / module is not verified', async () => {
    contractsGate.mockReturnValue({ allowed: false, chainId: 84532, block: 'unverified', reason: 'rpc down', retryAfterSeconds: 120 });
    const { client, updateMany } = db(syncMeta('setPolicy', encodeSetPolicy(desired()).params));
    await expect(preSubmitGuard(client, 'tx-1')).resolves.toEqual({ action: 'defer', reason: 'rpc down', delayMs: 120_000 });
    expect(contractsGate).toHaveBeenCalledWith(84532);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('S9: a superseded sync call is still FAILED (the DB decides first; the gate only delays what would be signed)', async () => {
    contractsGate.mockReturnValue({ allowed: false, chainId: 84532, block: 'unverified', reason: 'rpc down', retryAfterSeconds: 120 });
    agent = { safeAddress: SAFE, active: false, policy: policy({ active: false }) };
    const decision = await preSubmitGuard(db(syncMeta('resume', {})).client, 'tx-1');
    expect(decision).toMatchObject({ action: 'fail' });
  });

  it('S9: an ordinary executor-routed row (queuePayload.routedViaExecutor) waits too; a direct one does not ask', async () => {
    contractsGate.mockReturnValue({ allowed: false, chainId: 84532, block: 'mismatch', reason: 'not this build', retryAfterSeconds: 120 });
    const routed = db({ queuePayload: { routedViaExecutor: true } });
    await expect(preSubmitGuard(routed.client, 'tx-1')).resolves.toEqual({ action: 'defer', reason: 'not this build', delayMs: 120_000 });
    contractsGate.mockClear();
    const direct = db({ queuePayload: { routedViaExecutor: false } });
    await expect(preSubmitGuard(direct.client, 'tx-1')).resolves.toEqual({ action: 'proceed' });
    expect(contractsGate).not.toHaveBeenCalled();
  });
});
