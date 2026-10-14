/**
 * Unit tests — S9 AgentExecutor / AgentPolicyModule verification
 * (`config/policy-stack-check.ts`) with fake readers. The same checks run
 * against real deployments on Anvil in `contract-identity.*.anvil.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { EXPECTED_CONTRACT_CODE } from '../abi/contract-code.generated.js';
import { checkPolicyStacks, policyStackBootVerdict, type PolicyStackExpectation } from '../config/policy-stack-check.js';

const EXECUTOR = '0x00000000000000000000000000000000000E0E0E' as Address;
const MODULE = '0x00000000000000000000000000000000000A0D01' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const OPERATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const FEE_WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

const expected: PolicyStackExpectation = { chainId: 84532, executor: EXECUTOR, policyModule: MODULE, operator: OPERATOR, feeWallet: FEE_WALLET, feeBps: 30n };

interface Chain {
  chainId: number;
  code: Record<string, Hex | undefined>;
  views: Record<string, unknown>;
  down?: boolean;
}

function chain(overrides: Partial<Chain> = {}): Chain {
  return {
    chainId: 84532,
    code: {
      [EXECUTOR.toLowerCase()]: EXPECTED_CONTRACT_CODE.AgentExecutor.runtime,
      [MODULE.toLowerCase()]: EXPECTED_CONTRACT_CODE.AgentPolicyModule.runtime,
      ...(overrides.code ?? {}),
    },
    views: {
      [`${EXECUTOR.toLowerCase()}.policyModule`]: MODULE.toLowerCase(),
      [`${EXECUTOR.toLowerCase()}.feeWallet`]: FEE_WALLET,
      [`${EXECUTOR.toLowerCase()}.feeBps`]: 30n,
      [`${MODULE.toLowerCase()}.operator`]: OPERATOR,
      ...(overrides.views ?? {}),
    },
    ...(overrides.down ? { down: true } : {}),
    ...(overrides.chainId ? { chainId: overrides.chainId } : {}),
  };
}

const transport = () => Object.assign(new Error('HTTP request failed.\nURL: https://rpc.example/secret'), { name: 'HttpRequestError' });

async function check(c: Chain, exp: PolicyStackExpectation = expected) {
  const [result] = await checkPolicyStacks({
    chains: [exp],
    reader: () => async ({ address, functionName }) => {
      if (c.down) throw transport();
      const key = `${address.toLowerCase()}.${functionName}`;
      if (!(key in c.views)) {
        throw Object.assign(new Error('The contract function returned no data ("0x").'), { name: 'ContractFunctionZeroDataError' });
      }
      return c.views[key];
    },
    codeReader: () => async (address) => {
      if (c.down) throw transport();
      return c.code[address.toLowerCase()];
    },
    chainIdReader: () => async () => {
      if (c.down) throw transport();
      return c.chainId;
    },
    attempts: 1,
  });
  return result!;
}

describe('checkPolicyStacks', () => {
  it('our executor + our module, bound to each other, with the configured fee wallet, fee and operator: verified', async () => {
    expect(await check(chain())).toMatchObject({ problems: [], notes: [], unreadable: null });
  });

  it.each([
    ['an EOA', undefined, /EXECUTOR_ADDRESS_84532=.* is not this build's AgentExecutor: no code/],
    ['a foreign contract', '0x00' as Hex, /is not this build's AgentExecutor: its runtime code is 1 bytes/],
    ['a lookalike / legacy build', EXPECTED_CONTRACT_CODE.AgentPolicyModule.runtime, /is not this build's AgentExecutor/],
  ])('executor = %s → mismatch, nothing else trusted', async (_label, code, message) => {
    const result = await check(chain({ code: { [EXECUTOR.toLowerCase()]: code } }));
    expect(result.unreadable).toBeNull();
    expect(result.problems).toEqual([expect.stringMatching(message)]);
  });

  it('executor bound to another module than POLICY_MODULE_ADDRESS → mismatch (the synced policy would never be enforced)', async () => {
    const result = await check(chain({ views: { [`${EXECUTOR.toLowerCase()}.policyModule`]: OTHER } }));
    expect(result.problems).toEqual([expect.stringMatching(/the executor enforces AgentPolicyModule 0x1111.*not POLICY_MODULE_ADDRESS_84532/)]);
  });

  it('fee wallet and fee bps are bindings too', async () => {
    const result = await check(chain({ views: { [`${EXECUTOR.toLowerCase()}.feeWallet`]: OTHER, [`${EXECUTOR.toLowerCase()}.feeBps`]: 15n } }));
    expect(result.problems).toEqual([expect.stringMatching(/feeWallet\(\) is 0x1111.*OPERATOR_FEE_WALLET/), expect.stringMatching(/feeBps\(\) is 15, the backend adds 30/)]);
  });

  it('module not ours (lookalike answering operator()) → mismatch', async () => {
    const result = await check(chain({ code: { [MODULE.toLowerCase()]: '0x6080' as Hex } }));
    expect(result.problems).toEqual([expect.stringMatching(/POLICY_MODULE_ADDRESS_84532=.* is not this build's AgentPolicyModule/)]);
  });

  it('module operator() ≠ POLICY_OPERATOR_ADDRESS → mismatch; no expected operator → a note, not compared', async () => {
    expect((await check(chain({ views: { [`${MODULE.toLowerCase()}.operator`]: OTHER } }))).problems).toEqual([
      expect.stringMatching(/operator\(\) is 0x1111.*not POLICY_OPERATOR_ADDRESS_84532/),
    ]);
    const noOperator = await check(chain(), { ...expected, operator: null });
    expect(noOperator.problems).toEqual([]);
    expect(noOperator.notes).toEqual([expect.stringMatching(/no POLICY_OPERATOR_ADDRESS_84532/)]);
  });

  it('module only (no executor): its code and operator are verified', async () => {
    expect(await check(chain(), { ...expected, executor: null })).toMatchObject({ problems: [], unreadable: null });
    const wrong = await check(chain({ code: { [MODULE.toLowerCase()]: undefined } }), { ...expected, executor: null });
    expect(wrong.problems).toEqual([expect.stringMatching(/no code/)]);
  });

  it('executor only (no POLICY_MODULE_ADDRESS): the executor’s module is verified, with a note that the sync is unavailable', async () => {
    const result = await check(chain(), { ...expected, policyModule: null });
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toMatch(/no POLICY_MODULE_ADDRESS_84532 — the executor's module 0x[0-9a-fA-F]+ is verified/);
    const badModule = await check(chain({ code: { [MODULE.toLowerCase()]: undefined } }), { ...expected, policyModule: null });
    expect(badModule.problems).toEqual([expect.stringMatching(/executor.policyModule\(\)=.* is not this build's AgentPolicyModule/)]);
  });

  it('an RPC serving another chain → mismatch, before any code is read', async () => {
    expect((await check(chain({ chainId: 8453 }))).problems).toEqual([expect.stringMatching(/eth_chainId 8453, not 84532/)]);
  });

  it('RPC down → unreadable (never a mismatch, never verified), message sanitized', async () => {
    const result = await check(chain({ down: true }));
    expect(result).toMatchObject({ problems: [], unreadable: expect.stringContaining('HTTP request failed') });
    expect(result.unreadable).not.toContain('secret');
  });
});

describe('policyStackBootVerdict', () => {
  it('FATAL in production / staging on a mismatch, loud error elsewhere; unreadable is never fatal', async () => {
    const mismatch = await check(chain({ code: { [EXECUTOR.toLowerCase()]: undefined } }));
    const down = await check(chain({ down: true }));
    for (const env of ['production', 'staging']) {
      expect(policyStackBootVerdict(env, [mismatch]).fatal).toMatch(/^FATAL: the deployed AgentExecutor \/ AgentPolicyModule does not match/);
      expect(policyStackBootVerdict(env, [down]).fatal).toBeNull();
    }
    const dev = policyStackBootVerdict('development', [mismatch, down]);
    expect(dev.fatal).toBeNull();
    expect(dev.errors).toEqual([expect.stringMatching(/would be FATAL in production\/staging/), expect.stringMatching(/could not be verified/)]);
    expect(policyStackBootVerdict('production', [await check(chain())]).verified).toEqual([84532]);
  });
});
