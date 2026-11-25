/**
 * eth_getLogs in pages of at most 1,000 blocks (the Aevum public RPC refuses more: "block range too large, max range:
 * 1000", read on 2026-11-24 when `ops verify` of QDAY-2026-11-24-001 failed on blocks 0x3d7ff0–0x3d951f).
 *
 * What must hold: the pages cover the whole window, inclusive, with no gap and no overlap; the duplicate count still
 * sees a transfer in any page (not only the receipt's block); a page that fails after a good one makes the whole check
 * fail as INCOMPLETE, never "verified" on a partial count.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { blockPages, IncompleteLogScanError, LOG_PAGE_BLOCKS, makeChain, scanPages, transfersFrom, type ChainConfig } from '../src/chain.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import { inquireInvoice, verifyInvoice } from '../src/inquiry.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { InvoicePayer } from '../src/payer.js';

describe('log pages: the rule', () => {
  it('1,000 blocks are one page; 1,001 are two; the page size is 1,000', () => {
    assert.equal(LOG_PAGE_BLOCKS, 1000n);
    assert.deepEqual(blockPages(4030448n, 4031447n), [[4030448n, 4031447n]]);
    assert.deepEqual(blockPages(4030448n, 4031448n), [[4030448n, 4031447n], [4031448n, 4031448n]]);
    assert.deepEqual(blockPages(7n, 7n), [[7n, 7n]]);
    assert.deepEqual(blockPages(8n, 7n), []);
    assert.throws(() => blockPages(0n, 10n, 0n), /at least 1 block/);
  });

  it('the window of the failed ops verify (0x3d7ff0–0x3d951f, 5,424 blocks): 6 pages, inclusive, no gap, no overlap, none above 1,000', () => {
    const from = 0x3d7ff0n, to = 0x3d951fn;
    const pages = blockPages(from, to);
    assert.equal(pages.length, 6);
    assert.equal(pages[0]![0], from);
    assert.equal(pages.at(-1)![1], to);
    for (let i = 0; i < pages.length; i++) {
      const [s, e] = pages[i]!;
      assert.ok(e >= s && e - s + 1n <= 1000n, `page ${s}–${e}`);
      if (i > 0) assert.equal(s, pages[i - 1]![1] + 1n, 'the next page starts right after the previous one');
    }
    assert.equal(pages.reduce((n, [s, e]) => n + (e - s + 1n), 0n), to - from + 1n, 'every block exactly once');
  });

  it('random windows and sizes: every block exactly once', () => {
    for (let k = 0; k < 200; k++) {
      const from = BigInt(Math.floor(Math.random() * 1e7)), len = BigInt(Math.floor(Math.random() * 5000)), size = BigInt(1 + Math.floor(Math.random() * 1500));
      const pages = blockPages(from, from + len - 1n, size);
      let next = from;
      for (const [s, e] of pages) {
        assert.equal(s, next);
        assert.ok(e - s + 1n <= size);
        next = e + 1n;
      }
      assert.equal(next, from + len);
    }
  });

  it('a duplicate in another page is counted; a failure after a valid first page throws INCOMPLETE, never a partial list', async () => {
    const seen: Array<[bigint, bigint]> = [];
    const both = await scanPages('t', 0n, 2500n, async (s, e) => {
      seen.push([s, e]);
      return s === 0n ? ['pay'] : s === 2000n ? ['duplicate'] : [];
    });
    assert.deepEqual(both, ['pay', 'duplicate']);
    assert.deepEqual(seen, [[0n, 999n], [1000n, 1999n], [2000n, 2500n]]);

    await assert.rejects(
      scanPages('the Transfer logs', 0n, 2500n, async (s) => {
        if (s === 0n) return ['pay'];
        throw new Error('block range too large, max range: 1000');
      }),
      (e: unknown) => {
        assert.ok(e instanceof IncompleteLogScanError);
        assert.equal(e.pagesRead, 1);
        assert.equal(e.pagesTotal, 3);
        assert.deepEqual(e.failedPage, [1000n, 1999n]);
        assert.match(e.message, /INCOMPLETE.*nothing is verified/);
        return true;
      },
    );
  });
});

// ---- Against a node that enforces the Aevum limit: Anvil behind a proxy that refuses ranges above 1,000 blocks ----

const PORT = 9800 + Math.floor(Math.random() * 90);
const ANVIL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const PAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const PAYER = getAddress(privateKeyToAccount(PAYER_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
let anvil: ChildProcess;
let proxy: Server;
let proxyUrl = '';
/** eth_getLogs ranges the proxy saw, and the first block from which it fails every page (undefined: none). */
const ranges: Array<[bigint, bigint]> = [];
let failFrom: bigint | undefined;
const raw = async (method: string, params: unknown[] = []) =>
  ((await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: unknown }).result;

before(async () => {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await raw('eth_chainId').then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msgs = JSON.parse(body) as { id?: number; method?: string; params?: [{ fromBlock?: string; toBlock?: string }] } | Array<{ id?: number; method?: string; params?: [{ fromBlock?: string; toBlock?: string }] }>;
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      if (msg.method !== 'eth_getLogs') continue;
      const f = BigInt(msg.params![0].fromBlock!), t = BigInt(msg.params![0].toBlock!);
      ranges.push([f, t]);
      const error = t - f + 1n > 1000n ? 'block range too large, max range: 1000' : failFrom !== undefined && f >= failFrom ? 'upstream timeout' : undefined;
      if (error) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: error } }));
        return;
      }
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

describe('log pages: ops verify against a node limited to 1,000 blocks per eth_getLogs', () => {
  it('pays INV-P1; a second transfer to the vendor 1,500 blocks later is found in another page (NOT verified); a failing page → INCOMPLETE / cannot_verify_now', async () => {
    const chainDef = makeChain({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
    const pub = createPublicClient({ chain: chainDef, transport: http(ANVIL) });
    const wallet = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: chainDef, transport: http(ANVIL) });
    const wait = async (hash: Hex) => pub.waitForTransactionReceipt({ hash });
    const token = getAddress((await wait(await wallet.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }))).contractAddress!);
    await wait(await wallet.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [PAYER, 10_000_000n] }));
    const start = await pub.getBlockNumber();
    const cfg: ChainConfig = { rpcUrl: proxyUrl, chainId: CHAIN_ID, token, logsFromBlock: start };
    const mandate: Mandate = { chainId: CHAIN_ID, token, payer: PAYER, vendor: { id: 'acme', name: 'Acme', address: VENDOR }, maxPerInvoice: '5', maxPerDay: '5', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-pages-')), 'ledger.sqlite');
    const ledger = new Ledger(ledgerPath);
    const payer = new InvoicePayer({ ledger, chain: cfg, mandate, payerKey: PAYER_KEY, receiptTimeoutMs: 5_000 });
    const paid = await payer.submit({ id: 'INV-P1', vendorId: 'acme', payTo: VENDOR, amount: '1', currency: 'tUSD8' });
    assert.equal(paid.outcome, 'paid');
    await raw('anvil_mine', ['0x5dc']); // 1,500 blocks

    // A window of 1,500+ blocks: the old single 50,000-block window would be refused by this node.
    ranges.length = 0;
    const clean = await verifyInvoice(cfg, mandate, ledger, 'INV-P1');
    assert.equal(clean?.verified, true, 'one transfer, its own: verified');
    assert.equal(clean?.allToPayee.length, 1);
    assert.ok(ranges.length >= 2 && ranges.every(([f, t]) => t - f + 1n <= 1000n), `pages ${ranges.map(([f, t]) => `${f}-${t}`).join(' ')}`);

    // A duplicate payment to the same vendor, in a block more than 1,000 after the receipt's.
    await wait(await wallet.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [VENDOR, 1_000_000n] }));
    const dup = await verifyInvoice(cfg, mandate, ledger, 'INV-P1');
    assert.equal(dup?.allToPayee.length, 2, 'the transfer in the later page is counted');
    assert.equal(dup?.unexplained.length, 1);
    assert.equal(dup?.verified, false, 'an unexplained transfer to the payee is never "verified"');
    assert.equal((await transfersFrom(cfg, PAYER, VENDOR)).length, 2);

    // The node fails every page after the first one.
    failFrom = start + 1000n;
    try {
      await assert.rejects(verifyInvoice(cfg, mandate, ledger, 'INV-P1'), IncompleteLogScanError);
      // The read-only answer (MCP, ops ask): cannot verify now, and it says why.
      const ask = await inquireInvoice(cfg, mandate, ledgerPath, 'INV-P1');
      assert.equal(ask.state, 'cannot_verify_now', ask.answer);
      assert.match(ask.error ?? '', /INCOMPLETE/);
    } finally {
      failFrom = undefined;
      ledger.close();
    }
  });
});
