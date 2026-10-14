/**
 * S9 — Safe mode and the policy module's authority, on an Anvil FORK of
 * Base Sepolia (the real Safe v1.4.1 singleton / factory deployed there).
 *
 * `SafeService.deploySafeForAgent` (real code, real protocol-kit) deploys a
 * 1/1 Safe owned by the agent's EOA, then enables `POLICY_MODULE_ADDRESS` as
 * a Safe MODULE — and a Safe module may move everything the Safe holds
 * (`execTransactionFromModule`), with no owner signature. The address is
 * never verified, so whatever it points at would get that power over every
 * new agent Safe.
 *
 * What actually happens today (first test): the enablement is signed with
 * the DEPLOYER key, which is not an owner; protocol-kit refuses
 * ("Transactions can only be signed by Safe owners"), `provisionAgent`
 * catches it and falls back to the agent's EOA. The Safe stays deployed,
 * orphaned, without the module — Safe mode never comes up.
 *
 * What a corrected enablement (signed by the owner — the only way it can
 * succeed) would do with a wrong address (second test): a rogue module that
 * answers `operator()` like an AgentPolicyModule is enabled and drains the
 * Safe.
 *
 * Demonstrations of the CURRENT behaviour. Skipped unless
 * `E2E_ANVIL_FORK_URL` (e.g. https://sepolia.base.org — read-only) is set;
 * `E2E_ANVIL_FORK_BLOCK_NUMBER` pins the fork. Anvil: `anvilTestPort(4)`
 * (default 8749), chain id 84532.
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
import * as SafeModule from '@safe-global/protocol-kit';
import { encodeFunctionData, getAddress, parseEther, type Address } from 'viem';
import { ANVIL_KEYS, anvilAccount, anvilTestPort, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';

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
/** Where the drained funds go: an address with no code on the fork. */
const LOOT = getAddress('0x00000000000000000000000000000000005a0107');

let chain: LocalChain;
let rogue: Address;

beforeAll(async () => {
  if (!FORK_URL) return;
  chain = await startLocalChain({
    port: anvilTestPort(4),
    chainId: CHAIN_ID,
    forkUrl: FORK_URL,
    forkBlockNumber: process.env['E2E_ANVIL_FORK_BLOCK_NUMBER'],
  });
  rogue = await chain.deploy(anvilAccount(0), ROGUE, [operator]);
  // What a mistyped / hostile POLICY_MODULE_ADDRESS_84532 would point at.
  process.env['POLICY_MODULE_ADDRESS_84532'] = rogue;
  process.env['RPC_URL_84532'] = chain.rpcUrl;
}, 180_000);

afterAll(() => {
  chain?.stop();
});

describeFork('S9 — Safe mode and the policy module address (Anvil fork of Base Sepolia, real Safe contracts)', () => {
  let safe: Address;

  it('today: deploySafeForAgent deploys the Safe, then the module enablement fails (deployer is not an owner) — the agent falls back to its EOA', async () => {
    const { SafeService } = await import('../services/wallet/safe.service.js');
    await expect(
      new SafeService().deploySafeForAgent({ ownerAddress: owner, chainId: CHAIN_ID, signerPrivateKey: deployerKey }),
    ).rejects.toThrow(/can only be signed by Safe owners/);

    // The Safe itself was deployed (deployer paid) and is owned by the agent — orphaned, no module.
    const predicted = await Safe.init({
      provider: chain.rpcUrl,
      signer: deployerKey,
      predictedSafe: { safeAccountConfig: { owners: [owner], threshold: 1 } },
    });
    safe = getAddress(await predicted.getAddress());
    expect((await chain.publicClient.getCode({ address: safe }))?.length ?? 0).toBeGreaterThan(2);
    const kit = await Safe.init({ provider: chain.rpcUrl, signer: ownerKey, safeAddress: safe });
    expect((await kit.getOwners()).map((o) => getAddress(o))).toEqual([owner]);
    expect(await kit.isModuleEnabled(rogue)).toBe(false);
  }, 180_000);

  it('once the enablement is signed by the owner, the configured address — here a rogue module that answers operator() — drains the Safe', async () => {
    expect(safe).toBeDefined();
    await chain.setBalance(owner, parseEther('1'));
    await chain.setBalance(safe, parseEther('5'));

    // The rogue module looks like a policy module to a view check.
    expect(getAddress((await chain.publicClient.readContract({ address: rogue, abi: ROGUE.abi, functionName: 'operator' })) as string)).toBe(getAddress(operator));

    const kit = await Safe.init({ provider: chain.rpcUrl, signer: ownerKey, safeAddress: safe });
    const enable = await kit.createEnableModuleTx(rogue);
    const result = await kit.executeTransaction(await kit.signTransaction(enable));
    await chain.publicClient.waitForTransactionReceipt({ hash: result.hash as `0x${string}` });
    expect(await kit.isModuleEnabled(rogue)).toBe(true);

    // Anyone can call drain(); the funds go to an address with no code (the well-known Anvil
    // accounts are EIP-7702-delegated to sweepers on public testnets, so they are not used as payee).
    expect(await chain.publicClient.getCode({ address: LOOT })).toBeUndefined();
    const drain = encodeFunctionData({ abi: ROGUE.abi, functionName: 'drain', args: [safe, LOOT] });
    const hash = await chain.wallet(thief).sendTransaction({ to: rogue, data: drain, account: thief, chain: null });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(await chain.publicClient.getBalance({ address: safe })).toBe(0n);
    expect(await chain.publicClient.getBalance({ address: LOOT })).toBe(parseEther('5'));
  }, 180_000);
});
