// "Was this invoice paid?" read straight from the chain, in the browser: the InvoiceMandate vault's settlementOf,
// its InvoiceSettled event, the tUSD8 Transfer in the same transaction and the node's finalized block.
// READ-ONLY: plain JSON-RPC reads (eth_chainId, eth_getCode, eth_call, eth_getLogs, eth_getTransactionReceipt,
// eth_getBlockByNumber, eth_getTransactionByHash). No wallet, no key, no signing, nothing is sent.
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
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  };
}

const call = (rpc, to, data) => rpc('eth_call', [{ to, data }, 'latest']);

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
      bad('no InvoiceSettled event at that block');
      return done('mismatch', `The vault says ${o.invoiceId} is settled in block ${out.settlement.blockNumber}, but no InvoiceSettled event for it is there.`, DO_NOT_PAY);
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
    if (!receipt || receipt.status !== '0x1') {
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
    out.finality = { rule: 'finalized', block: n, blockTime: atHeight ? new Date(Number(BigInt(atHeight.timestamp)) * 1000).toISOString() : undefined, finalizedBlock: fin ? Number(BigInt(fin.number)) : undefined, head: Number(BigInt(head)), canonical: !!canonical };
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

