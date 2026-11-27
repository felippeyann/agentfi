// A small accounts-payable system that marks its OWN invoices as paid from a portable receipt (verify/receipt.js).
// Persistent state in a directory; every run is a separate process, so a "restart" is simply the next command.
//
//   node ap.mjs init                       create the state directory from the books (AP_BOOKS, default books.json)
//   node ap.mjs deliver <ref> <receipt>    a receipt arrives for invoice <ref> of the books
//   node ap.mjs retry                      re-check the deliveries queued after an inconclusive check
//   node ap.mjs status                     the books, the settlements, the queue
//
// Environment: AP_STATE (state directory, default ./.state next to this file), AP_RPC (default: the public Aevum RPC),
// AP_BOOKS (books file used by init), AP_RPC_DOWN=1 (simulates a network outage: every RPC call fails).
//
// Rules (what the example shows):
//   - the expected data of an invoice come from the books, never from the receipt;
//   - an invoice is marked paid only on `settle` (verify/receipt.js: chain read, finalized, receipt matches both);
//   - `retry` outcomes (pending, inconclusive) are queued and re-checked later; nothing is marked paid;
//   - the mark is written under an exclusive lock, after re-reading the ledger: a second delivery of the same receipt
//     (after a restart, or at the same time from another process) finds the invoice already paid and changes nothing;
//   - one on-chain payment settles at most one invoice of the books.
// Each command prints one line `RESULT {json}` for scripts. Exit code: 0 settled or already settled, 2 rejected,
// 3 queued for retry, 1 usage or state error.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReceipt, settlementId } from '../../verify/receipt.js';
import { DEFAULTS, rpcClient } from '../../verify/verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(process.env.AP_STATE ?? join(HERE, '.state'));
const RPC_URL = process.env.AP_RPC ?? DEFAULTS.rpcUrl;
const P = {
  books: join(STATE, 'books.json'),
  ledger: join(STATE, 'ledger.json'),
  queue: join(STATE, 'queue'),
  events: join(STATE, 'events.jsonl'),
  lock: join(STATE, 'ledger.lock'),
};

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

/** Write-then-rename, with fsync: a crash leaves the old file or the new one, never half of one. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

function logEvent(e) {
  appendFileSync(P.events, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...e }) + '\n');
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** An exclusive lock across processes: a file created with O_EXCL. A lock older than 30 s is a crashed holder's. */
function withLock(fn) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fd = openSync(P.lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(P.lock).mtimeMs > 30_000) unlinkSync(P.lock);
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error('the ledger is locked by another process; try again');
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    unlinkSync(P.lock);
  }
}

function rpc() {
  if (process.env.AP_RPC_DOWN === '1') return async (method) => { throw new Error(`${method}: simulated network outage (AP_RPC_DOWN=1)`); };
  return rpcClient(RPC_URL);
}

function init() {
  if (existsSync(P.books)) return { outcome: 'exists', state: STATE };
  mkdirSync(P.queue, { recursive: true });
  const books = readJson(resolve(process.env.AP_BOOKS ?? join(HERE, 'books.json')));
  writeJsonAtomic(P.books, books);
  writeJsonAtomic(P.ledger, { settlements: {}, bySettlementId: {} });
  logEvent({ type: 'init', invoices: Object.keys(books.invoices) });
  return { outcome: 'initialized', state: STATE, invoices: Object.keys(books.invoices) };
}

function requireState() {
  if (!existsSync(P.books)) throw new Error(`no state at ${STATE}: run "init" first`);
}

/** One delivery of a receipt (file contents) for invoice `ref` of the books. */
async function deliver(ref, receiptText, { deliveryId, receivedAt } = {}) {
  requireState();
  const books = readJson(P.books);
  const entry = books.invoices[ref];
  const sha = createHash('sha256').update(receiptText).digest('hex');
  const id = deliveryId ?? createHash('sha256').update(`${ref}\n${sha}`).digest('hex').slice(0, 16);
  const base = { ref, deliveryId: id, receiptSha256: sha };
  if (!entry) {
    logEvent({ type: 'rejected', ...base, state: 'unknown_ref' });
    return { ...base, outcome: 'rejected', state: 'unknown_ref', answer: `No invoice ${ref} in the books.` };
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptText);
  } catch {
    logEvent({ type: 'rejected', ...base, state: 'invalid' });
    return { ...base, outcome: 'rejected', state: 'invalid', answer: 'The receipt is not JSON.' };
  }

  // The check reads the chain and needs no lock: it only decides whether a mark is ALLOWED.
  const r = await checkReceipt({ rpc: rpc(), receipt, expected: entry.expected });
  const queued = join(P.queue, `${id}.json`);

  if (r.decision === 'retry') {
    const prev = existsSync(queued) ? readJson(queued) : undefined;
    writeJsonAtomic(queued, { ref, deliveryId: id, receivedAt: receivedAt ?? prev?.receivedAt ?? new Date().toISOString(), attempts: (prev?.attempts ?? 0) + 1, lastState: r.state, lastAnswer: r.answer, receipt: receiptText });
    logEvent({ type: 'queued', ...base, state: r.state, answer: r.answer });
    return { ...base, outcome: 'queued', state: r.state, answer: r.answer };
  }
  if (r.decision === 'reject') {
    if (existsSync(queued)) rmSync(queued);
    logEvent({ type: 'rejected', ...base, state: r.state, answer: r.answer, differences: r.differences });
    return { ...base, outcome: 'rejected', state: r.state, answer: r.answer, ...(r.differences ? { differences: r.differences } : {}) };
  }

  // settle: the mark, under the lock, after re-reading the ledger (another process may have marked it meanwhile).
  const sid = settlementId(receipt);
  const result = withLock(() => {
    const ledger = readJson(P.ledger);
    const already = ledger.settlements[ref];
    if (already) {
      if (already.settlementId === sid) return { outcome: 'already_settled', state: 'settle', answer: `${ref} was already marked paid by this payment (tx ${already.txHash}, delivery ${already.deliveryId}); nothing changed.` };
      return { outcome: 'rejected', state: 'conflict', answer: `${ref} is already marked paid by another payment (${already.settlementId}); this one (${sid}) is NOT applied. Investigate a possible double payment.` };
    }
    const usedBy = ledger.bySettlementId[sid];
    if (usedBy) return { outcome: 'rejected', state: 'payment_already_used', answer: `This payment already settled ${usedBy}; it cannot settle ${ref} too.` };
    ledger.settlements[ref] = { settlementId: sid, txHash: r.proof.txHash, blockNumber: r.proof.blockNumber, finalizedBlock: r.proof.finalizedBlock, receiptSha256: sha, deliveryId: id, settledAt: new Date().toISOString() };
    ledger.bySettlementId[sid] = ref;
    writeJsonAtomic(P.ledger, ledger);
    return { outcome: 'settled', state: 'settle', answer: r.answer };
  });
  if (existsSync(queued)) rmSync(queued);
  logEvent({ type: result.outcome, ...base, state: result.state, settlementId: sid, answer: result.answer });
  return { ...base, settlementId: sid, ...result };
}

async function retry() {
  requireState();
  const files = readdirSync(P.queue).filter((f) => f.endsWith('.json')).sort();
  const results = [];
  for (const f of files) {
    const q = readJson(join(P.queue, f));
    results.push(await deliver(q.ref, q.receipt, { deliveryId: q.deliveryId, receivedAt: q.receivedAt }));
  }
  return { outcome: 'retried', count: results.length, results };
}

function status() {
  requireState();
  const books = readJson(P.books), ledger = readJson(P.ledger);
  const queue = readdirSync(P.queue).filter((f) => f.endsWith('.json')).map((f) => readJson(join(P.queue, f))).map((q) => ({ ref: q.ref, deliveryId: q.deliveryId, attempts: q.attempts, lastState: q.lastState }));
  const invoices = Object.fromEntries(Object.keys(books.invoices).map((ref) => [ref, ledger.settlements[ref] ? { status: 'paid', ...ledger.settlements[ref] } : { status: 'open' }]));
  return { outcome: 'status', state: STATE, invoices, settlements: Object.keys(ledger.settlements).length, queue };
}

const exitFor = (r) => (r.outcome === 'settled' || r.outcome === 'already_settled' || r.outcome === 'initialized' || r.outcome === 'exists' || r.outcome === 'status' || r.outcome === 'retried' ? 0 : r.outcome === 'queued' ? 3 : 2);

const [cmd, a1, a2] = process.argv.slice(2);
try {
  let r;
  if (cmd === 'init') r = init();
  else if (cmd === 'deliver' && a1 && a2) r = await deliver(a1, readFileSync(a2, 'utf8'));
  else if (cmd === 'retry') r = await retry();
  else if (cmd === 'status') r = status();
  else {
    console.error('usage: node ap.mjs init | deliver <ref> <receipt.json> | retry | status');
    process.exit(1);
  }
  console.log(`RESULT ${JSON.stringify(r)}`);
  // exitCode, not process.exit(): exiting with fetch sockets still open crashes Node on Windows (0xC0000409).
  process.exitCode = cmd === 'retry' ? (r.results.some((x) => x.outcome === 'queued') ? 3 : 0) : exitFor(r);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
