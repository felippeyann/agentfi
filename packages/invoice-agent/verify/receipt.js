// A portable receipt for one settled invoice, and the read-only check a payee's system runs before it marks its own
// invoice as paid. No dependencies, no wallet, no key: the same file runs in the browser (the page's "Download
// receipt") and in Node (the accounts-payable example, the CLI).
//
// The receipt is a CLAIM, never a proof by itself. checkReceipt decides only from:
//   1. what the consumer EXPECTS, taken from its own records (network, vault, token, invoice id, vendor, payee,
//      amount): never from the receipt;
//   2. the chain, read through verifyInvoice (verify.js) for the consumer's expected vault and invoice: settlementOf,
//      the InvoiceSettled event, exactly one token Transfer vault → payee in the same transaction, a canonical block
//      at or below the node's finalized block.
// The receipt only has to agree with both. A valid receipt for another invoice or another vault is "divergent".

import { isAddress, units6, verifyInvoice } from './verify.js';

export const RECEIPT_FORMAT = 'agentfi.invoice-receipt';
export const RECEIPT_VERSION = 1;

const lower = (a) => String(a).toLowerCase();
const isHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
const isUnits = (u) => typeof u === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(u);
const isIndex = (n) => Number.isSafeInteger(n) && n >= 0;
const INVOICE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const VENDOR_ID = /^[\x21-\x7e]{1,32}$/;

/**
 * The receipt for a verdict that is paid_verified. Every field comes from the chain as verifyInvoice read it; the
 * payee is the one in the payment's own InvoiceSettled event (and its Transfer), not the vault's current mandate, so a
 * later change of the mandate does not change the receipt.
 */
export function buildReceipt(v, { rpcUrl, issuedAt = new Date().toISOString() } = {}) {
  if (!v || v.state !== 'paid_verified' || !v.event || !v.transfer || !v.settlement || !v.finality) {
    throw new Error(`a receipt needs a paid_verified verdict; this one is ${v?.state ?? 'missing'}`);
  }
  const e = v.event, t = v.transfer, s = v.settlement, f = v.finality;
  return {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    note: 'A claim, not a proof: check it against your own invoice record and the chain (checkReceipt, read-only) before marking the invoice paid.',
    network: { chainId: v.chainId, caip2: `eip155:${v.chainId}` },
    vault: v.vault,
    token: t.token,
    invoice: { id: e.invoiceId, vendorId: e.vendor, vendorBytes32: e.vendorRaw, invoiceKey: s.invoiceKey },
    payee: e.payTo,
    amount: { units: e.amountUnits, decimals: 6, display: units6(BigInt(e.amountUnits)) },
    payment: {
      txHash: e.txHash,
      blockNumber: f.block,
      blockHash: f.blockHash,
      blockTime: f.blockTime,
      agent: s.agent,
      events: [
        { name: 'InvoiceSettled', address: v.vault, logIndex: e.logIndex },
        { name: 'Transfer', address: t.token, logIndex: t.logIndex, from: t.from, to: t.to, value: e.amountUnits },
      ],
    },
    finality: { rule: 'finalized', finalizedBlockAtIssue: f.finalizedBlock },
    issued: { at: issuedAt, by: 'AgentFi invoice verification (read-only)', ...(rpcUrl ? { rpc: rpcUrl } : {}) },
    ...(v.explorer ? { explorer: v.explorer } : {}),
  };
}

/** The receipt's identity on chain: one payment, whatever invoice record it is delivered against. */
export function settlementId(r) {
  return `eip155:${r.network.chainId}:${lower(r.vault)}:${lower(r.invoice.invoiceKey)}`;
}

/** Shape check of a parsed receipt. `{ ok, problems }`; nothing here is read from the chain. */
export function validateReceipt(r) {
  const p = [];
  if (!r || typeof r !== 'object') return { ok: false, problems: ['not a JSON object'] };
  if (r.format !== RECEIPT_FORMAT) p.push(`format is not "${RECEIPT_FORMAT}"`);
  if (r.version !== RECEIPT_VERSION) p.push(`version ${JSON.stringify(r.version)} is not ${RECEIPT_VERSION}`);
  if (!Number.isSafeInteger(r.network?.chainId) || r.network.chainId <= 0) p.push('network.chainId');
  if (!isAddress(r.vault)) p.push('vault');
  if (!isAddress(r.token)) p.push('token');
  if (!INVOICE_ID.test(r.invoice?.id ?? '')) p.push('invoice.id');
  if (!VENDOR_ID.test(r.invoice?.vendorId ?? '')) p.push('invoice.vendorId');
  if (!isHash(r.invoice?.invoiceKey)) p.push('invoice.invoiceKey');
  if (!isAddress(r.payee)) p.push('payee');
  if (!isUnits(r.amount?.units)) p.push('amount.units (a decimal string of base units)');
  if (!isHash(r.payment?.txHash)) p.push('payment.txHash');
  if (!isIndex(r.payment?.blockNumber)) p.push('payment.blockNumber');
  if (!isHash(r.payment?.blockHash)) p.push('payment.blockHash');
  // Exactly the two events, each an object with a name and a log index: no null or extra entries, no duplicates.
  const ev = Array.isArray(r.payment?.events) ? r.payment.events : [];
  if (ev.length !== 2 || ev.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) p.push('payment.events (exactly two event objects)');
  const named = (name) => ev.filter((x) => x && typeof x === 'object' && x.name === name);
  const settled = named('InvoiceSettled'), transfer = named('Transfer');
  if (settled.length !== 1 || !isIndex(settled[0].logIndex)) p.push('payment.events InvoiceSettled.logIndex');
  if (transfer.length !== 1 || !isIndex(transfer[0].logIndex)) p.push('payment.events Transfer.logIndex');
  return { ok: p.length === 0, problems: p };
}

/** Shape check of the consumer's expectation (its own record of the invoice). */
export function validateExpected(x) {
  const p = [];
  if (!x || typeof x !== 'object') return { ok: false, problems: ['not an object'] };
  if (!Number.isSafeInteger(x.chainId) || x.chainId <= 0) p.push('chainId');
  if (!isAddress(x.vault)) p.push('vault');
  if (!isAddress(x.token)) p.push('token');
  if (!INVOICE_ID.test(x.invoiceId ?? '')) p.push('invoiceId');
  if (!VENDOR_ID.test(x.vendorId ?? '')) p.push('vendorId');
  if (!isAddress(x.payee)) p.push('payee');
  if (!isUnits(x.amountUnits)) p.push('amountUnits');
  return { ok: p.length === 0, problems: p };
}

/** What the receipt claims against what the consumer expects. Each entry: { field, expected, receipt }. */
export function compareClaims(r, x) {
  return [
    ['network.chainId', x.chainId, r.network.chainId, (a, b) => a === b],
    ['vault', x.vault, r.vault],
    ['token', x.token, r.token],
    ['invoice.id', x.invoiceId, r.invoice.id, (a, b) => a === b],
    ['invoice.vendorId', x.vendorId, r.invoice.vendorId, (a, b) => a === b],
    ['payee', x.payee, r.payee],
    ['amount.units', x.amountUnits, r.amount.units, (a, b) => a === b],
  ].filter(([, a, b, eq = (m, n) => lower(m) === lower(n)]) => !eq(a, b)).map(([field, expected, receipt]) => ({ field, expected, receipt }));
}

const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);

/**
 * Your vault, on this node, has no settlement of your invoice. That alone does not tell a receipt that is false from a
 * node that has not seen the payment yet, so the node is asked about the receipt's OWN transaction and block:
 *   - the node knows the transaction: its block is a fact. A block (or block hash) other than the receipt's is a
 *     proven divergence (mismatch); the declared block, with no settlement of your invoice, is proven not_paid;
 *   - the node does not know it, but has the declared block height: a block hash other than the receipt's is a proven
 *     divergence (mismatch); the same hash without the transaction is a node that cannot answer (inconclusive);
 *   - the node does not know it and is below the declared block: it may be behind (a genuine receipt) or the receipt
 *     may name a transaction that does not exist (a forged one, e.g. a block in the future). One source cannot tell
 *     these apart: inconclusive, with that uncertainty spelled out. The height difference alone never rejects.
 */
async function evidenceForUnsettled(rpc, r, v, { bad, done }) {
  const D = r.payment.blockNumber, T = r.payment.txHash;
  const none = `your vault has no settlement of "${v.invoiceId}" on this node`;
  let txr, head;
  try {
    [txr, head] = await Promise.all([rpc('eth_getTransactionReceipt', [T]), rpc('eth_blockNumber').then((h) => Number(BigInt(h)))]);
  } catch (e) {
    return done('inconclusive', `Inconclusive: ${none}, and the node did not answer about the receipt's transaction (${short(e)}). Nothing is concluded.`, { verdict: v, evidence: 'unavailable' });
  }
  if (txr) {
    const b = Number(BigInt(txr.blockNumber));
    if (b !== D || lower(txr.blockHash) !== lower(r.payment.blockHash)) {
      bad(`transaction ${T} is in block ${b} (${txr.blockHash}) on this node, not in block ${D} (${r.payment.blockHash}) as the receipt says`);
      return done('mismatch', `Proven divergence: transaction ${T} is in block ${b} on this chain, not in block ${D} as the receipt says, and ${none}. Do not mark the invoice paid with this file.`, { verdict: v, evidence: 'transaction', chainTx: { blockNumber: b, blockHash: txr.blockHash, status: txr.status } });
    }
    bad(`transaction ${T} is in block ${D} as declared, but did not settle your invoice in your vault`);
    return done('not_paid', `The chain does not back this receipt: transaction ${T} exists in block ${D} as declared, but ${none} (status ${txr.status}). It is not the payment of this invoice.`, { verdict: v, evidence: 'transaction' });
  }
  if (head >= D) {
    let blk;
    try {
      blk = await rpc('eth_getBlockByNumber', ['0x' + D.toString(16), false]);
    } catch (e) {
      return done('inconclusive', `Inconclusive: ${none}, the node does not know transaction ${T}, and it did not return block ${D} (${short(e)}). Nothing is concluded.`, { verdict: v, evidence: 'unavailable' });
    }
    if (blk?.hash && lower(blk.hash) !== lower(r.payment.blockHash)) {
      bad(`block ${D} on this chain is ${blk.hash}, not the receipt's ${r.payment.blockHash}`);
      return done('mismatch', `Proven divergence: block ${D} on this chain is ${blk.hash}, not ${r.payment.blockHash} as the receipt says; the node does not know transaction ${T} and ${none}. Do not mark the invoice paid with this file.`, { verdict: v, evidence: 'block' });
    }
    bad(`the node has block ${D} but neither transaction ${T} nor a settlement of your invoice`);
    return done('inconclusive', `Inconclusive: the node has block ${D}${blk?.hash ? ' with the receipt\'s block hash' : ''} but does not return transaction ${T}, and ${none}. This node cannot answer; nothing is concluded. Check with another RPC.`, { verdict: v, evidence: 'unavailable' });
  }
  bad(`the node is at block ${head}, below the receipt's block ${D}, and does not know transaction ${T}`);
  return done('inconclusive', `Inconclusive: this node is at block ${head}, below the receipt's block ${D}, does not know transaction ${T}, and ${none}. From this one source a node that is behind (a genuine receipt) cannot be told apart from a receipt naming a transaction that does not exist (a forged one). Nothing is concluded: keep the invoice open and check with another RPC, or later.`, { verdict: v, evidence: 'unavailable', uncertainty: 'node_behind_or_receipt_invalid' });
}

/**
 * Can the consumer mark its invoice as paid with this receipt? Read-only.
 *   settle        the chain shows exactly the expected payment, finalized, and the receipt describes that payment
 *   divergent     the receipt (or the payment on chain) is for another invoice, vault, token, payee or amount
 *   not_paid      the expected vault has no settlement of the expected invoice: the receipt is not backed by the chain
 *   mismatch      the chain's records disagree with each other, or the receipt names another transaction or event
 *   pending       paid, not finalized yet: ask again later
 *   inconclusive  the chain could not be read (or answered for another chain): nothing concluded, retry
 *   invalid       the receipt or the expectation is malformed
 * `decision` is 'settle' only for settle; 'retry' for pending and inconclusive; 'reject' otherwise. `conclusive` is
 * false exactly for 'retry': the chain gave no evidence either way (a reject always rests on evidence: a difference with
 * your record, or a fact the node reports). Whether and when to check again is the CALLER's policy (the
 * accounts-payable example caps the attempts and then parks the delivery for a person); this function never loops.
 *
 * @param {{ rpc: (m: string, p?: unknown[]) => Promise<any>, receipt: any, expected: any }} o
 */
export async function checkReceipt(o) {
  const checks = [];
  const ok = (what) => checks.push({ ok: true, what });
  const bad = (what) => checks.push({ ok: false, what });
  const done = (state, answer, extra = {}) => {
    const decision = state === 'settle' ? 'settle' : state === 'pending' || state === 'inconclusive' ? 'retry' : 'reject';
    return { state, decision, conclusive: decision !== 'retry', answer, checks, ...extra };
  };

  const ex = validateExpected(o.expected);
  if (!ex.ok) return done('invalid', `The expected invoice record is incomplete or malformed: ${ex.problems.join(', ')}.`);
  const rv = validateReceipt(o.receipt);
  if (!rv.ok) return done('invalid', `The receipt is malformed: ${rv.problems.join(', ')}.`);
  const r = o.receipt, x = o.expected;
  ok(`receipt format ${RECEIPT_FORMAT} v${RECEIPT_VERSION}`);

  const differences = compareClaims(r, x);
  if (differences.length) {
    bad(`receipt differs from the expected record: ${differences.map((d) => d.field).join(', ')}`);
    return done('divergent', `This receipt is not for the expected invoice: ${differences.map((d) => `${d.field} is ${d.receipt}, expected ${d.expected}`).join('; ')}. Do not mark the invoice paid with it.`, { differences, source: 'receipt' });
  }
  ok('receipt matches the expected record (network, vault, token, invoice, vendor, payee, amount)');

  // The chain, read for the EXPECTED vault and invoice (never for the receipt's).
  const v = await verifyInvoice({ rpc: o.rpc, vault: x.vault, invoiceId: x.invoiceId, vendorId: x.vendorId, chainId: x.chainId });
  for (const c of v.checks) checks.push(c);
  const why = v.answer;
  if (v.state === 'cannot_verify_now') return done('inconclusive', `Inconclusive: ${why} Nothing is concluded; try again.`, { verdict: v });
  if (v.state === 'pending') return done('pending', `${why} Try again later.`, { verdict: v });
  if (v.state === 'unknown_invoice' || v.state === 'failed') return evidenceForUnsettled(o.rpc, r, v, { bad, done });
  if (v.state !== 'paid_verified') return done('mismatch', `The chain's records disagree: ${why}`, { verdict: v });

  // The payment on chain against the expected record (the vault settled this id, but was it this payment?).
  const onChain = [
    ['token', x.token, v.transfer.token],
    ['payee', x.payee, v.event.payTo],
    ['amount.units', x.amountUnits, v.event.amountUnits],
    ['invoice.vendorId', x.vendorId, v.event.vendor],
  ].filter(([, a, b]) => lower(a) !== lower(b)).map(([field, expected, chain]) => ({ field, expected, chain }));
  if (onChain.length) {
    bad(`the settlement on chain differs from the expected record: ${onChain.map((d) => d.field).join(', ')}`);
    return done('divergent', `The vault settled "${x.invoiceId}", but not as expected: ${onChain.map((d) => `${d.field} is ${d.chain} on chain, expected ${d.expected}`).join('; ')}. Do not mark the invoice paid; ask the payer.`, { differences: onChain, source: 'chain', verdict: v });
  }
  ok('the settlement on chain matches the expected record');

  // The receipt against the payment on chain.
  const settledEv = r.payment.events.find((e) => e?.name === 'InvoiceSettled');
  const transferEv = r.payment.events.find((e) => e?.name === 'Transfer');
  const vsChain = [
    lower(r.payment.txHash) !== lower(v.event.txHash) && `transaction ${r.payment.txHash}, on chain ${v.event.txHash}`,
    r.payment.blockNumber !== v.finality.block && `block ${r.payment.blockNumber}, on chain ${v.finality.block}`,
    lower(r.payment.blockHash) !== lower(v.finality.blockHash) && `block hash ${r.payment.blockHash}, on chain ${v.finality.blockHash}`,
    lower(r.invoice.invoiceKey) !== lower(v.settlement.invoiceKey) && `invoice key ${r.invoice.invoiceKey}, on chain ${v.settlement.invoiceKey}`,
    settledEv.logIndex !== v.event.logIndex && `InvoiceSettled log ${settledEv.logIndex}, on chain ${v.event.logIndex}`,
    transferEv.logIndex !== v.transfer.logIndex && `Transfer log ${transferEv.logIndex}, on chain ${v.transfer.logIndex}`,
  ].filter(Boolean);
  if (vsChain.length) {
    bad(`the receipt does not describe the payment on chain: ${vsChain.join('; ')}`);
    return done('mismatch', `The receipt does not describe the payment on chain (${vsChain.join('; ')}). Do not settle with this file; get a fresh receipt.`, { verdict: v });
  }
  ok(`the receipt names the payment on chain: tx ${v.event.txHash}, block ${v.finality.block}, InvoiceSettled log ${v.event.logIndex}, Transfer log ${v.transfer.logIndex}`);

  return done('settle', `Paid: ${units6(BigInt(x.amountUnits))} to ${v.event.payTo} for "${x.invoiceId}" in transaction ${v.event.txHash}, block ${v.finality.block}, finalized (finalized block ${v.finality.finalizedBlock}). The invoice can be marked paid.`, {
    settlementId: settlementId(r),
    proof: { txHash: v.event.txHash, blockNumber: v.finality.block, blockHash: v.finality.blockHash, finalizedBlock: v.finality.finalizedBlock },
    verdict: v,
  });
}

