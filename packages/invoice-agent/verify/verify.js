// "Was this invoice paid?" read straight from the chain, in the browser: the InvoiceMandate vault's settlementOf,
// its InvoiceSettled event, the tUSD8 Transfer in the same transaction and the node's finalized block.
// READ-ONLY: plain JSON-RPC reads (eth_chainId, eth_getCode, eth_call, eth_getLogs, eth_getTransactionReceipt,
// eth_getBlockByNumber, eth_getTransactionByHash). No wallet, no key, no signing, nothing is sent. The "simulate a
// resend" check (simulateResend, at the end) is one more eth_call: the same payInvoice, simulated, never sent.
// No dependencies: the few ABI encodings and decodings it needs are written out below (their selectors and topics
// are checked against the contract's ABI by test/verify-page.test.ts).

export const DEFAULTS = Object.freeze({
  rpcUrl: 'https://rpc-test.qday.info',
  chainId: 44005,
  explorerUrl: 'https://explorer-test.qday.info',
  tUSD8: '0x456569838f1d43009A91ebA4263147Afd7233483',
});

export const SELECTORS = Object.freeze({
  settlementOf: '0x03c09e95', // settlementOf(string,bytes32)
  findSettlement: '0x143f47e1', // findSettlement(string)
  mandate: '0x39b1b96d', // mandate()
  token: '0xfc0c546a', // token()
  operator: '0x570ca735', // operator()
  payInvoice: '0x3a765838', // payInvoice(string,bytes32,address,uint256)
});
// The vault's custom errors that payInvoice can revert with (selector → name and argument types), for the
// "simulate a resend" check below. Checked against the ABI by the tests like the selectors above.
export const ERRORS = Object.freeze({
  '0x6fd708b6': { name: 'AlreadySettled', args: ['bytes32', 'uint256'] }, // AlreadySettled(bytes32 invoiceKey, uint256 blockNumber)
  '0x27267dfd': { name: 'MandateExpired', args: [] },
  '0x0d9ab13f': { name: 'NotAgent', args: [] },
  '0x089ee7df': { name: 'MandatePaused', args: [] },
  '0x4061a3da': { name: 'MandateChanged', args: ['bytes32', 'address'] }, // (vendor, payTo) the mandate has now
  '0x72fabe82': { name: 'AboveInvoiceCap', args: ['uint256', 'uint256'] }, // (amount, cap)
  '0xd440abf0': { name: 'AboveDailyLimit', args: ['uint256', 'uint256', 'uint256'] }, // (spentToday, amount, limit)
  '0x2611416a': { name: 'NoAgent', args: [] },
  '0x15a6bc43': { name: 'InvalidInvoiceId', args: [] },
  '0x1f2a2005': { name: 'ZeroAmount', args: [] },
  '0x90b8ec18': { name: 'TransferFailed', args: [] },
});
export const TOPICS = Object.freeze({
  // InvoiceSettled(bytes32,string,bytes32,address,uint256,address)
  invoiceSettled: '0x779f9c49d33123992aaa121c55042eb55d00b9b18051ae559ed542e9cedb6d2b',
  // Transfer(address,address,uint256)
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
});

const DO_NOT_PAY = 'Do NOT pay this invoice again, under this id or another, before the original transaction is checked.';

const strip = (h) => h.replace(/^0x/, '');
const word = (hex, i) => strip(hex).slice(i * 64, (i + 1) * 64);
const wordInt = (hex, i) => BigInt('0x' + (word(hex, i) || '0'));
const wordAddr = (hex, i) => '0x' + word(hex, i).slice(24);
const lower = (a) => String(a).toLowerCase();

export function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** UTF-8 bytes of a string as hex. */
function utf8Hex(s) {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** ABI encoding of one `string` argument (offset, length, padded bytes). */
export function encodeStringArg(s) {
  const data = utf8Hex(s);
  const len = (data.length / 2).toString(16).padStart(64, '0');
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return '0'.repeat(62) + '20' + len + padded;
}

/** ABI encoding of (string, bytes32): offset 0x40, the bytes32, then the string. */
export function encodeStringAndBytes32(s, b32) {
  const tail = encodeStringArg(s).slice(64); // length + padded bytes
  return '0'.repeat(62) + '40' + strip(b32).padEnd(64, '0') + tail;
}

/** A vendor id as the vault stores it: its ASCII bytes left-aligned in a bytes32. */
export function vendorBytes32(id) {
  return '0x' + utf8Hex(id).padEnd(64, '0');
}

/** Decodes an ABI string at byte offset `offset` (in a hex blob without 0x). */
function decodeStringAt(body, offset) {
  const len = Number(BigInt('0x' + body.slice(offset * 2, offset * 2 + 64)));
  const bytes = body.slice(offset * 2 + 64, offset * 2 + 64 + len * 2);
  return new TextDecoder().decode(new Uint8Array(bytes.match(/../g)?.map((b) => parseInt(b, 16)) ?? []));
}

/** "acme" from bytes32 0x61636d65…00 (the vault's vendor id). */
export function bytes32ToAscii(h) {
  const bytes = strip(h).match(/../g) ?? [];
  return bytes.map((b) => parseInt(b, 16)).filter((c) => c !== 0).map((c) => String.fromCharCode(c)).join('');
}

/** 8500000n → "8.5" (6 decimals). */
export function units6(v) {
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** A JSON-RPC client over fetch. Every failure (transport, HTTP, RPC error) is thrown: never read as an answer. */
export function rpcClient(url, fetchImpl = globalThis.fetch) {
  let id = 0;
  return async (method, params = []) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) {
      const err = new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
      // A revert (eth_call): the node gives the revert data next to the message. Kept as data, never shown as markup.
      err.rpcCode = j.error.code;
      err.rpcData = j.error.data;
      throw err;
    }
    return j.result;
  };
}

// Every view this file calls returns at least one 32-byte word. An empty answer ("0x") from a contract that has code is
// a node problem (not synced, a broken proxy), not "not settled": it is thrown, so it ends in cannot_verify_now.
const call = async (rpc, to, data) => {
  const r = await rpc('eth_call', [{ to, data }, 'latest']);
  if (typeof r !== 'string' || strip(r).length < 64) throw new Error(`eth_call returned no data (${String(r).slice(0, 20)}): the node may not be synced`);
  return r;
};

/**
 * The verdict for one invoice id of one vault. States (the same names as the agent's MCP `invoice_status`):
 *   paid_verified      settled by the vault, the event and the Transfer agree, and the block is finalized and canonical
 *   pending            settled in a block that is not finalized yet; or (with a tx hash) sent and not in a block yet
 *   failed             (with a tx hash) mined but reverted: no tokens moved for it
 *   unknown_invoice    the vault has no settlement for this id (it was not paid through this vault)
 *   mismatch           the vault's record, its event and the transfer disagree
 *   cannot_verify_now  the chain could not be read, or it is not the expected chain, or there is no vault there
 *
 * @param {{ rpc: (m: string, p?: unknown[]) => Promise<any>, vault: string, invoiceId: string, vendorId?: string, chainId?: number, explorerUrl?: string, txHash?: string }} o
 */
export async function verifyInvoice(o) {
  const out = { invoiceId: o.invoiceId, vault: o.vault, checks: [] };
  const ok = (what) => out.checks.push({ ok: true, what });
  const bad = (what) => out.checks.push({ ok: false, what });
  const explorerTx = (h) => (o.explorerUrl ? `${o.explorerUrl.replace(/\/$/, '')}/tx/${h}` : undefined);
  const done = (state, answer, next) => ({ ...out, state, answer, next });
  if (!isAddress(o.vault)) return done('cannot_verify_now', 'The vault address is not an address.', 'Paste the vault address (0x… 40 hex characters).');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.invoiceId ?? '')) return done('cannot_verify_now', 'The invoice id must be 1–64 letters, digits, ".", "_" or "-", exactly as written.', 'Type the invoice id exactly (case-sensitive).');
  try {
    const chainId = Number(BigInt(await o.rpc('eth_chainId')));
    out.chainId = chainId;
    if (o.chainId !== undefined && chainId !== o.chainId) {
      return done('cannot_verify_now', `The node serves chain ${chainId}, not ${o.chainId}: nothing is concluded against the wrong chain.`, 'Use the RPC of the expected chain.');
    }
    ok(`node serves chain ${chainId}`);
    if (strip(await o.rpc('eth_getCode', [o.vault, 'latest'])).length === 0) {
      return done('cannot_verify_now', `There is no contract at ${o.vault} on chain ${chainId}.`, 'Check the vault address and the network.');
    }
    const [tokenRaw, operatorRaw, m] = await Promise.all([call(o.rpc, o.vault, SELECTORS.token), call(o.rpc, o.vault, SELECTORS.operator), call(o.rpc, o.vault, SELECTORS.mandate)]);
    out.mandate = {
      token: wordAddr(tokenRaw, 0), operator: wordAddr(operatorRaw, 0),
      agent: wordAddr(m, 0), expiresAt: Number(wordInt(m, 1)), paused: wordInt(m, 2) === 1n, payTo: wordAddr(m, 3),
      maxPerInvoice: units6(wordInt(m, 4)), maxPerDay: units6(wordInt(m, 5)), vendor: bytes32ToAscii('0x' + word(m, 6)),
    };
    if (chainId === DEFAULTS.chainId && lower(out.mandate.token) !== lower(DEFAULTS.tUSD8)) {
      // Stop here: every later check would match transfers of THAT token and could announce a tUSD8 payment that is not one.
      bad(`the vault's token ${out.mandate.token} is NOT the official tUSD8 ${DEFAULTS.tUSD8}`);
      return done('mismatch', `This vault holds ${out.mandate.token}, not the official tUSD8 (${DEFAULTS.tUSD8}): nothing it settles is a tUSD8 payment.`, DO_NOT_PAY + ' Check the vault address; the operator inspects this vault.');
    }
    // With a vendor id: settlementOf(id, vendor). Without one, or when that vendor has none: findSettlement(id), which
    // looks the id up for EVERY vendor the vault has had, so "not settled" is never an artefact of a vendor change.
    const fromFind = async () => {
      const f = await call(o.rpc, o.vault, SELECTORS.findSettlement + encodeStringArg(o.invoiceId));
      return { settled: wordInt(f, 0) === 1n, vendor: bytes32ToAscii('0x' + word(f, 1)), amount: units6(wordInt(f, 2)), amountUnits: wordInt(f, 2).toString(), blockNumber: Number(wordInt(f, 3)), agent: wordAddr(f, 4), invoiceKey: '0x' + word(f, 5) };
    };
    if (o.vendorId) {
      if (!/^[\x21-\x7e]{1,32}$/.test(o.vendorId)) return done('cannot_verify_now', 'The vendor id must be 1–32 printable ASCII characters, as the vault names it.', 'Leave it empty to search every vendor of the vault.');
      const s = await call(o.rpc, o.vault, SELECTORS.settlementOf + encodeStringAndBytes32(o.invoiceId, vendorBytes32(o.vendorId)));
      out.settlement = { settled: wordInt(s, 0) === 1n, vendor: o.vendorId, amount: units6(wordInt(s, 1)), amountUnits: wordInt(s, 1).toString(), blockNumber: Number(wordInt(s, 2)), agent: wordAddr(s, 3), invoiceKey: '0x' + word(s, 4) };
      if (!out.settlement.settled) {
        const any = await fromFind();
        if (any.settled) {
          out.otherVendorSettlement = any;
          return done('unknown_invoice', `No settlement of "${o.invoiceId}" for vendor "${o.vendorId}", but the vault HAS one under the same id for vendor "${any.vendor}" (${any.amount} tUSD8, block ${any.blockNumber}).`, DO_NOT_PAY + ' Check which vendor this invoice belongs to (leave the vendor empty to see that settlement).');
        }
      }
    } else {
      out.settlement = await fromFind();
    }

    if (!out.settlement.settled) {
      if (o.txHash) {
        const r = await o.rpc('eth_getTransactionReceipt', [o.txHash]);
        if (r && r.status !== '0x1') return done('failed', `Not paid: transaction ${o.txHash} was mined in block ${Number(BigInt(r.blockNumber))} but reverted; the vault has no settlement for ${o.invoiceId}.`, 'No tokens moved for it. The operator decides; a new payment needs a new decision.');
        if (!r && (await o.rpc('eth_getTransactionByHash', [o.txHash]))) {
          out.explorer = explorerTx(o.txHash);
          return done('pending', `Pending: transaction ${o.txHash} is known to the node but not in a block yet; the vault has not settled ${o.invoiceId}.`, DO_NOT_PAY + ' Ask again later.');
        }
      }
      return done('unknown_invoice', `The vault has NO settlement for invoice "${o.invoiceId}" ${o.vendorId ? `for vendor "${o.vendorId}" nor ` : ''}under any vendor it has had: it was not paid through this vault.`, 'Check the id exactly as written (case-sensitive) and the vault. A payment still in the mempool is not settled yet: if one was sent, ask again later (or give its transaction hash) before paying.');
    }
    ok(`settlement (vendor "${out.settlement.vendor}"): settled, ${out.settlement.amount} tUSD8, block ${out.settlement.blockNumber}, agent ${out.settlement.agent}`);

    const block = '0x' + out.settlement.blockNumber.toString(16);
    const logs = await o.rpc('eth_getLogs', [{ address: o.vault, topics: [TOPICS.invoiceSettled, out.settlement.invoiceKey], fromBlock: block, toBlock: block }]);
    const log = logs[0];
    if (!log) {
      // The vault emits InvoiceSettled in the same call that records the settlement: a node that reports the record but
      // not the event is lagging (or limits eth_getLogs). Nothing is concluded from it.
      bad('no InvoiceSettled event at that block on this node');
      return done('cannot_verify_now', `The vault says ${o.invoiceId} is settled in block ${out.settlement.blockNumber}, but this node returns no InvoiceSettled event for it there: its logs may lag. Nothing is concluded.`, DO_NOT_PAY + ' Ask again later, or use another RPC.');
    }
    const body = strip(log.data);
    const ev = {
      txHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), blockNumber: Number(BigInt(log.blockNumber)),
      invoiceId: decodeStringAt(body, Number(wordInt(log.data, 0))), amountUnits: wordInt(log.data, 1).toString(), agent: wordAddr(log.data, 2),
      vendor: bytes32ToAscii(log.topics[2]), vendorRaw: log.topics[2], payTo: '0x' + strip(log.topics[3]).slice(24),
    };
    out.event = ev;
    out.explorer = explorerTx(ev.txHash);
    const evProblems = [
      ev.invoiceId !== o.invoiceId && `the event is for "${ev.invoiceId}"`,
      ev.amountUnits !== out.settlement.amountUnits && 'amount differs from settlementOf',
      lower(ev.agent) !== lower(out.settlement.agent) && 'agent differs from settlementOf',
      ev.vendor !== out.settlement.vendor && `the event's vendor "${ev.vendor}" differs from the settlement's "${out.settlement.vendor}"`,
    ].filter(Boolean);
    if (evProblems.length) {
      bad(`InvoiceSettled: ${evProblems.join(', ')}`);
      return done('mismatch', `The vault's record and its event disagree for ${o.invoiceId}: ${evProblems.join(', ')}.`, DO_NOT_PAY);
    }
    ok(`InvoiceSettled in tx ${ev.txHash} (log ${ev.logIndex}): ${units6(BigInt(ev.amountUnits))} tUSD8 to ${ev.payTo}`);

    const receipt = await o.rpc('eth_getTransactionReceipt', [ev.txHash]);
    if (!receipt) {
      // The node just returned this transaction's log: no receipt for it is a node problem, not a verdict.
      bad('the node returns no receipt for the settling transaction');
      return done('cannot_verify_now', `This node returns no receipt for the settling transaction ${ev.txHash}, whose event it just returned. Nothing is concluded.`, DO_NOT_PAY + ' Ask again later, or use another RPC.');
    }
    if (receipt.status !== '0x1') {
      bad('the settling transaction has no successful receipt');
      return done('mismatch', `The settling transaction ${ev.txHash} has no successful receipt on this node.`, DO_NOT_PAY);
    }
    const transfers = receipt.logs.filter((l) => lower(l.address) === lower(out.mandate.token) && l.topics[0] === TOPICS.transfer
      && lower('0x' + strip(l.topics[1]).slice(24)) === lower(o.vault) && lower('0x' + strip(l.topics[2]).slice(24)) === lower(ev.payTo)
      && BigInt(l.data).toString() === ev.amountUnits);
    if (transfers.length !== 1) {
      bad(`${transfers.length} matching tUSD8 Transfer logs vault → payee in the transaction`);
      return done('mismatch', `The settling transaction carries ${transfers.length} matching tUSD8 transfers from the vault to ${ev.payTo}, expected exactly one.`, DO_NOT_PAY);
    }
    out.transfer = { from: o.vault, to: ev.payTo, amount: units6(BigInt(ev.amountUnits)), logIndex: Number(BigInt(transfers[0].logIndex)), token: out.mandate.token };
    ok(`Transfer ${out.transfer.amount} tUSD8 vault → ${ev.payTo} (log ${out.transfer.logIndex})`);

    const [atHeight, fin, head] = await Promise.all([o.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), o.rpc('eth_getBlockByNumber', ['finalized', false]), o.rpc('eth_blockNumber')]);
    const n = Number(BigInt(receipt.blockNumber));
    const canonical = atHeight && atHeight.hash === receipt.blockHash;
    out.finality = { rule: 'finalized', block: n, blockHash: receipt.blockHash, blockTime: atHeight ? new Date(Number(BigInt(atHeight.timestamp)) * 1000).toISOString() : undefined, finalizedBlock: fin ? Number(BigInt(fin.number)) : undefined, head: Number(BigInt(head)), canonical: !!canonical };
    if (!canonical) {
      bad(`block ${n} is no longer canonical`);
      return done('pending', `The settlement's block ${n} changed (reorg): not final, ask again.`, DO_NOT_PAY + ' Ask again later.');
    }
    if (!fin || n > out.finality.finalizedBlock) {
      bad(`block ${n} is not finalized yet (finalized block ${out.finality.finalizedBlock ?? 'unknown'})`);
      return done('pending', `Pending: settled in block ${n} (transaction ${ev.txHash}), NOT finalized yet: the node's finalized block is ${out.finality.finalizedBlock ?? 'unknown'}${out.finality.finalizedBlock ? `, ${n - out.finality.finalizedBlock} blocks to go` : ''}. On Aevum this takes about an hour.`, DO_NOT_PAY + ' Do not treat it as paid yet; ask again later.');
    }
    ok(`block ${n} is canonical and at or below the finalized block ${out.finality.finalizedBlock}`);
    return done('paid_verified', `Paid and verified: ${out.transfer.amount} tUSD8 to ${ev.payTo} in transaction ${ev.txHash}, block ${n}, finalized. The vault refuses a second settlement of this invoice.`, 'Nothing to pay. Anyone can check the transaction in the explorer.');
  } catch (e) {
    return done('cannot_verify_now', `Could not read the chain right now (${String(e?.message ?? e).split('\n')[0].slice(0, 200)}).`, DO_NOT_PAY + ' Ask again once the RPC answers.');
  }
}


// ---------------------------------------------------------------------------------------------------------------
// "Simulate a resend after the payment": what the vault answers if the agent that settled the invoice sends the SAME
// payInvoice again. READ-ONLY: one eth_call (plus a control one block before the settlement), no wallet, no key,
// nothing is signed or sent. The settlement block comes from the verified receipt; the refusal comes from the
// simulation. Anything but the exact expected refusal is reported as inconclusive or unavailable, never as a proof.
// ---------------------------------------------------------------------------------------------------------------

/** How many blocks after the settlement block the historical simulation aims for (capped below the mandate's expiry). */
export const RESEND_OFFSET = 10;

// What nodes say when they no longer keep the state of an old block (geth, erigon, reth, nethermind, besu wordings).
const NO_HISTORY = /missing trie node|header not found|pruned|historical state|state (is )?not available|state histor|unknown block|not available|old data not available|no state/i;

/** ABI encoding of payInvoice(string invoiceId, bytes32 vendor, address payTo, uint256 amount), selector included. */
export function encodePayInvoice(invoiceId, vendorB32, payTo, amountUnits) {
  const tail = encodeStringArg(invoiceId).slice(64); // length + padded bytes
  return SELECTORS.payInvoice + '0'.repeat(62) + '80' + strip(vendorB32).padEnd(64, '0')
    + strip(payTo).toLowerCase().padStart(64, '0') + BigInt(amountUnits).toString(16).padStart(64, '0') + tail;
}

/**
 * Decodes revert data against the vault's errors. `{ name, selector, args }`; name null for a selector it does not
 * know (or data too short for the error's arguments: then `malformed` is set).
 */
export function decodeRevert(data) {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return { name: null, selector: null, args: [] };
  const selector = data.slice(0, 10).toLowerCase();
  const spec = ERRORS[selector];
  if (!spec) return { name: null, selector: selector.length === 10 ? selector : null, args: [] };
  const body = '0x' + data.slice(10);
  if (strip(body).length < spec.args.length * 64) return { name: null, selector, args: [], malformed: true };
  const args = spec.args.map((t, i) => (t === 'bytes32' ? '0x' + word(body, i) : t === 'address' ? wordAddr(body, i) : wordInt(body, i).toString()));
  return { name: spec.name, selector, args };
}

const errText = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);
const hexBlock = (n) => '0x' + n.toString(16);

/** One eth_call, classified: success, revert (with its decoded error), or the node could not answer. */
async function simCall(rpc, tx, blockNumber) {
  try {
    const returned = await rpc('eth_call', [tx, hexBlock(blockNumber)]);
    return { kind: 'success', returned };
  } catch (e) {
    const d = typeof e?.rpcData === 'string' ? e.rpcData : typeof e?.rpcData?.data === 'string' ? e.rpcData.data : undefined;
    if (d !== undefined && (e?.rpcCode === 3 || /revert/i.test(String(e?.message)))) return { kind: 'revert', data: d, error: decodeRevert(d) };
    return { kind: 'error', message: errText(e), noHistory: NO_HISTORY.test(String(e?.message ?? '')) };
  }
}

async function blockAt(rpc, tag) {
  const b = await rpc('eth_getBlockByNumber', [typeof tag === 'number' ? hexBlock(tag) : tag, false]);
  if (!b || b.number == null || b.timestamp == null) throw new Error(`eth_getBlockByNumber: no block ${tag}`);
  const timestamp = Number(BigInt(b.timestamp));
  return { number: Number(BigInt(b.number)), timestamp, time: new Date(timestamp * 1000).toISOString() };
}

/** One line for a simulated call's outcome: "succeeds (would settle)", "reverts AlreadySettled(0x…, 4030463)", … */
export const describeSimCall = (r) => {
  if (r.kind === 'success') return 'succeeds (would settle)';
  if (r.kind === 'error') return `no answer (${r.message})`;
  if (!r.error.name) return `reverts with ${r.error.selector ? `an unknown error ${r.error.selector}` : 'no error data'}`;
  return `reverts ${r.error.name}${r.error.args.length ? `(${r.error.args.join(', ')})` : ''}`;
};

/**
 * Simulates the agent sending the same payInvoice again, for a verdict that is paid_verified.
 * States: proven (AlreadySettled with the receipt's invoice key and settlement block), inconclusive (the node answered
 * something else), unavailable (the node could not answer, e.g. no historical state), not_available (no paid_verified
 * receipt to simulate against).
 *
 * @param {{ rpc: (m: string, p?: unknown[]) => Promise<any>, verdict: any, offset?: number }} o
 */
export async function simulateResend(o) {
  const v = o.verdict;
  const offset = o.offset ?? RESEND_OFFSET;
  const checks = [];
  const ok = (what) => checks.push({ ok: true, what });
  const bad = (what) => checks.push({ ok: false, what });
  if (!v || v.state !== 'paid_verified' || !v.settlement?.settled || !v.event) {
    return { state: 'not_available', answer: `The resend simulation needs a receipt that is paid_verified; this one is ${v?.state ?? 'not checked'}.`, checks };
  }
  const S = v.settlement.blockNumber;
  const key = v.settlement.invoiceKey;
  const call = {
    function: 'payInvoice', to: v.vault, from: v.settlement.agent,
    args: { invoiceId: v.event.invoiceId, vendor: v.event.vendorRaw, vendorId: v.event.vendor, payTo: v.event.payTo, amountUnits: v.settlement.amountUnits },
  };
  const tx = { from: call.from, to: call.to, data: encodePayInvoice(call.args.invoiceId, call.args.vendor, call.args.payTo, call.args.amountUnits) };
  const out = { settlementBlock: S, invoiceKey: key, call, checks };
  const unavailable = (answer) => ({ ...out, state: 'unavailable', answer });
  let latest, m;
  try {
    latest = await blockAt(o.rpc, 'latest');
    const raw = await o.rpc('eth_call', [{ to: v.vault, data: SELECTORS.mandate }, hexBlock(latest.number)]);
    m = { agent: wordAddr(raw, 0), expiresAt: Number(wordInt(raw, 1)), paused: wordInt(raw, 2) === 1n, payTo: wordAddr(raw, 3), vendorRaw: '0x' + word(raw, 6) };
  } catch (e) {
    return unavailable(`Simulation unavailable: the RPC did not answer (${errText(e)}). This says nothing either way.`);
  }
  const notNow = [
    latest.timestamp >= m.expiresAt && `the mandate expired at ${new Date(m.expiresAt * 1000).toISOString()}`,
    m.paused && 'the mandate is paused',
    lower(m.agent) !== lower(call.from) && 'the mandate has another agent now',
    (lower(m.vendorRaw) !== lower(call.args.vendor) || lower(m.payTo) !== lower(call.args.payTo)) && 'the mandate has another vendor or payee now',
  ].filter(Boolean);

  // Which block: the latest one if the mandate still lets this agent pay this vendor there; otherwise a block shortly
  // after the settlement, before the expiry (block timestamps read from the node), so the vault reaches its duplicate
  // check instead of refusing earlier (payInvoice checks the expiry before the duplicate).
  let target, chosenBecause;
  try {
    if (notNow.length === 0) {
      target = latest;
      chosenBecause = `the latest block: the mandate is still valid there (expires ${new Date(m.expiresAt * 1000).toISOString()})`;
    } else {
      const hi = Math.min(S + offset, latest.number);
      const atHi = hi > S ? await blockAt(o.rpc, hi) : undefined;
      if (!atHi) {
        target = await blockAt(o.rpc, S);
        chosenBecause = `the settlement block itself (its state includes the settlement): no later block exists yet, and at the latest block ${notNow.join(', ')}`;
      } else if (atHi.timestamp < m.expiresAt) {
        target = atHi;
        chosenBecause = `${hi - S} block${hi - S === 1 ? '' : 's'} after the settlement block, before the mandate's expiry (${new Date(m.expiresAt * 1000).toISOString()}): at the latest block ${notNow.join(', ')}`;
      } else {
        // The expiry falls within the offset: the last block after the settlement whose timestamp is before it.
        const first = await blockAt(o.rpc, S + 1);
        if (first.timestamp < m.expiresAt) {
          // Invariant: block `best` is before the expiry, block `top` is at or after it.
          let best = first, top = hi;
          while (top - best.number > 1) {
            const b = await blockAt(o.rpc, Math.floor((best.number + top) / 2));
            if (b.timestamp < m.expiresAt) best = b; else top = b.number;
          }
          target = best;
          chosenBecause = `the last block before the mandate's expiry (${new Date(m.expiresAt * 1000).toISOString()}), ${best.number - S} block${best.number - S === 1 ? '' : 's'} after the settlement`;
        } else {
          target = await blockAt(o.rpc, S);
          chosenBecause = `the settlement block itself (its state includes the settlement): the mandate expired (${new Date(m.expiresAt * 1000).toISOString()}) before the next block`;
        }
      }
    }
  } catch (e) {
    return unavailable(`Simulation unavailable: the RPC did not give the block headers needed to choose a block (${errText(e)}). This says nothing either way.`);
  }
  out.query = { block: target.number, blockTime: target.time, chosenBecause, latestBlock: latest.number };

  const [main, control] = await Promise.all([
    simCall(o.rpc, tx, target.number),
    S > 0 ? simCall(o.rpc, tx, S - 1).then(async (r) => ({ r, b: await blockAt(o.rpc, S - 1).catch(() => undefined) })) : Promise.resolve(undefined),
  ]);
  out.result = main;
  if (control) {
    const c = control.r;
    out.control = {
      block: S - 1, blockTime: control.b?.time, result: c,
      summary: c.kind === 'success'
        ? `At block ${S - 1}, one block before the settlement, the same call succeeds: it would have settled then.`
        : c.kind === 'error'
          ? `At block ${S - 1} the node did not answer (${c.message}): no control.`
          : `At block ${S - 1} the same call ${describeSimCall(c)}: the control does not show "it would have passed".`,
    };
  }

  if (main.kind === 'error') {
    bad(`eth_call at block ${target.number}: ${main.message}`);
    return unavailable(main.noHistory
      ? `Simulation unavailable: the node does not serve the state of block ${target.number} (${main.message}); it may not keep that much history. This says nothing either way.`
      : `Simulation unavailable: the RPC did not answer the simulated call at block ${target.number} (${main.message}). This says nothing either way.`);
  }
  const inconclusive = (answer) => ({ ...out, state: 'inconclusive', answer });
  if (main.kind === 'success') {
    bad(`the simulated resend at block ${target.number} did not revert`);
    return inconclusive(`Inconclusive: the simulated resend at block ${target.number} did NOT revert, where a refusal was expected. This is not a proof of anything; do not pay again before the original transaction is checked.`);
  }
  const e = main.error;
  if (e.name !== 'AlreadySettled') {
    bad(`the simulated resend at block ${target.number} ${describeSimCall(main)}`);
    const why = {
      MandateExpired: 'the mandate had expired there, so the vault refused before reaching its duplicate check',
      MandatePaused: 'the mandate was paused there, so the vault refused before reaching its duplicate check',
      NotAgent: 'the settling agent was not the mandate\'s agent there, so the vault refused before reaching its duplicate check',
      MandateChanged: 'the mandate had another vendor or payee there, so the vault refused before reaching its duplicate check',
      AboveInvoiceCap: 'the amount was above the per-invoice cap there, so the vault refused before reaching its duplicate check',
      AboveDailyLimit: 'the vault reached its daily-limit check, which comes AFTER its duplicate check: it did not see this invoice as settled there',
    }[e.name];
    return inconclusive(`Inconclusive: the simulated resend at block ${target.number} ${describeSimCall(main)}${why ? `: ${why}` : ''}. It does not show the duplicate refusal.`);
  }
  const [gotKey, gotBlock] = e.args;
  const problems = [
    lower(gotKey) !== lower(key) && `the refusal names invoice key ${gotKey}, not the receipt's ${key}`,
    gotBlock !== String(S) && `the refusal names block ${gotBlock}, not the receipt's settlement block ${S}`,
    control?.r.kind === 'revert' && control.r.error.name === 'AlreadySettled' && `the call already reverted AlreadySettled at block ${S - 1}, before the settlement block`,
  ].filter(Boolean);
  if (problems.length) {
    bad(`AlreadySettled, but ${problems.join('; ')}`);
    return inconclusive(`Inconclusive: the simulated resend at block ${target.number} reverts AlreadySettled, but ${problems.join('; ')}. This is not the expected proof; do not pay again before the original transaction is checked.`);
  }
  ok(`simulated resend at block ${target.number} reverts AlreadySettled(${gotKey}, ${gotBlock})`);
  ok(`its invoice key is the receipt's invoice key and its block is the receipt's settlement block ${S}`);
  if (control?.r.kind === 'success') ok(`control: at block ${S - 1} the same call succeeds`);
  return { ...out, state: 'proven', answer: `The vault refuses a second settlement of this invoice: the simulated resend at block ${target.number} reverts AlreadySettled. The original settlement in block ${S} stands.` };
}
