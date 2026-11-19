/**
 * `npm run demo` (in packages/invoice-agent): one invoice, one payment, one receipt, on a LOCAL Anvil
 * chain with a LOCAL TEST token. Starts and stops everything it needs; touches no public network.
 *
 *   1. The operator writes the mandate: pay "acme" at its registered address, ≤ 10 tUSD8 per invoice.
 *   2. INV-001, 8 tUSD8: paid, receipt, verified by the operator.
 *   3. INV-001 again: the same receipt; one transfer on-chain.
 *   4. INV-002 (12 tUSD8) and INV-003 (payee changed): refused, explained, no transfer.
 *   5. INV-004: the agent dies right after broadcasting (lost response); resubmitted: recovered, one transfer.
 *   6. INV-005: same crash while the chain is not mining: resubmitted → PENDING (not paid again); mined → recovered.
 *   7. INV-006: the agent dies after recording but before broadcasting: resubmitted → the SAME signed bytes are sent.
 *   Then invariants on balances and Transfer logs. Exit 0 only if all hold.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { balanceOf, makeChain, transfersFrom, type ChainConfig } from './chain.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from './generated/local-test-usd8.js';
import { formatUnits6 } from './invoice.js';
import { saveMandate, type Mandate } from './mandate.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
// Anvil's well-known development keys (public; worthless anywhere but a local Anvil).
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  vendor: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  impostor: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;
const addr = (k: Hex) => getAddress(privateKeyToAccount(k).address);
const ANVIL_PORT = Number(process.env['DEMO_ANVIL_PORT'] ?? 8566);
const AGENT_PORT = Number(process.env['DEMO_AGENT_PORT'] ?? 8787);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const CHAIN_ID = 31337;

const dir = mkdtempSync(join(tmpdir(), 'agentfi-qday-demo-'));
const transcript = process.env['DEMO_TRANSCRIPT'] ?? join(dir, 'transcript.txt');
const out = (line = '') => {
  console.log(line);
  appendFileSync(transcript, line + '\n');
};
let failures = 0;
const check = (ok: boolean, what: string) => {
  out(`  ${ok ? '✓' : '✗ INVARIANT BROKEN:'} ${what}`);
  if (!ok) failures++;
};
const children: ChildProcess[] = [];
const cleanup = () => children.forEach((c) => c.exitCode === null && c.kill());
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function findAnvil(): string {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  return existsSync(home) ? home : exe;
}

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return ((await r.json()) as { result: unknown }).result;
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const env = { INVOICE_RPC_URL: RPC, INVOICE_MANDATE: join(dir, 'mandate.json'), INVOICE_LEDGER: join(dir, 'ledger.sqlite') };

async function startAgent(failAt?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: PKG,
    env: { ...process.env, ...env, INVOICE_PAYER_KEY: KEYS.payer, INVOICE_PORT: String(AGENT_PORT), ...(failAt ? { INVOICE_FAIL_AT: failAt } : { INVOICE_FAIL_AT: '' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr!.on('data', (d) => process.env['DEMO_VERBOSE'] && process.stderr.write(d));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${AGENT_PORT}/health`)).ok, 'the agent');
  return child;
}

async function stopAgent(child: ChildProcess) {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
}

async function send(inv: Record<string, string>): Promise<Record<string, unknown> | { transportError: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${AGENT_PORT}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(inv) });
    return (await r.json()) as Record<string, unknown>;
  } catch (e) {
    return { transportError: e instanceof Error ? `${e.message}${e.cause ? ` (${(e.cause as Error).message ?? e.cause})` : ''}` : String(e) };
  }
}

const show = (label: string, r: Record<string, unknown>) => {
  if ('transportError' in r) return out(`  ${label} → NO RESPONSE: ${r['transportError']}`);
  const receipt = r['receipt'] as Record<string, unknown> | undefined;
  out(`  ${label} → ${String(r['outcome']).toUpperCase()}${receipt ? `: ${receipt['amount']} tUSD8 to ${receipt['to']}, tx ${receipt['txHash']}, block ${receipt['blockNumber']}` : ''}`);
  for (const k of ['reason', 'whatToDo', 'note', 'next'] as const) if (r[k]) out(`      ${k}: ${r[k]}`);
};

function ops(...args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'src/ops.ts', ...args], { cwd: PKG, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout!.on('data', (d) => (text += d));
    c.stderr!.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code: code ?? 1, text: text.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n|\(Use `node --trace-warnings[^\n]*\n/g, '').trimEnd() }));
  });
}
const showOps = async (...args: string[]) => {
  const r = await ops(...args);
  out(`  $ npm run ops -- ${args.join(' ')}`);
  for (const l of r.text.split('\n')) out(`    ${l}`);
  return r;
};

async function main() {
  writeFileSync(transcript, '');
  out(`AgentFi × QDay — invoice payment demo (LOCAL: Anvil chain ${CHAIN_ID}, LOCAL TEST token, demo data)`);
  out(`Working dir: ${dir}`);
  const anvil = spawn(findAnvil(), ['--port', String(ANVIL_PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  children.push(anvil);
  await waitFor(async () => (await rpc('eth_chainId')) !== undefined, 'anvil');

  const chain = makeChain({ rpcUrl: RPC, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const deployer = createWalletClient({ account: privateKeyToAccount(KEYS.deployer), chain, transport: http(RPC) });
  const deployHash = await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!);
  const mint = await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [addr(KEYS.payer), 100_000_000n] });
  await pub.waitForTransactionReceipt({ hash: mint });
  const cfg: ChainConfig = { rpcUrl: RPC, chainId: CHAIN_ID, token };
  const PAYER = addr(KEYS.payer), VENDOR = addr(KEYS.vendor), IMPOSTOR = addr(KEYS.impostor);
  out(`Token ${token} (tUSD8-LOCAL, 6 decimals) · payer ${PAYER} funded with 100 · vendor "acme" ${VENDOR}`);

  out('\n1. The operator approves the agent in advance: pay "acme" at its registered address, ≤ 10 tUSD8 per invoice, ≤ 50 per day.');
  const mandate: Mandate = {
    chainId: CHAIN_ID, token, payer: PAYER,
    vendor: { id: 'acme', name: 'Acme Data Ltd', address: VENDOR },
    maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'operator (demo)', approvedAt: new Date().toISOString(),
  };
  saveMandate(env.INVOICE_MANDATE, mandate);
  out(`  mandate.json written by the operator; the agent reads it and cannot change it.`);

  let agent = await startAgent();
  const inv = (id: string, amount: string, payTo = VENDOR) => ({ id, vendorId: 'acme', payTo, amount, currency: 'tUSD8', description: `demo invoice ${id}` });

  out('\n2. Invoice INV-001 for 8 tUSD8 arrives.');
  const first = await send(inv('INV-001', '8'));
  show('agent', first);
  const firstTx = (first as { receipt?: { txHash: string } }).receipt?.txHash;
  await showOps('verify', 'INV-001');

  out('\n3. The same invoice INV-001 arrives again.');
  const again = await send(inv('INV-001', '8'));
  show('agent', again);
  check((again as { outcome?: string }).outcome === 'replayed' && (again as { receipt?: { txHash: string } }).receipt?.txHash === firstTx, 'same receipt (same tx hash), outcome replayed');
  const conflict = await send(inv('INV-001', '9'));
  show('INV-001 again but for 9 tUSD8', conflict);
  const second = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: PKG, env: { ...process.env, ...env, INVOICE_PAYER_KEY: KEYS.payer, INVOICE_PORT: String(AGENT_PORT + 1), INVOICE_FAIL_AT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    c.stderr!.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code, text }));
  });
  const why = /another agent process[^\n]*/.exec(second.text)?.[0] ?? second.text.trim().split('\n').pop();
  out(`  a second agent process on the same ledger → refused to start: ${why}`);
  check(second.code !== 0 && /another agent process/.test(second.text), 'only one agent process may decide on these invoices');
  let toVendor = await transfersFrom(cfg, PAYER, VENDOR);
  check(toVendor.length === 1 && toVendor[0]!.value === 8_000_000n, `one transfer payer → acme on-chain (${toVendor.length}), 8 tUSD8`);
  check((await balanceOf(cfg, PAYER)) === 92_000_000n, 'payer balance 100 → 92');

  out('\n4. Invoices the mandate does not cover.');
  show('INV-002, 12 tUSD8', await send(inv('INV-002', '12')));
  show('INV-003, 5 tUSD8, payee changed', await send(inv('INV-003', '5', IMPOSTOR)));
  check((await transfersFrom(cfg, PAYER)).length === 1, 'still one transfer from the payer: nothing moved for INV-002 / INV-003');
  check((await balanceOf(cfg, IMPOSTOR)) === 0n, 'the changed payee received nothing');
  await showOps('verify', 'INV-003');

  out('\n5. The failure that matters: the payment goes out, the agent dies before answering.');
  await stopAgent(agent);
  agent = await startAgent('after-broadcast');
  show('INV-004, 3 tUSD8', await send(inv('INV-004', '3')));
  await new Promise((r) => agent.exitCode !== null ? r(null) : agent.once('exit', r));
  out(`  agent process killed (${agent.signalCode ?? `exit ${agent.exitCode}`}): simulated crash right after broadcasting, before answering`);
  const sentBefore = (await transfersFrom(cfg, PAYER)).length;
  out(`  on-chain meanwhile: ${sentBefore} transfers from the payer (the payment did go out)`);
  agent = await startAgent();
  const recovered = await send(inv('INV-004', '3'));
  show('INV-004 resubmitted after restart', recovered);
  const inv4 = (await transfersFrom(cfg, PAYER, VENDOR)).filter((t) => t.value === 3_000_000n);
  check((recovered as { outcome?: string }).outcome === 'recovered' && inv4.length === 1 && inv4[0]!.txHash === (recovered as { receipt?: { txHash: string } }).receipt?.txHash,
    'outcome recovered, and exactly one 3 tUSD8 transfer on-chain, the one in the receipt');

  out('\n6. Same crash while the chain is not mining yet (the receipt cannot exist).');
  await rpc('evm_setAutomine', [false]);
  await stopAgent(agent);
  agent = await startAgent('after-broadcast');
  show('INV-005, 2 tUSD8', await send(inv('INV-005', '2')));
  await new Promise((r) => agent.exitCode !== null ? r(null) : agent.once('exit', r));
  agent = await startAgent();
  const pending = await send(inv('INV-005', '2'));
  show('INV-005 resubmitted', pending);
  check((pending as { outcome?: string }).outcome === 'pending', 'outcome pending: the agent does not pay again');
  const again5 = await send(inv('INV-005', '2'));
  show('INV-005 resubmitted again, still not mined', again5);
  await showOps('verify', 'INV-005');
  out('  … a block is mined');
  await rpc('evm_mine');
  await rpc('evm_setAutomine', [true]);
  await showOps('reconcile', 'INV-005');
  const done5 = await send(inv('INV-005', '2'));
  show('INV-005 resubmitted after the block (the operator\'s reconcile already confirmed it)', done5);
  const pendingTx = (pending as { txHash?: string }).txHash;
  check((done5 as { receipt?: { txHash: string } }).receipt?.txHash === pendingTx, 'the receipt is the transaction reported as pending, not a new one');
  check((await transfersFrom(cfg, PAYER, VENDOR)).filter((t) => t.value === 2_000_000n).length === 1, 'exactly one 2 tUSD8 transfer on-chain');

  out('\n7. The agent dies after recording the signed payment but before sending it.');
  await stopAgent(agent);
  agent = await startAgent('after-sign');
  show('INV-006, 1 tUSD8', await send(inv('INV-006', '1')));
  await new Promise((r) => agent.exitCode !== null ? r(null) : agent.once('exit', r));
  check((await transfersFrom(cfg, PAYER)).length === 3, 'nothing reached the chain yet (still 3 transfers)');
  agent = await startAgent();
  const six = await send(inv('INV-006', '1'));
  show('INV-006 resubmitted', six);
  const events6 = (await (await fetch(`http://127.0.0.1:${AGENT_PORT}/invoices/INV-006`)).json()) as { events: { event: string; detail: string | null }[] };
  const signedHash = JSON.parse(events6.events.find((e) => e.event === 'signed')!.detail!).txHash as string;
  out(`  ledger events for INV-006: ${events6.events.map((e) => e.event).join(' → ')}`);
  check((six as { receipt?: { txHash: string } }).receipt?.txHash === signedHash, `receipt tx = the hash recorded when it was signed before the crash (${signedHash.slice(0, 10)}…)`);
  check((await transfersFrom(cfg, PAYER, VENDOR)).filter((t) => t.value === 1_000_000n).length === 1, 'exactly one 1 tUSD8 transfer: the same signed bytes were sent, not a new payment');

  out('\nOperator view at the end:');
  await showOps('status');
  const all = await transfersFrom(cfg, PAYER);
  const total = all.reduce((s, t) => s + t.value, 0n);
  check(all.length === 4 && total === 14_000_000n, `4 transfers from the payer, 8 + 3 + 2 + 1 = ${formatUnits6(total)} tUSD8`);
  check((await balanceOf(cfg, PAYER)) === 86_000_000n && (await balanceOf(cfg, VENDOR)) === 14_000_000n, 'payer 86, acme 14, changed payee 0');
  await stopAgent(agent);
  out(failures === 0 ? '\nOK: every invariant held.' : `\nFAILED: ${failures} invariant(s) broken.`);
  out(`Transcript: ${transcript}`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => {
  cleanup();
  process.exit(code);
}, (e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
