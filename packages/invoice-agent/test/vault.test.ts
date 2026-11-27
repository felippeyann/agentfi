/**
 * The vault path (mandate.vault set): the agent pays with InvoiceMandate.payInvoice on a real local chain (Anvil,
 * LOCAL TEST token, the vault built from contracts/src/InvoiceMandate.sol). The same write-ahead, crash and
 * confirmation guarantees as the direct path, plus what only the chain can give: a second settlement of the same
 * invoice is refused even by an agent with a NEW ledger, and "was it paid?" is answered from the vault alone.
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
import { balanceOf, makeChain, planTransfer, signingStats, transfersFrom, type ChainConfig } from '../src/chain.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from '../src/generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from '../src/generated/local-test-usd8.js';
import { inquireInvoice } from '../src/inquiry.js';
import type { Invoice } from '../src/invoice.js';
import { Ledger } from '../src/ledger.js';
import type { Mandate } from '../src/mandate.js';
import { FailPointError, InvoicePayer, type FailPoint, type Outcome } from '../src/payer.js';
import { preflight } from '../src/preflight.js';
import { assertVaultMatches, settlementOf, vendorKey } from '../src/vault.js';
import { freePort } from './fixtures/free-port.js';

const PORT = await freePort();
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // deploys and owns the vault
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex; // the vault's agent: signs, pays gas, holds no tUSD8
const AGENT = getAddress(privateKeyToAccount(AGENT_KEY).address);
const OPERATOR = getAddress(privateKeyToAccount(OPERATOR_KEY).address);
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const EMPTY_VENDOR = getAddress('0x00000000000000000000000000000000000E3e01');

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

const chainDef = makeChain({ rpcUrl: RPC, chainId: CHAIN_ID, token: '0x0000000000000000000000000000000000000000' });
const pub = () => createPublicClient({ chain: chainDef, transport: http(RPC) });
const operator = () => createWalletClient({ account: privateKeyToAccount(OPERATOR_KEY), chain: chainDef, transport: http(RPC) });

/** A fresh world: a token, a vault owned by the operator with 100 tUSD8, its mandate (≤ 10 per invoice, ≤ 50 per day). */
async function world(opts: { cap?: bigint; payTo?: string } = {}) {
  const p = pub(), op = operator();
  const wait = async (hash: Hex) => p.waitForTransactionReceipt({ hash });
  const token = getAddress((await wait(await op.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }))).contractAddress!);
  const vaultDeploy = await wait(await op.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [token] }));
  const vault = getAddress(vaultDeploy.contractAddress!);
  await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [OPERATOR, 1_000_000_000n] }));
  const deposit = await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [vault, 100_000_000n] }));
  const now = BigInt((await p.getBlock()).timestamp);
  const setMandate = await wait(await op.writeContract({
    address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate',
    args: [AGENT, vendorKey('acme'), getAddress(opts.payTo ?? VENDOR), Number(opts.cap ?? 10_000_000n), 50_000_000, Number(now + 30n * 86400n)],
  }));
  const cfg: ChainConfig = { rpcUrl: RPC, chainId: CHAIN_ID, token, vault, vaultVendorId: 'acme' };
  const mandate: Mandate = {
    chainId: CHAIN_ID, token, payer: AGENT, vendor: { id: 'acme', name: 'Acme', address: VENDOR }, vault,
    maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString(),
  };
  const newLedgerPath = () => join(mkdtempSync(join(tmpdir(), 'invoice-agent-vault-')), 'ledger.sqlite');
  const ledgerPath = newLedgerPath();
  const proc = (o: { failAt?: FailPoint; ledger?: string; chain?: ChainConfig } = {}) =>
    new InvoicePayer({ ledger: new Ledger(o.ledger ?? ledgerPath), chain: o.chain ?? cfg, mandate, payerKey: AGENT_KEY, receiptTimeoutMs: 5_000, ...(o.failAt ? { failAt: o.failAt } : {}) });
  const vaultCall = async (functionName: 'pause' | 'unpause' | 'revokeAgent') => wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName }));
  const setVendor = async (id: string, payTo: string) => {
    const t = BigInt((await p.getBlock()).timestamp);
    await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, vendorKey(id), getAddress(payTo), 10_000_000, 50_000_000, Number(t + 86_400n)] }));
  };
  return {
    cfg, mandate, token, vault, ledgerPath, newLedgerPath, proc, vaultCall, setVendor,
    sent: () => transfersFrom(cfg, vault),
    gas: { deploy: vaultDeploy.gasUsed, deposit: deposit.gasUsed, setMandate: setMandate.gasUsed },
  };
}

const invoice = (id: string, amount: string, payTo: string = VENDOR): Invoice => ({ id, vendorId: 'acme', payTo, amount, currency: 'tUSD8' });
const tx = (o: Outcome) => ('receipt' in o ? o.receipt.txHash : 'txHash' in o ? o.txHash : null);

describe('vault path: the agent pays through InvoiceMandate.payInvoice', () => {
  it('pays from the VAULT (not the agent key): Transfer vault → payee, InvoiceSettled, settlementOf; a resubmission replays', async () => {
    const w = await world();
    const r = await w.proc().submit(invoice('INV-1', '8'));
    assert.equal(r.outcome, 'paid');
    const receipt = (r as { receipt: { from: string; vault?: string; agent?: string; txHash: string; blockNumber: string } }).receipt;
    assert.equal(receipt.from, w.vault, 'the money left the vault');
    assert.equal(receipt.vault, w.vault);
    assert.equal(receipt.agent, AGENT);
    const onChain = await w.sent();
    assert.equal(onChain.length, 1);
    assert.equal(onChain[0]!.txHash, receipt.txHash);
    assert.equal(await balanceOf(w.cfg, w.vault), 92_000_000n);
    assert.equal(await balanceOf(w.cfg, AGENT), 0n, 'the agent key holds no tUSD8');
    const s = await settlementOf(w.cfg, 'INV-1');
    assert.equal(s.settled, true);
    assert.equal(s.amount, 8_000_000n);
    assert.equal(s.blockNumber.toString(), receipt.blockNumber);
    assert.equal(s.agent, AGENT);
    const again = await w.proc().submit(invoice('INV-1', '8'));
    assert.equal(again.outcome, 'replayed');
    assert.equal(tx(again), receipt.txHash);
  });

  it('crash right after broadcast → recovered: the original transaction, nothing new signed, one settlement', async () => {
    const w = await world();
    await assert.rejects(w.proc({ failAt: 'after-broadcast' }).submit(invoice('INV-2', '3')), FailPointError);
    const signaturesBefore = signingStats.signatures;
    const r = await w.proc().submit(invoice('INV-2', '3'));
    assert.equal(r.outcome, 'recovered');
    assert.equal(signingStats.signatures, signaturesBefore, 'nothing new was signed');
    const onChain = await w.sent();
    assert.equal(onChain.length, 1);
    assert.equal(tx(r), onChain[0]!.txHash);
    assert.equal((await settlementOf(w.cfg, 'INV-2')).settled, true);
  });

  it('crash after recording, before broadcast → the SAME signed bytes are sent (same hash)', async () => {
    const w = await world();
    await assert.rejects(w.proc({ failAt: 'after-sign' }).submit(invoice('INV-3', '1')), FailPointError);
    assert.equal((await w.sent()).length, 0);
    const signed = new Ledger(w.ledgerPath).get('INV-3')!.tx_hash;
    const r = await w.proc().submit(invoice('INV-3', '1'));
    assert.equal(r.outcome, 'recovered');
    assert.equal(tx(r), signed);
    assert.equal((await w.sent()).length, 1);
  });

  it('crash after broadcast while nothing is mined → pending (not sent again), then recovered once mined', async () => {
    const w = await world();
    await rpc('evm_setAutomine', [false]);
    try {
      await assert.rejects(w.proc({ failAt: 'after-broadcast' }).submit(invoice('INV-4', '2')), FailPointError);
      const p = w.proc();
      const p1 = await p.submit(invoice('INV-4', '2'));
      assert.equal(p1.outcome, 'pending');
      const ask = await inquireInvoice(w.cfg, w.mandate, w.ledgerPath, 'INV-4');
      assert.equal(ask.state, 'pending');
      assert.equal(ask.vault?.settled, false, 'the vault has not settled it yet');
      await rpc('evm_mine');
      const done = await p.submit(invoice('INV-4', '2'));
      assert.equal(done.outcome, 'recovered');
      assert.equal(tx(done), tx(p1));
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
  });

  it('a NEW ledger (the agent lost its memory): the same invoice is refused by the CHAIN, nothing signed; "was it paid?" answers from the vault', async () => {
    const w = await world();
    const first = await w.proc().submit(invoice('INV-5', '8'));
    assert.equal(first.outcome, 'paid');
    const fresh = w.newLedgerPath();
    const signaturesBefore = signingStats.signatures;
    const r = await w.proc({ ledger: fresh }).submit(invoice('INV-5', '8'));
    assert.equal(r.outcome, 'refused');
    assert.equal((r as { rule: string }).rule, 'vault:AlreadySettled');
    assert.match((r as { reason: string }).reason, /ALREADY settled/);
    assert.equal(signingStats.signatures, signaturesBefore, 'nothing was signed');
    assert.equal((await w.sent()).length, 1, 'still one payment');

    // The fresh ledger has it as refused, without a transaction: the vault answers "paid".
    const ask = await inquireInvoice(w.cfg, w.mandate, fresh, 'INV-5');
    assert.equal(ask.state, 'paid_verified', ask.answer);
    assert.equal(ask.receipt?.txHash, tx(first));
    assert.equal(ask.vault && 'agrees' in ask.vault && ask.vault.agrees, true);
    // No ledger at all: the vault still answers.
    const none = await inquireInvoice(w.cfg, w.mandate, join(tmpdir(), `no-such-ledger-${Date.now()}.sqlite`), 'INV-5');
    assert.equal(none.state, 'paid_verified', none.answer);
    // An id the vault never settled: unknown, and the vault says so.
    const unknown = await inquireInvoice(w.cfg, w.mandate, fresh, 'INV-404');
    assert.equal(unknown.state, 'unknown_invoice');
    assert.equal(unknown.vault?.settled, false);
  });

  it('the original ledger: paid_verified with the vault record agreeing (settlementOf, the event, the receipt)', async () => {
    const w = await world();
    await w.proc().submit(invoice('INV-6', '4'));
    const ask = await inquireInvoice(w.cfg, w.mandate, w.ledgerPath, 'INV-6');
    assert.equal(ask.state, 'paid_verified', ask.answer);
    assert.ok(ask.vault && 'agrees' in ask.vault && ask.vault.agrees && ask.vault.event?.txHash === ask.receipt?.txHash);
    assert.equal(ask.receipt?.from, w.vault);
  });

  it("after the operator rotates the agent key, a new agent on a fresh ledger still finds the old agent's payment (paid_verified, not mismatch)", async () => {
    const w = await world();
    const first = await w.proc().submit(invoice('INV-ROT', '2'));
    assert.equal(first.outcome, 'paid');
    // Anvil account 3 becomes the agent; the settlement of INV-ROT stays the old agent's.
    const NEW_AGENT = getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');
    const t = BigInt((await pub().getBlock()).timestamp);
    await pub().waitForTransactionReceipt({ hash: await operator().writeContract({ address: w.vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [NEW_AGENT, vendorKey('acme'), getAddress(VENDOR), 10_000_000, 50_000_000, Number(t + 86_400n)] }) });
    const ask = await inquireInvoice(w.cfg, { ...w.mandate, payer: NEW_AGENT }, w.newLedgerPath(), 'INV-ROT');
    assert.equal(ask.state, 'paid_verified', ask.answer);
    assert.equal(ask.receipt?.txHash, tx(first));
    assert.match(ask.answer, /Settled by agent 0x[0-9a-fA-F]{40}, an earlier key/);
  });

  it('operator pause → refused by the vault (nothing signed); unpause → the same invoice is judged again and paid', async () => {
    const w = await world();
    await w.vaultCall('pause');
    const p = w.proc();
    const before = signingStats.signatures;
    const r = await p.submit(invoice('INV-7', '1'));
    assert.equal(r.outcome, 'refused');
    assert.equal((r as { rule: string }).rule, 'vault:MandatePaused');
    assert.equal(signingStats.signatures, before);
    assert.equal((await inquireInvoice(w.cfg, w.mandate, w.ledgerPath, 'INV-7')).state, 'not_paid');
    await w.vaultCall('unpause');
    assert.equal((await p.submit(invoice('INV-7', '1'))).outcome, 'paid');
  });

  it('revoked agent → refused (vault:NotAgent); the on-chain cap wins over a looser mandate file (vault:AboveInvoiceCap)', async () => {
    const w = await world({ cap: 5_000_000n });
    const capped = await w.proc().submit(invoice('INV-8', '8')); // the file allows 10, the vault 5
    assert.equal((capped as { rule: string }).rule, 'vault:AboveInvoiceCap');
    await w.vaultCall('revokeAgent');
    const revoked = await w.proc().submit(invoice('INV-9', '1'));
    assert.equal((revoked as { rule: string }).rule, 'vault:NotAgent');
    assert.equal((await w.sent()).length, 0);
    await assert.rejects(assertVaultMatches(w.cfg, w.mandate), /no agent/);
  });

  it('the agent refuses a mandate file that disagrees with the vault (another payee)', async () => {
    const w = await world({ payTo: EMPTY_VENDOR });
    await assert.rejects(assertVaultMatches(w.cfg, w.mandate), /payTo: the vault pays/);
  });

  it('the gas ceiling applies to the vault call: 1 wei below its maximum is refused before signing, at the maximum it is paid', async () => {
    const w = await world();
    const plan = await planTransfer(w.cfg, AGENT, VENDOR, 1_000_000n, 'INV-10');
    const below = await w.proc({ chain: { ...w.cfg, maxGasCostWei: plan.maxCostWei - 1n } }).submit(invoice('INV-10', '1'));
    assert.equal((below as { rule: string }).rule, 'maxGasCost');
    const at = await w.proc({ chain: { ...w.cfg, maxGasCostWei: plan.maxCostWei } }).submit(invoice('INV-10', '1'));
    assert.equal(at.outcome, 'paid');
  });

  it('vendor switch race (review P2-1): bytes signed for acme, the operator switches to beta, the SAME bytes are re-sent → the vault reverts; beta gets nothing and its INV id stays free', async () => {
    const w = await world();
    const BETA_PAYEE = getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');
    await assert.rejects(w.proc({ failAt: 'after-sign' }).submit(invoice('INV-R', '2')), FailPointError);
    await w.setVendor('beta', BETA_PAYEE);
    const r = await w.proc().submit(invoice('INV-R', '2')); // reconcile: the recorded bytes are sent again, unchanged
    assert.equal(r.outcome, 'failed', JSON.stringify(r));
    assert.equal(await balanceOf(w.cfg, BETA_PAYEE), 0n, 'beta received nothing');
    assert.equal((await settlementOf(w.cfg, 'INV-R', 'beta')).settled, false, "beta's INV-R is still payable");
    assert.equal((await settlementOf(w.cfg, 'INV-R', 'acme')).settled, false);
    // A NEW invoice is refused before signing (the gas estimate reverts MandateChanged), with the reason.
    const fresh = await w.proc().submit(invoice('INV-S', '1'));
    assert.equal((fresh as { rule: string }).rule, 'vault:MandateChanged');
    assert.match((fresh as { reason: string }).reason, /now names vendor "beta"/);
  });

  it('preflight --vault: reads the vault and estimates payInvoice from the agent; fails when paused, for another agent, or above the ceiling', async () => {
    const w = await world();
    const base = { rpcUrl: RPC, chainId: CHAIN_ID, token: w.token, explorerUrl: null, gasSymbol: 'ETH', expectedDecimals: 6, payer: AGENT, vendor: VENDOR, amount: '1', vault: w.vault, vendorId: 'acme', invoiceId: 'PF-1' } as const;
    const ok = await preflight({ ...base, maxGasCostWei: 10n ** 18n });
    assert.equal(ok.ok, true, ok.lines.join('\n'));
    assert.ok(ok.lines.some((l) => /vault payment maximum .* · ceiling /.test(l)), 'prints the vault maximum next to the ceiling');
    assert.ok(ok.lines.some((l) => /✓ the vault's agent is .*this agent/.test(l)));
    const tight = await preflight({ ...base, maxGasCostWei: ok.gasCostWei! - 1n });
    assert.equal(tight.ok, false, 'above the ceiling fails');
    const other = await preflight({ ...base, payer: getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906') });
    assert.ok(other.lines.some((l) => /✗ the vault's agent is .*NOT this agent/.test(l)));
    await w.vaultCall('pause');
    const paused = await preflight(base);
    assert.equal(paused.ok, false);
    assert.ok(paused.lines.some((l) => /✗ the vault is PAUSED/.test(l)));
    assert.ok(paused.lines.some((l) => /✗ the vault would refuse .*MandatePaused/.test(l)), paused.lines.join('\n'));
  });

  it('gas used (Anvil, local token): deploy, deposit, setMandate, payInvoice vs a direct transfer', async (t) => {
    const w = await world();
    const p = pub();
    const viaVault = async (id: string, to: string) => {
      const r = await w.proc().submit({ ...invoice(id, '1'), payTo: to });
      return (await p.getTransactionReceipt({ hash: tx(r) as Hex })).gasUsed;
    };
    const holderVault = await viaVault('GAS-1', VENDOR); // the vault's first payment: the vendor had no tUSD8, the day slot was empty
    const holderVault2 = await viaVault('GAS-2', VENDOR); // steady state: the vendor holds tUSD8, same day
    const op = operator();
    const direct = async (to: string) =>
      (await p.waitForTransactionReceipt({ hash: await op.writeContract({ address: w.token, abi: LOCAL_TEST_USD8_ABI, functionName: 'transfer', args: [getAddress(to), 1_000_000n] }) })).gasUsed;
    const directHolder = await direct(VENDOR);
    const directEmpty = await direct(EMPTY_VENDOR);
    const plan = await planTransfer(w.cfg, AGENT, VENDOR, 1_000_000n, 'GAS-3');
    t.diagnostic(`deploy ${w.gas.deploy} · deposit ${w.gas.deposit} · setMandate ${w.gas.setMandate}`);
    t.diagnostic(`payInvoice: first payment to an empty vendor ${holderVault}, to a vendor holding tUSD8 ${holderVault2}; plan for the next: estimate ${plan.estimatedGas}, limit ${plan.gas}`);
    t.diagnostic(`direct transfer (local token): to a holder ${directHolder}, to an empty address ${directEmpty}; vault overhead ≈ ${holderVault2 - directHolder}`);
    assert.ok(holderVault2 > directHolder);
  });
});
