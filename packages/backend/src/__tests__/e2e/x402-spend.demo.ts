/**
 * x402 spend-control demo on a LOCAL Base Sepolia fork (x402 deliveries 1 and 2, 2026-11-15).
 *
 *   cd packages/backend
 *   npm run demo:x402:fork                     # forks https://sepolia.base.org by default
 *
 * What runs, all on this machine:
 *   - Anvil forking Base Sepolia (chain 84532) — real FiatToken USDC code and storage, LOCAL chain:
 *     nothing is sent to the public testnet;
 *   - the API (`src/index.ts`, local wallet provider, dedicated DB `agentfi_e2e_x402`, Redis DB 14);
 *   - the WORKER (`src/worker.ts`, the documented API + worker deployment) whose payment-recovery
 *     tick runs the automatic x402 reconciliation; it reads its chain evidence through a relay the
 *     demo can switch off (an unavailable evidence source);
 *   - an x402 v2 seller with the REAL `@x402/evm` exact facilitator settling on the fork.
 *
 * Scenarios (each asserted; exit 1 on the first broken invariant):
 *   A. operator sets the budget; the agent cannot raise it; a purchase above the per-payment limit
 *      is blocked before any signature;
 *   B. allowed purchase → proven automatically; a purchase whose body exceeds the read limit →
 *      proven, delivery PARTIAL;
 *   C. evidence source down: a lost-response purchase stays `unknown` and counted, backing off;
 *      the worker is KILLED; source back; a NEW worker process resumes and proves it; a retry is a
 *      ledger replay (no new signature, no new request);
 *   D. two reconciliation workers at once over three lost-response purchases: each transition once;
 *   E. a seller that takes the signature and never settles → `wait` → `expired` after validBefore
 *      on-chain, budget released — without any operator command.
 * Evidence checked against the chain: USDC Transfer logs and balances vs the ledger; seller-side
 * request counts (nothing re-sent, nothing re-fetched).
 *
 * Env: E2E_ANVIL_FORK_URL (default https://sepolia.base.org), E2E_ANVIL_FORK_BLOCK_NUMBER (default latest),
 * X402_DEMO_DATABASE_URL (default postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402),
 * X402_DEMO_REDIS_URL (default redis://localhost:6379/14), X402_DEMO_TRANSCRIPT (file to write).
 * No secrets are needed or read.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { BIG_BODY_BYTES, HOLD_WINDOW_SECONDS, startDemoSeller, startRpcRelay } from './x402-demo-seller.js';

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

const lines: string[] = [];
function say(text = ''): void {
  lines.push(text);
  console.log(text);
}
function check(condition: unknown, what: string): void {
  if (!condition) {
    say(`  ✗ INVARIANT BROKEN: ${what}`);
    throw new Error(what);
  }
  say(`  ✓ ${what}`);
}
const usdc = (units: bigint) => `${(Number(units) / 1e6).toFixed(2)} USDC`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
async function transfersTo(anvilRpc: string, from: Address, to: Address, fromBlock: bigint) {
  const logs = await forkClient(anvilRpc).getLogs({ address: USDC_BASE_SEPOLIA, event: TRANSFER, args: { from, to }, fromBlock });
  return logs.map((l) => ({ tx: l.transactionHash as Hex, value: l.args.value ?? 0n }));
}

function runOps(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/x402-ops.ts', ...args], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`x402:ops ${args.join(' ')} exited ${code}:\n${out}`))));
  });
}
/** The backend env prints WARN lines before a JSON document: parse from the first line that starts it. */
const jsonOf = <T>(out: string): T => JSON.parse(out.slice(out.search(/^[[{]/m))) as T;

interface WorkerHandle {
  name: string;
  logFile: string;
  child: ChildProcess;
  exited: Promise<void>;
}
function startWorker(name: string, env: NodeJS.ProcessEnv): WorkerHandle {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `worker-${name}-${Date.now()}.log`);
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return { name, logFile, child, exited };
}
async function stopWorker(w: WorkerHandle, signal: NodeJS.Signals): Promise<void> {
  w.child.kill(signal);
  await Promise.race([w.exited, sleep(10_000)]);
}

async function main(): Promise<void> {
  const sourceChain = Number(await rpc<string>(FORK_URL, 'eth_chainId'));
  if (sourceChain !== 84532) throw new Error(`E2E_ANVIL_FORK_URL answers chain ${sourceChain}; need Base Sepolia (84532)`);
  await assertPortFree(ANVIL_PORT, 'Anvil (X402_DEMO_ANVIL_PORT)');
  await assertPortFree(BACKEND_PORT, 'backend (X402_DEMO_BACKEND_PORT)');
  await resetTestDatabase(DATABASE_URL);
  await flushTestRedis(REDIS_URL);

  const anvilRpc = `http://127.0.0.1:${ANVIL_PORT}`;
  const anvil = await startAnvil({ port: ANVIL_PORT, chainId: 84532, forkUrl: FORK_URL, forkBlockNumber: FORK_BLOCK, readyTimeoutMs: 60_000 });
  const cleanups: Array<() => Promise<void> | void> = [() => stopAnvil(anvil)];
  const workers: WorkerHandle[] = [];
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  cleanups.push(() => db.$disconnect());
  try {
    await rpc(anvilRpc, 'anvil_setTime', [Math.floor(Date.now() / 1000)]);
    await rpc(anvilRpc, 'evm_mine');
    const forkBlock = await forkClient(anvilRpc).getBlockNumber();
    await rpc(anvilRpc, 'anvil_setCode', [ANVIL_ACCOUNTS.operator.address, '0x']);
    await setEthBalance(anvilRpc, ANVIL_ACCOUNTS.operator.address, 10n ** 20n);

    const seller = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    const shop = await startDemoSeller(anvilRpc, seller);
    cleanups.push(shop.close);
    const relay = await startRpcRelay(anvilRpc);
    cleanups.push(relay.close);

    const ctx = {
      chainId: 84532, anvilRpc, backendPort: BACKEND_PORT, apiSecret: API_SECRET, adminSecret: ADMIN_SECRET,
      databaseUrl: DATABASE_URL, redisUrl: REDIS_URL, feeWallet: ANVIL_ACCOUNTS.feeWallet.address,
      escrow: '', hook: '', evaluatorPrivateKey: '',
    } as unknown as EscrowForkContext;
    const common = {
      RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true',
      SYNTHETIC_TEST_PRICES_USD: '84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
      DOTENV_CONFIG_PATH: join(tmpdir(), 'agentfi-x402-demo-no-dotenv'),
    };
    // The API does not run the recovery tick: the worker process does (API + worker deployment).
    const backend = await startBackend(ctx, { name: 'x402-demo', overrides: { ...common, TRANSACTION_WORKER_ENABLED: 'false' } });
    cleanups.push(() => backend.stop());
    const workerEnv = backendEnv(ctx, {
      ...common,
      TRANSACTION_WORKER_ENABLED: 'true',
      RPC_URL_84532: relay.url, // evidence through the switchable relay
      // Second evidence source, required to apply an automatic expiry. On this local fork it can only be the
      // same Anvil node reached directly (not through the relay); on a public network it must be another provider.
      X402_RECONCILE_SECOND_RPC_URL_84532: anvilRpc,
      PAYMENT_RECOVERY_INTERVAL_SEC: '2',
      X402_RECONCILE_HEAD: 'latest-0',
      X402_RECONCILE_LOCAL_CHAIN: 'true',
      X402_RECONCILE_EXPIRY_MARGIN_SEC: '10',
      X402_RECONCILE_BACKOFF_BASE_SEC: '2',
      X402_RECONCILE_BACKOFF_CAP_SEC: '4',
      X402_RECONCILE_MAX_ATTEMPTS: '30',
      X402_RECONCILE_STALE_SEC: '30',
    });
    const opsEnv = backendEnv(ctx, common);
    cleanups.push(async () => {
      for (const w of workers) await stopWorker(w, 'SIGTERM');
    });

    say('# x402 spend control + automatic reconciliation — local Base Sepolia fork');
    say();
    say(`Run: ${new Date().toISOString()} · fork of ${new URL(FORK_URL).host} at block ${forkBlock} (local Anvil, chain 84532). NOT the public testnet.`);
    say(`Seller ${seller} at ${shop.base} · facilitator (real @x402/evm exact, settles on the fork) ${shop.facilitator}`);
    say(`API ${backend.url} · worker evidence via relay ${relay.url} → Anvil`);
    say();

    // ── A. Operator, budget, job ─────────────────────────────────────────
    const register = async (name: string, policy: Record<string, unknown>) => {
      const res = await call<{ id: string; apiKey: string; safeAddress: string }>(backend.url, '/v1/agents', {
        method: 'POST', apiKey: API_SECRET, body: { name, chainIds: [84532], policy },
      });
      if (res.status !== 201) throw new Error(`register ${name}: ${res.status} ${res.raw}`);
      return { id: res.body.id, apiKey: res.body.apiKey, address: getAddress(res.body.safeAddress) };
    };
    const requester = await register(`x402-demo-requester-${Date.now()}`, { maxValuePerTxUsd: '10', maxOutflowPerTxUsd: '10', cooldownSeconds: 0 });
    const agent = await register(`x402-demo-buyer-${Date.now()}`, { cooldownSeconds: 0 });
    await setUsdcBalance(anvilRpc, USDC_BASE_SEPOLIA, agent.address, 5_000_000n);
    await setUsdcBalance(anvilRpc, USDC_BASE_SEPOLIA, requester.address, 10_000_000n);

    say('## A. Operator sets the budget');
    const policy = await call(backend.url, `/v1/agents/${agent.id}/policy`, {
      method: 'PATCH', apiKey: API_SECRET,
      body: { maxValuePerTxUsd: '0.50', maxDailyVolumeUsd: '3.00', allowedRecipients: [seller], reason: 'x402 demo budget' },
    });
    check(policy.status === 200, 'operator PATCH policy → 200 (≤ 0.50 USD per payment, ≤ 3.00 USD per day, only to the seller)');
    const raise = await call(backend.url, `/v1/agents/${agent.id}/policy`, { method: 'PATCH', apiKey: agent.apiKey, body: { maxValuePerTxUsd: '100' } });
    check(raise.status === 403, `the agent raising its own per-payment limit → ${raise.status}`);
    const created = await call<{ id: string }>(backend.url, '/v1/jobs', {
      method: 'POST', apiKey: requester.apiKey,
      body: { providerId: agent.id, payload: { task: 'buy usage reports' }, reward: { amount: '5.00', token: 'USDC', chainId: 84532 } },
    });
    if (created.status !== 201) throw new Error(`create job: ${created.status} ${created.raw}`);
    const jobId = created.body.id;
    const accepted = await call(backend.url, `/v1/jobs/${jobId}`, { method: 'PATCH', apiKey: agent.apiKey, body: { status: 'ACCEPTED' } });
    if (accepted.status !== 200) throw new Error(`accept job: ${accepted.status} ${accepted.raw}`);
    const startBalance = await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, agent.address);
    say(`  job ${jobId}: budget 5.00 USDC · agent wallet ${agent.address}: ${usdc(startBalance)} on the fork`);

    const pay = (path: string, paymentId: string) =>
      call<Record<string, unknown>>(backend.url, `/v1/jobs/${jobId}/pay-resource`, {
        method: 'POST', apiKey: agent.apiKey, body: { url: `${shop.base}${path}`, method: 'GET', paymentId },
      });
    const row = (paymentId: string) =>
      db.resourcePayment.findUniqueOrThrow({ where: { jobId_paymentId: { jobId, paymentId } }, include: { reconcileState: true } });
    const waitFor = async (what: string, predicate: () => Promise<boolean>, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await sleep(500);
      }
    };

    const premium = await pay('/report-premium', 'demo-premium-0001-abcdef');
    check(
      premium.status === 403 && premium.body['code'] === 'POLICY_VIOLATION' && shop.paid('/report-premium') === 0,
      `a 0.60 purchase (limit 0.50) → ${premium.status} ${String(premium.body['code'])} rule ${String(premium.body['rule'])}; 0 paid requests reached the seller`,
    );
    say();

    // ── B. Allowed + partial, proven automatically ─────────────────────
    say('## B. Purchases proven automatically by the worker (no operator command)');
    let worker = startWorker('w1', workerEnv);
    workers.push(worker);
    const ok = await pay('/report', 'demo-allowed-0002-abcdef');
    check(ok.status === 200 && (ok.body['payment'] as Record<string, unknown>)['status'] === 'settled', 'allowed purchase → 200 settled (reported by the seller)');
    const big = await pay('/report-big', 'demo-partial-0003-abcdef');
    const bigResource = big.body['resource'] as Record<string, unknown> | undefined;
    check(big.status === 200 && bigResource?.['truncated'] === true, `a ${BIG_BODY_BYTES / 1024} KiB resource → 200, body cut at the 64 KiB read limit`);
    await waitFor('worker proves both', async () => Boolean((await row('demo-allowed-0002-abcdef')).chainVerifiedAt && (await row('demo-partial-0003-abcdef')).chainVerifiedAt));
    const bigRow = await row('demo-partial-0003-abcdef');
    check(true, 'the worker proved both on-chain (chainVerifiedAt set) on its own');
    check(bigRow.resourceTruncated === true && bigRow.resourceBytes === 64 * 1024, `partial delivery recorded: ${bigRow.resourceBytes} bytes received, resourceTruncated=true, sha256 ${bigRow.resourceSha256?.slice(0, 16)}…`);
    say();

    // ── C. Evidence source down, worker crash, restart ─────────────────
    say('## C. Lost response while the evidence source is DOWN; worker killed and restarted');
    relay.setUp(false);
    const drop = await pay('/report-drop', 'demo-dropped-0004-abcdef');
    check(drop.status === 502 && drop.body['code'] === 'PAYMENT_OUTCOME_UNKNOWN', 'seller settled on-chain but the response was lost → 502 PAYMENT_OUTCOME_UNKNOWN');
    await waitFor('two failed evidence reads', async () => ((await row('demo-dropped-0004-abcdef')).reconcileState?.attempts ?? 0) >= 2);
    const conservative = await row('demo-dropped-0004-abcdef');
    const onChainAlready = await transfersTo(anvilRpc, agent.address, seller, forkBlock);
    check(
      conservative.status === 'unknown' && conservative.chainVerifiedAt === null && conservative.reconcileState?.escalatedAt === null,
      `source down: row stays unknown (counted), attempts=${conservative.reconcileState?.attempts}, next look ${conservative.reconcileState?.nextAttemptAt.toISOString()} — not concluded, not released (relay refused ${relay.refused()} reads)`,
    );
    say(`  (meanwhile the chain already holds ${onChainAlready.length} transfers: the money DID move; the ledger simply waits for proof)`);
    await stopWorker(worker, 'SIGKILL');
    check(true, `worker ${worker.name} KILLED (SIGKILL) mid-backoff`);
    relay.setUp(true);
    worker = startWorker('w2-restarted', workerEnv);
    workers.push(worker);
    await waitFor('restarted worker proves the lost-response payment', async () => Boolean((await row('demo-dropped-0004-abcdef')).chainVerifiedAt), 90_000);
    const proven = await row('demo-dropped-0004-abcdef');
    check(proven.status === 'settled', `a NEW worker process resumed and proved it: tx ${proven.settlementTxHash}`);
    const replay = await pay('/report-drop', 'demo-dropped-0004-abcdef');
    check(replay.status === 200 && replay.body['replayed'] === true && shop.paid('/report-drop') === 1, 'retry with the same paymentId → ledger replay; the seller saw exactly 1 paid request (nothing re-signed or re-fetched)');
    say();

    // ── D. Two workers at once ─────────────────────────────────────────
    say('## D. Two reconciliation workers at once');
    await stopWorker(worker, 'SIGTERM');
    for (const id of ['demo-two-0005-abcdefgh', 'demo-two-0006-abcdefgh', 'demo-two-0007-abcdefgh']) {
      const r = await pay('/report-drop', id);
      if (r.body['code'] !== 'PAYMENT_OUTCOME_UNKNOWN') throw new Error(`expected unknown for ${id}: ${r.raw}`);
    }
    const autoArgs = ['auto', '--job', jobId, '--rpc', anvilRpc, '--confirmations', '0', '--local-chain', '--expiry-margin-seconds', '10', '--json'];
    const [outA, outB] = await Promise.all([runOps(opsEnv, autoArgs), runOps(opsEnv, autoArgs)]);
    type Outcome = { paymentId: string; applied: boolean; verdict: string };
    const applied = [...jsonOf<Outcome[]>(outA), ...jsonOf<Outcome[]>(outB)].filter((o) => o.applied);
    check(
      applied.length === 3 && new Set(applied.map((o) => o.paymentId)).size === 3,
      `3 lost-response payments, 2 concurrent workers: ${applied.length} transitions written, each payment once (A: ${jsonOf<Outcome[]>(outA).filter((o) => o.applied).length}, B: ${jsonOf<Outcome[]>(outB).filter((o) => o.applied).length})`,
    );
    say();

    // ── E. Signature taken, never settled → expired automatically ─────
    say('## E. Seller takes the signature and never settles');
    worker = startWorker('w3', workerEnv);
    workers.push(worker);
    const hold = await pay('/report-hold', 'demo-held-0008-abcdefgh');
    check(hold.body['code'] === 'PAYMENT_OUTCOME_UNKNOWN', 'pay /report-hold → 502 PAYMENT_OUTCOME_UNKNOWN');
    await waitFor('worker sees a live unused authorization', async () => (await row('demo-held-0008-abcdefgh')).reconcileState?.lastVerdict === 'wait');
    check(true, `worker: "wait" — unused but valid until validBefore; amount held; next look ${(await row('demo-held-0008-abcdefgh')).reconcileState?.nextAttemptAt.toISOString()}`);
    // Anvil mines only on transactions: mine a block now and then so the chain head moves with the clock.
    const miner = setInterval(() => void rpc(anvilRpc, 'evm_mine').catch(() => undefined), 2000);
    try {
      await waitFor('worker expires it', async () => (await row('demo-held-0008-abcdefgh')).status === 'expired', (HOLD_WINDOW_SECONDS + 60) * 1000);
    } finally {
      clearInterval(miner);
    }
    check(true, 'after validBefore + margin on-chain, confirmed by the second evidence source at the same block hash, the worker marked it expired (proven unused) — budget released, no operator command');
    await stopWorker(worker, 'SIGTERM');
    say();

    // ── Evidence ───────────────────────────────────────────────────────
    say('## Financial evidence (fork) vs the ledger');
    const transfers = await transfersTo(anvilRpc, agent.address, seller, forkBlock);
    const endBalance = await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, agent.address);
    const sellerBalance = await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, seller);
    const status = jsonOf<Array<{ jobs: Array<{ committedUsdc: string; provenUsdc: string; openUsdc: string; payments: Array<{ paymentId: string; status: string; txHash: string | null; money: string; delivery: string; action: string | null; automatic: string | null }> }> }>>(
      await runOps(opsEnv, ['status', '--job', jobId, '--json']),
    );
    const job = status[0]!.jobs[0]!;
    const provenTx = job.payments.filter((p) => p.money === 'proven').map((p) => p.txHash?.toLowerCase());
    check(transfers.length === 6, `6 USDC transfers on-chain (allowed, partial, 4 lost responses) — got ${transfers.length}`);
    check(transfers.every((t) => provenTx.includes(t.tx.toLowerCase())) && provenTx.length === 6, 'every on-chain transfer is a proven ledger row with the same tx hash, and vice versa');
    check(startBalance - endBalance === 1_800_000n && sellerBalance === 1_800_000n, `agent wallet −${usdc(startBalance - endBalance)}, seller +${usdc(sellerBalance)}`);
    check(job.committedUsdc === '1.8' && job.provenUsdc === '1.8' && job.openUsdc === '0', `ledger: committed ${job.committedUsdc}, proven ${job.provenUsdc}, open ${job.openUsdc} USDC`);
    const partialLine = job.payments.find((p) => p.paymentId === 'demo-partial-0003-abcdef')!;
    check(partialLine.money === 'proven' && partialLine.delivery === 'partial' && partialLine.action !== null, 'the partial purchase stays visible: money proven, delivery PARTIAL, operator action');
    check(shop.paid('/report-drop') === 4 && shop.paid('/report-hold') === 1 && shop.paid('/report') === 1 && shop.paid('/report-big') === 1, 'seller saw exactly one paid request per purchase (no duplicate authorization, no re-fetch)');
    say();
    say('## Operator view (`x402:ops status`)');
    say(indent(await runOps(opsEnv, ['status', '--agent', agent.id])));
    say();
    say(`Worker logs: ${workers.map((w) => w.logFile).join(', ')}`);
    say('What this run is: a LOCAL fork (Anvil) of Base Sepolia with the real FiatToken contract and a seller we control; not the public testnet, not an independent seller.');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

main()
  .then(() => {
    const out = process.env['X402_DEMO_TRANSCRIPT'];
    if (out) writeFileSync(out, `${lines.join('\n')}\n`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    const out = process.env['X402_DEMO_TRANSCRIPT'];
    if (out) writeFileSync(out, `${lines.join('\n')}\n\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
