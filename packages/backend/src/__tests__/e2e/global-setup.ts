/**
 * E2E Global Setup — runs once before all e2e test workers.
 *
 * 1. Builds Solidity contracts (forge build).
 * 2. Starts a local Anvil node on port 8545, impersonating chain 8453 (Base).
 * 3. Deploys AgentPolicyModule + AgentExecutor to Anvil.
 * 4. Writes contract addresses + Anvil RPC URL into process.env so that the
 *    forked test worker inherits them.
 *
 * Teardown kills the Anvil process.
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const execAsync = promisify(exec);

// ── Constants ──────────────────────────────────────────────────────────────

export const ANVIL_PORT = 8545;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
export const ANVIL_CHAIN_ID = 8453; // pretend to be Base

// Anvil's well-known account[0] — pre-funded with 10 000 ETH.
export const DEPLOYER_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const DEPLOYER_ADDRESS: Address =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// ── Resolve Foundry binaries ───────────────────────────────────────────────
// Foundry's installer puts binaries in ~/.foundry/bin/ which is not always
// in PATH (especially on Windows git-bash / CI without PATH export).

function resolveFoundryBin(name: string): string {
  // 1. Trust PATH first
  // We detect it's available by checking the well-known install dir directly.
  const candidates = [
    name, // already in PATH
    join(homedir(), '.foundry', 'bin', name),          // Linux / macOS
    join(homedir(), '.foundry', 'bin', `${name}.exe`), // Windows
  ];
  for (const candidate of candidates) {
    if (candidate === name) continue; // skip the "trust PATH" entry for exists check
    if (existsSync(candidate)) return candidate;
  }
  return name; // fall back to PATH — will fail with a clear OS error if absent
}

const FORGE_BIN = resolveFoundryBin('forge');
const ANVIL_BIN = resolveFoundryBin('anvil');

// ── State ──────────────────────────────────────────────────────────────────

let anvilProcess: ReturnType<typeof spawn> | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

async function waitForAnvil(timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1,
        }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Anvil did not start within ${timeout}ms`);
}

function readArtifact(contractsDir: string, contractName: string) {
  const path = join(
    contractsDir,
    'out',
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    abi: unknown[];
    bytecode: { object: `0x${string}` };
  };
  return { abi: raw.abi, bytecode: raw.bytecode.object };
}

// ── Exported Vitest globalSetup hooks ─────────────────────────────────────

export async function setup(): Promise<void> {
  // Load root .env for any missing vars, then override DB/Redis to local
  // so E2E never touches production Neon/Upstash instances.
  const { config: loadDotenv } = await import('dotenv');
  loadDotenv({ path: join(process.cwd(), '../../.env') });

  const LOCAL_DB = process.env['E2E_DATABASE_URL'] ?? 'postgresql://agentfi:agentfi@localhost:5432/agentfi';
  process.env['DATABASE_URL'] = LOCAL_DB;
  process.env['REDIS_URL'] = 'redis://localhost:6379';

  const forkUrl = process.env['E2E_ANVIL_FORK_URL'];
  const forkRequired = process.env['E2E_ANVIL_FORK_REQUIRED'] === 'true';
  const forkBlockNumber = process.env['E2E_ANVIL_FORK_BLOCK_NUMBER'];

  if (forkRequired && !forkUrl) {
    throw new Error(
      '[e2e] Fork mode required but E2E_ANVIL_FORK_URL is not set. ' +
      'Set a Base RPC URL and rerun test:e2e:fork.',
    );
  }

  // CWD when vitest runs from packages/backend → contracts is a sibling dir
  const contractsDir = join(process.cwd(), '../contracts');

  // Run DB migrations before anything else
  console.log('[e2e] Running database migrations…');
  try {
    await execAsync('npx prisma migrate deploy', { cwd: process.cwd() });
    console.log('[e2e] Migrations applied.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[e2e] prisma migrate deploy failed: ${msg}`);
  }

  // 1 ─ Build contracts (skip if artifacts already exist from a prior build)
  const policyArtifactPath = join(
    contractsDir,
    'out',
    'AgentPolicyModule.sol',
    'AgentPolicyModule.json',
  );
  if (!existsSync(policyArtifactPath)) {
    console.log(`[e2e] Building contracts (${FORGE_BIN} build)…`);
    try {
      await execAsync(`"${FORGE_BIN}" build`, { cwd: contractsDir });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[e2e] forge build failed.\n` +
        `Make sure Foundry is installed: https://getfoundry.sh\n` +
        `Tried binary: ${FORGE_BIN}\n` +
        `Detail: ${msg}`,
      );
    }
    console.log('[e2e] Contracts built.');
  } else {
    console.log('[e2e] Contract artifacts already exist — skipping forge build.');
  }

  // 2 ─ Start Anvil
  const anvilArgs = [
    '--port', String(ANVIL_PORT),
    '--chain-id', String(ANVIL_CHAIN_ID),
    '--silent',
  ];

  if (forkUrl) {
    anvilArgs.push('--fork-url', forkUrl);
    if (forkBlockNumber) {
      anvilArgs.push('--fork-block-number', forkBlockNumber);
    }
    process.env['E2E_ANVIL_MODE'] = 'fork';
    console.log(
      `[e2e] Starting Anvil fork on port ${ANVIL_PORT} (chain-id ${ANVIL_CHAIN_ID})…`,
    );
  } else {
    process.env['E2E_ANVIL_MODE'] = 'local';
    console.log(`[e2e] Starting Anvil on port ${ANVIL_PORT} (chain-id ${ANVIL_CHAIN_ID})…`);
  }

  anvilProcess = spawn(
    ANVIL_BIN,
    anvilArgs,
    { stdio: 'ignore', detached: false },
  );
  anvilProcess.on('error', (err) => {
    console.error('[e2e] Anvil process error:', err.message);
  });

  await waitForAnvil();
  console.log('[e2e] Anvil ready.');

  // 3 ─ Deploy contracts
  const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

  // Construct an inline chain definition that points to Anvil
  const anvilChain = {
    ...base,
    id: ANVIL_CHAIN_ID,
    rpcUrls: {
      default: { http: [ANVIL_RPC] },
      public: { http: [ANVIL_RPC] },
    },
  } as const;

  const walletClient = createWalletClient({
    account,
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });
  const publicClient = createPublicClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });

  // Deploy AgentPolicyModule(operator)
  const { abi: policyAbi, bytecode: policyBytecode } = readArtifact(
    contractsDir,
    'AgentPolicyModule',
  );
  const policyHash = await walletClient.deployContract({
    abi: policyAbi,
    bytecode: policyBytecode,
    args: [account.address],
  });
  const policyReceipt = await publicClient.waitForTransactionReceipt({
    hash: policyHash,
  });
  const policyAddress = policyReceipt.contractAddress!;
  console.log('[e2e] AgentPolicyModule deployed at', policyAddress);

  // Deploy AgentExecutor(policyModule, feeWallet, feeBps)
  const { abi: executorAbi, bytecode: executorBytecode } = readArtifact(
    contractsDir,
    'AgentExecutor',
  );
  const executorHash = await walletClient.deployContract({
    abi: executorAbi,
    bytecode: executorBytecode,
    args: [policyAddress, account.address, 30n], // FREE tier fee = 30 bps
  });
  const executorReceipt = await publicClient.waitForTransactionReceipt({
    hash: executorHash,
  });
  const executorAddress = executorReceipt.contractAddress!;
  console.log('[e2e] AgentExecutor deployed at', executorAddress);

  // 4 ─ Propagate addresses to test worker via process.env
  //     (inherited on fork since singleFork = true)
  process.env['E2E_ANVIL_RPC'] = ANVIL_RPC;
  process.env['E2E_DEPLOYER_ADDRESS'] = account.address;
  process.env['POLICY_MODULE_ADDRESS_8453'] = policyAddress;
  process.env['EXECUTOR_ADDRESS_8453'] = executorAddress;
  // Use deployer as fee wallet so fee transfers actually land somewhere on Anvil
  process.env['OPERATOR_FEE_WALLET'] = account.address;

  console.log('[e2e] Setup complete.');
}

export async function teardown(): Promise<void> {
  if (anvilProcess) {
    anvilProcess.kill('SIGTERM');
    anvilProcess = null;
    console.log('[e2e] Anvil stopped.');
  }
}
