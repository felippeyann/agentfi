/**
 * Unit tests — boot check of the deployed ERC-8183 escrow + ReputationHook
 * (task C3d, `config/escrow-boot-check.ts`) and the API ↔ worker capability
 * drift (`config/process-capabilities.ts`). Pure functions plus the reader
 * loop with a fake `readContract`; no RPC, no Redis.
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  checkEscrowDeployments,
  compareEscrowDeployment,
  escrowBootVerdict,
  type ContractReader,
  type EscrowChainExpectation,
  type EscrowChainReading,
} from '../config/escrow-boot-check.js';
import { capabilityDrift, describeCapabilities, type ProcessCapabilities } from '../config/process-capabilities.js';
import { DEFAULT_REPUTATION_REGISTRIES, resolveReputationRegistry } from '../config/contracts.js';

const ESCROW = '0x00000000000000000000000000000000000E5C20' as Address;
const HOOK = '0x000000000000000000000000000000000000400C' as Address;
const EVALUATOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address;
const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address;
const REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;

const expected: EscrowChainExpectation = {
  chainId: 84532,
  escrow: ESCROW,
  hook: HOOK,
  evaluator: EVALUATOR,
  identityRegistry: IDENTITY,
  reputationRegistry: REPUTATION,
  usdc: USDC,
};

const matching: EscrowChainReading = {
  token: USDC,
  acp: ESCROW,
  trustedEvaluator: EVALUATOR,
  identityRegistry: IDENTITY,
  reputationRegistry: REPUTATION,
};

/** A reader answering from `reading` (lower-cased addresses, like a node may). */
function readerFor(reading: EscrowChainReading, opts: { fail?: number; hang?: boolean } = {}): ContractReader {
  let failures = opts.fail ?? 0;
  return async ({ functionName }) => {
    if (opts.hang) return new Promise(() => undefined);
    if (failures > 0) {
      failures--;
      throw new Error('HTTP request failed.\nURL: https://rpc.example/key');
    }
    const map: Record<string, Address> = {
      token: reading.token,
      acp: reading.acp,
      trustedEvaluator: reading.trustedEvaluator,
      identityRegistry: reading.identityRegistry,
      reputationRegistry: reading.reputationRegistry,
    };
    return map[functionName]!.toLowerCase();
  };
}

describe('compareEscrowDeployment', () => {
  it('passes when the hook was deployed for this escrow, evaluator and registries, and the escrow token is the chain USDC', () => {
    expect(compareEscrowDeployment(expected, matching)).toEqual({ problems: [], notes: [] });
  });

  it('names every mismatch (acp, trustedEvaluator, identityRegistry, reputationRegistry, token) with its consequence', () => {
    const { problems } = compareEscrowDeployment(expected, {
      token: OTHER,
      acp: OTHER,
      trustedEvaluator: OTHER,
      identityRegistry: OTHER,
      reputationRegistry: OTHER,
    });
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/acp\(\) is .* not AGENT_JOB_ESCROW_ADDRESS_84532.*OnlyACP/);
    expect(problems[1]).toMatch(/trustedEvaluator\(\).*ESCROW_EVALUATOR_PRIVATE_KEY.*untrusted-evaluator/);
    expect(problems[2]).toMatch(/identityRegistry\(\).*IDENTITY_REGISTRY_ADDRESS_84532/);
    expect(problems[3]).toMatch(/reputationRegistry\(\).*REPUTATION_REGISTRY_ADDRESS_84532/);
    expect(problems[4]).toMatch(/token\(\).*USDC/);
  });

  it('notes (does not fail) what it cannot compare: no evaluator key, no registry, no USDC entry', () => {
    const { problems, notes } = compareEscrowDeployment(
      { ...expected, evaluator: null, identityRegistry: null, reputationRegistry: null, usdc: null },
      { ...matching, trustedEvaluator: OTHER },
    );
    expect(problems).toEqual([]);
    expect(notes).toHaveLength(4);
  });
});

describe('checkEscrowDeployments + escrowBootVerdict', () => {
  it('a matching deployment is verified in every environment', async () => {
    const checks = await checkEscrowDeployments({ chains: [expected], reader: () => readerFor(matching) });
    for (const env of ['production', 'staging', 'development', 'test']) {
      expect(escrowBootVerdict(env, checks)).toMatchObject({ fatal: null, errors: [], verified: [84532], unreadable: [] });
    }
  });

  it.each([
    ['acp', { acp: OTHER }, /acp\(\) is .* not AGENT_JOB_ESCROW_ADDRESS_84532/],
    ['trustedEvaluator', { trustedEvaluator: OTHER }, /trustedEvaluator\(\) is .*ESCROW_EVALUATOR_PRIVATE_KEY/],
    ['identityRegistry', { identityRegistry: OTHER }, /identityRegistry\(\) is .*IDENTITY_REGISTRY_ADDRESS_84532/],
    ['reputationRegistry', { reputationRegistry: OTHER }, /reputationRegistry\(\) is .*REPUTATION_REGISTRY_ADDRESS_84532/],
    ['escrow.token', { token: OTHER }, /token\(\) is .*not the chain's USDC/],
  ] as const)('%s mismatch alone: exactly one problem — FATAL in production and staging, error (boot continues) in development and test', async (_field, override, pattern) => {
    const checks = await checkEscrowDeployments({ chains: [expected], reader: () => readerFor({ ...matching, ...override }) });
    expect(checks[0]!.problems).toEqual([expect.stringMatching(pattern)]);
    for (const env of ['production', 'staging']) {
      expect(escrowBootVerdict(env, checks).fatal).toMatch(pattern);
    }
    for (const env of ['development', 'test']) {
      const verdict = escrowBootVerdict(env, checks);
      expect(verdict.fatal).toBeNull();
      expect(verdict.errors).toEqual([expect.stringMatching(pattern)]);
      expect(verdict.verified).toEqual([]);
    }
  });

  it('a mismatch is FATAL in production and staging, a loud error in development / test', async () => {
    const checks = await checkEscrowDeployments({ chains: [expected], reader: () => readerFor({ ...matching, trustedEvaluator: OTHER }) });
    for (const env of ['production', 'staging']) {
      const verdict = escrowBootVerdict(env, checks);
      expect(verdict.fatal).toMatch(new RegExp(`^FATAL: .*NODE_ENV=${env}.*trustedEvaluator`));
      expect(verdict.verified).toEqual([]);
    }
    for (const env of ['development', 'test']) {
      const verdict = escrowBootVerdict(env, checks);
      expect(verdict.fatal).toBeNull();
      expect(verdict.errors).toEqual([expect.stringMatching(/would be FATAL in production\/staging.*trustedEvaluator/)]);
    }
  });

  it('retries a failing read, then reports the chain unreadable (an error everywhere, never "ok", never fatal)', async () => {
    const flaky = readerFor(matching, { fail: 1 }); // one failed call, then healthy
    const recovered = await checkEscrowDeployments({ chains: [expected], reader: () => flaky });
    expect(recovered[0]).toMatchObject({ unreadable: null, problems: [] });

    const down = await checkEscrowDeployments({ chains: [expected], reader: () => readerFor(matching, { fail: 99 }), attempts: 2 });
    expect(down[0]).toMatchObject({ unreadable: 'HTTP request failed.', problems: [] });
    const verdict = escrowBootVerdict('production', down);
    expect(verdict).toMatchObject({ fatal: null, verified: [], unreadable: [84532] });
    expect(verdict.errors).toEqual([expect.stringMatching(/could not be verified .*re-checked in the background/)]);
  });

  it('a hanging RPC times out instead of blocking the boot', async () => {
    const checks = await checkEscrowDeployments({ chains: [expected], reader: () => readerFor(matching, { hang: true }), timeoutMs: 20, attempts: 1 });
    expect(checks[0]!.unreadable).toMatch(/timed out/);
  });

  it('checks every chain independently', async () => {
    const base = { ...expected, chainId: 8453, escrow: OTHER };
    const checks = await checkEscrowDeployments({
      chains: [expected, base],
      reader: (chainId) => readerFor(chainId === 84532 ? matching : { ...matching, acp: ESCROW }),
    });
    const verdict = escrowBootVerdict('production', checks);
    expect(verdict.verified).toEqual([84532]);
    expect(verdict.fatal).toMatch(/chain 8453: ReputationHook .*acp\(\)/);
  });

  it('the reputation registry defaults to the official Base / Base Sepolia deployments, overridable per chain', () => {
    expect(resolveReputationRegistry(84532, {})).toBe(DEFAULT_REPUTATION_REGISTRIES[84532]);
    expect(resolveReputationRegistry(84532, {})).toBe(REPUTATION);
    expect(resolveReputationRegistry(8453, {})).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(resolveReputationRegistry(84532, { REPUTATION_REGISTRY_ADDRESS_84532: OTHER })).toBe(OTHER);
    expect(resolveReputationRegistry(1, {})).toBeUndefined();
  });
});

describe('process capabilities and API ↔ worker drift', () => {
  const api = (overrides: Partial<ProcessCapabilities> = {}): ProcessCapabilities => ({
    role: 'api',
    nodeEnv: 'production',
    transactionWorker: false,
    paymentRecovery: false,
    settlementWorker: false,
    escrowChains: [{ chainId: 84532, escrow: ESCROW, hook: HOOK }],
    evaluator: EVALUATOR,
    bootedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  });
  const worker = (overrides: Partial<ProcessCapabilities> = {}): ProcessCapabilities => ({
    ...api(),
    role: 'worker',
    transactionWorker: true,
    paymentRecovery: true,
    settlementWorker: true,
    ...overrides,
  });

  it('the documented topology (API without workers, worker with everything, same escrow config) has no drift', () => {
    expect(capabilityDrift(api(), worker())).toEqual([]);
    expect(capabilityDrift(worker(), api())).toEqual([]);
  });

  it('a worker without the escrow address while the API has it: nothing would settle the jobs the API creates', () => {
    const drift = capabilityDrift(api(), worker({ escrowChains: [], settlementWorker: false, evaluator: null }));
    expect(drift).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/chain 84532: the api has AGENT_JOB_ESCROW_ADDRESS_84532=.*the worker has none/),
        expect.stringMatching(/evaluator differs/),
        expect.stringMatching(/neither process runs the settlement worker/),
      ]),
    );
  });

  it('different escrow / hook addresses on the same chain are drift; same addresses in another case are not', () => {
    expect(capabilityDrift(api(), worker({ escrowChains: [{ chainId: 84532, escrow: ESCROW.toLowerCase(), hook: HOOK.toLowerCase() }] }))).toEqual([]);
    expect(capabilityDrift(api(), worker({ escrowChains: [{ chainId: 84532, escrow: ESCROW, hook: OTHER }] }))).toEqual([
      expect.stringMatching(/chain 84532: escrow\/hook differ/),
    ]);
  });

  it('no payment recovery anywhere is drift too', () => {
    expect(capabilityDrift(api(), worker({ paymentRecovery: false }))).toEqual([expect.stringMatching(/payment recovery/)]);
  });

  it('describes what a process enables in one line', () => {
    expect(describeCapabilities(worker())).toMatch(/^worker process: transaction worker ON, payment recovery ON, settlement worker ON; ERC-8183 escrow on 84532/);
    expect(describeCapabilities(api({ escrowChains: [], evaluator: null }))).toMatch(/ERC-8183 escrow: none configured$/);
    expect(describeCapabilities(api({ evaluator: null }))).toMatch(/evaluator MISSING/);
  });
});
