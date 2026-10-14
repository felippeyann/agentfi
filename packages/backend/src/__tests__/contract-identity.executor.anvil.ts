/**
 * S9 — what a wrong `EXECUTOR_ADDRESS_<id>` receives, on REAL local contracts.
 *
 * The backend trusts the configured executor by address: nothing checks, at
 * boot or before use, that the address runs `AgentExecutor` (only a list of
 * two known legacy addresses is refused). An ETH-value swap is wrapped by
 * `ExecutorService.wrapSingle` into `executeSingle` with `value = amount +
 * fee` and sent TO the executor. These tests run that real wrapping, the real
 * production dry-run (`SimulatorService`'s eth_call / estimateGas path — what
 * production uses without Tenderly) and the real submitter (signing with the
 * agent key, broadcasting to Anvil), against:
 *   - our executor (baseline: the target and the fee wallet are paid);
 *   - an EOA (a typo): the dry-run passes, the transaction succeeds, the EOA
 *     keeps amount + fee;
 *   - a contract that is not ours (any payable fallback; here the 1-byte
 *     runtime `STOP`): same;
 *   - a lookalike that answers `policyModule()` / `feeWallet()` / `feeBps()`
 *     exactly like our deployment (a view-based boot check passes) and
 *     forwards everything to a thief;
 *   - the legacy build (old `Action` struct): same views, every call reverts
 *     (fail closed — no funds move, every executor transaction fails).
 * Then the identity evidence: only our executor runs the artifact's code with
 * its immutables filled in.
 *
 * These are demonstrations of the CURRENT behaviour (they pass on the unfixed
 * code). The check itself waits for the owner's trust-policy decision.
 *
 * Anvil: `anvilTestPort(2)` (default 8747), chain id 84532.
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
  keccak256,
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
import { cborTrailer, immutableValues, runsArtifact } from './helpers/contract-identity.js';

const CHAIN_ID = 84532;
const EXECUTOR_ARTIFACT = readArtifact('AgentExecutor');
const LOOKALIKE = readArtifact('LookalikeExecutor', 'Impostors.sol');
const LEGACY = readArtifact('LegacyActionExecutor', 'Impostors.sol');

const deployer = anvilAccount(0);
const agent = anvilAccount(2);
const thief = anvilAccount(3).address;
/** The intended recipient of the swap / transfer. */
const TARGET = getAddress('0x00000000000000000000000000000000000d0001');
/** The "typo": an address with no code. */
const TYPO_EOA = getAddress('0x00000000000000000000000000000000000d0e0a');
/** A contract that is not ours: runtime `STOP` (accepts any call and value). */
const FOREIGN_CONTRACT = getAddress('0x00000000000000000000000000000000000d0c0c');
const FEE_WALLET = getAddress('0x00000000000000000000000000000000000d0fee');

let chain: LocalChain;
let policyModule: Address;
let executor: Address;
let lookalike: Address;
let legacy: Address;

type ExecutorModule = typeof import('../services/transaction/executor.service.js');
type SimulatorModule = typeof import('../services/transaction/simulator.service.js');
type SubmitterModule = typeof import('../services/transaction/submitter.service.js');
let m: { ExecutorService: ExecutorModule['ExecutorService']; SimulatorService: SimulatorModule['SimulatorService']; SubmitterService: SubmitterModule['SubmitterService'] };

beforeAll(async () => {
  chain = await startLocalChain({ port: anvilTestPort(2), chainId: CHAIN_ID });
  ({ policyModule, executor } = await deployPolicyStack(chain, { deployer, operator: anvilAccount(1).address, feeWallet: FEE_WALLET }));
  lookalike = await chain.deploy(deployer, LOOKALIKE, [policyModule, FEE_WALLET, 30n, thief]);
  legacy = await chain.deploy(deployer, LEGACY, [policyModule, FEE_WALLET, 30n]);
  await chain.rpc('anvil_setCode', [FOREIGN_CONTRACT, '0x00']);
  process.env['RPC_URL_84532'] = chain.rpcUrl;
  m = {
    ExecutorService: (await import('../services/transaction/executor.service.js')).ExecutorService,
    SimulatorService: (await import('../services/transaction/simulator.service.js')).SimulatorService,
    SubmitterService: (await import('../services/transaction/submitter.service.js')).SubmitterService,
  };
});

afterAll(() => {
  chain?.stop();
});

const balance = (address: Address) => chain.publicClient.getBalance({ address });

/**
 * The backend's ETH-value path with EXECUTOR_ADDRESS_84532 = `configured`:
 * wrap (ExecutorService), dry-run (SimulatorService eth_call path), sign +
 * broadcast (SubmitterService with the agent's key). Returns the dry-run
 * verdict, the receipt status and the balance changes.
 */
async function sendThroughConfiguredExecutor(configured: Address, amount: bigint) {
  process.env['EXECUTOR_ADDRESS_84532'] = configured;
  const wrapped = new m.ExecutorService({ warn: () => undefined }).wrapSingle(CHAIN_ID, { to: TARGET, data: '0x', value: amount });
  const simulator = new m.SimulatorService() as unknown as {
    simulateWithEthCall(p: { chainId: number; from: Address; to: Address; data: Hex; value: bigint }): Promise<{ success: boolean; error?: string }>;
  };
  const dryRun = await simulator.simulateWithEthCall({ chainId: CHAIN_ID, from: agent.address, to: wrapped.to, data: wrapped.data, value: wrapped.value });

  const watched = [TARGET, configured, thief, FEE_WALLET] as const;
  const before = await Promise.all(watched.map(balance));
  let status: 'success' | 'reverted' | 'not-sent' = 'not-sent';
  if (dryRun.success) {
    const submitter = new m.SubmitterService({
      client: () => chain.publicClient as never,
      wallet: { signTransaction: async ({ unsignedTx }) => agent.signTransaction(parseTransaction(unsignedTx as Hex) as TransactionSerializable) },
    });
    const { txHash } = await submitter.submit({ chainId: CHAIN_ID, walletId: 'agent', from: agent.address, to: wrapped.to, data: wrapped.data, value: wrapped.value });
    status = (await chain.publicClient.waitForTransactionReceipt({ hash: txHash })).status;
  }
  const after = await Promise.all(watched.map(balance));
  const delta = (i: number) => after[i]! - before[i]!;
  return { wrapped, dryRun, status, target: delta(0), configured: delta(1), thief: delta(2), feeWallet: delta(3) };
}

const AMOUNT = parseEther('1');
const FEE = (AMOUNT * 30n) / 10_000n;

describe('S9 — a wrong EXECUTOR_ADDRESS receives the value (current behaviour)', () => {
  it('baseline, our executor: the target gets the amount, the fee wallet the fee', async () => {
    const r = await sendThroughConfiguredExecutor(executor, AMOUNT);
    expect(r.wrapped.routedViaExecutor).toBe(true);
    expect(r.wrapped.value).toBe(AMOUNT + FEE);
    expect(r.dryRun.success).toBe(true);
    expect(r.status).toBe('success');
    expect(r.target).toBe(AMOUNT);
    expect(r.feeWallet).toBe(FEE);
  });

  it('an EOA (typo): the dry-run passes, the transaction succeeds, the EOA keeps amount + fee, the target gets nothing', async () => {
    const r = await sendThroughConfiguredExecutor(TYPO_EOA, AMOUNT);
    expect(r.dryRun.success).toBe(true);
    expect(r.status).toBe('success');
    expect(r.configured).toBe(AMOUNT + FEE);
    expect(r.target).toBe(0n);
  });

  it('a contract that is not ours (any payable fallback): same — it keeps amount + fee', async () => {
    const r = await sendThroughConfiguredExecutor(FOREIGN_CONTRACT, AMOUNT);
    expect(r.dryRun.success).toBe(true);
    expect(r.status).toBe('success');
    expect(r.configured).toBe(AMOUNT + FEE);
    expect(r.target).toBe(0n);
  });

  it('a lookalike answering our views exactly passes a view-based check, then forwards everything to a thief', async () => {
    const views = async (address: Address) =>
      Promise.all(
        (['policyModule', 'feeWallet', 'feeBps'] as const).map((functionName) =>
          chain.publicClient.readContract({ address, abi: EXECUTOR_ARTIFACT.abi, functionName }),
        ),
      );
    expect(await views(lookalike)).toEqual(await views(executor));

    const r = await sendThroughConfiguredExecutor(lookalike, AMOUNT);
    expect(r.dryRun.success).toBe(true);
    expect(r.status).toBe('success');
    expect(r.thief).toBe(AMOUNT + FEE);
    expect(r.target).toBe(0n);
    expect(r.feeWallet).toBe(0n);
  });

  it('the legacy build (old Action struct): same views, every executor call reverts — fail closed, nothing moves', async () => {
    const r = await sendThroughConfiguredExecutor(legacy, AMOUNT);
    expect(r.dryRun.success).toBe(false);
    expect(r.status).toBe('not-sent');
    expect(r.target).toBe(0n);
    expect(r.configured).toBe(0n);
  });
});

describe('S9 — identity evidence: code, not views', () => {
  async function code(address: Address): Promise<Hex | undefined> {
    return chain.publicClient.getCode({ address });
  }

  it('only our executor runs the artifact’s runtime code with its immutables filled in', async () => {
    expect(runsArtifact(await code(executor), EXECUTOR_ARTIFACT)).toBe(true);
    for (const impostor of [TYPO_EOA, FOREIGN_CONTRACT, lookalike, legacy]) {
      expect(runsArtifact(await code(impostor), EXECUTOR_ARTIFACT), impostor).toBe(false);
    }
  });

  it('the immutables are read from the code itself and equal the configuration the backend expects', async () => {
    const onChain = (await code(executor))!;
    const words = immutableValues(onChain, EXECUTOR_ARTIFACT.immutableReferences).map((w) => BigInt(w));
    // policyModule, feeWallet, feeBps — order of `immutableReferences` keys (AST ids) is not guaranteed: compare as a set.
    expect(new Set(words)).toEqual(new Set([BigInt(policyModule), BigInt(FEE_WALLET), 30n]));
  });

  it('the CBOR metadata trailer is part of the code (bytecode_hash = ipfs): a rebuild from changed source has another identity', async () => {
    const onChain = (await code(executor))!;
    const trailer = cborTrailer(onChain);
    expect(trailer).toBe(cborTrailer(EXECUTOR_ARTIFACT.deployedBytecode));
    // a2 64 'ipfs' 58 22 <34-byte multihash> 64 'solc' 43 <0.8.24> 00 33
    expect(trailer.startsWith('0xa264697066735822')).toBe(true);
    expect(trailer.endsWith('64736f6c634300081800 33'.replace(' ', ''))).toBe(true);
    expect(keccak256(onChain)).not.toBe(keccak256(EXECUTOR_ARTIFACT.deployedBytecode)); // immutables differ
  });
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
    // With the fee included it goes through.
    await expect(chain.publicClient.call({ account: agent.address, to: executor, data, value: AMOUNT + FEE })).resolves.toBeDefined();
  });
});
