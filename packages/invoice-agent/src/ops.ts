/**
 * The operator's side. Never needs the agent's key.
 *
 *   npm run ops -- mandate --chain-id N --token 0x… --payer 0x… --vendor-id ID --vendor-name NAME
 *                          --vendor-address 0x… --max-per-invoice 10 --max-per-day 50 [--expires ISO] --by NAME
 *   npm run ops -- status            the mandate, every invoice in the ledger, balances and on-chain transfers
 *   npm run ops -- verify <invoiceId>  checks a receipt against the chain, independently of the agent's answer
 *   npm run ops -- reconcile [<invoiceId>]  brings open rows up to what the chain says (never signs)
 *
 * Environment: INVOICE_RPC_URL, INVOICE_MANDATE, INVOICE_LEDGER (as the agent).
 */
import { getAddress, type Hex } from 'viem';
import { assertNodeChain, balanceOf, publicClientFor, receiptOf, transfersFrom, transfersIn } from './chain.js';
import { loadConfig } from './config.js';
import { describeRule, explorerTx, judgeFinality, ruleFor } from './finality.js';
import { formatUnits6 } from './invoice.js';
import { Ledger } from './ledger.js';
import { saveMandate } from './mandate.js';
import { InvoicePayer } from './payer.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main(): Promise<number> {
  if (cmd === 'mandate') {
    const path = process.env['INVOICE_MANDATE'];
    if (!path) throw new Error('INVOICE_MANDATE is not set');
    const req = (n: string) => {
      const v = flag(n);
      if (!v) throw new Error(`--${n} is required`);
      return v;
    };
    saveMandate(path, {
      chainId: Number(req('chain-id')),
      token: getAddress(req('token')),
      payer: getAddress(req('payer')),
      vendor: { id: req('vendor-id'), name: req('vendor-name'), address: getAddress(req('vendor-address')) },
      maxPerInvoice: req('max-per-invoice'),
      maxPerDay: req('max-per-day'),
      expiresAt: flag('expires') ?? null,
      approvedBy: req('by'),
      approvedAt: new Date().toISOString(),
    });
    console.log(`mandate written to ${path}`);
    return 0;
  }

  const cfg = loadConfig();
  const ledger = new Ledger(cfg.ledgerPath);
  const m = cfg.mandate;
  // The node first: a mandate pointed at the wrong node must not bind a fresh ledger to it.
  await assertNodeChain(cfg.chain);
  ledger.bindContext({ chainId: cfg.chain.chainId, token: m.token, payer: m.payer });

  if (cmd === 'status') {
    console.log(`Mandate (approved by ${m.approvedBy} at ${m.approvedAt}): pay ${m.vendor.name} (${m.vendor.id}) at ${m.vendor.address}, ≤ ${m.maxPerInvoice} tUSD8 per invoice, ≤ ${m.maxPerDay} per day${m.expiresAt ? `, until ${m.expiresAt}` : ''}`);
    console.log(`Chain ${cfg.chain.chainId} · token ${m.token} · payer ${m.payer} · confirmation ${describeRule(ruleFor(cfg.chain))}`);
    for (const r of ledger.all()) {
      const amt = `${formatUnits6(BigInt(r.amount))} tUSD8`.padStart(13);
      console.log(`  ${r.invoice_id.padEnd(10)} ${r.status.padEnd(10)} ${amt} → ${r.pay_to}${r.tx_hash ? `  tx ${r.tx_hash}` : ''}${r.block_number ? ` block ${r.block_number}` : ''}`);
      if (r.reason) console.log(`      reason: ${r.reason}`);
    }
    const [payerBal, vendorBal, sent] = await Promise.all([balanceOf(cfg.chain, m.payer), balanceOf(cfg.chain, m.vendor.address), transfersFrom(cfg.chain, m.payer)]);
    console.log(`On-chain: payer ${formatUnits6(payerBal)} tUSD8 · ${m.vendor.name} ${formatUnits6(vendorBal)} tUSD8 · transfers from the payer: ${sent.length}`);
    for (const t of sent) console.log(`  - block ${t.blockNumber} tx ${t.txHash} → ${t.to} ${formatUnits6(t.value)} tUSD8`);
    return 0;
  }

  if (cmd === 'verify') {
    const id = rest[0];
    const row = id ? ledger.get(id) : undefined;
    if (!row) throw new Error(`unknown invoice ${id}`);
    if (!row.tx_hash) {
      console.log(`${id}: ${row.status}, nothing was signed${row.reason ? ` (${row.reason})` : ''}.`);
      const sentTo = await transfersFrom(cfg.chain, m.payer, row.pay_to);
      console.log(`  transfers from the payer to ${row.pay_to} on-chain: ${sentTo.length}`);
      return 0;
    }
    const receipt = await receiptOf(cfg.chain, row.tx_hash as Hex);
    if (!receipt) {
      console.log(`${id}: NOT on-chain yet (tx ${row.tx_hash}, ledger status ${row.status}). Do not pay again; run reconcile.`);
      return 2;
    }
    const block = await publicClientFor(cfg.chain).getBlock({ blockNumber: receipt.blockNumber });
    const match = transfersIn(cfg.chain, receipt).filter((t) => t.from === m.payer && t.to === getAddress(row.pay_to) && t.value === BigInt(row.amount));
    const all = await transfersFrom(cfg.chain, m.payer, row.pay_to);
    // The chain is the judge, not the agent's ledger: every transfer to this payee must belong to exactly one paid invoice.
    const paidRows = ledger.all().filter((r) => r.pay_to.toLowerCase() === row.pay_to.toLowerCase() && r.tx_hash && r.status !== 'refused');
    const known = new Set(paidRows.map((r) => r.tx_hash!.toLowerCase()));
    const unexplained = all.filter((t) => !known.has(t.txHash.toLowerCase()));
    const sameAsLedger = !['confirmed', 'included'].includes(row.status) || (row.block_number === receipt.blockNumber.toString() && row.log_index === match[0]?.logIndex);
    const fin = await judgeFinality(cfg.chain, receipt);
    const onChainOk = receipt.status === 'success' && match.length === 1 && sameAsLedger && unexplained.length === 0;
    const ok = onChainOk && fin.final;
    const notFinal = onChainOk && !fin.final;
    console.log(`${id}: ${ok ? 'VERIFIED' : notFinal ? 'IN A BLOCK, NOT CONFIRMED YET' : 'NOT VERIFIED'} on chain ${cfg.chain.chainId}`);
    console.log(`  tx ${row.tx_hash} · block ${receipt.blockNumber} (${new Date(Number(block.timestamp) * 1000).toISOString()}) · status ${receipt.status}`);
    console.log(`  confirmation rule ${describeRule(ruleFor(cfg.chain))}: ${fin.detail}${fin.final ? ' → met' : ' → not met: do not treat it as paid yet, do not pay again; run verify again later'}`);
    const link = explorerTx(cfg.chain, row.tx_hash);
    if (link) console.log(`  explorer: ${link}`);
    console.log(`  Transfer ${m.payer} → ${row.pay_to}: ${match.map((t) => `${formatUnits6(t.value)} tUSD8 (log ${t.logIndex})`).join(', ') || 'none matching'}`);
    if (!sameAsLedger) console.log(`  the ledger says block ${row.block_number} log ${row.log_index}; the chain says block ${receipt.blockNumber} log ${match[0]?.logIndex ?? '-'}`);
    console.log(`  all transfers from the payer to this payee: ${all.length} (${all.map((t) => formatUnits6(t.value)).join(' + ') || '-'} tUSD8), each matched to one invoice: ${unexplained.length === 0 ? 'yes' : `NO, ${unexplained.length} unexplained: ${unexplained.map((t) => t.txHash).join(', ')}`}`);
    return ok ? 0 : notFinal ? 2 : 1;
  }

  if (cmd === 'reconcile') {
    const payer = new InvoicePayer({ ledger, chain: cfg.chain, mandate: m });
    const rows = rest[0] ? [ledger.get(rest[0])].filter((r) => r !== undefined) : ledger.all();
    for (const r of rows) {
      const after = await payer.reconcile(r!);
      console.log(`  ${after.invoice_id} ${r!.status} → ${after.status}${after.tx_hash ? ` (tx ${after.tx_hash})` : ''}`);
    }
    return 0;
  }

  if (cmd === 'resolve') {
    // Only for a STUCK invoice, after the operator looked up the payer's transaction at that nonce.
    const id = rest[0];
    const by = flag('by'), note = flag('note');
    if (!id || !rest.includes('--not-paid') || !by || !note) {
      console.log('usage: npm run ops -- resolve <invoiceId> --not-paid --by NAME --note "what you checked (explorer link, tx at that nonce)"');
      return 2;
    }
    const row = ledger.get(id);
    if (!row || row.status !== 'stuck') {
      console.log(`${id}: only a stuck invoice can be resolved (status: ${row?.status ?? 'unknown'}). Run reconcile first.`);
      return 1;
    }
    // Last look before writing: if our transaction has appeared since, it WAS paid.
    const receipt = await receiptOf(cfg.chain, row.tx_hash as Hex);
    if (receipt) {
      console.log(`${id}: transaction ${row.tx_hash} is on-chain now (block ${receipt.blockNumber}): not resolved; run reconcile.`);
      return 1;
    }
    ledger.resolveStuckAsNotPaid(id, by, note);
    console.log(`${id}: resolved as NOT paid by ${by}.`);
    return 0;
  }

  console.log('usage: npm run ops -- <mandate|status|verify <invoiceId>|reconcile [<invoiceId>]|resolve <invoiceId> --not-paid --by NAME --note TEXT>');
  return 2;
}

// exitCode, not process.exit(): exiting with HTTP keep-alive sockets open trips a libuv assertion on Windows.
main().then((code) => {
  process.exitCode = code;
}, (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
