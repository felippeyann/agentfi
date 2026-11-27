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
 *   --vault      (with either mode) pay through the operator's InvoiceMandate vault instead of a direct transfer:
 *                the agent signs vault.payInvoice and the tUSD8 leave the vault. --rehearse --vault deploys a local
 *                vault (the deployer is the operator) and funds it; --aevum --vault 0x… uses the owner's vault, and
 *                INVOICE_PAYER_KEY is then the AGENT's key (gas coin only; never the operator's). The independent
 *                count in step 6 is then: exactly one InvoiceSettled for this invoice AND one Transfer vault → vendor,
 *                both in the original transaction.
 *   --probe-paid ID  (with --vault) before step 3, the agent, on this session's EMPTY ledger, receives invoice ID, which
 *                the vault has already settled (e.g. QDAY-2026-11-24-001): it must answer refused, rule
 *                vault:AlreadySettled, with nothing signed (no hash, the agent's nonce unchanged). The session first
 *                reads settlementOf(ID) and stops unless the vault shows it settled, so a typo can never pay a probe.
 *                --rehearse --vault --probe-paid ID replays the public history locally: ID is paid by the agent,
 *                one UTC day passes, the operator deposits again and renews the mandate.
 *
 * Gas: --max-gas-cost (default 0.0001, native coin) is the ceiling per transaction, checked by the preflight
 * and again by the agent on the prepared transaction right before signing (gas limit × maxFeePerGas).
 * --max-priority-fee-gwei G caps the EIP-1559 tip (maxFeePerGas is rebuilt as base part + the applied tip), with the
 * same rule in the preflight and in the agent (INVOICE_MAX_PRIORITY_FEE_GWEI); the ceiling still applies on top.
 * Stop criteria (exit 3, nothing else is sent): preflight fails (including a maximum above the ceiling);
 * the agent refuses on the ceiling (nothing signed); the agent records no payment;
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
import { isPublicAnvilKey, KNOWN_NETWORKS, parseGasCeiling, parsePriorityFeeCap } from './config.js';
import { parseConfirmRule } from './finality.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from './generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from './generated/local-test-usd8.js';
import { formatUnits6, toBaseUnits } from './invoice.js';
import { Ledger } from './ledger.js';
import { saveMandate } from './mandate.js';
import { DEFAULT_AEVUM_GAS_CEILING, preflight } from './preflight.js';
import { settledEventsSince, settlementOf, vendorKey } from './vault.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODE = flag('aevum') ? 'aevum' : flag('rehearse') ? 'rehearse' : null;
const VAULT_MODE = flag('vault');
const VAULT_ARG = opt('vault')?.startsWith('0x') ? opt('vault') : undefined;
const VENDOR_ID = 'vendor-1';
const AMOUNT = opt('amount') ?? '1';
const GAS_CEILING = opt('max-gas-cost') ?? DEFAULT_AEVUM_GAS_CEILING;
const TIP_CAP_GWEI = opt('max-priority-fee-gwei');
const AGENT_PORT = Number(opt('agent-port') ?? 8788);
const ANVIL_PORT = Number(opt('anvil-port') ?? 8567);
const MAX_UNMINED_MS = Number(opt('max-unmined-min') ?? 10) * 60_000;
const MAX_WAIT_MS = Number(opt('max-wait-min') ?? 150) * 60_000;
const POLL_MS = MODE === 'aevum' ? 30_000 : 500;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const DIR = resolve(opt('dir') ?? join(PKG, '.sessions', `${MODE ?? 'none'}-${stamp}`));
const INVOICE_ID = opt('invoice') ?? `QDAY-${stamp.slice(0, 10)}-001`;
/** --probe-paid ID (vault only): before the new invoice, resend an invoice the vault has ALREADY settled to the agent. */
const PROBE_ID = opt('probe-paid');

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
    console.log('usage: npm run session -- --rehearse [--vault]   |   npm run session -- --aevum --vendor 0x… --by NAME --i-authorize-a-public-transaction [--amount 1] [--vault 0x…]');
    return 2;
  }
  mkdirSync(DIR, { recursive: true });
  transcript = join(DIR, 'transcript.txt');
  writeFileSync(transcript, '');

  // ---- Network, keys, token -------------------------------------------------------------------
  let rpcUrl: string, chainId: number, token: Address, payerKey: Hex, vendor: Address, explorerUrl: string | null;
  let rehearsalClient: ReturnType<typeof createPublicClient> | undefined;
  let vault: Address | undefined;
  const confirmation = opt('confirmation') ?? 'finalized';
  if (confirmation !== 'finalized' && !/^depth:\d+$/.test(confirmation)) stop('--confirmation must be finalized or depth:N');
  if (PROBE_ID !== undefined) {
    if (!VAULT_MODE) stop('--probe-paid needs --vault: only the vault can refuse an invoice this ledger does not know');
    if (!PROBE_ID || PROBE_ID.startsWith('--') || PROBE_ID === INVOICE_ID) stop(`--probe-paid needs an invoice id the vault has already settled, other than this session's ${INVOICE_ID}`);
  }
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
    if (VAULT_MODE) {
      if (!VAULT_ARG) stop('--aevum --vault needs the vault address: --vault 0x… (deployed by the owner with script/InvoiceMandate.s.sol)');
      vault = getAddress(VAULT_ARG!);
    }
  } else {
    chainId = 31337;
    rpcUrl = `http://127.0.0.1:${ANVIL_PORT}`;
    explorerUrl = null;
    payerKey = ANVIL.payer;
    vendor = ANVIL.vendor;
    const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
    const home = join(homedir(), '.foundry', 'bin', exe);
    // The rehearsal needs its OWN fresh chain: refuse a port where something already answers.
    const busy = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(() => true, () => false);
    if (busy) stop(`port ${ANVIL_PORT} already answers: the rehearsal needs its own fresh Anvil (--anvil-port N)`);
    const anvil = spawn(existsSync(home) ? home : exe, ['--port', String(ANVIL_PORT), '--chain-id', '31337', '--block-time', '1', '--base-fee', '7', '--silent'], { stdio: 'ignore' });
    children.push(anvil);
    const chain = makeChain({ rpcUrl, chainId, token: '0x0000000000000000000000000000000000000000' });
    rehearsalClient = createPublicClient({ chain, transport: http(rpcUrl) });
    await waitFor(async () => (await rehearsalClient!.getChainId()) === 31337, 'anvil');
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL.deployer), chain, transport: http(rpcUrl) });
    const rc = await rehearsalClient.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) });
    token = getAddress(rc.contractAddress!);
    const wait = (hash: Hex) => rehearsalClient!.waitForTransactionReceipt({ hash });
    if (VAULT_MODE) {
      // The owner's three transactions, rehearsed: deploy (the deployer is the operator), deposit, set the mandate.
      const operator = getAddress(privateKeyToAccount(ANVIL.deployer).address);
      vault = getAddress((await wait(await deployer.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [token] }))).contractAddress!);
      await wait(await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [operator, 10_000_000n] }));
      // With --probe-paid the vault holds what each payment needs, like the public one (1 deposit per invoice).
      await wait(await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [vault, PROBE_ID ? toBaseUnits(AMOUNT) : 10_000_000n] }));
      const units = Number(toBaseUnits(AMOUNT));
      const agentAddr = getAddress(privateKeyToAccount(ANVIL.payer).address);
      const setMandate = async () => {
        const now = (await rehearsalClient!.getBlock()).timestamp;
        await wait(await deployer.writeContract({ address: vault!, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [agentAddr, vendorKey(VENDOR_ID), ANVIL.vendor, units, units, Number(now + 86_400n)] }));
      };
      await setMandate();
      // (Tests only, rehearsal only: SESSION_REHEARSE_SKIP_PROBE_HISTORY=1 leaves the probe unsettled, to check the guard.)
      if (PROBE_ID && VAULT_MODE && process.env['SESSION_REHEARSE_SKIP_PROBE_HISTORY'] !== '1') {
        // The public history, replayed: the agent pays PROBE_ID, a UTC day passes (the old mandate expires), the operator
        // deposits again and renews the mandate (same agent, vendor, payee and limits).
        const agentWallet = createWalletClient({ account: privateKeyToAccount(ANVIL.payer), chain, transport: http(rpcUrl) });
        await wait(await agentWallet.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args: [PROBE_ID, vendorKey(VENDOR_ID), ANVIL.vendor, BigInt(units)] }));
        await rehearsalClient.request({ method: 'evm_increaseTime' as never, params: [86_400 + 60] as never });
        // 72 blocks after the jump: Anvil's finalized (head − 64) is then past it, as on a chain that kept running.
        await rehearsalClient.request({ method: 'anvil_mine' as never, params: ['0x48'] as never });
        await wait(await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [vault, BigInt(units)] }));
        await setMandate();
      }
    } else {
      await wait(await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [getAddress(privateKeyToAccount(ANVIL.payer).address), 10_000_000n] }));
    }
  }
  const payer = getAddress(privateKeyToAccount(payerKey).address);
  const ceilingWei = parseGasCeiling(GAS_CEILING);
  const tipCapWei = TIP_CAP_GWEI !== undefined ? parsePriorityFeeCap(TIP_CAP_GWEI) : undefined;
  const chain: ChainConfig = { rpcUrl, chainId, token, confirm: parseConfirmRule(confirmation), maxGasCostWei: ceilingWei, ...(tipCapWei !== undefined ? { maxPriorityFeeWei: tipCapWei } : {}), ...(explorerUrl ? { explorerUrl } : {}), ...(vault ? { vault, vaultVendorId: VENDOR_ID } : {}) };
  /** Where the tUSD8 leave from: the vault, or the payer's own address. */
  const source = vault ?? payer;
  const client = createPublicClient({ chain: makeChain(chain), transport: http(rpcUrl) });
  const startBlock = await client.getBlockNumber();
  chain.logsFromBlock = startBlock;
  const tx = (h: string) => (explorerUrl ? `${explorerUrl}/tx/${h}` : h);

  out(`AgentFi invoice agent — session (${MODE === 'aevum' ? 'PUBLIC: QDay Aevum Testnet 44005, official tUSD8' : 'REHEARSAL: local Anvil 31337, local test token, nothing public'})`);
  if (vault) out(`Through the InvoiceMandate vault ${vault}: the agent ${payer} signs vault.payInvoice and pays gas; the tUSD8 leave the vault.`);
  out(`Session dir ${DIR} · invoice ${INVOICE_ID} · ${AMOUNT} tUSD8 · ${vault ? 'agent' : 'payer'} ${payer} → vendor ${vendor} · confirmation rule: ${confirmation} · gas ceiling ${GAS_CEILING} ${MODE === 'aevum' ? 'tQDAY' : 'ETH'} (${ceilingWei} wei) per transaction · tip cap ${tipCapWei !== undefined ? `${TIP_CAP_GWEI} gwei (${tipCapWei} wei)` : 'none (node suggestion)'} · counting from block ${startBlock}`);
  if (MODE === 'rehearse') out('  (on Anvil the node reports finalized = head − 64 blocks; the rehearsal mines blocks to move it. On Aevum it is the last L1-verified block.)');

  // ---- 1. Preflight ----------------------------------------------------------------------------
  out('\n1. Preflight (read-only)');
  const pf = await preflight({ rpcUrl, chainId, token, explorerUrl, gasSymbol: MODE === 'aevum' ? 'tQDAY' : 'ETH', expectedDecimals: 6, payer, vendor, amount: AMOUNT, maxGasCostWei: ceilingWei, ...(tipCapWei !== undefined ? { maxPriorityFeeWei: tipCapWei } : {}), ...(confirmation === 'finalized' ? { maxFinalizedLagSec: MAX_WAIT_MS / 1000 } : {}), ...(vault ? { vault, vendorId: VENDOR_ID, invoiceId: INVOICE_ID } : {}) });
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
    INVOICE_MAX_GAS_COST: GAS_CEILING,
    // Always set (empty = no cap), so a value left in the shell cannot give the agent a different rule than the preflight's.
    INVOICE_MAX_PRIORITY_FEE_GWEI: TIP_CAP_GWEI ?? '',
    ...(explorerUrl ? { INVOICE_EXPLORER_URL: explorerUrl } : {}),
  };
  saveMandate(env.INVOICE_MANDATE, {
    chainId, token, payer,
    vendor: { id: 'vendor-1', name: opt('vendor-name') ?? 'Vendor One', address: vendor },
    maxPerInvoice: AMOUNT, maxPerDay: AMOUNT, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    approvedBy: opt('by') ?? 'rehearsal', approvedAt: new Date().toISOString(),
    ...(vault ? { vault } : {}),
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
  // A resend. An agent error (e.g. the RPC failing) decides nothing and moves no money: it is reported
  // and the same invoice is asked again later, never paid under another id.
  const send = async (): Promise<Record<string, unknown>> => {
    try {
      const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invoice) });
      const body = (await res.json()) as Record<string, unknown>;
      return res.ok ? body : { outcome: 'agent-error', note: `HTTP ${res.status}: ${String(body['error'] ?? body['reason'] ?? '')}`.slice(0, 300) };
    } catch (e) {
      return { outcome: 'agent-error', note: e instanceof Error ? e.message : String(e) };
    }
  };
  const ledger = new Ledger(env.INVOICE_LEDGER);

  // ---- 2b. (--probe-paid) An already-paid invoice, resent to an agent whose ledger does not know it -------------
  if (PROBE_ID) {
    out(`\n2b. Invoice ${PROBE_ID}, already settled by the vault, is resent to the agent (this session's ledger is empty).`);
    const before = await settlementOf(chain, PROBE_ID);
    // Never send a probe the vault has not settled: the agent would pay it.
    if (!before.settled) stop(`the vault shows ${PROBE_ID} as NOT settled under ${VENDOR_ID}: no probe is sent (it would be paid). Check the id.`);
    out(`  vault settlementOf("${PROBE_ID}"): settled, ${formatUnits6(before.amount)} tUSD8, block ${before.blockNumber}, agent ${before.agent}`);
    const nonceBefore = await client.getTransactionCount({ address: payer, blockTag: 'pending' });
    const probeAgent = await startAgent();
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...invoice, id: PROBE_ID }) })
      .then(async (x) => (await x.json()) as Record<string, unknown>, (e) => ({ outcome: 'agent-error', note: e instanceof Error ? e.message : String(e) }) as Record<string, unknown>);
    probeAgent.kill();
    await new Promise((r) => (probeAgent.exitCode !== null || probeAgent.signalCode ? r(null) : probeAgent.once('exit', r)));
    const nonceAfter = await client.getTransactionCount({ address: payer, blockTag: 'pending' });
    const prow = ledger.get(PROBE_ID);
    out(`  agent → ${String(res['outcome']).toUpperCase()}${res['rule'] ? ` [${res['rule']}]` : ''}: ${String(res['reason'] ?? res['note'] ?? '')}`);
    out(`  ledger row: ${prow ? `${prow.status}, tx hash ${prow.tx_hash ?? 'none'}` : 'none'} · events ${ledger.events(PROBE_ID).map((e) => e.event).join(' → ') || '-'} · agent nonce (pending) ${nonceBefore} → ${nonceAfter}`);
    if (res['outcome'] !== 'refused' || res['rule'] !== 'vault:AlreadySettled' || prow?.tx_hash || nonceAfter !== nonceBefore) {
      stop(`the resend of ${PROBE_ID} was not refused by the vault with nothing signed: stop before the new invoice; check ${MODE === 'aevum' ? `${explorerUrl}/address/${payer}` : 'the ledger'}`);
    }
    out('  ✓ refused by the chain (vault:AlreadySettled at the gas estimate): nothing signed, nothing sent, no nonce used.');
  }

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
  const sawBroadcast = await waitFor(async () => ledger.events(INVOICE_ID).some((e) => e.event === 'broadcast' || e.event === 'refused' || e.event === 'refused-gas-ceiling' || e.event === 'refused-by-vault' || e.event === 'rpc-error-after-sign'), 'the broadcast in the ledger', 60_000, 10).then(() => true, () => false);
  agent.kill('SIGKILL');
  req.destroy();
  await new Promise((r) => (agent.exitCode !== null || agent.signalCode ? r(null) : agent.once('exit', r)));
  const row = ledger.get(INVOICE_ID);
  if (!row || !row.tx_hash) stop(`the agent recorded no payment for ${INVOICE_ID} (${row ? `${row.status}${row.rule ? ` [${row.rule}]` : ''}: ${row.reason}` : 'no row'}). Nothing was signed or sent.`);
  if (!sawBroadcast || !ledger.events(INVOICE_ID).some((e) => e.event === 'broadcast')) {
    stop(`the ledger did not record the broadcast within 60 s (status ${row!.status}, tx ${row!.tx_hash}): the agent was stopped. Not the planned scenario; do NOT pay this invoice again. Check ${tx(row!.tx_hash!)} and run ops reconcile.`);
  }
  const original = row!.tx_hash!;
  const signedEv = ledger.events(INVOICE_ID).find((e) => e.event === 'signed');
  const sd = signedEv?.detail ? (JSON.parse(signedEv.detail) as { maxGasCostWei?: string; ceilingWei?: string }) : {};
  out(`  signed with a maximum gas cost of ${sd.maxGasCostWei ?? '?'} wei (gas limit × maxFeePerGas), ceiling ${sd.ceilingWei ?? '?'} wei`);
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
  const where = MODE === 'aevum' ? `${explorerUrl}/address/${payer}` : 'the ledger';
  // Any outcome but these, or another hash, stops the session (unresolved, failed, conflict, refused).
  const check = (r: Record<string, unknown>, h: string | undefined) => {
    if (r['outcome'] === 'agent-error') return;
    if (!allowed.includes(String(r['outcome']))) stop(`the agent answered ${String(r['outcome']).toUpperCase()} for ${original}${r['reason'] ? ` (${r['reason']})` : ''}: stop, do not resend; check ${where}`);
    if (h !== original) stop(`the agent answered ${h ?? 'no hash'}, not the original ${original}: stop, do not resend; check ${where}`);
  };
  let r = await send();
  for (let i = 0; i < 5 && r['outcome'] === 'agent-error'; i++) {
    out(`  agent error, nothing decided: ${r['note']}; asking again in 10 s`);
    await new Promise((res) => setTimeout(res, 10_000));
    r = await send();
  }
  if (r['outcome'] === 'agent-error') stop(`the agent kept failing (${r['note']}): do not pay again; run ops reconcile later`);
  let h = show(r);
  check(r, h);
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
    if (r['stage'] === 'included') sentSince = Date.now();
    else if (r['outcome'] === 'pending' && Date.now() - sentSince > MAX_UNMINED_MS) {
      stop(`transaction ${original} has stayed out of a block for ${MAX_UNMINED_MS / 60_000} min: stop. Do NOT resend under another id; check ${tx(original)} and the payer's transactions.`);
    }
    if (MODE === 'rehearse') await rehearsalClient!.request({ method: 'anvil_mine' as never, params: ['0x21'] as never });
    await new Promise((res) => setTimeout(res, POLL_MS));
    r = await send();
    const stage = `${r['outcome']}/${r['stage'] ?? ''}/${r['blockNumber'] ?? ''}`;
    if (r['outcome'] === 'agent-error') {
      out(`  agent error, nothing decided: ${r['note']}; asking again`);
      continue;
    }
    if (stage !== lastStage) {
      h = show(r);
      lastStage = stage;
    }
    check(r, (((r['receipt'] as Record<string, unknown> | undefined)?.['txHash']) ?? r['txHash']) as string | undefined);
  }
  out(`  confirmed after ${Math.round((Date.now() - t0) / 1000)} s of waiting. Receipt:`);
  for (const l of JSON.stringify(r['receipt'], null, 2).split('\n')) out(`      ${l}`);

  // ---- 6. Independent checks ------------------------------------------------------------------------------------
  out('\n6. Checks');
  const v = await ops(env, 'verify', INVOICE_ID);
  for (const l of v.split('\n')) out(`    ${l}`);
  if (!/VERIFIED on chain/.test(v) || /NOT VERIFIED/.test(v)) stop('ops verify did not verify the receipt');
  const label = vault ? 'vault' : 'payer';
  const sent = await transfersFrom(chain, source, vendor);
  out(`  Transfer logs ${label} → vendor since block ${startBlock}: ${sent.length} (${sent.map((t) => `${formatUnits6(t.value)} tUSD8 in ${t.txHash}`).join(', ')})`);
  if (sent.length !== 1 || sent[0]!.txHash.toLowerCase() !== original.toLowerCase() || sent[0]!.value !== toBaseUnits(AMOUNT)) stop('not exactly one transfer, the one in the receipt');
  if (vault) {
    const settled = await settledEventsSince(chain);
    out(`  InvoiceSettled events of the vault since block ${startBlock}: ${settled.length} (${settled.map((s) => `"${s.invoiceId}" ${formatUnits6(s.amount)} tUSD8 → ${s.payTo} in ${s.txHash}`).join(', ')})`);
    const one = settled.length === 1 && settled[0]!;
    if (!one || one.txHash.toLowerCase() !== original.toLowerCase() || one.invoiceId !== INVOICE_ID || one.payTo !== vendor || one.amount !== toBaseUnits(AMOUNT)) stop('not exactly one InvoiceSettled, for this invoice, in the original transaction');
    const s = await settlementOf(chain, INVOICE_ID);
    out(`  settlementOf("${INVOICE_ID}"): ${s.settled ? `settled, ${formatUnits6(s.amount)} tUSD8, block ${s.blockNumber}, agent ${s.agent}` : 'NOT settled'}`);
    if (!s.settled || s.agent !== payer) stop('settlementOf does not show this settlement by this agent');
  }
  out(`  vendor balance now ${formatUnits6(await balanceOf(chain, vendor))} tUSD8 · ${label} ${formatUnits6(await balanceOf(chain, source))} tUSD8`);
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
