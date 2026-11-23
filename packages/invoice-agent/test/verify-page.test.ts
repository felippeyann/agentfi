/**
 * The static verification page (verify/verify.js, the logic the browser runs) against a real local chain:
 * the vault and the agent are the real ones, the page reads only JSON-RPC. Its states must match the agent's
 * read-only inquiry (the MCP `invoice_status`) under the same `finalized` rule.
 *
 * Run: npm test (in packages/invoice-agent). Needs `anvil` on PATH or in ~/.foundry/bin.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, encodeAbiParameters, getAddress, http, toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain, type ChainConfig } from '../src/chain.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from '../src/generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import { inquireInvoice } from '../src/inquiry.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer } from '../src/payer.js';
import { vendorKey } from '../src/vault.js';
import { encodeStringAndBytes32, encodeStringArg, rpcClient, SELECTORS, TOPICS, vendorBytes32, verifyInvoice } from '../verify/verify.js';

const PORT = 9500 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const AGENT = getAddress(privateKeyToAccount(AGENT_KEY).address);

const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

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

async function world() {
  const chainDef = makeChain({ rpcUrl: RPC, chainId: 31337, token: '0x0000000000000000000000000000000000000000' });
  const p = createPublicClient({ chain: chainDef, transport: http(RPC) });
  const op = createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), chain: chainDef, transport: http(RPC) });
  const wait = async (hash: Hex) => p.waitForTransactionReceipt({ hash });
  const token = getAddress((await wait(await op.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }))).contractAddress!);
  const vault = getAddress((await wait(await op.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [token] }))).contractAddress!);
  await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [vault, 100_000_000n] }));
  const now = BigInt((await p.getBlock()).timestamp);
  await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, vendorKey('acme'), VENDOR, 10_000_000, 50_000_000, Number(now + 86_400n)] }));
  // The same rule as the page (and Aevum): finalized. Anvil reports finalized = head − 64.
  const cfg: ChainConfig = { rpcUrl: RPC, chainId: 31337, token, vault, vaultVendorId: 'acme', confirm: { kind: 'finalized' } };
  const mandate: Mandate = { chainId: 31337, token, payer: AGENT, vendor: { id: 'acme', name: 'Acme', address: VENDOR }, vault, maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString() };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-page-')), 'ledger.sqlite');
  const agent = (failAt?: 'after-broadcast') => new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg, mandate, payerKey: AGENT_KEY, receiptTimeoutMs: 3_000, ...(failAt ? { failAt } : {}) });
  const page = (invoiceId: string, extra: { txHash?: string; chainId?: number; vault?: string; rpcUrl?: string; vendorId?: string } = {}) =>
    verifyInvoice({ rpc: rpcClient(extra.rpcUrl ?? RPC), vault: extra.vault ?? vault, invoiceId, chainId: extra.chainId ?? 31337, explorerUrl: 'https://explorer.example', ...(extra.txHash ? { txHash: extra.txHash } : {}), ...(extra.vendorId ? { vendorId: extra.vendorId } : {}) });
  const setVendor = async (id: string, payTo: string) => {
    const t = BigInt((await p.getBlock()).timestamp);
    await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, vendorKey(id), getAddress(payTo), 10_000_000, 50_000_000, Number(t + 86_400n)] }));
  };
  const mcp = (invoiceId: string) => inquireInvoice(cfg, mandate, ledgerPath, invoiceId);
  return { cfg, token, vault, agent, page, mcp, setVendor };
}

const inv = (id: string, amount: string) => ({ id, vendorId: 'acme', payTo: VENDOR, amount, currency: 'tUSD8' as const });

describe('verification page (read-only, in the browser): verify/verify.js against Anvil', () => {
  it('its hand-written selectors, topic and string encoding match the contract ABI', () => {
    const fn = (name: string) => INVOICE_MANDATE_ABI.find((x) => x.type === 'function' && x.name === name) as AbiFunction;
    assert.equal(SELECTORS.settlementOf, toFunctionSelector(fn('settlementOf')));
    assert.equal(SELECTORS.findSettlement, toFunctionSelector(fn('findSettlement')));
    assert.equal(SELECTORS.mandate, toFunctionSelector(fn('mandate')));
    assert.equal(SELECTORS.token, toFunctionSelector(fn('token')));
    assert.equal(SELECTORS.operator, toFunctionSelector(fn('operator')));
    assert.equal(TOPICS.invoiceSettled, toEventSelector(INVOICE_MANDATE_ABI.find((x) => x.type === 'event' && x.name === 'InvoiceSettled') as AbiEvent));
    for (const s of ['INV-001', '', 'x'.repeat(32), 'y'.repeat(33), 'é-ünïcode']) {
      assert.equal('0x' + encodeStringArg(s), encodeAbiParameters([{ type: 'string' }], [s]));
      assert.equal('0x' + encodeStringAndBytes32(s, vendorBytes32('vendor-1')), encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], [s, vendorKey('vendor-1')]));
    }
  });

  it('paid: pending until the block is finalized, then paid_verified, with the mandate, the settlement, the event, the transfer: the same states as the MCP', async () => {
    const w = await world();
    const paid = await w.agent().submit(inv('INV-1', '8'));
    assert.equal(paid.outcome, 'pending', 'the agent itself waits for finality');
    const p1 = await w.page('INV-1');
    assert.equal(p1.state, 'pending', p1.answer);
    assert.equal((await w.mcp('INV-1')).state, 'pending');
    assert.equal(p1.settlement?.settled, true);
    assert.equal(p1.settlement?.amount, '8');
    assert.equal(p1.mandate?.vendor, 'acme');
    assert.equal(p1.mandate?.payTo, VENDOR.toLowerCase());

    await raw('anvil_mine', ['0x50']); // 80 blocks: the payment's block is now at or below finalized (head − 64)
    const p2 = await w.page('INV-1');
    assert.equal(p2.state, 'paid_verified', p2.answer);
    assert.equal((await w.mcp('INV-1')).state, 'paid_verified');
    assert.equal(p2.event?.txHash, (paid as { txHash: string }).txHash);
    assert.equal(p2.explorer, `https://explorer.example/tx/${(paid as { txHash: string }).txHash}`);
    assert.equal(p2.transfer?.amount, '8');
    assert.equal(p2.finality?.canonical, true);
    assert.ok(p2.checks.every((c) => c.ok), JSON.stringify(p2.checks));
  });

  it('unknown id → unknown_invoice (as the MCP); a broadcast not yet mined, given its hash → pending; nothing given → unknown_invoice', async () => {
    const w = await world();
    assert.equal((await w.page('INV-404')).state, 'unknown_invoice');
    assert.equal((await w.mcp('INV-404')).state, 'unknown_invoice');
    await raw('evm_setAutomine', [false]);
    try {
      await assert.rejects(w.agent('after-broadcast').submit(inv('INV-2', '1')), FailPointError);
      const pending = await w.mcp('INV-2');
      assert.equal(pending.state, 'pending');
      const txHash = pending.ledger!.txHash!; // the hash the agent recorded before broadcasting
      assert.equal((await w.page('INV-2', { txHash })).state, 'pending');
      assert.equal((await w.page('INV-2')).state, 'unknown_invoice', 'without the hash the page can only say "not settled"');
      await raw('evm_mine');
    } finally {
      await raw('evm_setAutomine', [true]);
    }
    assert.equal((await w.page('INV-2')).state, 'pending', 'settled, not finalized yet');
  });

  it('cannot_verify_now: another chain, no contract at the address, an RPC that does not answer; bad input refused', async () => {
    const w = await world();
    assert.equal((await w.page('INV-1', { chainId: 44005 })).state, 'cannot_verify_now');
    assert.match((await w.page('INV-1', { chainId: 44005 })).answer, /serves chain 31337, not 44005/);
    assert.equal((await w.page('INV-1', { vault: VENDOR })).state, 'cannot_verify_now');
    assert.equal((await w.page('INV-1', { rpcUrl: 'http://127.0.0.1:1' })).state, 'cannot_verify_now');
    assert.equal((await w.page('INV 1')).state, 'cannot_verify_now');
    assert.equal((await w.page('INV-1', { vault: '0x1234' })).state, 'cannot_verify_now');

  });

  it('after a vendor change the page still finds the old vendor\'s settlement (never a false "not paid"); with another vendor id it names the settled one', async () => {
    const w = await world();
    await w.agent().submit(inv('INV-9', '2'));
    await raw('anvil_mine', ['0x50']);
    await w.setVendor('beta', '0x90F79bf6EB2c4f870365E785982E1f101E93b906');
    const any = await w.page('INV-9');
    assert.equal(any.state, 'paid_verified', any.answer);
    assert.equal(any.settlement?.vendor, 'acme');
    assert.equal(any.mandate?.vendor, 'beta');
    const byAcme = await w.page('INV-9', { vendorId: 'acme' });
    assert.equal(byAcme.state, 'paid_verified', byAcme.answer);
    const byBeta = await w.page('INV-9', { vendorId: 'beta' });
    assert.equal(byBeta.state, 'unknown_invoice');
    assert.match(byBeta.answer, /HAS one under the same id for vendor "acme"/);
    const never = await w.page('INV-404');
    assert.match(never.answer, /under any vendor it has had/);
    // The MCP answers for the agent's vendor (acme) and still finds it.
    assert.equal((await w.mcp('INV-9')).state, 'paid_verified');
  });
});
