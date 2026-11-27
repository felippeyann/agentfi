// "Was invoice INV-001 paid?" through MCP: a real MCP client (the SDK's, over stdio) talks to
// `src/mcp.ts` on a synthetic ledger and a local Anvil chain. Read-only; the chain going down must
// be answered as "cannot verify now", with the original transaction to check first. Local only.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain, type ChainConfig } from '../src/chain.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import { inquireInvoice, type Inquiry } from '../src/inquiry.js';
import type { Invoice } from '../src/invoice.js';
import { Ledger } from '../src/ledger.js';
import { saveMandate, type Mandate } from '../src/mandate.js';
import { InvoicePayer } from '../src/payer.js';
import { freePort } from './fixtures/free-port.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
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
let chainDown = false;
const raw = async (method: string, params: unknown[] = []) =>
  ((await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: unknown }).result;

let dir = '';
let ledgerPath = '';
let mandatePath = '';
let paidHash = '';
let pendingHash = '';
const fingerprint = () => createHash('sha256').update(JSON.stringify({ rows: new Ledger(ledgerPath).all(), events: new Ledger(ledgerPath).events() })).digest('hex');

before(async () => {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await raw('eth_chainId').then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // The RPC the MCP server reads through; `chainDown` makes every call fail (503).
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (chainDown) return void res.writeHead(503).end('upstream unavailable');
    const upstream = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

  // Synthetic invoices, paid by the real agent code: INV-001 confirmed, INV-002 in a block not yet
  // confirmed (rule depth:3), INV-003 refused by the mandate.
  const chain = makeChain({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(ANVIL) });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain, transport: http(ANVIL) });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) })).contractAddress!);
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [PAYER, 100_000_000n] }) });
  dir = mkdtempSync(join(tmpdir(), 'invoice-agent-mcp-'));
  ledgerPath = join(dir, 'ledger.sqlite');
  mandatePath = join(dir, 'mandate.json');
  const mandate: Mandate = { chainId: CHAIN_ID, token, payer: PAYER, vendor: { id: 'acme', name: 'Acme', address: VENDOR }, maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
  saveMandate(mandatePath, mandate);
  const cfg: ChainConfig = { rpcUrl: ANVIL, chainId: CHAIN_ID, token, confirm: { kind: 'depth', blocks: 3 } };
  const agent = new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg, mandate, payerKey: PAYER_KEY, receiptTimeoutMs: 3_000 });
  const inv = (id: string, amount: string): Invoice => ({ id, vendorId: 'acme', payTo: VENDOR, amount, currency: 'tUSD8' });
  const r1 = await agent.submit(inv('INV-001', '8'));
  paidHash = (r1 as { txHash: string }).txHash;
  await raw('anvil_mine', ['0x3']);
  assert.equal((await agent.submit(inv('INV-001', '8'))).outcome, 'recovered');
  const r2 = await agent.submit(inv('INV-002', '3'));
  assert.equal(r2.outcome, 'pending');
  pendingHash = (r2 as { txHash: string }).txHash;
  assert.equal((await agent.submit(inv('INV-003', '12'))).outcome, 'refused');
});
after(() => {
  anvil?.kill();
  proxy?.close();
});

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: PKG,
    env: { ...(process.env as Record<string, string>), INVOICE_RPC_URL: proxyUrl, INVOICE_MANDATE: mandatePath, INVOICE_LEDGER: ledgerPath, INVOICE_CONFIRMATION: 'depth:3', INVOICE_PAYER_KEY: PAYER_KEY },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'invoice-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}
async function ask(client: Client, invoiceId: string): Promise<Inquiry> {
  const r = await client.callTool({ name: 'invoice_status', arguments: { invoiceId } });
  return JSON.parse((r.content as { text: string }[])[0]!.text) as Inquiry;
}

describe('MCP: "was invoice X paid?" (read-only)', () => {
  it('exposes exactly two read-only tools: no signing, sending, reconcile, policy or admin', async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ['invoice_status', 'list_invoices']);
      for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
      const r = await client.callTool({ name: 'pay_invoice', arguments: {} });
      assert.equal(r.isError, true);
    } finally {
      await client.close();
    }
  });

  it('INV-001 → paid_verified, with network, hash, block and the receipt', async () => {
    const client = await connect();
    try {
      const a = await ask(client, 'INV-001');
      assert.equal(a.state, 'paid_verified', JSON.stringify(a));
      assert.equal(a.network.chainId, CHAIN_ID);
      assert.equal(a.receipt?.txHash, paidHash);
      assert.equal(a.receipt?.amount, '8');
      assert.ok(a.chain?.blockNumber);
      assert.match(a.answer, /Paid and verified/);
    } finally {
      await client.close();
    }
  });

  it('INV-002 → pending: in a block, not confirmed under the rule; says not to pay again', async () => {
    const client = await connect();
    try {
      const a = await ask(client, 'INV-002');
      assert.equal(a.state, 'pending', JSON.stringify(a));
      assert.equal(a.ledger?.txHash, pendingHash);
      assert.match(a.answer, /NOT confirmed yet/);
      assert.match(a.next, /Do NOT pay this invoice again/);
      assert.equal(a.receipt, undefined, 'no receipt while pending');
    } finally {
      await client.close();
    }
  });

  it('an unknown id → unknown_invoice; a refused one → not_paid (nothing signed)', async () => {
    const client = await connect();
    try {
      assert.equal((await ask(client, 'INV-404')).state, 'unknown_invoice');
      assert.equal((await ask(client, 'inv-001')).state, 'unknown_invoice', 'ids are case-sensitive');
      const refused = await ask(client, 'INV-003');
      assert.equal(refused.state, 'not_paid');
      assert.equal(refused.ledger?.txHash, null);
    } finally {
      await client.close();
    }
  });

  it('the chain is down → cannot_verify_now: the uncertainty is explicit, the original transaction is named, no "paid" and no "not paid"', async () => {
    const client = await connect();
    chainDown = true;
    try {
      for (const [id, hash] of [['INV-001', paidHash], ['INV-002', pendingHash]] as const) {
        const a = await ask(client, id);
        assert.equal(a.state, 'cannot_verify_now', JSON.stringify(a));
        assert.equal(a.receipt, undefined);
        assert.match(a.answer, /cannot be verified/);
        assert.match(a.next, new RegExp(`Do NOT pay this invoice again.*${hash}`));
        assert.equal(a.ledger?.txHash, hash, 'the last known state is shown, as the ledger\'s');
      }
    } finally {
      chainDown = false;
      await client.close();
    }
  });

  it('a ledger that never recorded its chain/token/payer: cannot_verify_now for a paid invoice, never "failed" or "not paid" (review P3)', async () => {
    const legacy = join(mkdtempSync(join(tmpdir(), 'invoice-agent-legacy-')), 'ledger.sqlite');
    const l = new Ledger(legacy);
    l.insert({ ...new Ledger(ledgerPath).get('INV-001')!, invoice_id: 'INV-001' });
    l.close();
    const m = JSON.parse(readFileSync(mandatePath, 'utf8')) as Mandate;
    const other = { ...m, token: '0x0000000000000000000000000000000000000001' };
    const a = await inquireInvoice({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: other.token }, other, legacy, 'INV-001');
    assert.equal(a.state, 'cannot_verify_now', JSON.stringify(a));
    assert.match(a.next, /Do NOT pay this invoice again/);
  });

  it('the questions changed nothing: the ledger rows and events are byte-for-byte the same', async () => {
    const before = fingerprint();
    const size = readFileSync(ledgerPath).length;
    const client = await connect();
    try {
      await ask(client, 'INV-001');
      await ask(client, 'INV-002');
      await client.callTool({ name: 'list_invoices', arguments: {} });
    } finally {
      await client.close();
    }
    assert.equal(fingerprint(), before);
    assert.equal(readFileSync(ledgerPath).length, size);
  });
});
