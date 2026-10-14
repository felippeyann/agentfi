/**
 * S9 — a wrong `POLICY_MODULE_ADDRESS_<id>`, and a lookalike escrow / hook,
 * on REAL local contracts.
 *
 * 1. Policy module ≠ the executor's module. `AgentExecutor` enforces the
 *    module it was DEPLOYED with (`policyModule()` immutable); the backend
 *    syncs (S8) and reads the module in its env. When they differ — a second
 *    genuine deployment (an earlier Deploy.s.sol run), a typo — the operator
 *    sync "succeeds" and reads back in sync while the executor enforces
 *    nothing: the on-chain policy is silently void. Nothing binds the two.
 * 2. Policy module = an address with no code: the sync's direct call is
 *    mined as a success (gas spent, nothing written); only the read-back
 *    notices (S8 reports `mismatch`).
 * 3. Escrow / hook: the Q7 / C3d boot check compares VIEWS. A lookalike
 *    escrow answering `token()` = USDC, and a lookalike hook answering the
 *    four views, are reported verified — then the lookalike escrow takes the
 *    budget the requester approved, and the lookalike hook blocks every
 *    settlement.
 *
 * Demonstrations of the CURRENT behaviour (pass on the unfixed code).
 * Anvil: `anvilTestPort(3)` (default 8748), chain id 84532.
 */
import { vi } from 'vitest';

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

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseEther, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  anvilAccount,
  anvilTestPort,
  deployPolicyStack,
  readArtifact,
  startLocalChain,
  type LocalChain,
} from './helpers/anvil-contracts.js';
import { runsArtifact } from './helpers/contract-identity.js';
import {
  desiredOnChainPolicy,
  planPolicySync,
  readOnChainPolicy,
  type PolicyModuleReader,
} from '../services/policy/policy-sync.js';
import { checkEscrowDeployments, compareEscrowDeployment, isDefinitiveContractError } from '../config/escrow-boot-check.js';

const CHAIN_ID = 84532;
const MODULE_ARTIFACT = readArtifact('AgentPolicyModule');
const EXECUTOR_ARTIFACT = readArtifact('AgentExecutor');

const deployer = anvilAccount(0);
const operator = anvilAccount(1);
const agent = anvilAccount(2);
const thief = anvilAccount(3).address;
const TARGET = getAddress('0x00000000000000000000000000000000000d0001');
const NO_CODE = getAddress('0x00000000000000000000000000000000000d0e0b');

let chain: LocalChain;
/** The module our executor was deployed with. */
let boundModule: Address;
let executor: Address;
/** A second, genuine AgentPolicyModule the env points at by mistake. */
let otherModule: Address;

beforeAll(async () => {
  chain = await startLocalChain({ port: anvilTestPort(3), chainId: CHAIN_ID });
  ({ policyModule: boundModule, executor } = await deployPolicyStack(chain, { deployer, operator: operator.address, feeWallet: deployer.address }));
  otherModule = await chain.deploy(deployer, MODULE_ARTIFACT, [operator.address]);
});

afterAll(() => {
  chain?.stop();
});

const reader: () => PolicyModuleReader = () => (params) => chain.publicClient.readContract(params as never);

async function send(account: PrivateKeyAccount, to: Address, data: Hex, value = 0n): Promise<'success' | 'reverted'> {
  const hash = await chain.wallet(account).sendTransaction({ to, data, value, gas: 1_000_000n, account, chain: null });
  return (await chain.publicClient.waitForTransactionReceipt({ hash })).status;
}

/** What the S8 operator sync sends for a policy capping native value at `maxEth`, sent the way the worker does (agent wallet → module). */
async function syncPolicyTo(module: Address, maxEth: string) {
  const derived = desiredOnChainPolicy({
    safeAddress: agent.address,
    agentActive: true,
    policy: { maxValuePerTxEth: maxEth, cooldownSeconds: 0, active: true, expiresAt: null, allowedContracts: [], allowedTokens: [] },
  });
  if (!derived.ok) throw new Error(derived.problems.join());
  const before = await readOnChainPolicy(reader(), module, agent.address, { contracts: [], tokens: [] });
  const plan = planPolicySync(derived.desired, before);
  for (const call of plan.calls) expect(await send(agent, module, call.data)).toBe('success');
  return derived.desired;
}

describe('S9 — POLICY_MODULE_ADDRESS is not bound to the executor (current behaviour)', () => {
  it('both addresses run genuine AgentPolicyModule code — identity alone does not catch it', async () => {
    expect(runsArtifact(await chain.publicClient.getCode({ address: boundModule }), MODULE_ARTIFACT)).toBe(true);
    expect(runsArtifact(await chain.publicClient.getCode({ address: otherModule }), MODULE_ARTIFACT)).toBe(true);
    expect(getAddress((await chain.publicClient.readContract({ address: executor, abi: EXECUTOR_ARTIFACT.abi, functionName: 'policyModule' })) as string)).toBe(
      getAddress(boundModule),
    );
  });

  it('a sync to the other module reads back in sync, yet the executor enforces nothing: a 1 ETH action passes a 0.01 ETH policy', async () => {
    const desired = await syncPolicyTo(otherModule, '0.01');
    const after = await readOnChainPolicy(reader(), otherModule, agent.address, { contracts: [], tokens: [] });
    expect(planPolicySync(desired, after).differences).toEqual([]); // the S8 view would say in-sync

    const oneEth = parseEther('1');
    const batch = encodeFunctionData({
      abi: EXECUTOR_ARTIFACT.abi,
      functionName: 'executeBatch',
      args: [[{ target: TARGET, value: oneEth, token: zeroAddress, data: '0x' }]],
    });
    const fee = (oneEth * 30n) / 10_000n;
    expect(await send(agent, executor, batch, oneEth + fee)).toBe('success');
    expect(await chain.publicClient.getBalance({ address: TARGET })).toBe(oneEth);

    // The same policy on the module the executor IS bound to refuses it.
    await syncPolicyTo(boundModule, '0.01');
    await expect(chain.publicClient.call({ account: agent.address, to: executor, data: batch, value: oneEth + fee })).rejects.toThrow();
  });

  it('an address with no code: the sync call is mined as a success with nothing written; only the read-back notices', async () => {
    const derived = desiredOnChainPolicy({
      safeAddress: agent.address,
      agentActive: true,
      policy: { maxValuePerTxEth: '0.01', cooldownSeconds: 0, active: true, expiresAt: null, allowedContracts: [], allowedTokens: [] },
    });
    if (!derived.ok) throw new Error('unexpected');
    const setPolicy = planPolicySync(derived.desired, { hasPolicy: false, core: null, contracts: { count: null, members: new Map() }, tokens: { count: null, members: new Map() } }).calls[0]!;
    expect(await send(agent, NO_CODE, setPolicy.data)).toBe('success');
    let readError: unknown;
    try {
      await readOnChainPolicy(reader(), NO_CODE, agent.address, { contracts: [], tokens: [] });
    } catch (err) {
      readError = err;
    }
    expect(readError).toBeDefined();
    expect(isDefinitiveContractError(readError)).toBe(true); // S8 status: mismatch
  });
});

describe('S9 — lookalike escrow / hook: they answer every view, the code identity refuses them', () => {
  let usdc: Address;
  let lookalikeEscrow: Address;
  let lookalikeHook: Address;
  const evaluator = anvilAccount(4).address;
  const IDENTITY = getAddress('0x8004a818bfb912233c491871b3d84c89a494bd9e');
  const REPUTATION = getAddress('0x8004b663056a597dffe9eccc1965a193b7388713');

  beforeAll(async () => {
    usdc = await chain.deploy(deployer, readArtifact('MockERC20'), []);
    lookalikeEscrow = await chain.deploy(deployer, readArtifact('LookalikeEscrow', 'Impostors.sol'), [usdc, thief]);
    lookalikeHook = await chain.deploy(deployer, readArtifact('LookalikeHook', 'Impostors.sol'), [lookalikeEscrow, evaluator, IDENTITY, REPUTATION]);
  });

  it('checkEscrowDeployments (Q7 / C3d + S9, real code): the views all match, the code does not — mismatch (escrow signatures blocked)', async () => {
    const chains = [{ chainId: CHAIN_ID, escrow: lookalikeEscrow, hook: lookalikeHook, evaluator, identityRegistry: IDENTITY, reputationRegistry: REPUTATION, usdc }];
    const reader = () => (params: { address: Address; abi: Abi; functionName: string }) => chain.publicClient.readContract(params as never);
    // The four hook views and escrow.token() answer exactly what the configuration expects…
    expect(compareEscrowDeployment(chains[0]!, {
      token: (await reader()({ address: lookalikeEscrow, abi: readArtifact('LookalikeEscrow', 'Impostors.sol').abi, functionName: 'token' })) as Address,
      acp: lookalikeEscrow,
      trustedEvaluator: evaluator,
      identityRegistry: IDENTITY,
      reputationRegistry: REPUTATION,
    }).problems).toEqual([]);
    // …and the check refuses them on their code.
    const [check] = await checkEscrowDeployments({
      chains,
      reader,
      chainIdReader: () => () => chain.publicClient.getChainId(),
      codeReader: () => (address) => chain.publicClient.getCode({ address }),
    });
    expect(check!.unreadable).toBeNull();
    expect(check!.problems).toEqual([
      expect.stringMatching(/AGENT_JOB_ESCROW_ADDRESS_84532=.* is not this build's AgentJobEscrow/),
      expect.stringMatching(/REPUTATION_HOOK_ADDRESS_84532=.* is not this build's ReputationHook/),
    ]);
  });

  it('what that refusal prevents: the lookalike escrow takes the budget a requester approves for `fund`', async () => {
    const budget = 25_000_000n; // 25 USDC
    const mockUsdcAbi = readArtifact('MockERC20').abi as Abi;
    expect(await send(deployer, usdc, encodeFunctionData({ abi: mockUsdcAbi, functionName: 'mint', args: [agent.address, budget] }))).toBe('success');
    // The orchestrator's two requester steps: approve(escrow, budget), then fund(jobId, budget, optParams).
    expect(await send(agent, usdc, encodeFunctionData({ abi: mockUsdcAbi, functionName: 'approve', args: [lookalikeEscrow, budget] }))).toBe('success');
    const fund = encodeFunctionData({
      abi: [{ type: 'function', name: 'fund', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] }],
      functionName: 'fund',
      args: [1n, budget, '0x'],
    });
    expect(await send(agent, lookalikeEscrow, fund)).toBe('success');
    const balanceOf = (who: Address) => chain.publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: 'balanceOf', args: [who] });
    expect(await balanceOf(thief)).toBe(budget);
    expect(await balanceOf(agent.address)).toBe(0n);
  });

  it('…and neither lookalike runs our code', async () => {
    expect(runsArtifact(await chain.publicClient.getCode({ address: lookalikeEscrow }), readArtifact('AgentJobEscrow'))).toBe(false);
    expect(runsArtifact(await chain.publicClient.getCode({ address: lookalikeHook }), readArtifact('ReputationHook'))).toBe(false);
  });
});
