/**
 * x402 spend-control demo on a LOCAL Base Sepolia fork (first x402 delivery, 2026-11-15).
 *
 *   cd packages/backend
 *   npm run demo:x402:fork                     # forks https://sepolia.base.org by default
 *
 * What runs, all on this machine:
 *   - Anvil forking Base Sepolia (chain 84532) — real FiatToken USDC code and storage, LOCAL chain:
 *     nothing is sent to the public testnet;
 *   - the backend (`src/index.ts`, local wallet provider, dedicated DB `agentfi_e2e_x402`, Redis DB 14);
 *   - an x402 v2 resource server with the REAL `@x402/evm` exact facilitator: it verifies the
 *     EIP-3009 signature and submits `transferWithAuthorization` to the fork (Anvil account 1 pays gas).
 *
 * Flow: the operator sets the agent's budget (policy) → the agent buys through
 * `POST /v1/jobs/:id/pay-resource` → the ledger records payment and delivery →
 * `x402:ops reconcile` proves or releases on-chain → `x402:ops status` shows the operator view.
 *
 * Scenarios (each asserted; the run exits 1 on the first broken invariant):
 *   1. allowed purchase                         → settled, then proven on-chain;
 *   2. purchase blocked by the daily budget     → 403 before any signature, no request to the seller;
 *   3a. seller settles, then drops the response → unknown; retry = replay, no 2nd signature; proven;
 *   3b. seller takes the signature, never settles, drops → unknown, budget held; after validBefore
 *       on-chain → expired, budget released, and the blocked purchase now fits.
 * Evidence checked against the chain: USDC Transfer logs payer → seller and balances.
 *
 * Env: E2E_ANVIL_FORK_URL (default https://sepolia.base.org), E2E_ANVIL_FORK_BLOCK_NUMBER (default latest),
 * X402_DEMO_DATABASE_URL (default postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402),
 * X402_DEMO_REDIS_URL (default redis://localhost:6379/14). No secrets are needed or read.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type HTTPRequestContext, type RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { ExactEvmScheme as ExactEvmServerScheme } from '@x402/evm/exact/server';
import { declarePaymentIdentifierExtension, paymentIdentifierResourceServerExtension } from '@x402/extensions/payment-identifier';
import { createWalletClient, getAddress, http, parseAbiItem, publicActions, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { startAnvil, stopAnvil } from './global-setup.js';
import {
  ANVIL_ACCOUNTS,
  BACKEND_DIR,
  USDC_BASE_SEPOLIA,
  assertPortFree,
  call,
  flushTestRedis,
  forkClient,
  resetTestDatabase,
  rpc,
  setEthBalance,
  setUsdcBalance,
  startBackend,
  usdcBalanceOf,
  backendEnv,
  type EscrowForkContext,
} from './escrow-fork.harness.js';

loadDotenv({ path: join(tmpdir(), 'agentfi-x402-demo-no-dotenv') });

const NETWORK: Network = 'eip155:84532';
const ANVIL_PORT = Number(process.env['X402_DEMO_ANVIL_PORT'] || 8547);
const BACKEND_PORT = Number(process.env['X402_DEMO_BACKEND_PORT'] || 3157);
const FORK_URL = process.env['E2E_ANVIL_FORK_URL']?.trim() || 'https://sepolia.base.org';
const FORK_BLOCK = process.env['E2E_ANVIL_FORK_BLOCK_NUMBER']?.trim() || undefined;
const DATABASE_URL = process.env['X402_DEMO_DATABASE_URL']?.trim() || 'postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402';
const REDIS_URL = process.env['X402_DEMO_REDIS_URL']?.trim() || 'redis://localhost:6379/14';
const API_SECRET = 'x402-demo-operator-secret-min-32-chars!!';
const ADMIN_SECRET = 'x402-demo-admin-secret-min-32-chars!!!!';
const HOLD_WINDOW_SECONDS = 20;

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

// ── Seller: x402 resource server + real exact facilitator on the fork ──────

interface SellerCounts {
  plain: Record<string, number>;
  paid: Record<string, number>;
}

class NodeAdapter implements HTTPAdapter {
  private readonly url: URL;
  constructor(private readonly req: IncomingMessage, base: string) {
    this.url = new URL(req.url ?? '/', base);
  }
  getHeader(name: string) {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }
  getMethod() {
    return this.req.method ?? 'GET';
  }
  getPath() {
    return this.url.pathname;
  }
  getUrl() {
    return this.url.toString();
  }
  getAcceptHeader() {
    return this.getHeader('accept') ?? '';
  }
  getUserAgent() {
    return this.getHeader('user-agent') ?? '';
  }
}

async function startSeller(anvilRpc: string, payTo: Address) {
  const facilitatorAccount = privateKeyToAccount(ANVIL_ACCOUNTS.operator.privateKey);
  const client = createWalletClient({
    account: facilitatorAccount,
    chain: { ...baseSepolia, rpcUrls: { default: { http: [anvilRpc] } } },
    transport: http(anvilRpc),
  }).extend(publicActions);
  const signer = toFacilitatorEvmSigner(
    {
      address: facilitatorAccount.address as `0x${string}`,
      readContract: (args) => client.readContract(args as never),
      verifyTypedData: (args) => client.verifyTypedData(args as never),
      writeContract: (args) => client.writeContract(args as never),
      sendTransaction: (args) => client.sendTransaction(args),
      waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      getCode: (args) => client.getCode(args),
    },
    { confirmationTimeoutMs: 30_000 },
  );
  const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmFacilitatorScheme(signer));
  const facilitatorClient: FacilitatorClient = {
    getSupported: async () => facilitator.getSupported() as never,
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  };

  const core = new x402ResourceServer(facilitatorClient).registerExtension(paymentIdentifierResourceServerExtension);
  core.register(NETWORK, new ExactEvmServerScheme());
  const extensions = { 'payment-identifier': declarePaymentIdentifierExtension(false) };
  const route = (maxTimeoutSeconds: number) => ({
    accepts: [{ scheme: 'exact', network: NETWORK, price: '$0.30', payTo, maxTimeoutSeconds }],
    extensions,
  });
  const routes: RoutesConfig = {
    'GET /report': route(120),
    'GET /report-drop': route(120),
    'GET /report-hold': route(HOLD_WINDOW_SECONDS),
  };
  const httpServer = new x402HTTPResourceServer(core, routes);
  await httpServer.initialize();

  const counts: SellerCounts = { plain: {}, paid: {} };
  let base = '';

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const adapter = new NodeAdapter(req, base);
    const path = adapter.getPath();
    const paymentHeader = adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment');
    const bucket = paymentHeader ? counts.paid : counts.plain;
    bucket[path] = (bucket[path] ?? 0) + 1;
    const context: HTTPRequestContext = {
      adapter,
      path,
      decodedPath: path,
      method: adapter.getMethod(),
      ...(paymentHeader !== undefined ? { paymentHeader } : {}),
    };
    const result = await httpServer.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      res.writeHead(result.response.status, result.response.headers);
      res.end(JSON.stringify(result.response.body ?? {}));
      return;
    }
    if (result.type === 'no-payment-required') {
      res.writeHead(404);
      res.end();
      return;
    }
    // The signature is verified by the facilitator at this point.
    if (path === '/report-hold') {
      // Takes the signed authorization and never settles: the buyer sees the connection die.
      req.socket.destroy();
      return;
    }
    const body = JSON.stringify({ report: 'weekly-usage', rows: 3, generatedAt: new Date().toISOString() });
    const settle = await httpServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      extensions,
      { request: context, responseBody: Buffer.from(body), responseHeaders: { 'content-type': 'application/json' } },
      undefined,
      result.beforeHandlerSettlement,
    );
    if (!settle.success) {
      res.writeHead(settle.response.status, settle.response.headers);
      res.end(JSON.stringify(settle.response.body ?? {}));
      return;
    }
    if (path === '/report-drop') {
      // Settled on-chain; the response never reaches the buyer.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { ...settle.headers, 'content-type': 'application/json' });
    res.end(body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('seller did not bind');
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    counts,
    facilitator: facilitatorAccount.address,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

async function transfersTo(anvilRpc: string, from: Address, to: Address, fromBlock: bigint) {
  const logs = await forkClient(anvilRpc).getLogs({ address: USDC_BASE_SEPOLIA, event: TRANSFER, args: { from, to }, fromBlock });
  return logs.map((l) => ({ tx: l.transactionHash as Hex, value: l.args.value ?? 0n }));
}

function runOps(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/x402-ops.ts', ...args], {
      cwd: BACKEND_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`x402:ops ${args.join(' ')} exited ${code}:\n${out}`))));
  });
}

function indent(text: string): string {
  return text.split('\n').map((l) => `    ${l}`).join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

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
  try {
    await rpc(anvilRpc, 'anvil_setTime', [Math.floor(Date.now() / 1000)]);
    await rpc(anvilRpc, 'evm_mine');
    const forkBlock = await forkClient(anvilRpc).getBlockNumber();
    // Sweeper bots put EIP-7702 code on the public Anvil accounts on Base Sepolia; clear it on the fork.
    await rpc(anvilRpc, 'anvil_setCode', [ANVIL_ACCOUNTS.operator.address, '0x']);
    await setEthBalance(anvilRpc, ANVIL_ACCOUNTS.operator.address, 10n ** 20n);

    const seller = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    const shop = await startSeller(anvilRpc, seller);
    cleanups.push(shop.close);

    const ctx = {
      chainId: 84532,
      anvilRpc,
      backendPort: BACKEND_PORT,
      apiSecret: API_SECRET,
      adminSecret: ADMIN_SECRET,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      feeWallet: ANVIL_ACCOUNTS.feeWallet.address,
      escrow: '',
      hook: '',
      evaluatorPrivateKey: '',
    } as unknown as EscrowForkContext;
    const overrides = {
      RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: 'true',
      TRANSACTION_WORKER_ENABLED: 'false',
      // The requester's legacy job reservation prices the USDC reward (testnet assets need a synthetic price).
      SYNTHETIC_TEST_PRICES_USD: '84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
      DOTENV_CONFIG_PATH: join(tmpdir(), 'agentfi-x402-demo-no-dotenv'),
    };
    const backend = await startBackend(ctx, { name: 'x402-demo', overrides });
    cleanups.push(() => backend.stop());
    const opsEnv = backendEnv(ctx, overrides);

    say('# x402 spend control — local Base Sepolia fork');
    say();
    say(`Run: ${new Date().toISOString()} · fork of ${new URL(FORK_URL).host} at block ${forkBlock} (local Anvil ${anvilRpc}, chain 84532)`);
    say(`Seller ${seller} at ${shop.base} · facilitator (real @x402/evm exact, submits on the fork) ${shop.facilitator}`);
    say(`Backend ${backend.url} (log ${backend.logFile})`);
    say();

    // ── Operator: agents, budget, job ─────────────────────────────────────
    const register = async (name: string, policy: Record<string, unknown>) => {
      const res = await call<{ id: string; apiKey: string; safeAddress: string }>(backend.url, '/v1/agents', {
        method: 'POST',
        apiKey: API_SECRET,
        body: { name, chainIds: [84532], policy },
      });
      if (res.status !== 201) throw new Error(`register ${name}: ${res.status} ${res.raw}`);
      return { id: res.body.id, apiKey: res.body.apiKey, address: getAddress(res.body.safeAddress) };
    };
    const requester = await register(`x402-demo-requester-${Date.now()}`, { maxValuePerTxUsd: '10', maxOutflowPerTxUsd: '10', cooldownSeconds: 0 });
    const agent = await register(`x402-demo-buyer-${Date.now()}`, { cooldownSeconds: 0 });
    await setUsdcBalance(anvilRpc, USDC_BASE_SEPOLIA, agent.address, 5_000_000n);
    await setUsdcBalance(anvilRpc, USDC_BASE_SEPOLIA, requester.address, 5_000_000n);

    say('## Operator sets the budget');
    const policy = await call(backend.url, `/v1/agents/${agent.id}/policy`, {
      method: 'PATCH',
      apiKey: API_SECRET,
      body: { maxValuePerTxUsd: '0.50', maxDailyVolumeUsd: '1.00', allowedRecipients: [seller], reason: 'x402 demo budget' },
    });
    check(policy.status === 200, `operator PATCH policy → 200 (≤ 0.50 USD per payment, ≤ 1.00 USD per day, only to the seller)`);
    const raise = await call(backend.url, `/v1/agents/${agent.id}/policy`, {
      method: 'PATCH',
      apiKey: agent.apiKey,
      body: { maxDailyVolumeUsd: '100' },
    });
    check(raise.status === 403, `the agent trying to raise its own daily limit to 100 → ${raise.status} (only the operator can loosen)`);

    const created = await call<{ id: string }>(backend.url, '/v1/jobs', {
      method: 'POST',
      apiKey: requester.apiKey,
      body: { providerId: agent.id, payload: { task: 'buy the weekly usage report' }, reward: { amount: '2.00', token: 'USDC', chainId: 84532 } },
    });
    if (created.status !== 201) throw new Error(`create job: ${created.status} ${created.raw}`);
    const jobId = created.body.id;
    const accepted = await call(backend.url, `/v1/jobs/${jobId}`, { method: 'PATCH', apiKey: agent.apiKey, body: { status: 'ACCEPTED' } });
    if (accepted.status !== 200) throw new Error(`accept job: ${accepted.status} ${accepted.raw}`);
    say(`  job ${jobId}: reward 2.00 USDC = the job's spend budget; the agent is its provider`);
    const startBalance = await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, agent.address);
    say(`  agent wallet ${agent.address}: ${usdc(startBalance)} on the fork`);
    say();

    const pay = (path: string, paymentId: string) =>
      call<Record<string, unknown>>(backend.url, `/v1/jobs/${jobId}/pay-resource`, {
        method: 'POST',
        apiKey: agent.apiKey,
        body: { url: `${shop.base}${path}`, method: 'GET', paymentId },
      });
    const reconcile = (apply: boolean) =>
      runOps(opsEnv, ['reconcile', '--job', jobId, '--rpc', anvilRpc, '--confirmations', '0', '--local-chain', '--expiry-margin-seconds', '10', '--stale-minutes', '1', ...(apply ? ['--apply'] : [])]);

    // ── 1. Allowed purchase ─────────────────────────────────────────────
    say('## 1. Allowed purchase');
    const p1 = await pay('/report', 'demo-allowed-0001-abcdef');
    const p1payment = p1.body['payment'] as Record<string, unknown> | undefined;
    check(p1.status === 200 && p1payment?.['status'] === 'settled', `pay-resource /report → ${p1.status}, payment ${String(p1payment?.['status'])}, resource ${JSON.stringify((p1.body['resource'] as Record<string, unknown> | undefined)?.['body'])}`);
    check(shop.counts.paid['/report'] === 1, 'the seller received exactly 1 paid request');
    say();

    // ── 3a. Settled, response lost ──────────────────────────────────────
    say('## 3a. Seller settles on-chain, then the response is lost');
    const p3a = await pay('/report-drop', 'demo-dropped-0002-abcdef');
    check(p3a.status === 502 && p3a.body['code'] === 'PAYMENT_OUTCOME_UNKNOWN', `pay-resource /report-drop → ${p3a.status} ${String(p3a.body['code'])} (nothing assumed)`);
    const retry = await pay('/report-drop', 'demo-dropped-0002-abcdef');
    check(retry.status === 200 && retry.body['replayed'] === true, 'retry with the same paymentId → replayed from the ledger, nothing signed');
    check(shop.counts.paid['/report-drop'] === 1, 'the seller received exactly 1 paid request for it (no second authorization)');
    say();

    // ── 3b. Signature taken, never settled ──────────────────────────────
    say('## 3b. Seller takes the signature, never settles, drops the connection');
    const p3b = await pay('/report-hold', 'demo-held-0003-abcdefgh');
    check(p3b.status === 502 && p3b.body['code'] === 'PAYMENT_OUTCOME_UNKNOWN', `pay-resource /report-hold → ${p3b.status} ${String(p3b.body['code'])}`);
    say();

    // ── 2. Blocked by the budget ───────────────────────────────────────
    say('## 2. Purchase blocked by the daily budget (0.90 committed + 0.30 > 1.00)');
    const plainBefore = shop.counts.plain['/report'] ?? 0;
    const p2 = await pay('/report', 'demo-blocked-0004-abcdef');
    check(p2.status === 403 && p2.body['code'] === 'POLICY_VIOLATION' && p2.body['rule'] === 'maxDailyVolume', `pay-resource /report → ${p2.status} ${String(p2.body['code'])} rule ${String(p2.body['rule'])}: ${String(p2.body['error'])}`);
    check(shop.counts.paid['/report'] === 1, 'no paid request reached the seller (blocked before signing)');
    say(`  (the seller only answered the unpaid 402 probe: ${(shop.counts.plain['/report'] ?? 0) - plainBefore} request)`);
    say();

    // ── Reconcile (first pass) ─────────────────────────────────────────
    say('## Reconciliation, first pass (`x402:ops reconcile --apply`, evidence from the fork)');
    say(indent(await reconcile(true)));
    say();

    say(`Waiting ${HOLD_WINDOW_SECONDS + 15} s (validBefore + the 10 s expiry margin) for the held authorization's validBefore to pass on-chain…`);
    await sleep((HOLD_WINDOW_SECONDS + 15) * 1000);
    await rpc(anvilRpc, 'evm_mine');
    say('## Reconciliation, second pass');
    say(indent(await reconcile(true)));
    say();

    say('## 3b (cont.). The released budget is usable again');
    const p2b = await pay('/report', 'demo-after-release-0005-abc');
    const p2bPayment = p2b.body['payment'] as Record<string, unknown> | undefined;
    check(p2b.status === 200 && p2bPayment?.['status'] === 'settled', `the purchase blocked in scenario 2 now fits: pay-resource /report → ${p2b.status} ${String(p2bPayment?.['status'])}`);
    say(indent(await reconcile(true)));
    say();

    // ── Evidence ───────────────────────────────────────────────────────
    say('## Financial evidence (fork) vs the ledger');
    const transfers = await transfersTo(anvilRpc, agent.address, seller, forkBlock);
    const endBalance = await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, agent.address);
    const sellerBalance = await usdcBalanceOf(anvilRpc, USDC_BASE_SEPOLIA, seller);
    for (const t of transfers) say(`  Transfer ${agent.address} → ${seller} ${usdc(t.value)} in ${t.tx}`);
    const statusOut = await runOps(opsEnv, ['status', '--job', jobId, '--json']);
    // The backend env prints a WARN line (synthetic test prices) before the JSON.
    const statusJson = JSON.parse(statusOut.slice(statusOut.search(/^\[/m))) as Array<{
      jobs: Array<{ committedUsdc: string; provenUsdc: string; reportedUsdc: string; openUsdc: string; payments: Array<{ status: string; txHash: string | null; money: string }> }>;
    }>;
    const job = statusJson[0]!.jobs[0]!;
    const provenTx = job.payments.filter((p) => p.money === 'proven').map((p) => p.txHash?.toLowerCase());
    check(transfers.length === 3, `3 USDC transfers on-chain (allowed, dropped-response, after-release) — got ${transfers.length}`);
    check(
      transfers.every((t) => provenTx.includes(t.tx.toLowerCase())) && provenTx.length === transfers.length,
      'every on-chain transfer is a proven ledger row with the same tx hash, and vice versa',
    );
    check(startBalance - endBalance === 900_000n && sellerBalance === 900_000n, `agent wallet −${usdc(startBalance - endBalance)}, seller +${usdc(sellerBalance)}`);
    check(job.committedUsdc === '0.9' && job.provenUsdc === '0.9' && job.openUsdc === '0', `ledger: committed ${job.committedUsdc}, proven ${job.provenUsdc}, open ${job.openUsdc} USDC`);
    check(job.payments.some((p) => p.status === 'expired'), 'the held authorization is `expired` (proven unused past validBefore), not counted');
    check(shop.counts.paid['/report-hold'] === 1 && shop.counts.paid['/report-drop'] === 1, 'one paid request per lost-response purchase: no duplicate authorization');
    say();

    say('## Operator view (`x402:ops status`)');
    say(indent(await runOps(opsEnv, ['status', '--agent', agent.id])));
    say();
    say('What this run is: a LOCAL fork (Anvil) of Base Sepolia with the real FiatToken contract; not the public testnet, not a real seller.');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

main()
  .then(async () => {
    const out = process.env['X402_DEMO_TRANSCRIPT'];
    if (out) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, `${lines.join('\n')}\n`);
    }
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    const out = process.env['X402_DEMO_TRANSCRIPT'];
    if (out) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, `${lines.join('\n')}\n\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  });
