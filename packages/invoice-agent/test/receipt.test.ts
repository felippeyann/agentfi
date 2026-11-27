/**
 * The portable receipt (verify/receipt.js) and the accounts-payable example (examples/accounts-payable) against a
 * real local chain: the real vault and agent, read-only checks. The public positive case (QDAY-2026-11-24-001 on
 * Aevum) is `npm run ap:demo`; here the same demo runs against Anvil so CI needs no public network.
 *
 * Run: npm test (in packages/invoice-agent). Needs `anvil` on PATH or in ~/.foundry/bin.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain, type ChainConfig } from '../src/chain.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from '../src/generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { InvoicePayer } from '../src/payer.js';
import { vendorKey } from '../src/vault.js';
import { buildReceipt, checkReceipt, settlementId, type ExpectedInvoice, type Receipt } from '../verify/receipt.js';
import { rpcClient, verifyInvoice, type Rpc } from '../verify/verify.js';
import { freePort } from './fixtures/free-port.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await freePort();
const RPC = `http://127.0.0.1:${PORT}`;
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const AGENT = getAddress(privateKeyToAccount(AGENT_KEY).address);
const PAYEE = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const OTHER_PAYEE = getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');

let anvil: ChildProcess;
const raw = async (method: string, params: unknown[] = []) =>
  ((await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: unknown }).result;

before(async () => {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await raw('eth_chainId').catch(() => undefined)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('anvil did not start');
});
after(() => anvil?.kill());

/** A token, a vault paying vendor "acme" through the real agent, and helpers. Anvil: finalized = head − 64. */
async function world() {
  const chainDef = makeChain({ rpcUrl: RPC, chainId: 31337, token: '0x0000000000000000000000000000000000000000' });
  const p = createPublicClient({ chain: chainDef, transport: http(RPC) });
  const op = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), chain: chainDef, transport: http(RPC) });
  const wait = async (hash: Hex) => p.waitForTransactionReceipt({ hash });
  const token = getAddress((await wait(await op.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }))).contractAddress!);
  const deployVault = async () => {
    const vault = getAddress((await wait(await op.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [token] }))).contractAddress!);
    await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [vault, 100_000_000n] }));
    const now = BigInt((await p.getBlock()).timestamp);
    await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, vendorKey('acme'), PAYEE, 10_000_000, 50_000_000, Number(now + 86_400n)] }));
    const cfg: ChainConfig = { rpcUrl: RPC, chainId: 31337, token, vault, vaultVendorId: 'acme', confirm: { kind: 'finalized' } };
    const mandate: Mandate = { chainId: 31337, token, payer: AGENT, vendor: { id: 'acme', name: 'Acme', address: PAYEE }, vault, maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-receipt-')), 'ledger.sqlite');
    const pay = async (id: string, amount: string) => new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg, mandate, payerKey: AGENT_KEY, receiptTimeoutMs: 3_000 }).submit({ id, vendorId: 'acme', payTo: PAYEE, amount, currency: 'tUSD8' });
    return { vault, pay };
  };
  const finalize = () => raw('anvil_mine', ['0x50']);
  const receiptFor = async (vault: string, invoiceId: string): Promise<Receipt> => {
    const v = await verifyInvoice({ rpc: rpcClient(RPC), vault, invoiceId, vendorId: 'acme', chainId: 31337 });
    assert.equal(v.state, 'paid_verified', v.answer);
    return buildReceipt(v, { rpcUrl: RPC });
  };
  const expected = (vault: string, invoiceId: string, amountUnits = '2000000'): ExpectedInvoice => ({ chainId: 31337, vault, token, invoiceId, vendorId: 'acme', payee: PAYEE, amountUnits });
  const repointPayee = async (vault: string, payTo: string) => {
    const now = BigInt((await p.getBlock()).timestamp);
    await wait(await op.writeContract({ address: vault as Hex, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, vendorKey('acme'), getAddress(payTo), 10_000_000, 50_000_000, Number(now + 86_400n)] }));
  };
  return { token, deployVault, finalize, receiptFor, expected, repointPayee };
}

/** An RPC that fails its first `n` calls (a network outage), then answers. */
function flaky(n: number): Rpc {
  const real = rpcClient(RPC);
  let calls = 0;
  return async (method, params) => {
    if (calls++ < n) throw new Error(`${method}: simulated outage`);
    return real(method, params);
  };
}

describe('portable receipt', () => {
  it('carries the historical payee and amount in base units, and settles against the consumer\'s own record', async () => {
    const w = await world();
    const a = await w.deployVault();
    await a.pay('INV-R1', '2');
    await w.finalize();
    const r = await w.receiptFor(a.vault, 'INV-R1');
    assert.equal(r.format, 'agentfi.invoice-receipt');
    assert.equal(r.version, 1);
    assert.equal(r.network.chainId, 31337);
    assert.equal(r.amount.units, '2000000');
    assert.equal(r.payee.toLowerCase(), PAYEE.toLowerCase());
    assert.deepEqual(r.payment.events.map((e) => e.name), ['InvoiceSettled', 'Transfer']);
    const ok = await checkReceipt({ rpc: rpcClient(RPC), receipt: r, expected: w.expected(a.vault, 'INV-R1') });
    assert.equal(ok.state, 'settle', ok.answer);
    assert.equal(ok.decision, 'settle');
    assert.equal(ok.settlementId, settlementId(r));
    assert.equal(ok.proof?.txHash, r.payment.txHash);

    // A later change of the mandate (another payee) changes neither the receipt nor the decision.
    await w.repointPayee(a.vault, OTHER_PAYEE);
    const again = await w.receiptFor(a.vault, 'INV-R1');
    assert.equal(again.payee.toLowerCase(), PAYEE.toLowerCase(), 'payee from the payment, not the current mandate');
    assert.deepEqual({ ...again, issued: undefined }, { ...r, issued: undefined, finality: again.finality });
    const after = await checkReceipt({ rpc: rpcClient(RPC), receipt: r, expected: w.expected(a.vault, 'INV-R1') });
    assert.equal(after.state, 'settle', after.answer);
  });

  it('a valid receipt of another invoice or of another vault is divergent, without reading the chain', async () => {
    const w = await world();
    const a = await w.deployVault();
    const b = await w.deployVault();
    await a.pay('INV-A', '2');
    await b.pay('INV-B', '2');
    await w.finalize();
    const ra = await w.receiptFor(a.vault, 'INV-A');
    const rb = await w.receiptFor(b.vault, 'INV-B');
    const noChain: Rpc = async () => { throw new Error('must not be called'); };

    const otherInvoice = await checkReceipt({ rpc: noChain, receipt: ra, expected: w.expected(a.vault, 'INV-C') });
    assert.equal(otherInvoice.state, 'divergent');
    assert.equal(otherInvoice.decision, 'reject');
    assert.deepEqual(otherInvoice.differences?.map((d) => d.field), ['invoice.id']);

    const otherVault = await checkReceipt({ rpc: noChain, receipt: rb, expected: w.expected(a.vault, 'INV-B') });
    assert.equal(otherVault.state, 'divergent');
    assert.deepEqual(otherVault.differences?.map((d) => d.field), ['vault']);

    const otherAmount = await checkReceipt({ rpc: noChain, receipt: ra, expected: w.expected(a.vault, 'INV-A', '3000000') });
    assert.deepEqual(otherAmount.differences?.map((d) => d.field), ['amount.units']);
  });

  it('an edited copy is caught by the chain: forged invoice id, edited amount, another transaction', async () => {
    const w = await world();
    const a = await w.deployVault();
    await a.pay('INV-E', '2');
    await w.finalize();
    const r = await w.receiptFor(a.vault, 'INV-E');

    const forgedId = structuredClone(r);
    forgedId.invoice.id = 'INV-NEVER-PAID';
    const f = await checkReceipt({ rpc: rpcClient(RPC), receipt: forgedId, expected: w.expected(a.vault, 'INV-NEVER-PAID') });
    assert.equal(f.state, 'not_paid', f.answer);
    assert.equal(f.decision, 'reject');

    // The record and the copy both say 3 tUSD8; the chain says 2: divergent, from the chain.
    const edited = structuredClone(r);
    edited.amount.units = '3000000';
    const e = await checkReceipt({ rpc: rpcClient(RPC), receipt: edited, expected: w.expected(a.vault, 'INV-E', '3000000') });
    assert.equal(e.state, 'divergent', e.answer);
    assert.equal(e.source, 'chain');

    const otherTx = structuredClone(r);
    otherTx.payment.txHash = '0x' + 'ab'.repeat(32);
    const t = await checkReceipt({ rpc: rpcClient(RPC), receipt: otherTx, expected: w.expected(a.vault, 'INV-E') });
    assert.equal(t.state, 'mismatch', t.answer);
    assert.equal(t.decision, 'reject');

    const malformed = await checkReceipt({ rpc: rpcClient(RPC), receipt: { ...r, version: 2 }, expected: w.expected(a.vault, 'INV-E') });
    assert.equal(malformed.state, 'invalid');
  });

  it('an RPC outage is inconclusive (retry), and the same check settles once the RPC answers', async () => {
    const w = await world();
    const a = await w.deployVault();
    await a.pay('INV-O', '2');
    await w.finalize();
    const r = await w.receiptFor(a.vault, 'INV-O');
    for (const failing of [1, 3, 6]) {
      const down = await checkReceipt({ rpc: flaky(failing), receipt: r, expected: w.expected(a.vault, 'INV-O') });
      assert.equal(down.state, 'inconclusive', `${failing} failed calls: ${down.answer}`);
      assert.equal(down.decision, 'retry');
    }
    const up = await checkReceipt({ rpc: flaky(0), receipt: r, expected: w.expected(a.vault, 'INV-O') });
    assert.equal(up.state, 'settle', up.answer);
  });

  it('a settlement that is not finalized yet is pending (retry), not settle', async () => {
    const w = await world();
    const a = await w.deployVault();
    await a.pay('INV-F', '2');
    await w.finalize();
    const r = await w.receiptFor(a.vault, 'INV-F');
    await a.pay('INV-P', '1'); // settled, not finalized
    const copy = structuredClone(r);
    copy.invoice.id = 'INV-P';
    copy.amount.units = '1000000';
    const p = await checkReceipt({ rpc: rpcClient(RPC), receipt: copy, expected: w.expected(a.vault, 'INV-P', '1000000') });
    assert.equal(p.state, 'pending', p.answer);
    assert.equal(p.decision, 'retry');
  });
});

/** An RPC that answers like the real one except for one method, whose answer is replaced (a degraded node). */
function degraded(method: string, answer: unknown): Rpc {
  const real = rpcClient(RPC);
  return async (m, params) => (m === method ? answer : real(m, params));
}

describe('degraded RPC answers are inconclusive, never a reject', () => {
  it('no logs, no transaction receipt, an empty eth_call, a node behind the receipt\'s block', async () => {
    const w = await world();
    const a = await w.deployVault();
    await a.pay('INV-D', '2');
    await w.finalize();
    const r = await w.receiptFor(a.vault, 'INV-D');
    const x = w.expected(a.vault, 'INV-D');
    for (const [method, answer] of [['eth_getLogs', []], ['eth_getTransactionReceipt', null], ['eth_call', '0x']] as const) {
      const c = await checkReceipt({ rpc: degraded(method, answer), receipt: r, expected: x });
      assert.equal(c.state, 'inconclusive', `${method} -> ${JSON.stringify(answer)}: ${c.answer}`);
      assert.equal(c.decision, 'retry');
    }
    // A node whose state is behind (it does not know the settlement yet) and whose head is below the receipt's block.
    const behind: Rpc = async (m, params) => {
      if (m === 'eth_blockNumber') return '0x1';
      if (m === 'eth_call') return '0x' + '0'.repeat(64 * 6);
      return rpcClient(RPC)(m, params);
    };
    const b = await checkReceipt({ rpc: behind, receipt: r, expected: x });
    assert.equal(b.state, 'inconclusive', b.answer);
  });
});

const AP = join(PKG, 'examples', 'accounts-payable', 'ap.mjs');
type ApRun = { code: number | null; result?: { outcome: string; state?: string; invoices?: Record<string, { status: string }>; settlements?: number; settledEvents?: number; inbox?: unknown[]; results?: { outcome: string }[] } };
function apAsync(state: string, args: string[], env: Record<string, string> = {}): Promise<ApRun> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', AP, ...args], { env: { ...process.env, AP_STATE: state, AP_RPC: RPC, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      done({ code, ...(line ? { result: JSON.parse(line.slice(7)) } : {}) });
    });
  });
}

describe('accounts-payable example', () => {
  async function setup() {
    const w = await world();
    const a = await w.deployVault();
    await a.pay('QDAY-2026-11-24-001', '1');
    await w.finalize();
    const dir = mkdtempSync(join(tmpdir(), 'ap-demo-'));
    const receipt = join(dir, 'receipt.json');
    writeFileSync(receipt, JSON.stringify(await w.receiptFor(a.vault, 'QDAY-2026-11-24-001'), null, 2));
    const exp = (invoiceId: string) => w.expected(a.vault, invoiceId, '1000000');
    const books = join(dir, 'books.json');
    writeFileSync(books, JSON.stringify({ invoices: { 'AP-2026-0001': { expected: exp('QDAY-2026-11-24-001') }, 'AP-2026-0002': { expected: exp('QDAY-2026-11-24-002') } } }));
    return { dir, receipt, books, vault: a.vault };
  }

  it('npm run ap:demo against a local chain: outage then one mark, restart, divergent copies, concurrent deliveries', async () => {
    const { dir, receipt, books } = await setup();
    const run = spawnSync(process.execPath, [join(PKG, 'examples', 'accounts-payable', 'demo.mjs')], {
      env: { ...process.env, AP_RPC: RPC, AP_BOOKS: books, AP_RECEIPT: receipt, AP_DEMO_DIR: dir }, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Every step behaved as expected/);
    // The books on disk, read by a new process: one mark for the expected invoice, an empty inbox.
    const s = (await apAsync(join(dir, '.state'), ['status'])).result as unknown as { invoices: Record<string, { status: string }>; settlements: number; inbox: unknown[] };
    assert.deepEqual(Object.fromEntries(Object.entries(s.invoices).map(([k, v]) => [k, v.status])), { 'AP-2026-0001': 'paid', 'AP-2026-0002': 'open' });
    assert.equal(s.inbox.length, 0);
  });

  it('a process killed during the check leaves the delivery in the inbox; retry marks it once', async () => {
    const { dir, receipt, books } = await setup();
    const state = join(dir, 'killed');
    assert.equal((await apAsync(state, ['init'], { AP_BOOKS: books })).code, 0);
    // An RPC that accepts the connection and never answers: the check hangs, then the process is killed.
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const hang = createServer((sock) => { sock.on('error', () => undefined); sockets.push(sock); }).listen(0, '127.0.0.1');
    await new Promise((r) => hang.once('listening', r));
    const port = (hang.address() as import('node:net').AddressInfo).port;
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', AP, 'deliver', 'AP-2026-0001', receipt], { env: { ...process.env, AP_STATE: state, AP_RPC: `http://127.0.0.1:${port}` }, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
    p.kill('SIGKILL');
    await new Promise((r) => p.once('close', r));
    for (const s of sockets) s.destroy();
    hang.close();
    const before = (await apAsync(state, ['status'])).result!;
    assert.equal(before.settlements, 0);
    assert.equal(before.inbox?.length, 1, 'the delivery was written down on arrival');
    const r = await apAsync(state, ['retry']);
    assert.equal(r.code, 0);
    assert.equal(r.result?.results?.[0]?.outcome, 'settled');
    const after = (await apAsync(state, ['status'])).result!;
    assert.equal(after.settlements, 1);
    assert.equal(after.inbox?.length, 0);
  });

  it('six deliveries and two retries at the same time, plus the same payment for another invoice: one mark', async () => {
    const { dir, receipt, books, vault } = await setup();
    // A duplicate entry in the books (same expected data under another reference): one payment settles one invoice.
    const dupBooks = join(dir, 'books-dup.json');
    const b = JSON.parse(readFileSync(books, 'utf8'));
    b.invoices['AP-2026-0003'] = b.invoices['AP-2026-0001'];
    writeFileSync(dupBooks, JSON.stringify(b));
    const state = join(dir, 'many');
    assert.equal((await apAsync(state, ['init'], { AP_BOOKS: dupBooks })).code, 0);
    const runs = await Promise.all([
      ...Array.from({ length: 6 }, () => apAsync(state, ['deliver', 'AP-2026-0001', receipt])),
      apAsync(state, ['retry']), apAsync(state, ['retry']),
      apAsync(state, ['deliver', 'AP-2026-0003', receipt]),
    ]);
    for (const r of runs) assert.notEqual(r.code, 1, JSON.stringify(r));
    const s = (await apAsync(state, ['status'])).result as unknown as { invoices: Record<string, { status: string }>; settlements: number; settledEvents: number; inbox: unknown[] };
    assert.equal(s.settlements, 1);
    assert.equal(s.settledEvents, 1);
    assert.equal(s.inbox.length, 0);
    assert.equal(Object.values(s.invoices).filter((v) => v.status === 'paid').length, 1);
    assert.ok(vault);
  });

  it('the CLI scripts: receipt:fetch writes the receipt, receipt:check settles it and rejects an edited record', async () => {
    const { dir, vault } = await setup();
    const out = join(dir, 'fetched.json');
    const f = spawnSync(process.execPath, [join(PKG, 'scripts', 'fetch-receipt.mjs'), '--vault', vault, '--invoice', 'QDAY-2026-11-24-001', '--vendor', 'acme', '--rpc', RPC, '--chain', '31337', '--out', out], { encoding: 'utf8' });
    assert.equal(f.status, 0, f.stderr);
    const fetched = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(fetched.format, 'agentfi.invoice-receipt');
    const books = JSON.parse(readFileSync(join(dir, 'books.json'), 'utf8'));
    const expect = join(dir, 'expected.json');
    writeFileSync(expect, JSON.stringify(books.invoices['AP-2026-0001'].expected));
    const ok = spawnSync(process.execPath, [join(PKG, 'scripts', 'check-receipt.mjs'), '--receipt', out, '--expect', expect, '--rpc', RPC], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^SETTLE \(decision: settle\)/);
    writeFileSync(expect, JSON.stringify({ ...books.invoices['AP-2026-0001'].expected, amountUnits: '2000000' }));
    const bad = spawnSync(process.execPath, [join(PKG, 'scripts', 'check-receipt.mjs'), '--receipt', out, '--expect', expect, '--rpc', RPC], { encoding: 'utf8' });
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /^DIVERGENT/);
  });
});
