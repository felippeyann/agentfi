/**
 * S9 + Safe mode, on an Anvil FORK of Base Sepolia (the real Safe v1.4.1
 * singleton / factory deployed there), with the real `SafeService` and
 * protocol-kit.
 *
 * `deploySafeForAgent` deploys a 1/1 Safe owned by the agent's EOA, then
 * enables `POLICY_MODULE_ADDRESS` as a Safe MODULE — and a Safe module may move
 * everything the Safe holds (`execTransactionFromModule`) with no owner
 * signature.
 *  1. S9 gate: a configured module that is not this build's (a rogue contract
 *     answering `operator()` like a policy module) → refused BEFORE anything
 *     is deployed (no orphaned Safe, no module).
 *  2. With our verified module the gate passes — and the enablement still
 *     fails: it is signed by the deployer, who is not an owner (protocol-kit:
 *     "Transactions can only be signed by Safe owners"); the Safe stays
 *     deployed and orphaned, the agent falls back to its EOA. This is why Safe
 *     mode is refused in production / staging (env-guards `safeModeVerdict`).
 *  3. What the gate prevents: once enabled by the owner, a rogue module
 *     drains the Safe.
 *
 * Skipped unless `E2E_ANVIL_FORK_URL` (e.g. https://sepolia.base.org,
 * read-only) is set; `E2E_ANVIL_FORK_BLOCK_NUMBER` pins the fork. Anvil:
 * `anvilTestPort(4)` (default 8749), chain id 84532.
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
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify: async () => undefined } }));
// Hermetic reads: only the fork (no fallback to the public Base Sepolia RPC behind the override).
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  const { createPublicClient, http } = await import('viem');
  return {
    ...actual,
    createChainPublicClient: (chainId: number) =>
      createPublicClient({ chain: actual.getChain(chainId), transport: http(process.env[`RPC_URL_${chainId}`], { retryCount: 0 }) }),
  };
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as SafeModule from '@safe-global/protocol-kit';
import { encodeFunctionData, getAddress, parseEther, type Address } from 'viem';
import { ANVIL_KEYS, anvilAccount, anvilTestPort, deployPolicyStack, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';

const FORK_URL = process.env['E2E_ANVIL_FORK_URL'];
const describeFork = FORK_URL ? describe : describe.skip;
if (!FORK_URL) console.warn('[contract-identity.safe.anvil] E2E_ANVIL_FORK_URL not set — Safe-mode fork suite skipped');

const CHAIN_ID = 84532;
const ROGUE = readArtifact('RogueSafeModule', 'Impostors.sol');

type SafeKit = {
  getAddress(): Promise<string>;
  createEnableModuleTx(moduleAddress: string): Promise<unknown>;
  signTransaction(tx: unknown): Promise<unknown>;
  executeTransaction(tx: unknown): Promise<{ hash: string }>;
  isModuleEnabled(moduleAddress: string): Promise<boolean>;
  getOwners(): Promise<string[]>;
};
const Safe = (SafeModule as unknown as { default: { init(config: Record<string, unknown>): Promise<SafeKit> } }).default;

const deployerKey = ANVIL_KEYS[0];
const operator = anvilAccount(1).address;
/** The agent's EOA (the Safe's only owner). */
const ownerKey = ANVIL_KEYS[2];
const owner = anvilAccount(2).address;
const thief = anvilAccount(3);
/** Where drained funds go: an address with no code (the well-known Anvil accounts are EIP-7702-delegated to sweepers on public testnets). */
const LOOT = getAddress('0x00000000000000000000000000000000005a0107');

let chain: LocalChain;
let rogue: Address;
let policyModule: Address;
let executor: Address;

beforeAll(async () => {
  if (!FORK_URL) return;
  chain = await startLocalChain({ port: anvilTestPort(4), chainId: CHAIN_ID, forkUrl: FORK_URL, forkBlockNumber: process.env['E2E_ANVIL_FORK_BLOCK_NUMBER'] });
  rogue = await chain.deploy(anvilAccount(0), ROGUE, [operator]);
  ({ policyModule, executor } = await deployPolicyStack(chain, { deployer: anvilAccount(0), operator, feeWallet: getAddress(process.env['OPERATOR_FEE_WALLET']!) }));
  process.env['RPC_URL_84532'] = chain.rpcUrl;
}, 180_000);

afterAll(() => {
  chain?.stop();
});

/** A fresh process configured with POLICY_MODULE_ADDRESS_84532 = `module`, after its S9 boot check. */
async function processWith(module: Address) {
  process.env['POLICY_MODULE_ADDRESS_84532'] = module;
  process.env['EXECUTOR_ADDRESS_84532'] = executor;
  process.env['POLICY_OPERATOR_ADDRESS_84532'] = operator;
  vi.resetModules();
  const boot = await import('../config/policy-stack-boot.runtime.js');
  const verdict = await boot.runPolicyStackBootCheck('api');
  boot.__stopPolicyStackRecheckForTests();
  const { SafeService } = await import('../services/wallet/safe.service.js');
  return { verdict, safeService: new SafeService() };
}

async function predictedSafe(): Promise<Address> {
  const kit = await Safe.init({ provider: chain.rpcUrl, signer: deployerKey, predictedSafe: { safeAccountConfig: { owners: [owner], threshold: 1 } } });
  return getAddress(await kit.getAddress());
}

describeFork('S9 + Safe mode (Anvil fork of Base Sepolia, real Safe contracts)', () => {
  let safe: Address;

  it('a configured module that is not this build’s (rogue) → the S9 gate refuses BEFORE anything is deployed', async () => {
    const { verdict, safeService } = await processWith(rogue);
    expect(verdict!.verified).toEqual([]);
    await expect(safeService.deploySafeForAgent({ ownerAddress: owner, chainId: CHAIN_ID, signerPrivateKey: deployerKey })).rejects.toThrow(
      /Safe not deployed: the AgentPolicyModule of chain 84532 is not verified against this build \(mismatch\)/,
    );
    safe = await predictedSafe();
    expect(await chain.publicClient.getCode({ address: safe })).toBeUndefined(); // no orphaned Safe
  }, 180_000);

  it('our verified module passes the gate — and the enablement still fails (the deployer is not an owner): why Safe mode is refused in production', async () => {
    const { verdict, safeService } = await processWith(policyModule);
    expect(verdict).toMatchObject({ fatal: null, verified: [CHAIN_ID] });
    await expect(safeService.deploySafeForAgent({ ownerAddress: owner, chainId: CHAIN_ID, signerPrivateKey: deployerKey })).rejects.toThrow(
      /can only be signed by Safe owners/,
    );
    // The Safe was deployed (deployer paid) and is owned by the agent — orphaned, no module.
    expect((await chain.publicClient.getCode({ address: safe }))?.length ?? 0).toBeGreaterThan(2);
    const kit = await Safe.init({ provider: chain.rpcUrl, signer: ownerKey, safeAddress: safe });
    expect((await kit.getOwners()).map((o) => getAddress(o))).toEqual([owner]);
    expect(await kit.isModuleEnabled(policyModule)).toBe(false);
  }, 180_000);

  it('what the gate prevents: once enabled by the owner, a rogue module (answering operator()) drains the Safe', async () => {
    await chain.setBalance(owner, parseEther('1'));
    await chain.setBalance(safe, parseEther('5'));
    expect(getAddress((await chain.publicClient.readContract({ address: rogue, abi: ROGUE.abi, functionName: 'operator' })) as string)).toBe(getAddress(operator));

    const kit = await Safe.init({ provider: chain.rpcUrl, signer: ownerKey, safeAddress: safe });
    const result = await kit.executeTransaction(await kit.signTransaction(await kit.createEnableModuleTx(rogue)));
    await chain.publicClient.waitForTransactionReceipt({ hash: result.hash as `0x${string}` });
    expect(await kit.isModuleEnabled(rogue)).toBe(true);

    expect(await chain.publicClient.getCode({ address: LOOT })).toBeUndefined();
    const drain = encodeFunctionData({ abi: ROGUE.abi, functionName: 'drain', args: [safe, LOOT] });
    const hash = await chain.wallet(thief).sendTransaction({ to: rogue, data: drain, account: thief, chain: null });
    expect((await chain.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
    expect(await chain.publicClient.getBalance({ address: safe })).toBe(0n);
    expect(await chain.publicClient.getBalance({ address: LOOT })).toBe(parseEther('5'));
  }, 180_000);
});
