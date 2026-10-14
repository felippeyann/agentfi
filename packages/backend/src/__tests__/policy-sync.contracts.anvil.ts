/**
 * S8 — who may change an agent's on-chain policy, on REAL local contracts.
 *
 * `AgentPolicyModule.setPolicy` / `updateContractWhitelist` /
 * `updateTokenWhitelist` / `emergencyPause` / `resume` accept only the
 * module's immutable `operator` or `msg.sender == safe`. The admin "Sync
 * policy" button and the kill-switch `onChainSync` notice sent the module
 * calls through `POST /admin/transactions/batch`, i.e. as actions of
 * `AgentExecutor.executeBatch` — where the EXECUTOR is `msg.sender` of every
 * action. These tests deploy the Foundry artifacts on Anvil and send exactly
 * the calldata the backend builds (`OnChainPolicyService` + the admin batch
 * encoding) to show what each path does on-chain.
 *
 * Wallet mode: an agent without a Safe (SAFE_DEPLOYER_PRIVATE_KEY unset, or a
 * Safe deployment that fell back) has `safeAddress` = its own EOA, so "the
 * Safe" in the module's sense is that EOA.
 *
 * Anvil: `anvilTestPort(0)` (default 8745), chain id 84532.
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
import {
  BaseError,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { AGENT_EXECUTOR_ABI } from '../abi/AgentExecutor.abi.js';
import { OnChainPolicyService } from '../services/policy/onchain-policy.service.js';
import {
  anvilAccount,
  anvilTestPort,
  deployPolicyStack,
  readArtifact,
  startLocalChain,
  type LocalChain,
} from './helpers/anvil-contracts.js';

const CHAIN_ID = 84532;
const MODULE_ABI = readArtifact('AgentPolicyModule').abi;
const EXECUTOR_ABI = readArtifact('AgentExecutor').abi;

let chain: LocalChain;
let policyModule: Address;
let executor: Address;
const deployer = anvilAccount(0);
const operator = anvilAccount(1);
/** An EOA-mode agent: its `safeAddress` is this EOA. */
const agent = anvilAccount(2);
const stranger = anvilAccount(3);
/** A second EOA-mode agent (a different "safe"). */
const otherAgent = anvilAccount(4);
const onChain = new OnChainPolicyService();

beforeAll(async () => {
  chain = await startLocalChain({ port: anvilTestPort(0), chainId: CHAIN_ID });
  ({ policyModule, executor } = await deployPolicyStack(chain, {
    deployer,
    operator: operator.address,
    feeWallet: deployer.address,
  }));
});

afterAll(() => {
  chain?.stop();
});

/** The admin batch encoding (`POST /admin/transactions/batch`, admin.ts): token = 0, value = 0. */
function adminBatchCalldata(actions: Array<{ to: Address; data: Hex }>): Hex {
  return encodeFunctionData({
    abi: AGENT_EXECUTOR_ABI,
    functionName: 'executeBatch',
    args: [actions.map((a) => ({ target: a.to, value: 0n, token: zeroAddress, data: a.data }))],
  });
}

/** Sends `data` to `to` from `account` with a fixed gas limit (no estimation) and returns the receipt status. */
async function send(account: PrivateKeyAccount, to: Address, data: Hex): Promise<'success' | 'reverted'> {
  const hash = await chain.wallet(account).sendTransaction({ to, data, gas: 1_000_000n, account, chain: null });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  return receipt.status;
}

/** The custom error a reverted `eth_call` of `data` raises, decoded with `abi`. */
async function revertOf(account: Address, to: Address, data: Hex, abi: Abi): Promise<{ errorName: string; args: readonly unknown[] }> {
  try {
    await chain.publicClient.call({ account, to, data });
  } catch (err) {
    const raw = (err as BaseError).walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null;
    if (!raw?.data) throw err;
    const decoded = decodeErrorResult({ abi, data: raw.data });
    return { errorName: decoded.errorName, args: decoded.args ?? [] };
  }
  throw new Error('expected the call to revert');
}

async function readPolicy(safe: Address) {
  return chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'getPolicy', args: [safe] }) as Promise<{
    maxValuePerTx: bigint;
    cooldownBetweenTx: bigint;
    active: boolean;
    policyExpiresAt: bigint;
    numAllowedContracts: bigint;
    numAllowedTokens: bigint;
  }>;
}

async function hasPolicy(safe: Address): Promise<boolean> {
  return chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'hasPolicy', args: [safe] }) as Promise<boolean>;
}

function setPolicyCalldata(safe: Address, maxValuePerTxEth: string, cooldownSeconds: number, active: boolean): Promise<Hex> {
  return onChain.buildSyncPolicyCalldata({ safeAddress: safe, maxValuePerTxEth, cooldownSeconds, active });
}

describe('S8 repro — the executor path can never sync a policy (unfixed behaviour, kept as regressions)', () => {
  it('the admin "Sync policy" batch reverts ActionFailed(0, module, Unauthorized()): the executor is msg.sender', async () => {
    const data = await setPolicyCalldata(agent.address, '0.5', 0, true);
    const batch = adminBatchCalldata([{ to: policyModule, data }]);

    const reverted = await revertOf(agent.address, executor, batch, EXECUTOR_ABI);
    expect(reverted.errorName).toBe('ActionFailed');
    const [index, target, returnData] = reverted.args as [bigint, Address, Hex];
    expect(index).toBe(0n);
    expect(target.toLowerCase()).toBe(policyModule.toLowerCase());
    expect(decodeErrorResult({ abi: MODULE_ABI, data: returnData }).errorName).toBe('Unauthorized');

    // Broadcast anyway (the admin batch has no simulation): mined, reverted, nothing written.
    expect(await send(agent, executor, batch)).toBe('reverted');
    expect(await hasPolicy(agent.address)).toBe(false);
  });

  it('the kill-switch emergencyPause / resume calldata through the executor reverts too; the on-chain policy stays as it was', async () => {
    // A policy exists on-chain (set by the operator key directly).
    expect(await send(operator, policyModule, await setPolicyCalldata(otherAgent.address, '1', 0, true))).toBe('success');

    const pause = adminBatchCalldata([{ to: policyModule, data: await onChain.buildEmergencyPauseCalldata({ safeAddress: otherAgent.address }) }]);
    const reverted = await revertOf(otherAgent.address, executor, pause, EXECUTOR_ABI);
    expect(reverted.errorName).toBe('ActionFailed');
    expect(decodeErrorResult({ abi: MODULE_ABI, data: (reverted.args as [bigint, Address, Hex])[2] }).errorName).toBe('Unauthorized');
    expect(await send(otherAgent, executor, pause)).toBe('reverted');
    expect((await readPolicy(otherAgent.address)).active).toBe(true);

    const resume = adminBatchCalldata([{ to: policyModule, data: await onChain.buildResumeCalldata({ safeAddress: otherAgent.address }) }]);
    expect(await send(otherAgent, executor, resume)).toBe('reverted');
  });
});

describe('S8 — the authority the module already defines', () => {
  it('a stranger cannot set, pause or whitelist anybody’s policy', async () => {
    const calls: Hex[] = [
      await setPolicyCalldata(agent.address, '100', 0, true),
      await onChain.buildEmergencyPauseCalldata({ safeAddress: agent.address }),
      await onChain.buildResumeCalldata({ safeAddress: agent.address }),
      await onChain.buildUpdateWhitelistCalldata({ type: 'contract', safeAddress: agent.address, addresses: [stranger.address], allowed: [true] }),
      await onChain.buildUpdateWhitelistCalldata({ type: 'token', safeAddress: agent.address, addresses: [stranger.address], allowed: [true] }),
    ];
    for (const data of calls) {
      expect((await revertOf(stranger.address, policyModule, data, MODULE_ABI)).errorName).toBe('Unauthorized');
    }
  });

  it('an agent EOA cannot set the policy of another agent (msg.sender must be THAT safe)', async () => {
    const data = await setPolicyCalldata(otherAgent.address, '100', 0, true);
    expect((await revertOf(agent.address, policyModule, data, MODULE_ABI)).errorName).toBe('Unauthorized');
  });

  it('the agent EOA itself (msg.sender == safe, EOA mode) and the operator key can — sent directly, not through the executor', async () => {
    expect(await send(agent, policyModule, await setPolicyCalldata(agent.address, '0.25', 0, true))).toBe('success');
    let read = await readPolicy(agent.address);
    expect(read.maxValuePerTx).toBe(250_000_000_000_000_000n);
    expect(read.active).toBe(true);

    expect(await send(operator, policyModule, await onChain.buildEmergencyPauseCalldata({ safeAddress: agent.address }))).toBe('success');
    read = await readPolicy(agent.address);
    expect(read.active).toBe(false);
    expect(read.maxValuePerTx).toBe(250_000_000_000_000_000n);

    expect(await send(agent, policyModule, await onChain.buildResumeCalldata({ safeAddress: agent.address }))).toBe('success');
    expect((await readPolicy(agent.address)).active).toBe(true);
  });
});

/**
 * The two contract findings of S8 were fixed in AgentPolicyModule before C4
 * (owner decision 2026-10-14): before, a 2-action batch reverted CooldownActive
 * once a cooldown was set, and a stranger's validateTransaction(victim, …)
 * restarted the victim's cooldown. These run against the fixed build.
 */
describe('S8 contract findings — fixed (cooldown once per execution; validations by the bound executor only)', () => {
  const batchOf = (n: number) =>
    encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [Array.from({ length: n }, () => ({ target: deployer.address, value: 0n, token: zeroAddress, data: '0x' as Hex }))],
    });
  const lastTx = (safe: Address) =>
    chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'getLastTxTimestamp', args: [safe] }) as Promise<bigint>;

  it('the module is bound to this executor (bindExecutor in the deployment)', async () => {
    expect(await chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'executor' })).toBe(getAddress(executor));
  });

  it('a 2-action batch under a 60 s cooldown passes and stamps the cooldown once; a second batch inside it reverts', async () => {
    const safe = stranger; // a fresh EOA-mode agent for this case
    expect(await send(safe, policyModule, await setPolicyCalldata(safe.address, '1', 60, true))).toBe('success');
    expect(await send(safe, executor, batchOf(2))).toBe('success');
    const stamped = await lastTx(safe.address);
    expect(stamped).toBeGreaterThan(0n);
    const reverted = await revertOf(safe.address, executor, batchOf(2), MODULE_ABI);
    expect(reverted.errorName).toBe('CooldownActive');
    await chain.rpc('evm_increaseTime', [61]);
    await chain.rpc('evm_mine', []);
    expect(await send(safe, executor, batchOf(3))).toBe('success');
    expect(await lastTx(safe.address)).toBeGreaterThan(stamped);
  });

  it('a stranger can no longer restart an agent’s cooldown: validateTransaction / recordExecution answer Unauthorized', async () => {
    const victim = otherAgent;
    expect(await send(operator, policyModule, await setPolicyCalldata(victim.address, '1', 60, true))).toBe('success');
    await chain.rpc('evm_increaseTime', [3600]);
    await chain.rpc('evm_mine', []);
    const before = await lastTx(victim.address);

    const grief = encodeFunctionData({ abi: MODULE_ABI, functionName: 'validateTransaction', args: [victim.address, deployer.address, 0n, zeroAddress] });
    expect((await revertOf(stranger.address, policyModule, grief, MODULE_ABI)).errorName).toBe('Unauthorized');
    const stamp = encodeFunctionData({ abi: MODULE_ABI, functionName: 'recordExecution', args: [victim.address] });
    expect((await revertOf(stranger.address, policyModule, stamp, MODULE_ABI)).errorName).toBe('Unauthorized');
    expect(await send(stranger, policyModule, stamp)).toBe('reverted');

    expect(await lastTx(victim.address)).toBe(before);
    await expect(chain.publicClient.call({ account: victim.address, to: executor, data: batchOf(1) })).resolves.toBeDefined();
  });
});
