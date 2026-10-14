/**
 * Real local contracts on Anvil for `*.anvil.ts` suites (`vitest.config.anvil.ts`).
 *
 * Each suite starts its OWN Anvil on `anvilTestPort(offset)` — base port from
 * `ANVIL_TEST_PORT_BASE` (default 8745), so a suite never shares the dev
 * stack's or the E2E harness's node — and deploys the contracts it needs from
 * the Foundry artifacts in `packages/contracts/out` (`forge build` first; a
 * missing artifact fails the suite with the command to run).
 *
 * Accounts are Anvil's well-known pre-funded keys (test values only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { startAnvil, stopAnvil } from '../e2e/global-setup.js';

/** Anvil's default mnemonic accounts 0–4 (pre-funded with 10 000 ETH each). */
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
] as const satisfies readonly Hex[];

export function anvilAccount(index: 0 | 1 | 2 | 3 | 4): PrivateKeyAccount {
  return privateKeyToAccount(ANVIL_KEYS[index]);
}

/** `ANVIL_TEST_PORT_BASE` (default 8745) + `offset`: one port per suite. */
export function anvilTestPort(offset: number): number {
  const base = Number(process.env['ANVIL_TEST_PORT_BASE'] ?? 8745);
  return base + offset;
}

export const CONTRACTS_DIR = join(process.cwd(), '../contracts');

export interface FoundryArtifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
}

/** `packages/contracts/out/<Name>.sol/<Name>.json`. */
export function readArtifact(contractName: string, sourceFile = `${contractName}.sol`): FoundryArtifact {
  const path = join(CONTRACTS_DIR, 'out', sourceFile, `${contractName}.json`);
  if (!existsSync(path)) {
    throw new Error(`Foundry artifact ${path} is missing — run \`forge build\` in packages/contracts first`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
    deployedBytecode: { object: Hex; immutableReferences?: FoundryArtifact['immutableReferences'] };
  };
  return {
    abi: raw.abi,
    bytecode: raw.bytecode.object,
    deployedBytecode: raw.deployedBytecode.object,
    immutableReferences: raw.deployedBytecode.immutableReferences ?? {},
  };
}

export interface LocalChain {
  chainId: number;
  rpcUrl: string;
  publicClient: PublicClient;
  wallet(account: PrivateKeyAccount): ReturnType<typeof createWalletClient>;
  /** Deploys `artifact` with `args` from `account`; resolves to the contract address. */
  deploy(account: PrivateKeyAccount, artifact: FoundryArtifact, args?: readonly unknown[]): Promise<Address>;
  /** `anvil_setBalance`. */
  setBalance(address: Address, wei: bigint): Promise<void>;
  /** Raw JSON-RPC call (anvil_* / evm_* cheats). */
  rpc(method: string, params: unknown[]): Promise<unknown>;
  stop(): void;
}

/** Starts Anvil on `port` with `chainId` (a fork of `forkUrl` when given) and returns clients bound to it. */
export async function startLocalChain(opts: {
  port: number;
  chainId: number;
  forkUrl?: string | undefined;
  forkBlockNumber?: string | undefined;
}): Promise<LocalChain> {
  const child: ChildProcess = await startAnvil({
    port: opts.port,
    chainId: opts.chainId,
    forkUrl: opts.forkUrl,
    forkBlockNumber: opts.forkBlockNumber,
    ...(opts.forkUrl ? { readyTimeoutMs: 90_000 } : {}),
  });
  const rpcUrl = `http://127.0.0.1:${opts.port}`;
  const chain = defineChain({
    id: opts.chainId,
    name: `anvil-${opts.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpcUrl) });
  let id = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  return {
    chainId: opts.chainId,
    rpcUrl,
    publicClient,
    wallet,
    async deploy(account, artifact, args = []) {
      const hash = await wallet(account).deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        args: args as unknown[],
        account,
        chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error(`deployment ${hash} created no contract`);
      return receipt.contractAddress;
    },
    async setBalance(address, wei) {
      await rpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
    },
    rpc,
    stop: () => stopAnvil(child),
  };
}

/** `AgentPolicyModule(operator)` + `AgentExecutor(module, feeWallet, feeBps)` from the Foundry artifacts. */
export async function deployPolicyStack(
  chain: LocalChain,
  opts: { deployer: PrivateKeyAccount; operator: Address; feeWallet: Address; feeBps?: bigint },
): Promise<{ policyModule: Address; executor: Address }> {
  const policyModule = await chain.deploy(opts.deployer, readArtifact('AgentPolicyModule'), [opts.operator]);
  const executor = await chain.deploy(opts.deployer, readArtifact('AgentExecutor'), [
    policyModule,
    opts.feeWallet,
    opts.feeBps ?? 30n,
  ]);
  return { policyModule, executor };
}
