/**
 * The operator's cap on the EIP-1559 tip (ChainConfig.maxPriorityFeeWei / INVOICE_MAX_PRIORITY_FEE_GWEI /
 * --max-priority-fee-gwei), on the vault path, against a local node that reproduces the Aevum reading of 24 Nov 2026:
 * base fee 7 wei and a node-suggested tip (eth_maxPriorityFeePerGas) of 4,099,999,993 wei, so viem's estimate is
 * maxFeePerGas 4,100,000,001 wei; gas ceiling 0.0002 per payInvoice; the agent holds 0.001 of gas coin.
 *
 * What must hold: the same rule in the preflight and in the signed bytes; the cap lowers maxFeePerGas (base part +
 * applied tip), not only the tip; the ceiling and the 3× balance reserve are unchanged and still refuse when they should;
 * refusals sign and transmit nothing; a pending invoice resent keeps its original hash.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, parseEther, parseGwei, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { feesWithTipCap, makeChain, planTransfer, signingStats, transfersFrom, type ChainConfig } from '../src/chain.js';
import { parsePriorityFeeCap } from '../src/config.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from '../src/generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import type { Invoice } from '../src/invoice.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer } from '../src/payer.js';
import { preflight } from '../src/preflight.js';
import { vendorKey } from '../src/vault.js';

const PORT = 9900 + Math.floor(Math.random() * 90);
const ANVIL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const OPERATOR = getAddress(privateKeyToAccount(OPERATOR_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
/** The Aevum reading of 24 Nov 2026 (eth_maxPriorityFeePerGas = 0xf46108f9). */
const AEVUM_SUGGESTED_TIP = 4_099_999_993n;
const CEILING = parseEther('0.0002');
const CAP = parseGwei('1'); // the candidate proposed for the Aevum session
const AGENT_GAS_COIN = parseEther('0.001');

let anvil: ChildProcess;
let proxy: Server;
let proxyUrl = '';
let suggestedTip: bigint = AEVUM_SUGGESTED_TIP;
/** eth_sendRawTransaction calls that went through the proxy (the agent's only way to transmit). */
let broadcasts = 0;
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
  // The node the agent and the preflight talk to: Anvil, except that it suggests the Aevum tip.
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body) as { id?: number; method?: string };
    if (msg.method === 'eth_maxPriorityFeePerGas') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: `0x${suggestedTip.toString(16)}` }));
      return;
    }
    if (msg.method === 'eth_sendRawTransaction') broadcasts++;
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

const chainDef = makeChain({ rpcUrl: ANVIL, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });

/** A vault with 1 tUSD8 and a mandate (≤ 1 per invoice and per day, vendor-1), whose agent is a FRESH key holding `gasCoin`. */
async function world(gasCoin: bigint = AGENT_GAS_COIN) {
  await setBaseFee(7n);
  const pub = createPublicClient({ chain: chainDef, transport: http(ANVIL) });
  const op = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), chain: chainDef, transport: http(ANVIL) });
  const wait = async (hash: Hex) => pub.waitForTransactionReceipt({ hash });
  const agentKey = generatePrivateKey();
  const agent = getAddress(privateKeyToAccount(agentKey).address);
  const token = getAddress((await wait(await op.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }))).contractAddress!);
  const vault = getAddress((await wait(await op.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [token] }))).contractAddress!);
  await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [OPERATOR, 10_000_000n] }));
  await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [vault, 1_000_000n] }));
  const now = BigInt((await pub.getBlock()).timestamp);
  await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [agent, vendorKey('vendor-1'), VENDOR, 1_000_000, 1_000_000, Number(now + 86_400n)] }));
  await wait(await op.sendTransaction({ to: agent, value: gasCoin }));
  await setBaseFee(7n);
  const cfg = (cap?: bigint): ChainConfig => ({ rpcUrl: proxyUrl, chainId: CHAIN_ID, token, vault, vaultVendorId: 'vendor-1', maxGasCostWei: CEILING, logsFromBlock: 0n, ...(cap !== undefined ? { maxPriorityFeeWei: cap } : {}) });
  const mandate: Mandate = { chainId: CHAIN_ID, token, payer: agent, vendor: { id: 'vendor-1', name: 'Vendor One', address: VENDOR }, vault, maxPerInvoice: '1', maxPerDay: '1', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-tipcap-')), 'ledger.sqlite');
  const payer = (cap?: bigint, failAt?: 'after-broadcast') => new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg(cap), mandate, payerKey: agentKey, receiptTimeoutMs: 5_000, ...(failAt ? { failAt } : {}) });
  const pf = (cap?: bigint, invoiceId = 'TIP-PROBE') => preflight({ rpcUrl: proxyUrl, chainId: CHAIN_ID, token, explorerUrl: null, gasSymbol: 'ETH', expectedDecimals: 6, payer: agent, vendor: VENDOR, amount: '1', maxGasCostWei: CEILING, vault, vendorId: 'vendor-1', invoiceId, ...(cap !== undefined ? { maxPriorityFeeWei: cap } : {}) });
  const nonce = () => pub.getTransactionCount({ address: agent, blockTag: 'pending' });
  /** viem's base part for the next block: the latest base fee × 1.2, integer. */
  const basePart = async () => ((await pub.getBlock()).baseFeePerGas! * 12n) / 10n;
  return { pub, token, vault, agent, ledgerPath, cfg, payer, pf, nonce, basePart, sent: () => transfersFrom(cfg(), vault) };
}
const invoice = (id: string): Invoice => ({ id, vendorId: 'vendor-1', payTo: VENDOR, amount: '1', currency: 'tUSD8' });
const failed = (lines: string[]) => lines.filter((l) => l.startsWith('✗'));

describe('tip cap: the rule', () => {
  it('parses gwei to exact wei and refuses nonsense', () => {
    assert.equal(parsePriorityFeeCap('1'), 1_000_000_000n);
    assert.equal(parsePriorityFeeCap('0.000000008'), 8n);
    for (const bad of ['0', '-1', '1e9', '', '1001', 'abc', '0.0000000001']) assert.throws(() => parsePriorityFeeCap(bad), bad);
  });

  it('feesWithTipCap: a suggestion above the cap becomes the cap AND maxFeePerGas = base part + cap; at or below the cap nothing changes', () => {
    const est = { maxFeePerGas: 4_100_000_001n, maxPriorityFeePerGas: AEVUM_SUGGESTED_TIP }; // base part 8
    assert.deepEqual(feesWithTipCap(est, CAP), { maxFeePerGas: 1_000_000_008n, maxPriorityFeePerGas: CAP });
    assert.deepEqual(feesWithTipCap(est, AEVUM_SUGGESTED_TIP), est, 'equal to the cap: unchanged');
    assert.deepEqual(feesWithTipCap(est, AEVUM_SUGGESTED_TIP + 1n), est, 'within the cap: unchanged');
    assert.deepEqual(feesWithTipCap(est), est, 'no cap: unchanged (previous behaviour)');
    assert.throws(() => feesWithTipCap({ maxFeePerGas: 1n, maxPriorityFeePerGas: 2n }, CAP), /inconsistent/);
  });
});

describe('tip cap on the vault path, against the Aevum reading (base fee 7 wei, suggested tip 4.1 gwei, ceiling 0.0002)', () => {
  let snap: { sig: number; bc: number };
  beforeEach(() => {
    suggestedTip = AEVUM_SUGGESTED_TIP;
    snap = { sig: signingStats.signatures, bc: broadcasts };
  });

  it('WITHOUT a cap it reproduces the block: maxFeePerGas 4,100,000,001 wei, above the ceiling and the 3× reserve; the agent refuses before signing', async () => {
    const w = await world();
    const plan = await planTransfer(w.cfg(), w.agent, VENDOR, 1_000_000n, 'TIP-PROBE');
    assert.equal(plan.maxPriorityFeePerGas, AEVUM_SUGGESTED_TIP);
    assert.equal(plan.maxFeePerGas, (await w.basePart()) + AEVUM_SUGGESTED_TIP);
    assert.equal(plan.maxFeePerGas, 4_100_000_001n, 'the same max fee the Aevum preflight showed');
    assert.ok(plan.maxCostWei > CEILING);
    const pf = await w.pf();
    assert.equal(pf.ok, false);
    assert.equal(failed(pf.lines).length, 2, failed(pf.lines).join('\n'));
    assert.ok(failed(pf.lines).some((l) => l.includes('within the ceiling')));
    assert.ok(failed(pf.lines).some((l) => l.includes('3× that gas')));
    const nonceBefore = await w.nonce();
    const r = await w.payer().submit(invoice('NOCAP-1'));
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.equal((r as { rule: string }).rule, 'maxGasCost');
    assert.equal(signingStats.signatures - snap.sig, 0, 'zero signatures');
    assert.equal(broadcasts - snap.bc, 0, 'zero transmissions');
    assert.equal(await w.nonce(), nonceBefore);
    assert.equal((await w.sent()).length, 0);
  });

  it('WITH a 1 gwei cap: the preflight passes, shows suggested vs applied tip, and the SIGNED BYTES carry exactly the fields and maximum it showed; paid once', async () => {
    const w = await world();
    const pf = await w.pf(CAP, 'CAP-1'); // the session estimates the very invoice it pays
    assert.equal(pf.ok, true, pf.lines.join('\n'));
    const tipLine = pf.lines.find((l) => l.includes('tip (maxPriorityFeePerGas)'))!;
    assert.match(tipLine, new RegExp(`node suggests ${AEVUM_SUGGESTED_TIP} wei; applied ${CAP} wei \\(operator's cap ${CAP} wei: capped\\)`));
    const base = await w.basePart();
    assert.equal(pf.maxPriorityFeePerGas, CAP);
    assert.equal(pf.maxFeePerGas, base + CAP, 'max fee = base part + applied tip, not the old suggestion');
    assert.ok(pf.gasCostWei! <= CEILING);
    assert.ok(pf.gasCostWei! * 3n <= AGENT_GAS_COIN, '3× reserve within 0.001');
    const r = await w.payer(CAP).submit(invoice('CAP-1'));
    assert.equal(r.outcome, 'paid', JSON.stringify(r));
    const row = new Ledger(w.ledgerPath).get('CAP-1')!;
    const signed = parseTransaction(row.raw_tx as Hex);
    assert.equal(signed.type, 'eip1559');
    assert.equal(signed.chainId, CHAIN_ID);
    assert.equal(signed.maxPriorityFeePerGas, CAP, 'signed tip = the cap');
    assert.equal(signed.maxFeePerGas, pf.maxFeePerGas, 'signed max fee = the max fee the preflight showed');
    assert.equal(signed.gas! * signed.maxFeePerGas!, pf.gasCostWei, 'signed maximum = the maximum the preflight showed');
    assert.ok(signed.gas! * signed.maxFeePerGas! <= CEILING);
    const ev = new Ledger(w.ledgerPath).events('CAP-1').find((e) => e.event === 'signed')!;
    const d = JSON.parse(ev.detail!) as Record<string, string>;
    assert.equal(d['maxPriorityFeePerGas'], CAP.toString());
    assert.equal(d['suggestedPriorityFeePerGas'], AEVUM_SUGGESTED_TIP.toString());
    assert.equal(d['priorityFeeCapWei'], CAP.toString());
    assert.equal(signingStats.signatures - snap.sig, 1);
    assert.equal(broadcasts - snap.bc, 1);
    assert.equal((await w.sent()).length, 1);
    const resend = await w.payer(CAP).submit(invoice('CAP-1'));
    assert.ok(resend.outcome === 'replayed' || resend.outcome === 'paid', JSON.stringify(resend));
    assert.equal((resend as { receipt: { txHash: string } }).receipt.txHash, (r as { receipt: { txHash: string } }).receipt.txHash);
    assert.equal((await w.sent()).length, 1, 'still one transfer');
  });

  it('a cap that would price the transaction below the node\'s gas price fails the preflight (review P2): it may never be mined', async () => {
    const w = await world();
    const gasPrice = (await w.pub.getGasPrice());
    const tooLow = 8n; // maxFee = base part + 8 wei, far below the node's gas price
    const pf = await w.pf(tooLow);
    assert.equal(pf.ok, false);
    assert.ok(gasPrice > (await w.basePart()) + tooLow, `precondition: node gas price ${gasPrice}`);
    assert.ok(failed(pf.lines).some((l) => l.includes("at least the node's gas price")), pf.lines.join('\n'));
    const ok = await w.pf(gasPrice); // tip = the node's gas price: max fee ≥ gas price
    assert.ok(!failed(ok.lines).some((l) => l.includes("node's gas price")), ok.lines.join('\n'));
  });

  it('a suggestion BELOW the cap is used as is (the cap is a cap, not a floor)', async () => {
    const w = await world();
    suggestedTip = 8n;
    const plan = await planTransfer(w.cfg(CAP), w.agent, VENDOR, 1_000_000n, 'TIP-PROBE');
    assert.equal(plan.maxPriorityFeePerGas, 8n);
    assert.equal(plan.maxFeePerGas, (await w.basePart()) + 8n);
  });

  it('base fee too high even with the cap: preflight fails on the ceiling and the agent refuses; zero signatures, zero transmissions', async () => {
    const w = await world();
    await setBaseFee(parseGwei('10'));
    const pf = await w.pf(CAP);
    assert.equal(pf.ok, false);
    assert.ok(failed(pf.lines).some((l) => l.includes('within the ceiling')), pf.lines.join('\n'));
    const nonceBefore = await w.nonce();
    const r = await w.payer(CAP).submit(invoice('HIGHBASE-1'));
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.equal((r as { rule: string }).rule, 'maxGasCost');
    assert.equal(signingStats.signatures - snap.sig, 0);
    assert.equal(broadcasts - snap.bc, 0);
    assert.equal(await w.nonce(), nonceBefore);
    await setBaseFee(7n);
  });

  it('fees rise BETWEEN an approved preflight and the signature: the agent re-plans with the same rule and refuses; zero signatures, zero transmissions', async () => {
    const w = await world();
    const pf = await w.pf(CAP);
    assert.equal(pf.ok, true, pf.lines.join('\n'));
    await setBaseFee(parseGwei('10'));
    const r = await w.payer(CAP).submit(invoice('RISE-1'));
    assert.equal(r.outcome, 'refused', JSON.stringify(r));
    assert.equal(signingStats.signatures - snap.sig, 0);
    assert.equal(broadcasts - snap.bc, 0);
    await setBaseFee(7n);
    await setBaseFee(7n);
    const r2 = await w.payer(CAP).submit(invoice('RISE-1'));
    assert.equal(r2.outcome, 'paid', 'judged again once fees fall');
  });

  it('insufficient gas coin: with the cap but only 0.0003 on the agent, the preflight fails the 3× reserve (it never signs)', async () => {
    const w = await world(parseEther('0.0003'));
    const pf = await w.pf(CAP);
    assert.equal(pf.ok, false);
    const f = failed(pf.lines);
    assert.equal(f.length, 1, f.join('\n'));
    assert.ok(f[0]!.includes('3× that gas'));
    assert.equal(signingStats.signatures - snap.sig, 0);
    assert.equal(broadcasts - snap.bc, 0);
  });

  it('a PENDING invoice resent after the suggestion changes keeps its ORIGINAL hash; nothing is signed again', async () => {
    const w = await world();
    await raw('evm_setAutomine', [false]);
    try {
      await assert.rejects(w.payer(CAP, 'after-broadcast').submit(invoice('PEND-1')), FailPointError);
      const original = new Ledger(w.ledgerPath).get('PEND-1')!.tx_hash;
      const sigAfter = signingStats.signatures;
      suggestedTip = parseGwei('9');
      const r = await w.payer(CAP).submit(invoice('PEND-1'));
      assert.equal(r.outcome, 'pending', JSON.stringify(r));
      assert.equal((r as { txHash: string }).txHash, original);
      assert.equal(signingStats.signatures, sigAfter, 'never re-signed');
      await raw('evm_mine');
      const r2 = await w.payer(CAP).submit(invoice('PEND-1'));
      assert.ok(r2.outcome === 'recovered' || r2.outcome === 'replayed' || r2.outcome === 'paid', JSON.stringify(r2));
      assert.equal((r2 as { receipt: { txHash: string } }).receipt.txHash, original);
      assert.equal((await w.sent()).length, 1);
    } finally {
      await raw('evm_setAutomine', [true]);
    }
  });
});
