/**
 * S9 — a configured `EXECUTOR_ADDRESS_<id>` must be this repository's
 * AgentExecutor, bound to the configured module, before any transaction is
 * routed through it. REAL local contracts, the backend's real boot check and
 * re-check loop (`policy-stack-boot.runtime.ts`), the real gate and the API's
 * 503.
 *
 * Before S9 (demonstrated on this file's first version): with the address
 * pointing at an EOA, a foreign contract or a lookalike answering our views,
 * the production dry-run passed, the transaction succeeded and the wrong
 * address kept amount + fee. Now each one is a MISMATCH at boot, the gate is
 * closed, executor-routed requests answer 503 CONTRACTS_UNVERIFIED and
 * nothing is sent. The legacy build fails closed too. RPC down → unverified
 * (503, no fatal); RPC back → the re-check verifies again by itself.
 *
 * Hermetic: `createChainPublicClient` reads only RPC_URL_84532 here (no
 * fallback to the public Base Sepolia RPC the production client keeps behind
 * the override). Anvil: `anvilTestPort(2)` (default 8747), chain id 84532.
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
  // A fast re-check so the recovery is observable: TTL 4 s, re-check every 1 s.
  process.env['ESCROW_CONFIG_VERIFIED_TTL_SECONDS'] = '4';
  process.env['ESCROW_CONFIG_RECHECK_SECONDS'] = '1';
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify: async () => undefined } }));
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  const { createPublicClient, http } = await import('viem');
  return {
    ...actual,
    createChainPublicClient: (chainId: number) =>
      createPublicClient({ chain: actual.getChain(chainId), transport: http(process.env[`RPC_URL_${chainId}`], { retryCount: 0, timeout: 3_000 }) }),
  };
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BaseError,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  parseEther,
  parseTransaction,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionSerializable,
} from 'viem';
import {
  anvilAccount,
  anvilTestPort,
  deployPolicyStack,
  readArtifact,
  startLocalChain,
  type LocalChain,
} from './helpers/anvil-contracts.js';

const CHAIN_ID = 84532;
const EXECUTOR_ARTIFACT = readArtifact('AgentExecutor');
const LOOKALIKE = readArtifact('LookalikeExecutor', 'Impostors.sol');
const LEGACY = readArtifact('LegacyActionExecutor', 'Impostors.sol');

const deployer = anvilAccount(0);
const operator = anvilAccount(1).address;
const agent = anvilAccount(2);
const thief = anvilAccount(3).address;
const TARGET = getAddress('0x00000000000000000000000000000000000d0001');
/** The "typo": an address with no code. */
const TYPO_EOA = getAddress('0x00000000000000000000000000000000000d0e0a');
/** A contract that is not ours: runtime `STOP` (accepts any call and value). */
const FOREIGN_CONTRACT = getAddress('0x00000000000000000000000000000000000d0c0c');
const FEE_WALLET = getAddress(process.env['OPERATOR_FEE_WALLET']!);
const AMOUNT = parseEther('1');
const FEE = (AMOUNT * 30n) / 10_000n;

let chain: LocalChain;
let policyModule: Address;
let executor: Address;
let lookalike: Address;
let legacy: Address;

type Runtime = {
  boot: typeof import('../config/policy-stack-boot.runtime.js');
  state: typeof import('../config/policy-stack-verification.runtime.js');
  gate: typeof import('../api/contracts-gate.js');
  ExecutorService: typeof import('../services/transaction/executor.service.js')['ExecutorService'];
  SubmitterService: typeof import('../services/transaction/submitter.service.js')['SubmitterService'];
};
let current: Runtime | null = null;

beforeAll(async () => {
  chain = await startLocalChain({ port: anvilTestPort(2), chainId: CHAIN_ID });
  ({ policyModule, executor } = await deployPolicyStack(chain, { deployer, operator, feeWallet: FEE_WALLET }));
  lookalike = await chain.deploy(deployer, LOOKALIKE, [policyModule, FEE_WALLET, 30n, thief]);
  legacy = await chain.deploy(deployer, LEGACY, [policyModule, FEE_WALLET, 30n]);
  await chain.rpc('anvil_setCode', [FOREIGN_CONTRACT, '0x00']);
});

afterEach(() => {
  current?.boot.__stopPolicyStackRecheckForTests();
  current = null;
});

afterAll(() => {
  chain?.stop();
});

/** A fresh process (module registry) configured with `executorAddress`, after its boot check. */
async function bootWith(executorAddress: Address, rpcUrl: string = chain.rpcUrl) {
  process.env['RPC_URL_84532'] = rpcUrl;
  process.env['EXECUTOR_ADDRESS_84532'] = executorAddress;
  process.env['POLICY_MODULE_ADDRESS_84532'] = policyModule;
  process.env['POLICY_OPERATOR_ADDRESS_84532'] = operator;
  vi.resetModules();
  current = {
    boot: await import('../config/policy-stack-boot.runtime.js'),
    state: await import('../config/policy-stack-verification.runtime.js'),
    gate: await import('../api/contracts-gate.js'),
    ExecutorService: (await import('../services/transaction/executor.service.js')).ExecutorService,
    SubmitterService: (await import('../services/transaction/submitter.service.js')).SubmitterService,
  };
  const verdict = await current.boot.runPolicyStackBootCheck('api');
  return { verdict, rt: current };
}

/** What `POST /v1/transactions/batch` / the swap route answer through `refuseUnverifiedContracts`. */
function apiAnswer(rt: Runtime): { status: number; body: Record<string, unknown> | null } {
  const sent: { status: number; body: Record<string, unknown> | null } = { status: 200, body: null };
  const reply = {
    code(status: number) {
      sent.status = status;
      return reply;
    },
    header() {
      return reply;
    },
    send(body: Record<string, unknown>) {
      sent.body = body;
      return reply;
    },
  };
  rt.gate.refuseUnverifiedContracts(reply as never, CHAIN_ID, 'a batch routed through the AgentExecutor');
  return sent;
}

const balance = (address: Address) => chain.publicClient.getBalance({ address });

async function sendWrappedSwap(rt: Runtime) {
  const wrapped = new rt.ExecutorService({ warn: () => undefined }).wrapSingle(CHAIN_ID, { to: TARGET, data: '0x', value: AMOUNT });
  const submitter = new rt.SubmitterService({
    client: () => chain.publicClient as never,
    wallet: { signTransaction: async ({ unsignedTx }) => agent.signTransaction(parseTransaction(unsignedTx as Hex) as TransactionSerializable) },
  });
  const { txHash } = await submitter.submit({ chainId: CHAIN_ID, walletId: 'agent', from: agent.address, to: wrapped.to, data: wrapped.data, value: wrapped.value });
  return { wrapped, status: (await chain.publicClient.waitForTransactionReceipt({ hash: txHash })).status };
}

describe('S9 — the correct build verifies and the executor path works', () => {
  it('our executor + module, bound, with the configured fee wallet / fee / operator: verified, the gate is open, the swap pays target and fee wallet', async () => {
    const { verdict, rt } = await bootWith(executor);
    expect(verdict).toMatchObject({ fatal: null, errors: [], verified: [CHAIN_ID] });
    expect(rt.state.policyStackGate(CHAIN_ID)).toMatchObject({ allowed: true });
    expect(apiAnswer(rt).body).toBeNull();

    const [targetBefore, feeBefore] = await Promise.all([balance(TARGET), balance(FEE_WALLET)]);
    const { wrapped, status } = await sendWrappedSwap(rt);
    expect(getAddress(wrapped.to)).toBe(getAddress(executor));
    expect(wrapped).toMatchObject({ routedViaExecutor: true, value: AMOUNT + FEE });
    expect(status).toBe('success');
    expect((await balance(TARGET)) - targetBefore).toBe(AMOUNT);
    expect((await balance(FEE_WALLET)) - feeBefore).toBe(FEE);
  });
});

describe('S9 — a wrong EXECUTOR_ADDRESS is refused before it receives anything (the demonstrations, now blocked)', () => {
  it.each([
    ['an EOA (typo)', () => TYPO_EOA, /EXECUTOR_ADDRESS_84532=.* is not this build's AgentExecutor: no code at the address/],
    ['a contract that is not ours', () => FOREIGN_CONTRACT, /is not this build's AgentExecutor: its runtime code is 1 bytes/],
    ['a lookalike answering our views', () => lookalike, /is not this build's AgentExecutor/],
    ['the legacy build (old Action struct)', () => legacy, /is not this build's AgentExecutor/],
  ])('%s → mismatch at boot, gate closed, the API answers 503 CONTRACTS_UNVERIFIED, nothing is sent', async (_label, address, message) => {
    const configured = address();
    const watched = [TARGET, configured, thief, FEE_WALLET] as const;
    const before = await Promise.all(watched.map(balance));

    const { verdict, rt } = await bootWith(configured);
    expect(verdict!.verified).toEqual([]);
    expect(verdict!.errors).toEqual([expect.stringMatching(message)]);
    expect(rt.state.policyStackGate(CHAIN_ID)).toMatchObject({ allowed: false, block: 'mismatch' });
    const answer = apiAnswer(rt);
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: 'CONTRACTS_UNVERIFIED', state: 'mismatch' });

    expect(await Promise.all(watched.map(balance))).toEqual(before);
  });

  it('production would not even boot with the lookalike (FATAL, exit 1)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.env['NODE_ENV'] = 'production';
      const { verdict } = await bootWith(lookalike);
      expect(verdict!.fatal).toMatch(/^FATAL: the deployed AgentExecutor \/ AgentPolicyModule does not match this build/);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.env['NODE_ENV'] = 'test';
      exit.mockRestore();
      err.mockRestore();
    }
  });

  it('why it matters (contract level, no backend in the path): the lookalike keeps amount + fee of a swap sent to it', async () => {
    const { rt } = await bootWith(executor); // our executor configured — only to borrow the encoders
    const wrapped = new rt.ExecutorService({ warn: () => undefined }).wrapSingle(CHAIN_ID, { to: TARGET, data: '0x', value: AMOUNT });
    const before = await balance(thief);
    const hash = await chain.wallet(agent).sendTransaction({ to: lookalike, data: wrapped.data, value: wrapped.value, account: agent, chain: null });
    expect((await chain.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
    expect((await balance(thief)) - before).toBe(AMOUNT + FEE);
  });
});

describe('S9 — RPC down, then recovered', () => {
  it('unreadable at boot: unverified (never fatal), 503 meanwhile; the re-check verifies it by itself once the RPC answers', async () => {
    const dead = `http://127.0.0.1:${anvilTestPort(2) + 50}`;
    const { verdict, rt } = await bootWith(executor, dead);
    expect(verdict).toMatchObject({ fatal: null, verified: [], unreadable: [CHAIN_ID] });
    expect(rt.state.policyStackGate(CHAIN_ID)).toMatchObject({ allowed: false, block: 'unverified' });
    expect(apiAnswer(rt).status).toBe(503);

    process.env['RPC_URL_84532'] = chain.rpcUrl; // the RPC is back
    const deadline = Date.now() + 15_000;
    while (!rt.state.policyStackGate(CHAIN_ID).allowed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    expect(rt.state.policyStackGate(CHAIN_ID)).toMatchObject({ allowed: true });
    expect(apiAnswer(rt).body).toBeNull();

    // A failure after a success revokes the verification at once (TTL 4 s, re-check 1 s).
    process.env['RPC_URL_84532'] = dead;
    const revokeBy = Date.now() + 10_000;
    while (rt.state.policyStackGate(CHAIN_ID).allowed && Date.now() < revokeBy) await new Promise((r) => setTimeout(r, 250));
    expect(rt.state.policyStackGate(CHAIN_ID)).toMatchObject({ allowed: false, block: 'unverified' });
  }, 40_000);
});

describe('side finding — the agent batch sends the action value without the executor fee', () => {
  it('executeBatch with msg.value = Σ action values (what POST /v1/transactions/batch sends) reverts InsufficientValueForFee', async () => {
    const data = encodeFunctionData({
      abi: EXECUTOR_ARTIFACT.abi,
      functionName: 'executeBatch',
      args: [[{ target: TARGET, value: AMOUNT, token: zeroAddress, data: '0x' }]],
    });
    let revertData: Hex | undefined;
    try {
      await chain.publicClient.call({ account: agent.address, to: executor, data, value: AMOUNT });
    } catch (err) {
      revertData = ((err as BaseError).walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null)?.data;
    }
    expect(revertData).toBeDefined();
    const decoded = decodeErrorResult({ abi: EXECUTOR_ARTIFACT.abi, data: revertData! });
    expect(decoded.errorName).toBe('InsufficientValueForFee');
    expect(decoded.args).toEqual([AMOUNT, AMOUNT + FEE]);
    await expect(chain.publicClient.call({ account: agent.address, to: executor, data, value: AMOUNT + FEE })).resolves.toBeDefined();
  });
});
