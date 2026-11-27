// The confirmation rule (finality.ts): a payment is pending until its block satisfies the rule and is
// canonical; a block that leaves the canonical chain before that is never "paid", and the recovery
// re-uses the original signed transaction (one transfer, one hash). Local Anvil only.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain, receiptOf, transfersFrom, type ChainConfig } from '../src/chain.js';
import { judgeFinality, parseConfirmRule, ruleFor, type ConfirmRule } from '../src/finality.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import type { Invoice } from '../src/invoice.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer, type Outcome } from '../src/payer.js';
import { freePort } from './fixtures/free-port.js';

const PORT = await freePort();
const ANVIL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const PAYER = getAddress(privateKeyToAccount(PAYER_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

let anvil: ChildProcess;
let proxy: Server;
let proxyUrl = '';
const failing = new Set<string>();
let tamperBlockHashes = false;
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
    const msg = JSON.parse(body) as { method?: string; params?: unknown[] };
    // Fails only reads of the "finalized" block (or every call of a listed method).
    if (failing.has(msg.method ?? '') || (failing.has('finalized-tag') && msg.method === 'eth_getBlockByNumber' && msg.params?.[0] === 'finalized')) {
      res.writeHead(503).end('upstream unavailable');
      return;
    }
    const upstream = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    let text = await upstream.text();
    // An inconsistent node: blocks read by number come back with another hash than the receipts say.
    if (tamperBlockHashes && msg.method === 'eth_getBlockByNumber' && /^0x/.test(String(msg.params?.[0]))) {
      text = text.replace(/"hash":"0x[0-9a-f]{64}"/, `"hash":"0x${'ab'.repeat(32)}"`);
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});
after(() => {
  anvil?.kill();
  proxy?.close();
});

async function world(confirm: ConfirmRule, rpcUrl = ANVIL) {
  const chain = makeChain({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(ANVIL) });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain, transport: http(ANVIL) });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) })).contractAddress!);
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [PAYER, 100_000_000n] }) });
  const fromBlock = await pub.getBlockNumber();
  const cfg: ChainConfig = { rpcUrl, chainId: CHAIN_ID, token, confirm, logsFromBlock: fromBlock };
  const direct: ChainConfig = { ...cfg, rpcUrl: ANVIL };
  const mandate: Mandate = { chainId: CHAIN_ID, token, payer: PAYER, vendor: { id: 'acme', name: 'Acme', address: VENDOR }, maxPerInvoice: '10', maxPerDay: '10', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-final-')), 'ledger.sqlite');
  const agent = (failAt?: 'after-broadcast') => new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg, mandate, payerKey: PAYER_KEY, receiptTimeoutMs: 3_000, ...(failAt ? { failAt } : {}) });
  return { cfg, direct, pub, ledgerPath, agent, sent: () => transfersFrom(direct, PAYER, VENDOR), mine: (n: number) => raw('anvil_mine', [`0x${n.toString(16)}`]) };
}
const invoice = (id: string, amount = '1'): Invoice => ({ id, vendorId: 'acme', payTo: VENDOR, amount, currency: 'tUSD8' });
const hashOf = (o: Outcome) => ('receipt' in o ? o.receipt.txHash : 'txHash' in o ? o.txHash : null);

describe('confirmation rules', () => {
  it('parses the rules; inclusion is the local default, finalized everywhere else', () => {
    assert.deepEqual(parseConfirmRule('depth:12'), { kind: 'depth', blocks: 12 });
    assert.deepEqual(parseConfirmRule('finalized'), { kind: 'finalized' });
    assert.throws(() => parseConfirmRule('depth:0'));
    assert.throws(() => parseConfirmRule('2 blocks'));
    assert.equal(ruleFor({ rpcUrl: '', chainId: 31337, token: '' }).kind, 'inclusion');
    assert.equal(ruleFor({ rpcUrl: '', chainId: 44005, token: '' }).kind, 'finalized');
  });

  it('finalized: the lost response is recovered with the ORIGINAL hash, PENDING (included) until the block is finalized, then the receipt; one transfer', async () => {
    const w = await world({ kind: 'finalized' });
    await assert.rejects(w.agent('after-broadcast').submit(invoice('F-1')), FailPointError);
    const original = new Ledger(w.ledgerPath).get('F-1')!.tx_hash!;
    const r1 = await w.agent().submit(invoice('F-1'));
    assert.equal(r1.outcome, 'pending');
    assert.equal((r1 as { stage: string }).stage, 'included');
    assert.equal(hashOf(r1), original);
    assert.match((r1 as { note: string }).note, /NOT confirmed/);
    const receipt = (await receiptOf(w.direct, original as Hex))!;
    const fin = await judgeFinality(w.direct, receipt);
    assert.equal(fin.final, false, fin.detail);
    await w.mine(70);
    const r2 = await w.agent().submit(invoice('F-1'));
    assert.equal(r2.outcome, 'recovered');
    assert.equal(hashOf(r2), original);
    assert.match((r2 as { receipt: { confirmation: string } }).receipt.confirmation, /^finalized/);
    const sent = await w.sent();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.txHash, original);
  });

  const firstBlockHash = (ledgerPath: string, id: string) =>
    JSON.parse(new Ledger(ledgerPath).events(id).find((e) => e.event === 'included')!.detail!).blockHash as string;

  for (const rule of [{ kind: 'depth', blocks: 5 }, { kind: 'finalized' }] as ConfirmRule[]) {
    const name = rule.kind === 'depth' ? 'depth:5' : 'finalized';

    it(`${name}: the payment's block is dropped from the chain before the rule is met (the transaction disappears) → PENDING with the same hash, the SAME signed bytes are sent again, one transfer`, async () => {
      const w = await world(rule);
      const snap = await raw('evm_snapshot');
      const r1 = await w.agent().submit(invoice('R-1'));
      assert.equal(r1.outcome, 'pending', 'one block is not enough under this rule');
      assert.equal((r1 as { stage: string }).stage, 'included');
      const original = hashOf(r1)!;
      // The block that held the payment is no longer canonical: revert to before it and mine other blocks.
      await raw('evm_revert', [snap]);
      await w.mine(3);
      assert.equal(await receiptOf(w.direct, original as Hex), null, 'the payment is no longer in a canonical block');
      assert.equal((await w.sent()).length, 0, 'no transfer on the canonical chain right now');
      // What the operator sees in the interval: pending, the same hash, nothing signed anew.
      const r2 = await w.agent().submit(invoice('R-1'));
      assert.equal(r2.outcome, 'pending', JSON.stringify(r2));
      assert.equal(hashOf(r2), original);
      const events = new Ledger(w.ledgerPath).events('R-1').map((e) => e.event);
      assert.ok(events.includes('left-canonical-chain') && events.includes('rebroadcast-same-bytes'), events.join(', '));
      assert.equal(events.filter((e) => e === 'signed').length, 1, 'signed once, ever');
      await w.mine(rule.kind === 'depth' ? 6 : 70);
      const r3 = await w.agent().submit(invoice('R-1'));
      assert.ok(r3.outcome === 'recovered' || r3.outcome === 'replayed', JSON.stringify(r3));
      assert.equal(hashOf(r3), original);
      const sent = await w.sent();
      assert.equal(sent.length, 1, 'exactly one transfer after the reorg and the recovery');
      assert.equal(sent[0]!.txHash, original);
    });

    it(`${name}: a reorg replaces the payment's block (anvil_reorg) → PENDING with the same hash, re-mined in a NEW block, confirmed only once that block meets the rule; one transfer`, async () => {
      const w = await world(rule);
      const r1 = await w.agent().submit(invoice('Q-1'));
      assert.equal(r1.outcome, 'pending');
      const original = hashOf(r1)!;
      const firstHash = firstBlockHash(w.ledgerPath, 'Q-1');
      const height = BigInt((r1 as { blockNumber: string }).blockNumber);
      const head = BigInt((await raw('eth_blockNumber')) as string);
      await raw('anvil_reorg', [Number(head - height + 1n), []]);
      const atHeight = await w.pub.getBlock({ blockNumber: height });
      assert.notEqual(atHeight.hash, firstHash, 'the block at that height was replaced');
      const r2 = await w.agent().submit(invoice('Q-1'));
      assert.equal(r2.outcome, 'pending', JSON.stringify(r2));
      assert.equal(hashOf(r2), original);
      await w.mine(rule.kind === 'depth' ? 6 : 70);
      const r3 = await w.agent().submit(invoice('Q-1'));
      assert.ok(r3.outcome === 'recovered' || r3.outcome === 'replayed', JSON.stringify(r3));
      assert.equal(hashOf(r3), original);
      const sent = await w.sent();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.txHash, original);
      const confirmedEvent = JSON.parse(new Ledger(w.ledgerPath).events('Q-1').find((e) => e.event === 'confirmed')!.detail!) as { blockHash: string };
      assert.notEqual(confirmedEvent.blockHash, firstHash, 'confirmed in the replacement chain, not in the dropped block');
      assert.equal(new Ledger(w.ledgerPath).events('Q-1').filter((e) => e.event === 'signed').length, 1, 'signed once, ever');
    });
  }

  it('a receipt whose block hash is not the canonical block at that height is never confirmed, even past the rule (node serving an inconsistent receipt)', async () => {
    const w = await world({ kind: 'depth', blocks: 2 }, '');
    w.cfg.rpcUrl = proxyUrl;
    const r1 = await w.agent().submit(invoice('C-1'));
    const original = hashOf(r1)!;
    await w.mine(5);
    tamperBlockHashes = true;
    try {
      const r2 = await w.agent().submit(invoice('C-1'));
      assert.equal(r2.outcome, 'pending', JSON.stringify(r2));
      assert.match((r2 as { note: string }).note, /changed/);
      assert.equal(hashOf(r2), original);
    } finally {
      tamperBlockHashes = false;
    }
    assert.equal((await w.agent().submit(invoice('C-1'))).outcome, 'recovered');
    assert.equal((await w.sent()).length, 1);
  });

  it('the finalized block cannot be read (RPC 503): an error, the row stays open, nothing new is sent; then confirmed', async () => {
    const w = await world({ kind: 'finalized' }, '');
    w.cfg.rpcUrl = proxyUrl;
    const r1 = await w.agent().submit(invoice('E-1'));
    assert.equal(r1.outcome, 'pending');
    const original = hashOf(r1);
    await w.mine(70);
    failing.add('finalized-tag');
    try {
      const during = await w.agent().submit(invoice('E-1'));
      assert.equal(during.outcome, 'pending', 'a failed read of the finalized block is never "final"');
      assert.equal(hashOf(during), original, 'the answer keeps the hash');
      assert.match((during as { note: string }).note, /Could not read the chain.*Do NOT pay this invoice again/);
      assert.equal(new Ledger(w.ledgerPath).get('E-1')!.status, 'included');
    } finally {
      failing.clear();
    }
    const r2 = await w.agent().submit(invoice('E-1'));
    assert.ok(r2.outcome === 'recovered' || r2.outcome === 'replayed', r2.outcome);
    assert.equal(hashOf(r2), original);
    assert.equal((await w.sent()).length, 1);
  });

  it('depth:N is operational: a confirmation undone by a deeper reorg is WITHDRAWN on the next resend, the same signed bytes are mined again, one transfer (review P2-1)', async () => {
    const w = await world({ kind: 'depth', blocks: 3 });
    const snap = await raw('evm_snapshot');
    const r1 = await w.agent().submit(invoice('W-1'));
    const original = hashOf(r1)!;
    await w.mine(3);
    assert.equal((await w.agent().submit(invoice('W-1'))).outcome, 'recovered', 'confirmed at depth 3');
    // A reorg deeper than 3 blocks removes it.
    await raw('evm_revert', [snap]);
    await w.mine(10);
    assert.equal((await w.sent()).length, 0);
    const r2 = await w.agent().submit(invoice('W-1'));
    assert.equal(r2.outcome, 'pending', `no longer paid: ${JSON.stringify(r2)}`);
    assert.equal(hashOf(r2), original);
    const events = new Ledger(w.ledgerPath).events('W-1').map((e) => e.event);
    assert.ok(events.includes('confirmation-withdrawn') && events.includes('rebroadcast-same-bytes'), events.join(', '));
    await w.mine(3);
    const r3 = await w.agent().submit(invoice('W-1'));
    assert.ok(r3.outcome === 'recovered' || r3.outcome === 'replayed', JSON.stringify(r3));
    assert.equal(hashOf(r3), original);
    assert.equal((await w.sent()).length, 1);
    assert.equal(events.filter((e) => e === 'signed').length, 1);
  });

  it('a payment in a block but not confirmed counts against the daily limit', async () => {
    const w = await world({ kind: 'finalized' });
    assert.equal((await w.agent().submit(invoice('D-1', '6'))).outcome, 'pending');
    const r = await w.agent().submit(invoice('D-2', '6'));
    assert.equal(r.outcome, 'refused');
    assert.equal((r as { rule: string }).rule, 'maxPerDay');
  });
});
