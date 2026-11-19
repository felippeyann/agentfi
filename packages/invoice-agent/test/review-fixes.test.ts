/**
 * Regression tests for the independent review of 2026-11-19 (local Anvil, LOCAL TEST token):
 *   P1-a  two writers on one ledger must not pay the same invoice twice (insert check + one-process lock)
 *   P1-b  an RPC failure while resubmitting after a lost response must not turn a payment into "no money moved"
 *         (and a nonce taken by another transaction leaves the invoice OPEN, never "no money moved")
 *   P2-b  a refused invoice is judged again on resubmission
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain, transfersFrom, type ChainConfig } from '../src/chain.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import type { Invoice } from '../src/invoice.js';
import { acquireInstanceLock, Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer, type FailPoint } from '../src/payer.js';

const PORT = 8900 + Math.floor(Math.random() * 300);
const ANVIL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const PAYER = getAddress(privateKeyToAccount(PAYER_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

let anvil: ChildProcess;
let proxy: Server;
let proxyUrl = '';
/** JSON-RPC methods the proxy answers with HTTP 503 (a flaky public RPC). */
const failing = new Set<string>();

before(async () => {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(() => true, () => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const method = (JSON.parse(body) as { method?: string }).method ?? '';
    if (failing.has(method)) {
      res.writeHead(503).end('upstream unavailable');
      return;
    }
    const upstream = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});
after(() => {
  anvil?.kill();
  proxy?.close();
});

async function world(rpcUrl = ANVIL) {
  const chain = makeChain({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(ANVIL) });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain, transport: http(ANVIL) });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) })).contractAddress!);
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [PAYER, 100_000_000n] }) });
  const cfg: ChainConfig = { rpcUrl, chainId: CHAIN_ID, token };
  const direct: ChainConfig = { rpcUrl: ANVIL, chainId: CHAIN_ID, token };
  const mandate = (maxPerInvoice = '10'): Mandate => ({
    chainId: CHAIN_ID, token, payer: PAYER, vendor: { id: 'acme', name: 'Acme', address: VENDOR },
    maxPerInvoice, maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString(),
  });
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-fix-')), 'ledger.sqlite');
  const agent = (opts: { failAt?: FailPoint; max?: string } = {}) =>
    new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg, mandate: mandate(opts.max), payerKey: PAYER_KEY, receiptTimeoutMs: 4_000, ...(opts.failAt ? { failAt: opts.failAt } : {}) });
  return { cfg, direct, ledgerPath, agent, sent: () => transfersFrom(direct, PAYER), pub, token };
}
const invoice = (id: string, amount: string): Invoice => ({ id, vendorId: 'acme', payTo: VENDOR, amount, currency: 'tUSD8' });

describe('review P1-a: two writers on one ledger', () => {
  it('two payer instances racing the same invoice: one signs and pays, the other discards its signature', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.agent().submit(invoice('INV-R1', '8')), w.agent().submit(invoice('INV-R1', '8'))]);
    const onChain = await w.sent();
    assert.equal(onChain.length, 1, `exactly one transfer (got ${onChain.length})`);
    const hashes = [a, b].map((o) => ('receipt' in o ? o.receipt.txHash : 'txHash' in o ? o.txHash : null));
    assert.deepEqual(hashes, [onChain[0]!.txHash, onChain[0]!.txHash], `${a.outcome} / ${b.outcome}`);
    // The race really happened: the second writer signed too, found the id taken and threw its bytes away.
    const events = new Ledger(w.ledgerPath).events('INV-R1').map((e) => e.event);
    assert.ok(events.includes('discarded-duplicate-signature'), `events: ${events.join(', ')}`);
  });

  it('a second agent process on the same ledger is refused; a lock left by a dead process is taken over', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'invoice-agent-lock-')), 'ledger.sqlite');
    const release = acquireInstanceLock(path);
    writeFileSync(`${path}.lock`, String(process.ppid)); // a live process that is not us
    assert.throws(() => acquireInstanceLock(path), /another agent process/);
    writeFileSync(`${path}.lock`, '2147483646'); // a pid that does not exist
    const again = acquireInstanceLock(path);
    again();
    release();
  });
});

describe('review P1-b: chain reads that fail or cannot see the payment', () => {
  it('RPC failing during the resubmission after a lost response: an error, the row unchanged, then recovered', async () => {
    const w = await world(proxyUrl);
    await assert.rejects(w.agent({ failAt: 'after-broadcast' }).submit(invoice('INV-R2', '8')), FailPointError);
    failing.add('eth_getTransactionReceipt').add('eth_getTransactionByHash');
    try {
      await assert.rejects(w.agent().submit(invoice('INV-R2', '8')), 'a chain read that fails is an error, not "not found"');
      const row = new Ledger(w.ledgerPath).get('INV-R2')!;
      assert.equal(row.status, 'broadcast', 'the row is left open, not marked as failed');
    } finally {
      failing.clear();
    }
    const r = await w.agent().submit(invoice('INV-R2', '8'));
    assert.equal(r.outcome, 'recovered');
    assert.equal((await w.sent()).length, 1);
  });

  it('the payer nonce taken by another transaction: the invoice is UNRESOLVED (open), never "no money moved"', async () => {
    const w = await world();
    await assert.rejects(w.agent({ failAt: 'after-sign' }).submit(invoice('INV-R6', '3')), FailPointError);
    const row = new Ledger(w.ledgerPath).get('INV-R6')!;
    // Someone else uses the payer's key with the same nonce (an unrelated self-transfer of 1 unit).
    const other = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: makeChain(w.direct), transport: http(ANVIL) });
    await w.pub.waitForTransactionReceipt({ hash: await other.writeContract({ address: w.token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [PAYER, 1n], nonce: row.nonce! }) });
    const r = await w.agent().submit(invoice('INV-R6', '3'));
    assert.equal(r.outcome, 'unresolved');
    assert.match((r as { next: string }).next, /Do NOT pay this invoice again/);
    assert.equal(new Ledger(w.ledgerPath).get('INV-R6')!.status, 'stuck');
    assert.equal((await w.agent().submit(invoice('INV-R6', '3'))).outcome, 'unresolved', 'stays open, checked again');
    assert.equal((await w.sent()).filter((t) => t.to === VENDOR).length, 0, 'nothing was paid to the vendor');
  });
});

describe('review P2-b: a refusal is not forever', () => {
  it('a refused invoice is judged again: paid once the operator raised the limit', async () => {
    const w = await world();
    assert.equal((await w.agent().submit(invoice('INV-R3', '12'))).outcome, 'refused');
    const r = await w.agent({ max: '20' }).submit(invoice('INV-R3', '12'));
    assert.equal(r.outcome, 'paid');
    assert.equal((await w.sent()).length, 1);
  });
});
