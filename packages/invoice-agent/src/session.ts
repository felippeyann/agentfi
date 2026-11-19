/**
 * `npm run session`: the sequence we show, end to end, with real processes.
 *
 *   1. Preflight (read-only): the node's chain, the token, decimals, the explorer, balances, gas.
 *   2. The operator's mandate: one vendor, ≤ AMOUNT per invoice and per day.
 *   3. One invoice of AMOUNT tUSD8. The agent signs, records and broadcasts; the moment the ledger
 *      records the broadcast, the caller drops the connection and the agent process is KILLED
 *      (SIGKILL): the lost response, for real (no simulated fail point).
 *   4. The agent restarts; the operator resends the SAME invoice: the agent finds the original
 *      transaction by its recorded hash and answers with it (pending while the block is not
 *      confirmed, then the receipt). Nothing new is signed.
 *   5. Wait for the confirmation rule (finality.ts), resending the same invoice now and then.
 *   6. `ops verify` and an independent count: exactly ONE Transfer payer → vendor since the session
 *      started, the one in the receipt; the receipt's explorer link.
 *
 * Modes:
 *   --rehearse   local Anvil (chain 31337, one block per second like Aevum), the local test token, Anvil's public keys, and the
 *                `finalized` rule (Anvil reports finalized = head − 64 blocks; the session mines
 *                blocks to move it). Touches no public network.
 *   --aevum      QDay Aevum Testnet (44005), the official tUSD8. Needs, from the owner at run time:
 *                INVOICE_PAYER_KEY in the environment (never written anywhere by this script),
 *                --vendor 0x… (public address), --by NAME, and the explicit flag
 *                --i-authorize-a-public-transaction. Signs and sends ONE transfer of AMOUNT.
 *
 * Stop criteria (exit 3, nothing else is sent): preflight fails; the agent records no payment;
 * the resend answers anything but the ORIGINAL hash; the transaction stays out of a block for
 * --max-unmined-min (default 10) minutes (do not resend, check the payer in the explorer); the
 * receipt fails `ops verify`; the count of transfers is not exactly one.
 * Exit 2: still not confirmed after --max-wait-min (default 150): the ledger stays in --dir and
 * `ops verify` can be run again later. Exit 0: verified.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { balanceOf, makeChain, transfersFrom, type ChainConfig } from './chain.js';
import { isPublicAnvilKey, KNOWN_NETWORKS } from './config.js';
import { parseConfirmRule } from './finality.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from './generated/local-test-usd8.js';
import { formatUnits6, toBaseUnits } from './invoice.js';
import { Ledger } from './ledger.js';
import { saveMandate } from './mandate.js';
import { preflight } from './preflight.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODE = flag('aevum') ? 'aevum' : flag('rehearse') ? 'rehearse' : null;
const AMOUNT = opt('amount') ?? '1';
const AGENT_PORT = Number(opt('agent-port') ?? 8788);
const ANVIL_PORT = Number(opt('anvil-port') ?? 8567);
const MAX_UNMINED_MS = Number(opt('max-unmined-min') ?? 10) * 60_000;
const MAX_WAIT_MS = Number(opt('max-wait-min') ?? 150) * 60_000;
const POLL_MS = MODE === 'aevum' ? 30_000 : 500;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const DIR = resolve(opt('dir') ?? join(PKG, '.sessions', `${MODE ?? 'none'}-${stamp}`));
const INVOICE_ID = opt('invoice') ?? `QDAY-${stamp.slice(0, 10)}-001`;

// Anvil's public development accounts (rehearsal only; the config refuses them on any other chain).
const ANVIL = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
  vendor: getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'),
};

let transcript = '';
const out = (line = '') => {
  console.log(line);
  if (transcript) appendFileSync(transcript, line + '\n');
};
const children: ChildProcess[] = [];
process.on('exit', () => children.forEach((c) => c.exitCode === null && c.kill()));
process.on('SIGINT', () => process.exit(130));

class Stop extends Error {}
const stop = (why: string): never => {
  throw new Stop(why);
};

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 30_000, everyMs = 150) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main(): Promise<number> {
  if (!MODE) {
    console.log('usage: npm run session -- --rehearse   |   npm run session -- --aevum --vendor 0x… --by NAME --i-authorize-a-public-transaction [--amount 1]');
    return 2;
  }
  mkdirSync(DIR, { recursive: true });
  transcript = join(DIR, 'transcript.txt');
  writeFileSync(transcript, '');

  // ---- Network, keys, token -------------------------------------------------------------------
  let rpcUrl: string, chainId: number, token: Address, payerKey: Hex, vendor: Address, explorerUrl: string | null;
  let rehearsalClient: ReturnType<typeof createPublicClient> | undefined;
  const confirmation = opt('confirmation') ?? 'finalized';
  if (confirmation !== 'finalized' && !/^depth:\d+$/.test(confirmation)) stop('--confirmation must be finalized or depth:N');
  if (MODE === 'aevum') {
    if (!flag('i-authorize-a-public-transaction')) stop('--aevum signs and sends a public transaction: pass --i-authorize-a-public-transaction');
    const key = process.env['INVOICE_PAYER_KEY']?.trim();
    if (!key) stop('INVOICE_PAYER_KEY is not set (the owner provides it in the environment at run time)');
    if (!opt('vendor') || !opt('by')) stop('--vendor 0x… (public address) and --by NAME are required');
    const net = KNOWN_NETWORKS[44005]!;
    ({ rpcUrl, explorerUrl } = net);
    chainId = 44005;
    token = getAddress(net.tUSD8);
    payerKey = key as Hex;
    if (isPublicAnvilKey(payerKey)) stop("INVOICE_PAYER_KEY is one of Anvil's public development keys: never on a public chain");
    vendor = getAddress(opt('vendor')!);
  } else {
    chainId = 31337;
    rpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
    explorerUrl = null;
    payerKey = ANVIL.payer;
    vendor = ANVIL.vendor;
    const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
    const home = join(homedir(), '.foundry', 'bin', exe);
    const anvil = spawn(existsSync(home) ? home : exe, ['--port', String(ANVIL_PORT), '--chain-id', '31337', '--block-time', '1', '--silent'], { stdio: 'ignore' });
    children.push(anvil);
    const chain = makeChain({ rpcUrl, chainId, token: '0x0000000000000000000000000000000000000000' });
    rehearsalClient = createPublicClient({ chain, transport: http(rpcUrl) });
    await waitFor(async () => (await rehearsalClient!.getChainId()) === 31337, 'anvil');
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL.deployer), chain, transport: http(rpcUrl) });
    const rc = await rehearsalClient.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) });
    token = getAddress(rc.contractAddress!);
    await rehearsalClient.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [getAddress(privateKeyToAccount(ANVIL.payer).address), 10_000_000n] }) });
  }
  const payer = getAddress(privateKeyToAccount(payerKey).address);
  const chain: ChainConfig = { rpcUrl, chainId, token, confirm: parseConfirmRule(confirmation), ...(explorerUrl ? { explorerUrl } : {}) };
  const client = createPublicClient({ chain: makeChain(chain), transport: http(rpcUrl) });
  const startBlock = await client.getBlockNumber();
  chain.logsFromBlock = startBlock;
  const tx = (h: string) => (explorerUrl ? `${explorerUrl}/tx/${h}` : h);

  out(`AgentFi invoice agent — session (${MODE === 'aevum' ? 'PUBLIC: QDay Aevum Testnet 44005, official tUSD8' : 'REHEARSAL: local Anvil 31337, local test token, nothing public'})`);
  out(`Session dir ${DIR} · invoice ${INVOICE_ID} · ${AMOUNT} tUSD8 · payer ${payer} → vendor ${vendor} · confirmation rule: ${confirmation} · counting from block ${startBlock}`);
  if (MODE === 'rehearse') out('  (on Anvil the node reports finalized = head − 64 blocks; the rehearsal mines blocks to move it. On Aevum it is the last L1-verified block.)');

  // ---- 1. Preflight ----------------------------------------------------------------------------
  out('\n1. Preflight (read-only)');
  const pf = await preflight({ rpcUrl, chainId, token, explorerUrl, gasSymbol: MODE === 'aevum' ? 'tQDAY' : 'ETH', expectedDecimals: 6, payer, vendor, amount: AMOUNT, ...(confirmation === 'finalized' ? { maxFinalizedLagSec: MAX_WAIT_MS / 1000 } : {}) });
  pf.lines.forEach((l) => out(`  ${l}`));
  if (!pf.ok) stop('preflight failed');

  // ---- 2. Mandate --------------------------------------------------------------------------------
  const env = {
    INVOICE_RPC_URL: rpcUrl,
    INVOICE_MANDATE: join(DIR, 'mandate.json'),
    INVOICE_LEDGER: join(DIR, 'ledger.sqlite'),
    INVOICE_CONFIRMATION: confirmation,
    INVOICE_LOGS_FROM_BLOCK: startBlock.toString(),
    INVOICE_FAIL_AT: '',
    ...(explorerUrl ? { INVOICE_EXPLORER_URL: explorerUrl } : {}),
  };
  saveMandate(env.INVOICE_MANDATE, {
    chainId, token, payer,
    vendor: { id: 'vendor-1', name: opt('vendor-name') ?? 'Vendor One', address: vendor },
    maxPerInvoice: AMOUNT, maxPerDay: AMOUNT, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    approvedBy: opt('by') ?? 'rehearsal', approvedAt: new Date().toISOString(),
  });
  out(`\n2. Mandate: pay ${vendor} (vendor-1), ≤ ${AMOUNT} tUSD8 per invoice and per day, for 24 h (${env.INVOICE_MANDATE})`);

  const startAgent = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: PKG,
      env: { ...process.env, ...env, INVOICE_PAYER_KEY: payerKey, INVOICE_PORT: String(AGENT_PORT) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    await waitFor(async () => (await fetch(`http://127.0.0.1:${AGENT_PORT}/health`)).ok, 'the agent', 30_000).catch(() => stop(`the agent did not start: ${err.split('\n').find((l) => l.includes('refusing')) ?? err.slice(0, 300)}`));
    return child;
  };
  const invoice = { id: INVOICE_ID, vendorId: 'vendor-1', payTo: vendor, amount: AMOUNT, currency: 'tUSD8', description: 'QDay Builder Challenge test invoice (fictitious)' };
  const send = async () => (await (await fetch(`http://127.0.0.1:${AGENT_PORT}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invoice) })).json()) as Record<string, unknown>;
  const ledger = new Ledger(env.INVOICE_LEDGER);

  // ---- 3. The payment, and the lost response ------------------------------------------------------
  out(`\n3. Invoice ${INVOICE_ID} for ${AMOUNT} tUSD8 is sent to the agent.`);
  let agent = await startAgent();
  const req = request(`http://127.0.0.1:${AGENT_PORT}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  let answered = false;
  req.on('response', (res) => {
    answered = true;
    res.resume();
  });
  req.on('error', () => undefined);
  req.end(JSON.stringify(invoice));
  await waitFor(async () => ledger.events(INVOICE_ID).some((e) => e.event === 'broadcast' || e.event === 'refused'), 'the broadcast in the ledger', 60_000, 10).catch(() => undefined);
  agent.kill('SIGKILL');
  req.destroy();
  await new Promise((r) => (agent.exitCode !== null || agent.signalCode ? r(null) : agent.once('exit', r)));
  const row = ledger.get(INVOICE_ID);
  if (!row || !row.tx_hash) stop(`the agent recorded no payment for ${INVOICE_ID} (${row ? `${row.status}: ${row.reason}` : 'no row'})`);
  const original = row!.tx_hash!;
  out(`  the ledger recorded ${original} as ${row!.status} (${ledger.events(INVOICE_ID).map((e) => e.event).join(' → ')})`);
  out(`  the agent process was KILLED at that moment and the caller dropped the connection: ${answered ? 'an answer had started to arrive and was discarded unread' : 'no answer reached the caller'} — the lost response.`);

  // ---- 4. Restart, resend the same invoice -----------------------------------------------------------
  out(`\n4. The agent restarts; the operator resends the same invoice ${INVOICE_ID}.`);
  agent = await startAgent();
  const show = (r: Record<string, unknown>) => {
    const rc = r['receipt'] as Record<string, unknown> | undefined;
    const h = (rc?.['txHash'] ?? r['txHash']) as string | undefined;
    out(`  agent → ${String(r['outcome']).toUpperCase()}${r['stage'] ? ` (${r['stage']}${r['blockNumber'] ? `, block ${r['blockNumber']}` : ''})` : ''}${h ? `, tx ${h}` : ''}${h && h !== original ? '  ✗ NOT THE ORIGINAL HASH' : h ? '  ✓ the original hash' : ''}`);
    if (r['note']) out(`      ${r['note']}`);
    return h;
  };
  const allowed = ['pending', 'recovered', 'replayed', 'paid'];
  let r = await send();
  let h = show(r);
  if (!allowed.includes(String(r['outcome'])) || h !== original) stop(`the resend answered ${String(r['outcome'])} with ${h ?? 'no hash'}, not the original ${original}: do not resend; check ${MODE === 'aevum' ? `${explorerUrl}/address/${payer}` : 'the ledger'}`);
  out('  operator view while waiting:');
  for (const l of (await ops(env, 'verify', INVOICE_ID)).split('\n')) out(`    ${l}`);

  // ---- 5. Wait for the confirmation rule ------------------------------------------------------------------
  out(`\n5. Waiting for the confirmation rule (${confirmation}); the same invoice is resent every ${POLL_MS / 1000} s.`);
  const t0 = Date.now();
  let lastStage = '';
  let sentSince = Date.now();
  while (!['recovered', 'replayed', 'paid'].includes(String(r['outcome']))) {
    if (Date.now() - t0 > MAX_WAIT_MS) {
      out(`  still not confirmed after ${MAX_WAIT_MS / 60_000} min. Nothing more is sent. Check later: INVOICE_RPC_URL=${rpcUrl} INVOICE_MANDATE=${env.INVOICE_MANDATE} INVOICE_LEDGER=${env.INVOICE_LEDGER} INVOICE_CONFIRMATION=${confirmation} npm run ops -- verify ${INVOICE_ID}`);
      return 2;
    }
    if (r['stage'] === 'sent') {
      if (Date.now() - sentSince > MAX_UNMINED_MS) stop(`transaction ${original} has stayed out of a block for ${MAX_UNMINED_MS / 60_000} min: stop. Do NOT resend under another id; check ${tx(original)} and the payer's transactions.`);
    } else sentSince = Date.now();
    if (MODE === 'rehearse') await rehearsalClient!.request({ method: 'anvil_mine' as never, params: ['0x21'] as never });
    await new Promise((res) => setTimeout(res, POLL_MS));
    r = await send();
    const stage = `${r['outcome']}/${r['stage'] ?? ''}/${r['blockNumber'] ?? ''}`;
    if (stage !== lastStage) {
      h = show(r);
      lastStage = stage;
      if (h !== original) stop(`a resend answered ${h}, not the original ${original}`);
    }
  }
  out(`  confirmed after ${Math.round((Date.now() - t0) / 1000)} s of waiting. Receipt:`);
  for (const l of JSON.stringify(r['receipt'], null, 2).split('\n')) out(`      ${l}`);

  // ---- 6. Independent checks ------------------------------------------------------------------------------------
  out('\n6. Checks');
  const v = await ops(env, 'verify', INVOICE_ID);
  for (const l of v.split('\n')) out(`    ${l}`);
  if (!/VERIFIED on chain/.test(v) || /NOT VERIFIED/.test(v)) stop('ops verify did not verify the receipt');
  const sent = await transfersFrom(chain, payer, vendor);
  out(`  Transfer logs payer → vendor since block ${startBlock}: ${sent.length} (${sent.map((t) => `${formatUnits6(t.value)} tUSD8 in ${t.txHash}`).join(', ')})`);
  if (sent.length !== 1 || sent[0]!.txHash.toLowerCase() !== original.toLowerCase() || sent[0]!.value !== toBaseUnits(AMOUNT)) stop('not exactly one transfer, the one in the receipt');
  out(`  vendor balance now ${formatUnits6(await balanceOf(chain, vendor))} tUSD8 · payer ${formatUnits6(await balanceOf(chain, payer))} tUSD8`);
  agent.kill();
  out(`\nOK: one invoice, one transfer, one receipt${explorerUrl ? `: ${tx(original)}` : ` (tx ${original})`}`);
  out(`Transcript: ${transcript}`);
  return 0;
}

function ops(env: Record<string, string>, ...args: string[]): Promise<string> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'src/ops.ts', ...args], { cwd: PKG, env: { ...process.env, ...env, INVOICE_PAYER_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout!.on('data', (d) => (text += d));
    c.stderr!.on('data', (d) => (text += d));
    c.on('exit', (code) => res(`${text.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n|\(Use `node --trace-warnings[^\n]*\n/g, '').trimEnd()}\n(exit ${code})`));
  });
}

main().then(
  (code) => {
    process.exitCode = code;
    children.forEach((c) => c.exitCode === null && c.kill());
  },
  (e) => {
    out(e instanceof Stop ? `\nSTOP: ${e.message}` : `\nERROR: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    out('Nothing more is sent. The ledger and transcript stay in the session dir.');
    process.exitCode = e instanceof Stop ? 3 : 1;
    children.forEach((c) => c.exitCode === null && c.kill());
  },
);
