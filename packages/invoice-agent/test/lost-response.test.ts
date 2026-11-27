/**
 * The failure that matters, on a real local chain (Anvil, LOCAL TEST token): the payment goes out
 * and the agent dies before it can answer. Each case kills the payer at a fail point (in-process:
 * FailPointError), builds a NEW payer on the same ledger file (a restarted process), resubmits the
 * invoice and counts the token Transfer logs on-chain.
 *
 * Run: npm test (in packages/invoice-agent). Needs `anvil` on PATH or in ~/.foundry/bin.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { balanceOf, makeChain, transfersFrom, type ChainConfig } from '../src/chain.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import type { Invoice } from '../src/invoice.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer, type FailPoint, type Outcome } from '../src/payer.js';
import { freePort } from './fixtures/free-port.js';

const PORT = await freePort();
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const PAYER = getAddress(privateKeyToAccount(PAYER_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const OTHER = getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');

let anvil: ChildProcess;
const rpc = async (method: string, params: unknown[] = []) =>
  ((await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: unknown }).result;

before(async () => {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await rpc('eth_chainId').catch(() => undefined)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('anvil did not start');
});
after(() => anvil?.kill());

/** A fresh world for one case: a new token (so counts start at zero), a new ledger file, the mandate. */
async function world() {
  const chain = makeChain({ rpcUrl: RPC, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain, transport: http(RPC) });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) })).contractAddress!);
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [PAYER, 100_000_000n] }) });
  const cfg: ChainConfig = { rpcUrl: RPC, chainId: CHAIN_ID, token };
  const mandate: Mandate = {
    chainId: CHAIN_ID, token, payer: PAYER, vendor: { id: 'acme', name: 'Acme', address: VENDOR },
    maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString(),
  };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'invoice-agent-test-')), 'ledger.sqlite');
  /** A payer process: a new ledger handle on the same file each time, like a restart. */
  const process = (failAt?: FailPoint) => new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: cfg, mandate, payerKey: PAYER_KEY, receiptTimeoutMs: 5_000, ...(failAt ? { failAt } : {}) });
  const sent = async () => transfersFrom(cfg, PAYER);
  return { cfg, process, sent };
}

const invoice = (id: string, amount: string, payTo: string = VENDOR): Invoice => ({ id, vendorId: 'acme', payTo, amount, currency: 'tUSD8' });
const tx = (o: Outcome) => ('receipt' in o ? o.receipt.txHash : 'txHash' in o ? o.txHash : null);

describe('lost response: the payment goes out, the answer does not', () => {
  it('crash right after broadcast → the resubmission finds the payment on-chain, pays nothing new, returns the receipt', async () => {
    const w = await world();
    await assert.rejects(w.process('after-broadcast').submit(invoice('INV-1', '8')), FailPointError);
    assert.equal((await w.sent()).length, 1, 'the payment did go out before the crash');

    const restarted = w.process();
    const r = await restarted.submit(invoice('INV-1', '8'));
    assert.equal(r.outcome, 'recovered');
    const onChain = await w.sent();
    assert.equal(onChain.length, 1, 'still exactly one transfer');
    assert.equal(tx(r), onChain[0]!.txHash, 'the receipt is that transfer');
    assert.equal(onChain[0]!.value, 8_000_000n);

    const again = await restarted.submit(invoice('INV-1', '8'));
    assert.equal(again.outcome, 'replayed');
    assert.equal(tx(again), onChain[0]!.txHash);
    assert.equal(await balanceOf(w.cfg, PAYER), 92_000_000n);
  });

  it('crash after broadcast while nothing is mined → PENDING on every resubmission (no new transaction), then the receipt once mined', async () => {
    const w = await world();
    await rpc('evm_setAutomine', [false]);
    try {
      await assert.rejects(w.process('after-broadcast').submit(invoice('INV-2', '2')), FailPointError);
      const restarted = w.process();
      const p1 = await restarted.submit(invoice('INV-2', '2'));
      const p2 = await restarted.submit(invoice('INV-2', '2'));
      assert.equal(p1.outcome, 'pending');
      assert.equal(p2.outcome, 'pending');
      assert.equal(tx(p1), tx(p2), 'the same transaction both times');
      const pool = (await rpc('txpool_content')) as { pending: Record<string, Record<string, unknown>> };
      const fromPayer = Object.entries(pool.pending).filter(([a]) => getAddress(a) === PAYER).flatMap(([, byNonce]) => Object.values(byNonce));
      assert.equal(fromPayer.length, 1, 'exactly one transaction from the payer is waiting in the mempool');
      assert.equal((await w.sent()).length, 0, 'nothing mined yet');

      await rpc('evm_mine');
      const done = await restarted.submit(invoice('INV-2', '2'));
      assert.equal(done.outcome, 'recovered');
      assert.equal(tx(done), tx(p1));
      assert.equal((await w.sent()).length, 1);
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
  });

  it('crash after recording but before broadcast → the SAME signed bytes are sent (same hash), one transfer', async () => {
    const w = await world();
    const crashed = w.process('after-sign');
    await assert.rejects(crashed.submit(invoice('INV-3', '1')), FailPointError);
    assert.equal((await w.sent()).length, 0, 'nothing reached the chain');
    const restarted = w.process();
    const r = await restarted.submit(invoice('INV-3', '1'));
    assert.equal(r.outcome, 'recovered');
    const onChain = await w.sent();
    assert.equal(onChain.length, 1);
    assert.equal(tx(r), onChain[0]!.txHash);
  });

  it('a NEW invoice after a crash does not take the nonce of the unsent payment: both are paid once', async () => {
    const w = await world();
    await assert.rejects(w.process('after-sign').submit(invoice('INV-4a', '4')), FailPointError);
    const restarted = w.process();
    const b = await restarted.submit(invoice('INV-4b', '5'));
    assert.equal(b.outcome, 'paid');
    const a = await restarted.submit(invoice('INV-4a', '4'));
    assert.ok(a.outcome === 'replayed' || a.outcome === 'recovered', `INV-4a: ${a.outcome}`);
    const onChain = await w.sent();
    assert.deepEqual(onChain.map((t) => t.value).sort(), [4_000_000n, 5_000_000n].sort());
    assert.equal(onChain.length, 2, 'two invoices, two transfers');
  });
});

describe('the mandate and the invoice id', () => {
  it('over the per-invoice limit or a changed payee: refused with a reason, nothing signed, nothing on-chain', async () => {
    const w = await world();
    const p = w.process();
    const over = await p.submit(invoice('INV-5', '12'));
    const payee = await p.submit(invoice('INV-6', '5', OTHER));
    assert.equal(over.outcome, 'refused');
    assert.equal(payee.outcome, 'refused');
    assert.match((over as { reason: string }).reason, /above the 10 tUSD8 per invoice/);
    assert.match((payee as { reason: string }).reason, /not Acme's registered address/);
    assert.equal((await w.sent()).length, 0);
    assert.equal((await p.submit(invoice('INV-5', '12'))).outcome, 'refused', 'a refused invoice stays refused');
  });

  it('the same invoice id with different content is a conflict, not a second payment', async () => {
    const w = await world();
    const p = w.process();
    assert.equal((await p.submit(invoice('INV-7', '8'))).outcome, 'paid');
    assert.equal((await p.submit(invoice('INV-7', '9'))).outcome, 'conflict');
    assert.equal((await w.sent()).length, 1);
  });
});
