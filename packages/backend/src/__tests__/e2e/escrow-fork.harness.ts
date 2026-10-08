/**
 * ERC-8183 escrow + ERC-8004 reputation rehearsal on a local Anvil fork of
 * Base Sepolia (task C5a) — shared harness.
 *
 * Used by:
 *  - `escrow-fork.global-setup.ts` (vitest globalSetup of
 *    `npm run test:e2e:escrow-fork`): fork + deploy + DB/Redis reset;
 *  - `escrow-erc8183.fork.e2e.ts` (the suite): backend child processes,
 *    cheat-code funding, HTTP and chain helpers;
 *  - `escrow-fork.stack.ts` (`npm run e2e:escrow-fork:stack`): the same
 *    stack kept running so `examples/escrow-erc8183` can be pointed at it.
 *
 * What is real and what is not:
 *  - Real (forked state): Circle's testnet USDC, the ERC-8004 Identity and
 *    Reputation registries (implementation v2.0.0), chain id 84532.
 *  - Deployed fresh on the fork with the C4 runbook script and env names:
 *    `AgentJobEscrow` + `ReputationHook` (`script/DeployEscrow.s.sol`).
 *  - Cheats (Anvil only): USDC balance written into the FiatToken storage
 *    slot, native ETH set with `anvil_setBalance`, chain time aligned to the
 *    wall clock (the backend computes `expiresAt` from it), and the EIP-7702
 *    delegations that sweeper bots put on the public Anvil test accounts on
 *    Base Sepolia cleared from the role accounts we reuse.
 *  - Keys: only Anvil's public test keys (mnemonic "test test … junk") and
 *    the backend's in-memory local wallets. Nothing here touches real funds.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { execAsync, FORGE_BIN, runMigrations, startAnvil } from './global-setup.js';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../../abi/ReputationHook.abi.js';

// ── Paths ──────────────────────────────────────────────────────────────────

/** packages/backend */
export const BACKEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));
/** packages/contracts */
export const CONTRACTS_DIR = fileURLToPath(new URL('../../../../contracts/', import.meta.url));
/** repository root */
export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

// ── Chain facts (Base Sepolia) ─────────────────────────────────────────────

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Fork block pinned for reproducibility (Base Sepolia, 2026-10-07): the
 * Identity Registry implementation v2.0.0 verified in R2 and the Reputation
 * Registry v2.0.0 are live there. Override with E2E_ANVIL_FORK_BLOCK_NUMBER
 * (`latest` = do not pin). The public RPC https://sepolia.base.org serves
 * archive state for it.
 */
export const DEFAULT_ESCROW_FORK_BLOCK = '47822000';

export const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const IDENTITY_REGISTRY_BASE_SEPOLIA: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const REPUTATION_REGISTRY_BASE_SEPOLIA: Address = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

/**
 * Circle FiatToken v2.2 keeps `balanceAndBlacklistStates` (balance in the low
 * 255 bits, blacklist flag in the top bit) in the mapping at storage slot 9,
 * where v1 kept `balances`. Writing a value below 2^255 at
 * keccak256(abi.encode(holder, 9)) sets the balance and leaves the holder
 * un-blacklisted. `setUsdcBalance` re-reads `balanceOf` and fails loudly if
 * the layout ever changes.
 */
export const FIAT_TOKEN_BALANCE_SLOT = 9n;

/** Platform fee configured by `DeployEscrow.s.sol` (default `FEE_BPS`). */
export const PLATFORM_FEE_BPS = 30n;

// ── Anvil public test accounts (mnemonic "test test … junk") ───────────────
// Public, well-known keys. On real Base Sepolia accounts 1–3 carry EIP-7702
// delegations to sweeper contracts; `startEscrowFork` clears them on the fork.

interface TestAccount {
  address: Address;
  privateKey: Hex;
}

export const ANVIL_ACCOUNTS = {
  /** account[0] — broadcasts DeployEscrow.s.sol (`--private-key`, like the runbook's CLI signer). */
  deployer: {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
  /** account[1] — `OPERATOR_ADDRESS` (pause, fee wallet rotation, fee sweep). */
  operator: {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  },
  /** account[2] — `FEE_WALLET` / backend `OPERATOR_FEE_WALLET`. */
  feeWallet: {
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  },
  /** account[3] — `TRUSTED_EVALUATOR` / backend `ESCROW_EVALUATOR_PRIVATE_KEY`. */
  evaluator: {
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    privateKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  },
} as const satisfies Record<string, TestAccount>;

// ── Minimal ABIs not generated in src/abi ──────────────────────────────────

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** ERC-8004 Reputation Registry (docs/architecture/erc-8004-integration.md §3). */
export const REPUTATION_REGISTRY_ABI = parseAbi([
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function getVersion() view returns (string)',
  'function getIdentityRegistry() view returns (address)',
]);

export const IDENTITY_REGISTRY_READ_ABI = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'function getVersion() view returns (string)',
]);

// ── Context handed from globalSetup to the suite ───────────────────────────

export interface EscrowForkContext {
  chainId: number;
  anvilRpc: string;
  /** Block the fork was taken at (pinned or resolved from `latest`). */
  forkBlockNumber: string;
  escrow: Address;
  hook: Address;
  usdc: Address;
  identityRegistry: Address;
  reputationRegistry: Address;
  deployer: Address;
  operator: Address;
  feeWallet: Address;
  evaluator: Address;
  evaluatorPrivateKey: Hex;
  databaseUrl: string;
  redisUrl: string;
  backendPort: number;
  apiSecret: string;
  adminSecret: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    /** null when E2E_ANVIL_FORK_URL is unset: the suite skips. */
    escrowFork: EscrowForkContext | null;
  }
}

// ── Configuration from env ─────────────────────────────────────────────────

export interface EscrowForkConfig {
  forkUrl: string;
  /** undefined = fork `latest`. */
  forkBlockNumber: string | undefined;
  anvilPort: number;
  backendPort: number;
  databaseUrl: string;
  redisUrl: string;
  apiSecret: string;
  adminSecret: string;
}

/** Reads the harness config; null when `E2E_ANVIL_FORK_URL` is unset (the suite then skips). */
export function readEscrowForkConfig(source: NodeJS.ProcessEnv = process.env): EscrowForkConfig | null {
  const forkUrl = source['E2E_ANVIL_FORK_URL']?.trim();
  if (!forkUrl) return null;
  const pinned = source['E2E_ANVIL_FORK_BLOCK_NUMBER']?.trim() || DEFAULT_ESCROW_FORK_BLOCK;
  return {
    forkUrl,
    forkBlockNumber: pinned === 'latest' ? undefined : pinned,
    anvilPort: Number(source['E2E_ESCROW_ANVIL_PORT'] || 8546),
    backendPort: Number(source['E2E_ESCROW_BACKEND_PORT'] || 3155),
    databaseUrl:
      source['E2E_DATABASE_URL']?.trim() || 'postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_escrow',
    redisUrl: source['E2E_ESCROW_REDIS_URL']?.trim() || 'redis://localhost:6379/13',
    apiSecret: source['API_SECRET'] || 'e2e-escrow-fork-api-secret-min-32-chars!!',
    adminSecret: source['ADMIN_SECRET'] || 'e2e-escrow-fork-admin-secret-min-32-chars',
  };
}

// ── JSON-RPC + cheat codes ─────────────────────────────────────────────────

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

export function forkClient(anvilRpc: string): PublicClient {
  return createPublicClient({
    chain: { ...baseSepolia, rpcUrls: { default: { http: [anvilRpc] } } },
    transport: http(anvilRpc),
    pollingInterval: 250,
  }) as PublicClient;
}

/** `anvil_setBalance` — native ETH for gas. */
export async function setEthBalance(anvilRpc: string, address: Address, wei: bigint): Promise<void> {
  await rpc(anvilRpc, 'anvil_setBalance', [address, numberToHex(wei)]);
}

/** Writes `units` (6 decimals) of fork USDC to `holder` through the FiatToken balance slot, then verifies `balanceOf`. */
export async function setUsdcBalance(anvilRpc: string, usdc: Address, holder: Address, units: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, FIAT_TOKEN_BALANCE_SLOT]));
  await rpc(anvilRpc, 'anvil_setStorageAt', [usdc, slot, numberToHex(units, { size: 32 })]);
  const balance = await forkClient(anvilRpc).readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] });
  if (balance !== units) {
    throw new Error(
      `USDC balance cheat failed: wrote ${units} at slot keccak(holder, ${FIAT_TOKEN_BALANCE_SLOT}) but balanceOf = ${balance} — ` +
        'the FiatToken storage layout changed; fund through anvil_impersonateAccount of a holder instead',
    );
  }
}

export async function usdcBalanceOf(anvilRpc: string, usdc: Address, holder: Address): Promise<bigint> {
  return forkClient(anvilRpc).readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] });
}

// ── Database + Redis isolation ─────────────────────────────────────────────

function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

/**
 * Migrates the suite's dedicated database (created if missing — `prisma
 * migrate deploy` does that) and empties every table, so jobs left by an
 * earlier run (their local wallets are gone) never reach the new workers.
 * Refuses to wipe `agentfi`, the docker-compose dev database.
 */
export async function resetTestDatabase(databaseUrl: string): Promise<void> {
  const name = databaseName(databaseUrl);
  if (!name || name === 'agentfi') {
    throw new Error(
      `[e2e:escrow-fork] refusing to reset database "${name || '(none)'}": point E2E_DATABASE_URL at a dedicated database ` +
        '(default postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_escrow)',
    );
  }
  await runMigrations(databaseUrl);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    if (tables.length > 0) {
      await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
    }
  } finally {
    await db.$disconnect();
  }
}

/**
 * The suite's BullMQ queues use the backend's fixed names (`transactions`,
 * `escrow-settlement`, …). A dev stack running on the same Redis logical DB
 * would steal those jobs (and fail: it does not hold the suite's in-memory
 * wallets), so the suite requires its own logical DB (default 13) and
 * flushes it before starting.
 */
export async function flushTestRedis(redisUrl: string): Promise<void> {
  const dbIndex = Number(new URL(redisUrl).pathname.replace(/^\//, '') || '0');
  if (!Number.isInteger(dbIndex) || dbIndex === 0) {
    throw new Error(
      `[e2e:escrow-fork] E2E_ESCROW_REDIS_URL=${redisUrl} uses Redis DB 0, which the dev stack's workers share — ` +
        'use a dedicated logical DB, e.g. redis://localhost:6379/13',
    );
  }
  const { Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

/**
 * Fails fast when `port` is taken — typically an Anvil or backend left over by
 * an interrupted run (on Windows killing the npm/vitest parent does not kill
 * its children) — instead of silently talking to a stale process.
 */
export async function assertPortFree(port: number, what: string): Promise<void> {
  const { createServer } = await import('net');
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(new Error(`[e2e:escrow-fork] port ${port} (${what}) is already in use — stop the leftover process or pick another port`)),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

// ── Fork + deployment ──────────────────────────────────────────────────────

export interface EscrowForkStack {
  context: EscrowForkContext;
  anvil: ChildProcess;
}

/** Parses `AGENT_JOB_ESCROW_ADDRESS_<id>=0x…` / `REPUTATION_HOOK_ADDRESS_<id>=0x…` from the script's "Copy to .env" block. */
export function parseDeployOutput(stdout: string, chainId: number): { escrow: Address; hook: Address } {
  const find = (name: string): Address => {
    const match = new RegExp(`${name}_${chainId}=(0x[0-9a-fA-F]{40})`).exec(stdout);
    if (!match?.[1]) throw new Error(`DeployEscrow.s.sol output has no ${name}_${chainId}=0x… line`);
    return getAddress(match[1]);
  };
  return { escrow: find('AGENT_JOB_ESCROW_ADDRESS'), hook: find('REPUTATION_HOOK_ADDRESS') };
}

/** Env of the `forge script` child: the runbook variables only, no inherited key or address overrides. */
function deployEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'PRIVATE_KEY',
    'USDC_ADDRESS',
    'REPUTATION_REGISTRY_ADDRESS',
    'IDENTITY_REGISTRY_ADDRESS',
    'FEE_BPS',
    'EVALUATOR_FEE_BPS',
    'MIN_FEEDBACK_BUDGET',
    'FEEDBACK_GAS_LIMIT',
    'IDENTITY_CALL_GAS_LIMIT',
  ]) {
    delete env[key];
  }
  // C4 runbook step 5, verbatim variable names.
  env['OPERATOR_ADDRESS'] = ANVIL_ACCOUNTS.operator.address;
  env['FEE_WALLET'] = ANVIL_ACCOUNTS.feeWallet.address;
  env['TRUSTED_EVALUATOR'] = ANVIL_ACCOUNTS.evaluator.address;
  return env;
}

/**
 * Starts the Base Sepolia fork, aligns its clock, clears the role accounts'
 * 7702 delegations, deploys `AgentJobEscrow` + `ReputationHook` with
 * `script/DeployEscrow.s.sol` exactly as the C4 runbook does (same script,
 * same env names; Anvil key instead of the keystore) and checks the result.
 */
export async function startEscrowFork(config: EscrowForkConfig, log: (msg: string) => void = console.log): Promise<EscrowForkStack> {
  // The fork source must be Base Sepolia: E2E_ANVIL_FORK_URL is also the
  // variable of `test:e2e:fork` (Base mainnet), so check before forking.
  const sourceChainId = Number(await rpc<string>(config.forkUrl, 'eth_chainId'));
  if (sourceChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `[e2e:escrow-fork] E2E_ANVIL_FORK_URL answers chain ${sourceChainId}; the escrow rehearsal needs a Base Sepolia (84532) RPC, ` +
        'e.g. https://sepolia.base.org',
    );
  }

  for (const [role, account] of Object.entries(ANVIL_ACCOUNTS)) {
    if (privateKeyToAccount(account.privateKey).address !== account.address) {
      throw new Error(`ANVIL_ACCOUNTS.${role}: key does not match address`);
    }
  }

  await assertPortFree(config.anvilPort, 'Anvil, E2E_ESCROW_ANVIL_PORT');
  await assertPortFree(config.backendPort, 'backend, E2E_ESCROW_BACKEND_PORT');

  const anvilRpc = `http://127.0.0.1:${config.anvilPort}`;
  log(`[e2e:escrow-fork] Starting Anvil fork of Base Sepolia on ${anvilRpc} (block ${config.forkBlockNumber ?? 'latest'})…`);
  const anvil = await startAnvil({
    port: config.anvilPort,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    forkUrl: config.forkUrl,
    forkBlockNumber: config.forkBlockNumber,
    readyTimeoutMs: 60_000,
  });

  try {
    const client = forkClient(anvilRpc);
    const forkBlockNumber = config.forkBlockNumber ?? (await client.getBlockNumber()).toString();

    // The backend computes `expiresAt` (= on-chain `expiredAt`) from the wall
    // clock; a pinned fork starts at the fork block's timestamp. Align them.
    await rpc(anvilRpc, 'anvil_setTime', [Math.floor(Date.now() / 1000)]);
    await rpc(anvilRpc, 'evm_mine');

    // Sweeper bots set EIP-7702 delegations on the public Anvil accounts on
    // Base Sepolia; on the fork that code would run on every ETH receipt.
    for (const account of [ANVIL_ACCOUNTS.operator, ANVIL_ACCOUNTS.feeWallet, ANVIL_ACCOUNTS.evaluator]) {
      await rpc(anvilRpc, 'anvil_setCode', [account.address, '0x']);
      await setEthBalance(anvilRpc, account.address, 10n ** 20n);
    }
    await setEthBalance(anvilRpc, ANVIL_ACCOUNTS.deployer.address, 10n ** 20n);

    log('[e2e:escrow-fork] Deploying AgentJobEscrow + ReputationHook with script/DeployEscrow.s.sol…');
    let stdout: string;
    try {
      ({ stdout } = await execAsync(
        `"${FORGE_BIN}" script script/DeployEscrow.s.sol --rpc-url ${anvilRpc} --broadcast --private-key ${ANVIL_ACCOUNTS.deployer.privateKey}`,
        { cwd: CONTRACTS_DIR, env: deployEnv(), maxBuffer: 32 * 1024 * 1024 },
      ));
    } catch (err) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      throw new Error(`[e2e:escrow-fork] forge script DeployEscrow.s.sol failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
    }
    const { escrow, hook } = parseDeployOutput(stdout, BASE_SEPOLIA_CHAIN_ID);

    // What C4's "Post-deployment checks" verify, on the fork.
    const [
      token,
      feeBps,
      operator,
      acp,
      trustedEvaluator,
      identityRegistry,
      reputationRegistry,
      minFeedbackBudget,
      feedbackGasLimit,
      identityCallGasLimit,
    ] = await Promise.all([
      client.readContract({ address: escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'token' }),
      client.readContract({ address: escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'platformFeeBP' }),
      client.readContract({ address: escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'operator' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'acp' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'trustedEvaluator' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'identityRegistry' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'reputationRegistry' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'minFeedbackBudget' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'feedbackGasLimit' }),
      client.readContract({ address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'identityCallGasLimit' }),
    ]);
    const mismatches = [
      getAddress(token as Address) !== USDC_BASE_SEPOLIA && `token ${token}`,
      BigInt(feeBps as bigint) !== PLATFORM_FEE_BPS && `platformFeeBP ${feeBps}`,
      getAddress(operator as Address) !== ANVIL_ACCOUNTS.operator.address && `operator ${operator}`,
      getAddress(acp as Address) !== escrow && `hook.acp ${acp}`,
      getAddress(trustedEvaluator as Address) !== ANVIL_ACCOUNTS.evaluator.address && `hook.trustedEvaluator ${trustedEvaluator}`,
      getAddress(identityRegistry as Address) !== IDENTITY_REGISTRY_BASE_SEPOLIA && `hook.identityRegistry ${identityRegistry}`,
      getAddress(reputationRegistry as Address) !== REPUTATION_REGISTRY_BASE_SEPOLIA && `hook.reputationRegistry ${reputationRegistry}`,
      BigInt(minFeedbackBudget as bigint) !== 1_000_000n && `hook.minFeedbackBudget ${minFeedbackBudget}`,
      // R3c deploy defaults (FEEDBACK_GAS_LIMIT / IDENTITY_CALL_GAS_LIMIT unset).
      BigInt(feedbackGasLimit as bigint) !== 500_000n && `hook.feedbackGasLimit ${feedbackGasLimit}`,
      BigInt(identityCallGasLimit as bigint) !== 50_000n && `hook.identityCallGasLimit ${identityCallGasLimit}`,
    ].filter(Boolean);
    if (mismatches.length > 0) throw new Error(`[e2e:escrow-fork] unexpected deployment: ${mismatches.join(', ')}`);
    log(`[e2e:escrow-fork] AgentJobEscrow ${escrow} · ReputationHook ${hook} (fork block ${forkBlockNumber})`);

    return {
      anvil,
      context: {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        anvilRpc,
        forkBlockNumber,
        escrow,
        hook,
        usdc: USDC_BASE_SEPOLIA,
        identityRegistry: IDENTITY_REGISTRY_BASE_SEPOLIA,
        reputationRegistry: REPUTATION_REGISTRY_BASE_SEPOLIA,
        deployer: ANVIL_ACCOUNTS.deployer.address,
        operator: ANVIL_ACCOUNTS.operator.address,
        feeWallet: ANVIL_ACCOUNTS.feeWallet.address,
        evaluator: ANVIL_ACCOUNTS.evaluator.address,
        evaluatorPrivateKey: ANVIL_ACCOUNTS.evaluator.privateKey,
        databaseUrl: config.databaseUrl,
        redisUrl: config.redisUrl,
        backendPort: config.backendPort,
        apiSecret: config.apiSecret,
        adminSecret: config.adminSecret,
      },
    };
  } catch (err) {
    anvil.kill('SIGTERM');
    throw err;
  }
}

// ── Backend child process ──────────────────────────────────────────────────

export interface BackendHandle {
  url: string;
  logFile: string;
  /** Last `lines` lines of the backend log (diagnostics on failure). */
  logTail(lines?: number): string;
  stop(): Promise<void>;
}

/** Inherited variables that would change what the backend talks to: dropped before the explicit ones are set. */
const INHERITED_ENV_DROP = [
  /^(POLICY_MODULE|EXECUTOR|ESCROW_MODULE|AGENT_JOB_ESCROW|REPUTATION_HOOK|IDENTITY_REGISTRY)_ADDRESS_\d+$/,
  /^RPC_URL_\d+$/,
  /^ESCROW_/,
  /^TENDERLY_/,
  /^STRIPE_/,
  /^ENS_/,
  /^VITEST/,
  /^SAFE_DEPLOYER_PRIVATE_KEY$/,
  /^NODE_OPTIONS$/,
  /^PORT$/,
  /^INFURA_API_KEY$/,
];

/**
 * The backend env of the rehearsal — what an operator would put in `.env`
 * for C5, with the fork in place of Base Sepolia:
 * `RPC_URL_84532` → Anvil, `AGENT_JOB_ESCROW_ADDRESS_84532` /
 * `REPUTATION_HOOK_ADDRESS_84532` from the deploy, the evaluator key, the
 * local wallet provider, and dummy Alchemy/Infura keys so no RPC fallback
 * can reach the real network with a fork-signed transaction.
 */
export function backendEnv(ctx: EscrowForkContext, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED_ENV_DROP.some((re) => re.test(key))) env[key] = value;
  }
  const url = `http://127.0.0.1:${ctx.backendPort}`;
  Object.assign(env, {
    NODE_ENV: 'development',
    API_PORT: String(ctx.backendPort),
    API_SECRET: ctx.apiSecret,
    ADMIN_SECRET: ctx.adminSecret,
    DATABASE_URL: ctx.databaseUrl,
    REDIS_URL: ctx.redisUrl,
    WALLET_PROVIDER: 'local',
    ALCHEMY_API_KEY: 'e2e-escrow-fork-dummy',
    TURNKEY_API_PUBLIC_KEY: 'e2e-dummy',
    TURNKEY_API_PRIVATE_KEY: 'e2e-dummy',
    TURNKEY_ORGANIZATION_ID: 'e2e-dummy',
    OPERATOR_FEE_WALLET: ctx.feeWallet,
    TRANSACTION_WORKER_ENABLED: 'true',
    [`RPC_URL_${ctx.chainId}`]: ctx.anvilRpc,
    [`AGENT_JOB_ESCROW_ADDRESS_${ctx.chainId}`]: ctx.escrow,
    [`REPUTATION_HOOK_ADDRESS_${ctx.chainId}`]: ctx.hook,
    ESCROW_EVALUATOR_PRIVATE_KEY: ctx.evaluatorPrivateKey,
    ESCROW_EVALUATION_DELAY_SECONDS: '0',
    BACKEND_PUBLIC_URL: url,
    // Agents poll their jobs; the FREE default (30/min) is for the public API.
    RATE_LIMIT_FREE: '6000',
    // Never read a stray packages/backend/.env into the rehearsal.
    DOTENV_CONFIG_PATH: join(tmpdir(), 'agentfi-escrow-fork-no-dotenv'),
    ...overrides,
  });
  return env;
}

/**
 * Boots `src/index.ts` (API + transaction worker + escrow settlement worker +
 * payment recovery, exactly as `npm run dev` wires them) in a child process
 * and resolves once `GET /health` answers. Its local wallets live in that
 * process, so agents registered through one backend can only be driven by
 * that backend.
 */
export async function startBackend(
  ctx: EscrowForkContext,
  opts: { name: string; overrides?: Record<string, string>; readyTimeoutMs?: number },
): Promise<BackendHandle> {
  const url = `http://127.0.0.1:${ctx.backendPort}`;
  const logDir = join(tmpdir(), 'agentfi-escrow-fork');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `backend-${opts.name}-${Date.now()}.log`);
  const logStream: WriteStream = createWriteStream(logFile);

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env: backendEnv(ctx, opts.overrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  let exited: number | null | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      exited = code;
      resolve();
    });
  });

  const logTail = (lines = 80): string => {
    try {
      // eslint-disable-next-line no-control-regex
      const text = readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
      return text.split(/\r?\n/).slice(-lines).join('\n');
    } catch {
      return '(no backend log)';
    }
  };

  const stop = async (): Promise<void> => {
    if (exited === undefined) {
      child.kill('SIGTERM');
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 10_000))]);
    }
    logStream.end();
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 90_000);
  for (;;) {
    if (exited !== undefined) {
      await stop();
      throw new Error(`[e2e:escrow-fork] backend "${opts.name}" exited with code ${exited} before it was ready:\n${logTail()}`);
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`[e2e:escrow-fork] backend "${opts.name}" not ready after ${opts.readyTimeoutMs ?? 90_000} ms:\n${logTail()}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return { url, logFile, logTail, stop };
}

// ── HTTP (what an agent does) ──────────────────────────────────────────────

export interface ApiResult<T> {
  status: number;
  body: T;
  raw: string;
}

/** One HTTP call to the backend; never throws on a non-2xx status (callers assert). */
export async function call<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  opts: { method?: string; apiKey?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // not JSON — keep the text
  }
  return { status: res.status, body: body as T, raw };
}

/** Polls `read` until `done` (resolve) or `fail` (reject with its message); rejects on timeout with the last value. */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; fail?: (value: T) => string | null; describe?: (value: T) => string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    const failure = opts.fail?.(last);
    if (failure) throw new Error(`${what}: ${failure}`);
    if (Date.now() > deadline) {
      throw new Error(`${what}: timed out after ${opts.timeoutMs} ms; last = ${opts.describe ? opts.describe(last) : JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
  }
}

/** True when a file the harness depends on exists (used by the stack script's preflight). */
export function contractsCheckedOut(): boolean {
  return existsSync(join(CONTRACTS_DIR, 'lib', 'forge-std', 'src', 'Script.sol'));
}
