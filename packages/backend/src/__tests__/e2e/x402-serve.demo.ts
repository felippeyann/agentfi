/**
 * x402 "serve" mode: the REAL LOCAL BACKEND of the fork demo, kept running for an agent framework to use
 * (alpha entry-experience, front 1A, 2026-11-18).
 *
 *   cd packages/backend
 *   npm run demo:x402:serve -- --out-dir <dir> [--stop-file <file>]
 *   (or, with the checks and the destructive-target banner: `npm run alpha:serve` / `npm run alpha:framework` at the repo root)
 *
 * It boots the same pieces as `x402-spend.demo.ts` and then WAITS (Ctrl+C or the stop file):
 *   - Anvil forking Base Sepolia (LOCAL chain; nothing is sent to the public testnet);
 *   - the API (`src/index.ts`) and the WORKER (`src/worker.ts`, automatic reconciliation);
 *   - a seller we control with the REAL `@x402/evm` exact facilitator settling on the fork:
 *       /report 0.30 USDC (allowed), /report-premium 0.60 USDC (above the per-payment policy cap);
 *   - the operator policy (<= 0.50 USD per payment, <= 3.00 USD per day, only to the seller), a requester and a
 *     provider (buyer) agent, an ACCEPTED USDC job with a 5.00 budget and a second one with 0.20, and the
 *     provider wallet funded on the FORK (storage write; no faucet, no real funds).
 *
 * Files written to --out-dir (all KEY=VALUE, shell-sourceable; written atomically, `agent.env` last = ready):
 *   operator.env  what `npm run x402:ops -- status --job $AGENTFI_JOB_ID` needs (DATABASE_URL, RPC_URL_84532, ...)
 *                 plus CONTROL_URL (read-only evidence endpoint of THIS process). Holds the demo operator secrets:
 *                 never hand it to the agent.
 *   agent.env     what the AGENT side needs: AGENTFI_API_URL, AGENTFI_API_KEY (the PROVIDER agent's key), job ids,
 *                 seller URLs. No operator secret.
 *
 * Destructive: truncates the target database and flushes the Redis DB exactly like the demo (the harness guard
 * refuses non-loopback hosts, names outside /(^|_)(e2e|demo|test)(_|$)/i and Redis DB 0).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';
import { getAddress, parseAbiItem, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startAnvil, stopAnvil } from './global-setup.js';
import {
  ANVIL_ACCOUNTS,
  BACKEND_DIR,
  USDC_BASE_SEPOLIA,
  assertPortFree,
  backendEnv,
  call,
  flushTestRedis,
  forkClient,
  resetTestDatabase,
  rpc,
  setEthBalance,
  setUsdcBalance,
  startBackend,
  usdcBalanceOf,
  type EscrowForkContext,
} from './escrow-fork.harness.js';
import { startDemoSeller } from './x402-demo-seller.js';

loadDotenv({ path: join(tmpdir(), 'agentfi-x402-demo-no-dotenv') });

const ANVIL_PORT = Number(process.env['X402_DEMO_ANVIL_PORT'] || 8547);
const BACKEND_PORT = Number(process.env['X402_DEMO_BACKEND_PORT'] || 3157);
const FORK_URL = process.env['E2E_ANVIL_FORK_URL']?.trim() || 'https://sepolia.base.org';
const FORK_BLOCK = process.env['E2E_ANVIL_FORK_BLOCK_NUMBER']?.trim() || undefined;
const DATABASE_URL = process.env['X402_DEMO_DATABASE_URL']?.trim() || 'postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402';
const REDIS_URL = process.env['X402_DEMO_REDIS_URL']?.trim() || 'redis://localhost:6379/14';
const API_SECRET = 'x402-demo-operator-secret-min-32-chars!!';
const ADMIN_SECRET = 'x402-demo-admin-secret-min-32-chars!!!!';
const LOG_DIR = join(tmpdir(), 'agentfi-x402-demo');

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT_DIR = resolve(argValue('--out-dir') || join(tmpdir(), 'agentfi-alpha-serve'));
const STOP_FILE = resolve(argValue('--stop-file') || join(OUT_DIR, 'stop'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (text = '') => console.log(text);
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** KEY=VALUE lines, written to a temp name and renamed so a reader never sees half a file. */
function writeEnvFile(path: string, entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error(`bad env entry ${key}`);
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  renameSync(tmp, path);
}

interface WorkerHandle {
  logFile: string;
  child: ChildProcess;
  exited: Promise<void>;
}
function startWorker(env: NodeJS.ProcessEnv): WorkerHandle {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `worker-serve-${Date.now()}.log`);
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  return { logFile, child, exited };
}

async function main(): Promise<void> {
  const sourceChain = Number(await rpc<string>(FORK_URL, 'eth_chainId'));
  if (sourceChain !== 84532) throw new Error(`E2E_ANVIL_FORK_URL answers chain ${sourceChain}; need Base Sepolia (84532)`);
  await assertPortFree(ANVIL_PORT, 'Anvil (X402_DEMO_ANVIL_PORT)');
  await assertPortFree(BACKEND_PORT, 'backend (X402_DEMO_BACKEND_PORT)');
  const pgUrl = new URL(DATABASE_URL);
  const redisUrl = new URL(REDIS_URL);
  say(
    `DESTRUCTIVE: this run WIPES Postgres ${pgUrl.hostname}:${pgUrl.port || 5432} database "${pgUrl.pathname.replace(/^\//, '')}" (all tables TRUNCATED) ` +
      `and Redis ${redisUrl.hostname}:${redisUrl.port || 6379} logical DB ${redisUrl.pathname.replace(/^\//, '') || '0'} (FLUSHDB).\n`,
  );
  await resetTestDatabase(DATABASE_URL);
  await flushTestRedis(REDIS_URL);
  mkdirSync(OUT_DIR, { recursive: true });
  // A stale stop file from an earlier run must not stop this one at once.
  const staleStop = existsSync(STOP_FILE);
  if (staleStop) throw new Error(`stop file ${STOP_FILE} already exists; remove it first`);

  const anvilRpc = `http://127.0.0.1:${ANVIL_PORT}`;
  const anvil = await startAnvil({ port: ANVIL_PORT, chainId: 84532, forkUrl: FORK_URL, forkBlockNumber: FORK_BLOCK, readyTimeoutMs: 60_000 });
  const cleanups: Array<() => Promise<void> | void> = [() => stopAnvil(anvil)];
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  cleanups.push(() => db.$disconnect());
  let worker: WorkerHandle | undefined;
  try {
    await rpc(anvilRpc, 'anvil_setTime', [Math.floor(Date.now() / 1000)]);
    await rpc(anvilRpc, 'evm_mine');
    const forkBlock = await forkClient(anvilRpc).getBlockNumber();
    await rpc(anvilRpc, 'anvil_setCode', [ANVIL_ACCOUNTS.operator.address, '0x']);
    await setEthBalance(anvilRpc, ANVIL_ACCOUNTS.operator.address, 10n ** 20n);

    const seller = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    const shop = await startDemoSeller(anvilRpc, seller);
    cleanups.push(shop.close);

    const ctx = {
      chainId: 84532, anvilRpc, backendPort: BACKEND_PORT, apiSecret: API_SECRET, adminSecret: ADMIN_SECRET,
      databaseUrl: DATABASE_URL, redisUrl: REDIS_URL, feeWallet: ANVIL_ACCOUNTS.feeWallet.address,
      escrow: '', hook: '', evaluatorPrivateKey: '',
    } as unknown as EscrowForkContext;
    const common = {
      // Non-production only: lets the API call a seller on 127.0.0.1 (the outbound URL policy refuses private hosts otherwise).
      RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true',
      SYNTHETIC_TEST_PRICES_USD: '84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
      DOTENV_CONFIG_PATH: join(tmpdir(), 'agentfi-x402-demo-no-dotenv'),
    };
    const backend = await startBackend(ctx, { name: 'x402-serve', overrides: { ...common, TRANSACTION_WORKER_ENABLED: 'false' } });
    cleanups.push(() => backend.stop());
    const workerEnv = backendEnv(ctx, {
      ...common,
      TRANSACTION_WORKER_ENABLED: 'true',
      X402_RECONCILE_SECOND_RPC_URL_84532: anvilRpc, // same Anvil node: wiring, not independence
      PAYMENT_RECOVERY_INTERVAL_SEC: '2',
      X402_RECONCILE_HEAD: 'latest-0',
      X402_RECONCILE_LOCAL_CHAIN: 'true',
      X402_RECONCILE_EXPIRY_MARGIN_SEC: '10',
      X402_RECONCILE_BACKOFF_BASE_SEC: '2',
      X402_RECONCILE_BACKOFF_CAP_SEC: '4',
      X402_RECONCILE_MAX_ATTEMPTS: '30',
      X402_RECONCILE_STALE_SEC: '10', // a settled-but-unproven row is looked at after this (default 5 min)
    });
    worker = startWorker(workerEnv);
    cleanups.push(async () => {
      worker?.child.kill('SIGTERM');
      await Promise.race([worker?.exited, sleep(10_000)]);
    });

    const register = async (name: string, policy: Record<string, unknown>) => {
      const res = await call<{ id: string; apiKey: string; safeAddress: string }>(backend.url, '/v1/agents', {
        method: 'POST', apiKey: API_SECRET, body: { name, chainIds: [84532], policy },
      });
      if (res.status !== 201) throw new Error(`register ${name}: ${res.status} ${res.raw}`);
      return { id: res.body.id, apiKey: res.body.apiKey, address: getAddress(res.body.safeAddress) };
    };
    const stamp = Date.now();
    const requester = await register(`serve-requester-${stamp}`, { maxValuePerTxUsd: '10', maxOutflowPerTxUsd: '10', cooldownSeconds: 0 });
    const agent = await register(`serve-buyer-${stamp}`, { cooldownSeconds: 0 });
    await setUsdcBalance(anvilRpc, USDC_BASE_SEPOLIA, agent.address, 5_000_000n);
    await setUsdcBalance(anvilRpc, USDC_BASE_SEPOLIA, requester.address, 10_000_000n);
    const policy = await call(backend.url, `/v1/agents/${agent.id}/policy`, {
      method: 'PATCH', apiKey: API_SECRET,
      body: { maxValuePerTxUsd: '0.50', maxDailyVolumeUsd: '3.00', allowedRecipients: [seller], reason: 'framework serve budget' },
    });
    if (policy.status !== 200) throw new Error(`operator policy: ${policy.status} ${policy.raw}`);
    const makeJob = async (amount: string, task: string) => {
      const created = await call<{ id: string }>(backend.url, '/v1/jobs', {
        method: 'POST', apiKey: requester.apiKey,
        body: { providerId: agent.id, payload: { task }, reward: { amount, token: 'USDC', chainId: 84532 } },
      });
      if (created.status !== 201) throw new Error(`create job: ${created.status} ${created.raw}`);
      const accepted = await call(backend.url, `/v1/jobs/${created.body.id}`, { method: 'PATCH', apiKey: agent.apiKey, body: { status: 'ACCEPTED' } });
      if (accepted.status !== 200) throw new Error(`accept job: ${accepted.status} ${accepted.raw}`);
      return created.body.id;
    };
    const jobId = await makeJob('5.00', 'framework run: buy usage reports');
    const smallJobId = await makeJob('0.20', 'framework run: a purchase this job cannot afford');

    // Read-only evidence endpoint of this process (the driver reads the DB, the chain and the seller counters through it).
    const evidence = async () => {
      const logs = await forkClient(anvilRpc).getLogs({ address: USDC_BASE_SEPOLIA, event: TRANSFER, args: { from: agent.address, to: seller }, fromBlock: forkBlock });
      const rows = await db.resourcePayment.findMany({ where: { jobId: { in: [jobId, smallJobId] } }, orderBy: { reservedAt: 'asc' } });
      return {
        takenAt: new Date().toISOString(),
        forkBlock: forkBlock.toString(),
        head: (await forkClient(anvilRpc).getBlockNumber()).toString(),
        agentWallet: agent.address,
        seller,
        agentUsdc: (await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, agent.address)).toString(),
        sellerUsdc: (await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, seller)).toString(),
        sellerCounts: shop.counts,
        transfers: logs.map((l) => ({ tx: l.transactionHash as Hex, from: l.args.from, to: l.args.to, value: (l.args.value ?? 0n).toString(), block: l.blockNumber.toString() })),
        ledger: rows.map((r) => ({
          jobId: r.jobId, paymentId: r.paymentId, status: r.status, amount: r.amount, url: r.url, payTo: r.payTo,
          authorizationNonce: r.authorizationNonce, settlementTxHash: r.settlementTxHash, chainVerifiedAt: r.chainVerifiedAt?.toISOString() ?? null,
          responseStatus: r.responseStatus, resourceBytes: r.resourceBytes, resourceTruncated: r.resourceTruncated, reconcileNote: r.reconcileNote,
        })),
      };
    };
    const control = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/evidence') {
        res.writeHead(404).end();
        return;
      }
      evidence()
        .then((body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)))
        .catch((e: unknown) => res.writeHead(500).end(String(e)));
    });
    await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
    const controlAddr = control.address();
    if (!controlAddr || typeof controlAddr === 'string') throw new Error('control server did not bind');
    cleanups.push(() => new Promise<void>((r) => { control.closeAllConnections(); control.close(() => r()); }));

    writeEnvFile(join(OUT_DIR, 'operator.env'), {
      NODE_ENV: 'development',
      API_PORT: String(BACKEND_PORT),
      API_SECRET,
      ADMIN_SECRET,
      DATABASE_URL,
      REDIS_URL,
      WALLET_PROVIDER: 'local',
      ALCHEMY_API_KEY: 'e2e-escrow-fork-dummy',
      OPERATOR_FEE_WALLET: ANVIL_ACCOUNTS.feeWallet.address,
      RPC_URL_84532: anvilRpc,
      SYNTHETIC_TEST_PRICES_USD: common.SYNTHETIC_TEST_PRICES_USD,
      CONTROL_URL: `http://127.0.0.1:${controlAddr.port}`,
      AGENTFI_JOB_ID: jobId,
      AGENTFI_SMALL_JOB_ID: smallJobId,
    });
    writeEnvFile(join(OUT_DIR, 'agent.env'), {
      AGENTFI_API_URL: backend.url,
      AGENTFI_API_KEY: agent.apiKey,
      AGENTFI_AGENT_ID: agent.id,
      AGENTFI_JOB_ID: jobId,
      AGENTFI_SMALL_JOB_ID: smallJobId,
      SELLER_URL: shop.base,
      SELLER_ADDRESS: seller,
      AGENT_WALLET: agent.address,
      ANVIL_RPC_URL: anvilRpc,
    });
    say(`SERVE READY: API ${backend.url} · Anvil ${anvilRpc} (fork block ${forkBlock}) · seller ${shop.base} · job ${jobId} (budget 5.00) · small job ${smallJobId} (0.20)`);
    say(`agent env: ${join(OUT_DIR, 'agent.env')}`);
    say(`operator env: ${join(OUT_DIR, 'operator.env')}`);
    say(`worker log: ${worker.logFile}`);
    say(`Stop with Ctrl+C, or create ${STOP_FILE}`);

    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
    while (!stopping && !existsSync(STOP_FILE)) {
      if (worker.child.exitCode !== null) throw new Error('the worker process exited');
      await sleep(500);
    }
    say('stopping...');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
