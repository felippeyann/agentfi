// The gas ceiling per transaction: the preflight and the signing path use the same rule
// (estimate + 20%, × maxFeePerGas), the agent checks the PREPARED transaction right before signing,
// and a refusal signs nothing, sends nothing and is recorded as a refusal (never sent / pending).
// A payment already sent stays reconcilable when fees rise. Local Anvil only (base fee 7 wei, like Aevum).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GAS_MARGIN_DEN, GAS_MARGIN_NUM, makeChain, planTransfer, signingStats, transfersFrom, type ChainConfig } from '../src/chain.js';
import { parseGasCeiling } from '../src/config.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import type { Invoice } from '../src/invoice.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer } from '../src/payer.js';
import { preflight } from '../src/preflight.js';

const PORT = 9600 + Math.floor(Math.random() * 300);
const ANVIL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const PAYER = getAddress(privateKeyToAccount(PAYER_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const CEILING = parseEther('0.0001');

let anvil: ChildProcess;
let proxy: Server;
let proxyUrl = '';
/** eth_sendRawTransaction calls that went through the proxy (the agent's only way to transmit). */
let broadcasts = 0;
/** A hostile node: answers eth_fillTransaction with another chain, a legacy type and other gas. */
let hostileFill = false;
let fillCalls = 0;
const raw = async (method: string, params: unknown[] = []) =>
  ((await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: unknown }).result;

before(async () => {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--base-fee', '7', '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await raw('eth_chainId').then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body) as { id?: number; method?: string; params?: { nonce?: string; to?: string; data?: string }[] };
    if (msg.method === 'eth_sendRawTransaction') broadcasts++;
    if (msg.method === 'eth_fillTransaction') {
      fillCalls++;
      if (hostileFill) {
        const p = msg.params?.[0] ?? {};
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { raw: '0x', tx: { chainId: '0x1', type: '0x0', gas: '0x5208', gasPrice: '0x1', nonce: p.nonce ?? '0x0', to: p.to, input: p.data, value: '0x0' } } }));
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

async function setBaseFee(wei: bigint) {
  await raw('anvil_setNextBlockBaseFeePerGas', [`0x${wei.toString(16)}`]);
  await raw('evm_mine');
}

async function world() {
  await setBaseFee(7n);
  const chain = makeChain({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(ANVIL) });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain, transport: http(ANVIL) });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) })).contractAddress!);
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [PAYER, 100_000_000n] }) });
  await setBaseFee(7n);
  const direct: ChainConfig = { rpcUrl: ANVIL, chainId: CHAIN_ID, token, logsFromBlock: await pub.getBlockNumber() };
  const mandate: Mandate = { chainId: CHAIN_ID, token, payer: PAYER, vendor: { id: 'acme', name: 'Acme', address: VENDOR }, maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-gas-')), 'ledger.sqlite');
  const agent = (ceiling: bigint, failAt?: 'after-broadcast') =>
    new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: { ...direct, rpcUrl: proxyUrl, maxGasCostWei: ceiling }, mandate, payerKey: PAYER_KEY, receiptTimeoutMs: 3_000, ...(failAt ? { failAt } : {}) });
  const nonce = () => pub.getTransactionCount({ address: PAYER, blockTag: 'pending' });
  return { direct, pub, token, ledgerPath, agent, nonce, sent: () => transfersFrom(direct, PAYER, VENDOR), plan: () => planTransfer(direct, PAYER, VENDOR, 1_000_000n) };
}
const invoice = (id: string): Invoice => ({ id, vendorId: 'acme', payTo: VENDOR, amount: '1', currency: 'tUSD8' });

/** The evidence of a refusal: no signature, no transmission, no nonce used, no transfer, the ledger says refused. */
async function assertNothingSigned(w: Awaited<ReturnType<typeof world>>, id: string, before: { sig: number; bc: number; nonce: number }) {
  assert.equal(signingStats.signatures - before.sig, 0, 'zero signatures');
  assert.equal(broadcasts - before.bc, 0, 'zero transmissions (eth_sendRawTransaction)');
  assert.equal(await w.nonce(), before.nonce, 'the payer nonce is unchanged (nothing in the mempool either)');
  assert.equal((await w.sent()).length, 0, 'no transfer');
  const row = new Ledger(w.ledgerPath).get(id)!;
  assert.equal(row.status, 'refused');
  assert.equal(row.rule, 'maxGasCost');
  assert.equal(row.tx_hash, null);
  assert.equal(row.raw_tx, null);
  const events = new Ledger(w.ledgerPath).events(id).map((e) => e.event);
  assert.ok(!events.includes('signed') && !events.includes('broadcast'), events.join(', '));
}

describe('the signed transaction is exactly what the agent decided', () => {
  it('a node that answers eth_fillTransaction with another chain id, a legacy type and other gas cannot change the signed bytes (review P2)', async () => {
    const w = await world();
    hostileFill = true;
    fillCalls = 0;
    try {
      const r = await w.agent(CEILING).submit(invoice('H-1'));
      if (r.outcome === 'paid') {
        const tx = await w.pub.getTransaction({ hash: r.receipt.txHash as Hex });
        assert.equal(tx.chainId, CHAIN_ID, 'signed for the mandate chain');
        assert.equal(tx.type, 'eip1559');
        assert.ok(tx.gas * tx.maxFeePerGas! <= CEILING);
      } else {
        assert.fail(`expected paid with the pinned fields, got ${JSON.stringify(r)} (fill calls ${fillCalls})`);
      }
    } finally {
      hostileFill = false;
    }
  });
});

describe('gas ceiling per transaction', () => {
  let snap: { sig: number; bc: number; nonce: number };
  beforeEach(() => {
    snap = { sig: signingStats.signatures, bc: broadcasts, nonce: 0 };
  });

  it('the ceiling parses to exact wei; the rule is estimate + 20% × maxFeePerGas', async () => {
    assert.equal(parseGasCeiling('0.0001'), 100_000_000_000_000n);
    assert.throws(() => parseGasCeiling('1e-4'));
    assert.throws(() => parseGasCeiling('0'));
    const w = await world();
    const p = await w.plan();
    assert.equal(p.gas, (p.estimatedGas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN);
    assert.equal(p.maxCostWei, p.gas * p.maxFeePerGas);
  });

  it('a maximum EXACTLY at the ceiling is signed and paid; the signed transaction carries exactly that maximum', async () => {
    const w = await world();
    const p = await w.plan();
    const r = await w.agent(p.maxCostWei).submit(invoice('G-EQ'));
    assert.equal(r.outcome, 'paid', JSON.stringify(r));
    const tx = await w.pub.getTransaction({ hash: (r as { receipt: { txHash: Hex } }).receipt.txHash });
    assert.equal(tx.gas * tx.maxFeePerGas!, p.maxCostWei, 'gas limit × maxFeePerGas of the signed transaction = the ceiling');
    assert.equal(signingStats.signatures - snap.sig, 1);
    assert.equal(broadcasts - snap.bc, 1);
    assert.equal((await w.sent()).length, 1);
  });

  it('ONE WEI below the maximum as ceiling (the maximum is 1 wei above it): refused before signing; zero signatures, zero transmissions', async () => {
    const w = await world();
    snap.nonce = await w.nonce();
    const p = await w.plan();
    const r = await w.agent(p.maxCostWei - 1n).submit(invoice('G-UP1'));
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.equal((r as { rule: string }).rule, 'maxGasCost');
    assert.match((r as { reason: string }).reason, new RegExp(`${p.maxCostWei} wei\\), above the operator's ceiling .*\\(${p.maxCostWei - 1n} wei\\)`));
    await assertNothingSigned(w, 'G-UP1', snap);
  });

  it('fees rise AFTER an approved preflight: the agent refuses on the prepared transaction (zero signatures, zero transmissions); when fees fall, the same invoice is judged again and paid', async () => {
    const w = await world();
    snap.nonce = await w.nonce();
    const pf = await preflight({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: w.token, explorerUrl: null, gasSymbol: 'ETH', expectedDecimals: 6, payer: PAYER, vendor: VENDOR, amount: '1', maxGasCostWei: CEILING });
    assert.equal(pf.ok, true, pf.lines.join('\n'));
    assert.ok(pf.gasCostWei! <= CEILING);
    await setBaseFee(parseEther('0.00000001')); // 10 gwei: far above Aevum's 7 wei
    const r = await w.agent(CEILING).submit(invoice('G-SPIKE'));
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.equal((r as { rule: string }).rule, 'maxGasCost');
    await assertNothingSigned(w, 'G-SPIKE', snap);
    const again = await preflight({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: w.token, explorerUrl: null, gasSymbol: 'ETH', expectedDecimals: 6, payer: PAYER, vendor: VENDOR, amount: '1', maxGasCostWei: CEILING });
    assert.equal(again.ok, false, 'the preflight now fails too');
    // Fees back down: the refusal is not final.
    await setBaseFee(7n);
    await setBaseFee(7n);
    const r2 = await w.agent(CEILING).submit(invoice('G-SPIKE'));
    assert.equal(r2.outcome, 'paid', JSON.stringify(r2));
    assert.equal((await w.sent()).length, 1);
  });

  it('a payment already transmitted stays reconcilable when fees rise above the ceiling: the original receipt is recovered, nothing is signed again', async () => {
    const w = await world();
    await assert.rejects(w.agent(CEILING, 'after-broadcast').submit(invoice('G-SENT')), FailPointError);
    const original = new Ledger(w.ledgerPath).get('G-SENT')!.tx_hash;
    const sigAfterFirst = signingStats.signatures;
    await setBaseFee(parseEther('0.000001')); // 1000 gwei
    const r = await w.agent(CEILING).submit(invoice('G-SENT'));
    assert.equal(r.outcome, 'recovered', JSON.stringify(r));
    assert.equal((r as { receipt: { txHash: string } }).receipt.txHash, original);
    // The operator's reconcile (no key) also works.
    const ops = new InvoicePayer({ ledger: new Ledger(w.ledgerPath), chain: { ...w.direct, maxGasCostWei: CEILING }, mandate: (w.agent(CEILING) as unknown as { o: { mandate: Mandate } }).o.mandate });
    assert.equal((await ops.reconcile(new Ledger(w.ledgerPath).get('G-SENT')!)).status, 'confirmed');
    assert.equal(signingStats.signatures, sigAfterFirst, 'no new signature');
    assert.equal((await w.sent()).length, 1);
  });

  it('a payment transmitted but not yet mined when fees rise: still PENDING with its hash, never re-signed; mined once fees allow it', async () => {
    const w = await world();
    await raw('evm_setAutomine', [false]);
    try {
      await assert.rejects(w.agent(CEILING, 'after-broadcast').submit(invoice('G-POOL')), FailPointError);
      const original = new Ledger(w.ledgerPath).get('G-POOL')!.tx_hash;
      const sigAfterFirst = signingStats.signatures;
      await setBaseFee(parseEther('0.000001')); // the pending transaction's maxFeePerGas is now below the base fee
      const r = await w.agent(CEILING).submit(invoice('G-POOL'));
      assert.equal(r.outcome, 'pending', JSON.stringify(r));
      assert.equal((r as { txHash: string }).txHash, original);
      assert.equal(signingStats.signatures, sigAfterFirst, 'never re-signed at the new fee');
      await setBaseFee(7n);
      // Anvil drops an underpriced transaction from its pool but keeps answering eth_getTransaction
      // for it, so the agent (rightly) does not resend it. A node that forgot it would make reconcile
      // resend the RECORDED bytes; the test does exactly that, with the bytes from the ledger.
      const recorded = new Ledger(w.ledgerPath).get('G-POOL')!.raw_tx as Hex;
      await raw('eth_sendRawTransaction', [recorded]);
      await raw('evm_mine');
      const r2 = await w.agent(CEILING).submit(invoice('G-POOL'));
      assert.ok(r2.outcome === 'recovered' || r2.outcome === 'replayed', JSON.stringify(r2));
      assert.equal((r2 as { receipt: { txHash: string } }).receipt.txHash, original);
      assert.equal((await w.sent()).length, 1);
    } finally {
      await raw('evm_setAutomine', [true]);
    }
  });
});
