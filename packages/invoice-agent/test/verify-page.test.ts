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
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeErrorResult, encodeFunctionData, getAddress, http, toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain, type ChainConfig } from '../src/chain.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from '../src/generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import { inquireInvoice } from '../src/inquiry.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer } from '../src/payer.js';
import { vendorKey } from '../src/vault.js';
import { decodeRevert, encodePayInvoice, encodeStringAndBytes32, encodeStringArg, ERRORS, rpcClient, SELECTORS, simulateResend, TOPICS, vendorBytes32, verifyInvoice, type Rpc } from '../verify/verify.js';
import { freePort } from './fixtures/free-port.js';

// VERIFY_PAGE_ANVIL_PORT pins the port (e.g. to inspect the chain); otherwise one the OS reports free.
const PORT = Number(process.env['VERIFY_PAGE_ANVIL_PORT'] ?? (await freePort()));
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
  // Re-sets the mandate (same agent, vendor and payee) to expire `seconds` after the current block.
  const setExpiry = async (seconds: number) => {
    const t = BigInt((await p.getBlock()).timestamp);
    await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, vendorKey('acme'), VENDOR, 10_000_000, 50_000_000, Number(t + BigInt(seconds))] }));
    return Number(t) + seconds;
  };
  return { cfg, token, vault, agent, page, mcp, setVendor, setExpiry };
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

  it('on Aevum, a vault that holds another token than the official tUSD8 is a mismatch, never paid_verified', async () => {
    // A JSON-RPC stub: chain 44005, a contract at the vault, token() = another address. Nothing past the token check may run.
    const other = '0x' + '0'.repeat(24) + '1111111111111111111111111111111111111111';
    const zero = '0x' + '0'.repeat(64 * 7);
    const calls: string[] = [];
    const rpc = async (m: string, p?: unknown[]) => {
      calls.push(m);
      if (m === 'eth_chainId') return '0xabe5';
      if (m === 'eth_getCode') return '0x6080';
      if (m === 'eth_call') return (p![0] as { data: string }).data.startsWith(SELECTORS.token) ? other : zero;
      throw new Error('unexpected ' + m);
    };
    const v = await verifyInvoice({ rpc, vault: '0xA0BfD474378bB8F7Ee96294313a3832B26f4D7A3', invoiceId: 'QDAY-1', chainId: 44005 });
    assert.equal(v.state, 'mismatch', v.answer);
    assert.match(v.answer, /not the official tUSD8/);
    assert.deepEqual([...new Set(calls)], ['eth_chainId', 'eth_getCode', 'eth_call']);
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

describe('verification page: "Simulate a resend after the payment" (read-only eth_call of the same payInvoice)', () => {
  const real = rpcClient(RPC);
  /** An RPC that answers `hook` where it returns something, the real Anvil otherwise. */
  const tamper = (hook: (m: string, p: any[]) => Promise<unknown> | undefined): Rpc => async (m, p = []) => (hook(m, p as any[]) ?? real(m, p));
  const isPay = (m: string, p: any[]) => m === 'eth_call' && String(p[0]?.data).startsWith(SELECTORS.payInvoice);
  const reverts = (data: Hex) => Promise.reject(Object.assign(new Error('eth_call: execution reverted'), { rpcCode: 3, rpcData: data }));
  const errAbi = INVOICE_MANDATE_ABI.filter((x) => x.type === 'error');
  const blockTime = async (n: number) => Number(BigInt(((await raw('eth_getBlockByNumber', ['0x' + n.toString(16), false])) as { timestamp: string }).timestamp));

  /** A finalized paid invoice and its page verdict. */
  async function paid(id: string) {
    const w = await world();
    await w.agent().submit(inv(id, '1'));
    await raw('anvil_mine', ['0x50']);
    const verdict = await w.page(id);
    assert.equal(verdict.state, 'paid_verified', verdict.answer);
    return { w, verdict, S: verdict.settlement!.blockNumber };
  }

  it('its payInvoice selector, its encoding and its error selectors and decoding match the contract ABI', () => {
    const fn = INVOICE_MANDATE_ABI.find((x) => x.type === 'function' && x.name === 'payInvoice') as AbiFunction;
    assert.equal(SELECTORS.payInvoice, toFunctionSelector(fn));
    for (const id of ['QDAY-2026-11-24-001', 'x'.repeat(64), 'é']) {
      assert.equal(encodePayInvoice(id, vendorBytes32('vendor-1'), VENDOR, '1000000'),
        encodeFunctionData({ abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args: [id, vendorKey('vendor-1'), VENDOR, 1_000_000n] }));
    }
    for (const [selector, spec] of Object.entries(ERRORS)) {
      const e = errAbi.find((x) => x.name === spec.name);
      assert.ok(e, `${spec.name} is in the ABI`);
      assert.equal(selector, toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`), spec.name);
      assert.deepEqual(spec.args, e.inputs.map((i) => i.type), spec.name);
    }
    for (const name of ['AlreadySettled', 'MandateExpired', 'NotAgent', 'MandatePaused', 'MandateChanged', 'AboveInvoiceCap', 'AboveDailyLimit']) {
      assert.ok(Object.values(ERRORS).some((s) => s.name === name), `${name} is decoded`);
    }
    const key = ('0x' + 'ab'.repeat(32)) as Hex;
    assert.deepEqual(decodeRevert(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'AlreadySettled', args: [key, 4030463n] })), { name: 'AlreadySettled', selector: '0x6fd708b6', args: [key, '4030463'] });
    assert.deepEqual(decodeRevert(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'MandateChanged', args: [vendorKey('beta'), VENDOR] })).args, [vendorKey('beta'), VENDOR.toLowerCase()]);
    assert.deepEqual(decodeRevert(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'AboveDailyLimit', args: [1n, 2n, 3n] })).args, ['1', '2', '3']);
    assert.equal(decodeRevert('0x27267dfd').name, 'MandateExpired');
    assert.equal(decodeRevert('0xdeadbeef').name, null);
    assert.equal(decodeRevert('0x6fd708b6').name, null, 'AlreadySettled without its arguments is not decoded');
    assert.equal(decodeRevert('<b>x</b>').name, null);
  });

  it('mandate valid: at the latest block the vault reverts AlreadySettled with the receipt\'s key and block; one block before the settlement the same call passes', async () => {
    const { w, verdict, S } = await paid('INV-R1');
    const s = await simulateResend({ rpc: real, verdict });
    assert.equal(s.state, 'proven', s.answer);
    const head = Number(BigInt((await raw('eth_blockNumber')) as string));
    assert.equal(s.query?.block, head, 'the mandate is valid: simulated at the latest block');
    assert.ok(s.query!.block > S);
    assert.match(s.query!.chosenBecause, /latest block: the mandate is still valid/);
    assert.equal(s.settlementBlock, S);
    assert.equal(s.result?.kind, 'revert');
    assert.deepEqual(s.result?.kind === 'revert' && s.result.error, { name: 'AlreadySettled', selector: '0x6fd708b6', args: [verdict.settlement!.invoiceKey, String(S)] });
    assert.equal(s.call?.from.toLowerCase(), AGENT.toLowerCase());
    assert.equal(s.call?.to, w.vault);
    assert.equal(s.call?.args.amountUnits, '1000000');
    assert.equal(s.control?.block, S - 1);
    assert.equal(s.control?.result.kind, 'success', s.control?.summary);
    assert.match(s.answer, new RegExp(`original settlement in block ${S} stands`));
    assert.ok(s.checks.every((c) => c.ok));
  });

  it('not offered for a receipt that is not paid_verified', async () => {
    const w = await world();
    await w.agent().submit(inv('INV-R2', '1')); // settled, not finalized
    const pending = await w.page('INV-R2');
    assert.equal(pending.state, 'pending');
    const calls: string[] = [];
    const s = await simulateResend({ rpc: async (m) => { calls.push(m); throw new Error('no call expected'); }, verdict: pending });
    assert.equal(s.state, 'not_available');
    assert.match(s.answer, /paid_verified; this one is pending/);
    assert.deepEqual(calls, []);
  });

  it('mandate expired at the latest block (the vault answers MandateExpired there): the historical simulation a few blocks after the settlement still proves it', async () => {
    const { w, verdict, S } = await paid('INV-R3');
    await raw('evm_increaseTime', [2 * 86_400]);
    await raw('evm_mine');
    const data = encodePayInvoice('INV-R3', vendorBytes32('acme'), VENDOR, '1000000');
    // The scenario: at the latest block the vault refuses for the expiry, before its duplicate check.
    await assert.rejects(real('eth_call', [{ from: AGENT, to: w.vault, data }, 'latest']), (e: { rpcData?: string }) => e.rpcData === '0x27267dfd');
    const s = await simulateResend({ rpc: real, verdict });
    assert.equal(s.state, 'proven', s.answer);
    assert.equal(s.query?.block, S + 10);
    assert.ok(s.query!.block < s.query!.latestBlock);
    assert.match(s.query!.chosenBecause, /10 blocks after the settlement block, before the mandate's expiry .*: at the latest block the mandate expired/);
    assert.equal(s.control?.result.kind, 'success');
  });

  it('expiry within the offset: the last block before the expiry is used; expiry right after the settlement block: the settlement block itself', async () => {
    // Blocks 30 s apart after the payment, a mandate that expires 120 s after it was set: the expiry falls 3–4 blocks later.
    {
      const w = await world();
      const expiresAt = await w.setExpiry(120);
      await w.agent().submit(inv('INV-R4', '1'));
      await raw('anvil_mine', ['0x50', '0x1e']);
      const verdict = await w.page('INV-R4');
      assert.equal(verdict.state, 'paid_verified', verdict.answer);
      const S = verdict.settlement!.blockNumber;
      const s = await simulateResend({ rpc: real, verdict });
      assert.equal(s.state, 'proven', s.answer);
      const b = s.query!.block;
      assert.ok(b > S && b < S + 10, `block ${b}, settlement ${S}`);
      assert.ok((await blockTime(b)) < expiresAt);
      assert.ok((await blockTime(b + 1)) >= expiresAt, 'it is the LAST block before the expiry');
      assert.match(s.query!.chosenBecause, /the last block before the mandate's expiry/);
    }
    {
      const w = await world();
      await w.setExpiry(100);
      await w.agent().submit(inv('INV-R5', '1'));
      await raw('anvil_mine', ['0x50', '0xc8']); // the next block is 200 s later: past the expiry
      const verdict = await w.page('INV-R5');
      const S = verdict.settlement!.blockNumber;
      const s = await simulateResend({ rpc: real, verdict });
      assert.equal(s.state, 'proven', s.answer);
      assert.equal(s.query?.block, S);
      assert.match(s.query!.chosenBecause, /the settlement block itself/);
    }
  });

  it('an RPC that does not answer, or no longer keeps the historical state ("missing trie node", "header not found"): unavailable, never a proof', async () => {
    const { verdict, S } = await paid('INV-R6');
    const down = await simulateResend({ rpc: rpcClient('http://127.0.0.1:1'), verdict });
    assert.equal(down.state, 'unavailable', down.answer);
    assert.match(down.answer, /RPC did not answer/);

    const pruned = await simulateResend({ rpc: tamper((m, p) => (isPay(m, p) ? Promise.reject(new Error('eth_call: missing trie node 3c1f… (path ) state 0xabc is not available')) : undefined)), verdict });
    assert.equal(pruned.state, 'unavailable', pruned.answer);
    assert.match(pruned.answer, /does not serve the state of block \d+.*says nothing either way/);
    assert.equal(pruned.result?.kind === 'error' && pruned.result.noHistory, true);
    assert.equal(pruned.control?.result.kind, 'error');

    const noHeader = await simulateResend({ rpc: tamper((m, p) => (m === 'eth_getBlockByNumber' && p[0] !== 'latest' ? Promise.reject(new Error('eth_getBlockByNumber: header not found')) : isPay(m, p) && p[1] !== '0x' + (S - 1).toString(16) ? Promise.reject(new Error('eth_call: header not found')) : undefined)), verdict });
    assert.equal(noHeader.state, 'unavailable', noHeader.answer);
  });

  it('unexpected answers are inconclusive: a success where a refusal was expected, an unknown error, another refusal, AlreadySettled with another key or block, or already refused before the settlement', async () => {
    const { verdict, S } = await paid('INV-R7');
    const key = verdict.settlement!.invoiceKey as Hex;
    const atTarget = (answer: () => Promise<unknown>) => tamper((m, p) => (isPay(m, p) && p[1] !== '0x' + (S - 1).toString(16) ? answer() : undefined));
    const cases: [string, Rpc, RegExp][] = [
      ['success', atTarget(async () => '0x'), /did NOT revert/],
      ['unknown selector', atTarget(() => reverts('0xdeadbeef')), /unknown error 0xdeadbeef/],
      ['no revert data', atTarget(() => reverts('0x')), /no error data/],
      ['MandateExpired', atTarget(() => reverts('0x27267dfd')), /MandateExpired: the mandate had expired there/],
      ['NotAgent', atTarget(() => reverts(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'NotAgent' }))), /NotAgent/],
      ['another key', atTarget(() => reverts(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'AlreadySettled', args: [('0x' + '11'.repeat(32)) as Hex, BigInt(S)] }))), /names invoice key 0x1111/],
      ['another block', atTarget(() => reverts(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'AlreadySettled', args: [key, BigInt(S + 1)] }))), new RegExp(`names block ${S + 1}, not the receipt's settlement block ${S}`)],
      ['refused before the settlement', tamper((m, p) => (isPay(m, p) ? reverts(encodeErrorResult({ abi: INVOICE_MANDATE_ABI, errorName: 'AlreadySettled', args: [key, BigInt(S)] })) : undefined)), new RegExp(`already reverted AlreadySettled at block ${S - 1}`)],
    ];
    for (const [what, rpc, re] of cases) {
      const s = await simulateResend({ rpc, verdict });
      assert.equal(s.state, 'inconclusive', `${what}: ${s.answer}`);
      assert.match(s.answer, re, what);
      assert.match(s.answer, /^Inconclusive/, what);
      assert.ok(s.checks.some((c) => !c.ok), what);
    }
  });
});
