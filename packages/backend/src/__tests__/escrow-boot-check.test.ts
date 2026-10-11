/**
 * Unit tests — boot check of the deployed ERC-8183 escrow + ReputationHook
 * (task C3d, `config/escrow-boot-check.ts`) and the API ↔ worker capability
 * drift (`config/process-capabilities.ts`). Pure functions plus the reader
 * loop with a fake `readContract`; no RPC, no Redis.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, HttpRequestError, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  checkEscrowDeployments,
  compareEscrowDeployment,
  escrowBootVerdict,
  isDefinitiveContractError,
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
    const map: Record<string, Address | undefined> = {
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

  it('escrow without a hook: escrow.token() is still verified (a wrong token is FATAL), the hook views are not read', async () => {
    const noHook = { ...expected, hook: null };
    const reads: string[] = [];
    const reader = (token: Address): ContractReader => async ({ address, functionName }) => {
      reads.push(`${address}.${functionName}`);
      return token;
    };
    const ok = await checkEscrowDeployments({ chains: [noHook], reader: () => reader(USDC) });
    expect(reads).toEqual([`${ESCROW}.token`]);
    expect(ok[0]).toMatchObject({ hook: null, problems: [], unreadable: null });
    expect(ok[0]!.notes).toEqual([expect.stringMatching(/no REPUTATION_HOOK_ADDRESS_84532 — only escrow\.token\(\) checked/)]);
    expect(escrowBootVerdict('production', ok)).toMatchObject({ fatal: null, verified: [84532] });

    const wrong = await checkEscrowDeployments({ chains: [noHook], reader: () => reader(OTHER) });
    expect(escrowBootVerdict('production', wrong).fatal).toMatch(/token\(\) is .*not the chain's USDC/);
  });

  it('the reputation registry defaults to the official Base / Base Sepolia deployments, overridable per chain', () => {
    expect(resolveReputationRegistry(84532, {})).toBe(DEFAULT_REPUTATION_REGISTRIES[84532]);
    expect(resolveReputationRegistry(84532, {})).toBe(REPUTATION);
    expect(resolveReputationRegistry(8453, {})).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(resolveReputationRegistry(84532, { REPUTATION_REGISTRY_ADDRESS_84532: OTHER })).toBe(OTHER);
    expect(resolveReputationRegistry(1, {})).toBeUndefined();
  });
});

/**
 * A REAL viem public client (custom transport, no network): `eth_call` to the
 * escrow returns the ABI-encoded `escrowToken`; to any other address it runs
 * `hookCall`. So the errors below are the ones `readContract` really throws.
 */
/** viem validates checksums: the escrow fixture above is not checksummed, so the viem tests use it lower-cased. */
const V_ESCROW = ESCROW.toLowerCase() as Address;
const vExpected: EscrowChainExpectation = { ...expected, escrow: V_ESCROW };

function viemReader(hookCall: () => Promise<unknown>, escrowCall?: () => Promise<unknown>): ContractReader {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_chainId') return '0x14a34';
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
        const to = String((params as Array<{ to?: string }>)[0]?.to ?? '').toLowerCase();
        if (to === V_ESCROW) return escrowCall ? escrowCall() : encodeAbiParameters([{ type: 'address' }], [USDC]);
        return hookCall();
      },
    }),
  });
  return (params) => client.readContract(params as never) as Promise<unknown>;
}

const reverted = async (): Promise<never> => {
  throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
};
const ALCHEMY_KEY = 'AbCdEf0123456789ghIJklMNop';
const rpcDown = async (): Promise<never> => {
  throw new HttpRequestError({ url: `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`, status: 503 });
};

describe('boot check: no contract / revert / zero data is a mismatch; only transport errors and timeouts are "unreadable" (C3d review P2-1)', () => {
  const NO_HOOK = /chain 84532: no ReputationHook at REPUTATION_HOOK_ADDRESS_84532=0x000000000000000000000000000000000000400C \(acp\(\) .*no code, wrong address or wrong chain/;

  const definitive: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['eth_call returns 0x (no code at the hook address)', async () => '0x', /returned no data/],
    ['the hook views revert (another contract at that address)', reverted, /reverted/],
    ['the call returns 2 bytes (undecodable)', async () => '0x1234', /too small/],
  ];
  it.each(definitive)('real viem client — %s: FATAL in production / staging, loud error in development / test', async (_case, hookCall, why) => {
    const checks = await checkEscrowDeployments({ chains: [vExpected], reader: () => viemReader(hookCall), attempts: 2 });
    expect(checks[0]).toMatchObject({ unreadable: null });
    expect(checks[0]!.problems).toEqual([expect.stringMatching(NO_HOOK)]);
    expect(checks[0]!.problems[0]).toMatch(why);
    for (const env of ['production', 'staging']) {
      expect(escrowBootVerdict(env, checks)).toMatchObject({ fatal: expect.stringMatching(NO_HOOK), unreadable: [], verified: [] });
    }
    for (const env of ['development', 'test']) {
      const verdict = escrowBootVerdict(env, checks);
      expect(verdict).toMatchObject({ fatal: null, unreadable: [], verified: [] });
      expect(verdict.errors).toEqual([expect.stringMatching(/would be FATAL in production\/staging\): chain 84532: no ReputationHook at/)]);
    }
  });

  it('a reader that RESOLVES "0x" (not an address) is a mismatch, not unreadable', async () => {
    const zeroHook: ContractReader = async ({ functionName }) => (functionName === 'token' ? USDC : '0x');
    const checks = await checkEscrowDeployments({ chains: [expected], reader: () => zeroHook });
    expect(checks[0]).toMatchObject({ unreadable: null, problems: [expect.stringMatching(/no ReputationHook at .*acp\(\) returned "0x"/)] });
    expect(escrowBootVerdict('production', checks).fatal).toMatch(/^FATAL: .*no ReputationHook at/);
  });

  it('no code at the escrow address: "no AgentJobEscrow at …" (also on a chain without a hook)', async () => {
    for (const chain of [vExpected, { ...vExpected, hook: null }]) {
      const checks = await checkEscrowDeployments({ chains: [chain], reader: () => viemReader(async () => encodeAbiParameters([{ type: 'address' }], [V_ESCROW]), async () => '0x') });
      expect(checks[0]!.problems).toEqual(expect.arrayContaining([expect.stringMatching(/no AgentJobEscrow at AGENT_JOB_ESCROW_ADDRESS_84532=0x00000000000000000000000000000000000e5c20 \(token\(\) .*returned no data/)]));
      expect(escrowBootVerdict('staging', checks).fatal).toMatch(/no AgentJobEscrow at/);
    }
  });

  it('a transport error (HTTP 503 through viem) stays unreadable — never fatal — and the RPC key is not in the message', async () => {
    const checks = await checkEscrowDeployments({ chains: [vExpected], reader: () => viemReader(rpcDown, rpcDown), attempts: 2 });
    expect(checks[0]).toMatchObject({ problems: [], unreadable: 'HTTP request failed.' });
    const verdict = escrowBootVerdict('production', checks);
    expect(verdict).toMatchObject({ fatal: null, unreadable: [84532], verified: [] });
    expect(JSON.stringify(verdict)).not.toContain(ALCHEMY_KEY);
  });

  it('a definitive answer from the hook wins over a transport error on the escrow read', async () => {
    const checks = await checkEscrowDeployments({ chains: [vExpected], reader: () => viemReader(async () => '0x', rpcDown) });
    expect(checks[0]).toMatchObject({ unreadable: null, problems: [expect.stringMatching(NO_HOOK)] });
  });

  it('isDefinitiveContractError: names and messages through the cause chain', () => {
    expect(isDefinitiveContractError({ name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionZeroDataError' } })).toBe(true);
    expect(isDefinitiveContractError({ name: 'X', cause: { name: 'Y', cause: { name: 'ExecutionRevertedError' } } })).toBe(true);
    expect(isDefinitiveContractError(new Error('execution reverted: OnlyACP'))).toBe(true);
    expect(isDefinitiveContractError({ name: 'ContractFunctionExecutionError', cause: { name: 'HttpRequestError', shortMessage: 'HTTP request failed.' } })).toBe(false);
    expect(isDefinitiveContractError(new Error('timed out after 10000 ms'))).toBe(false);
    expect(isDefinitiveContractError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
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
