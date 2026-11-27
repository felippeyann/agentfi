// A small accounts-payable system that marks its OWN invoices as paid from a portable receipt (verify/receipt.js).
// Persistent state in one SQLite file (node:sqlite); every run is a separate process, so a "restart" is simply the
// next command.
//
//   node ap.mjs init                       create the state from the books (AP_BOOKS, default books.json)
//   node ap.mjs deliver <ref> <receipt>    a receipt arrives for invoice <ref> of the books
//   node ap.mjs retry                      re-check the deliveries in the inbox that are due (not parked)
//   node ap.mjs status                     the books, the settlements, the inbox
//
// Environment: AP_STATE (state directory, default ./.state next to this file), AP_RPC (default: the public Aevum RPC),
// AP_BOOKS (books file used by init), AP_RPC_DOWN=1 (simulates a network outage: every RPC call fails),
// AP_MAX_ATTEMPTS (default 5) and AP_RETRY_BASE_S (default 30): the retry policy below.
//
// Retry policy (the CALLER's, not the verifier's: checkReceipt never loops). A check that ends without evidence
// (`retry`: pending, inconclusive) leaves the invoice open and the delivery in the inbox, due again after a backoff
// (base x 2^(attempts-1) seconds, at most one hour). After AP_MAX_ATTEMPTS checks without evidence the delivery is
// PARKED: it stays in the inbox, the invoice stays open, `retry` no longer checks it, and a `needs_review` event asks a
// person to look (for instance with another RPC). Delivering the receipt again is that person's explicit re-check.
//
// Rules (what the example shows):
//   - the expected data of an invoice come from the books, never from the receipt;
//   - an invoice is marked paid only on `settle` (verify/receipt.js: chain read, finalized, receipt matches both);
//   - a delivery is written to the inbox when it arrives and leaves it only with a final answer: `retry` outcomes
//     (pending, inconclusive) and a process killed mid-check leave it there for `retry`;
//   - the mark, its audit event and the inbox removal are one transaction (BEGIN IMMEDIATE), with UNIQUE constraints
//     on the invoice and on the payment (settlementId): a second delivery of the same receipt, after a restart or at
//     the same time from another process, finds the invoice already paid and changes nothing, and one on-chain payment
//     settles at most one invoice of the books.
// Each command prints one line `RESULT {json}` for scripts. Exit code: 0 settled or already settled, 2 rejected,
// 3 left in the inbox for retry, 4 parked for review (invoice open, no automatic retry), 1 usage or state error.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { checkReceipt, compareClaims, settlementId, validateReceipt } from '../../verify/receipt.js';
import { DEFAULTS, rpcClient } from '../../verify/verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(process.env.AP_STATE ?? join(HERE, '.state'));
const DB_PATH = join(STATE, 'ap.sqlite');
const RPC_URL = process.env.AP_RPC ?? DEFAULTS.rpcUrl;
const MAX_ATTEMPTS = Number(process.env.AP_MAX_ATTEMPTS ?? 5);
const RETRY_BASE_S = Number(process.env.AP_RETRY_BASE_S ?? 30);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS invoices (ref TEXT PRIMARY KEY, description TEXT, expected TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settlements (
    ref TEXT PRIMARY KEY REFERENCES invoices(ref),
    settlement_id TEXT NOT NULL UNIQUE,
    tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL, finalized_block INTEGER,
    receipt_sha256 TEXT NOT NULL, delivery_id TEXT NOT NULL, settled_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inbox (
    delivery_id TEXT PRIMARY KEY, ref TEXT NOT NULL, receipt TEXT NOT NULL, received_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_state TEXT, last_answer TEXT,
    next_attempt_at TEXT, parked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, pid INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
`;

// busy_timeout comes first: any statement before it fails at once with SQLITE_BUSY while other processes hold the
// file. WAL is set once by init (it is persistent in the file), so a normal open never asks for a mode change.
function open() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
  return db;
}

const now = () => new Date().toISOString();
const logEvent = (db, type, data) => db.prepare('INSERT INTO events (at, pid, type, data) VALUES (?, ?, ?, ?)').run(now(), process.pid, type, JSON.stringify(data));

/** Runs fn inside BEGIN IMMEDIATE (one writer at a time across processes); rolls back on any error. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function rpc() {
  if (process.env.AP_RPC_DOWN === '1') return async (method) => { throw new Error(`${method}: simulated network outage (AP_RPC_DOWN=1)`); };
  return rpcClient(RPC_URL);
}

function init() {
  if (existsSync(DB_PATH)) return { outcome: 'exists', state: STATE };
  mkdirSync(STATE, { recursive: true });
  const books = JSON.parse(readFileSync(resolve(process.env.AP_BOOKS ?? join(HERE, 'books.json')), 'utf8'));
  const db = open();
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    tx(db, () => {
      const ins = db.prepare('INSERT INTO invoices (ref, description, expected) VALUES (?, ?, ?)');
      for (const [ref, inv] of Object.entries(books.invoices)) ins.run(ref, inv.description ?? null, JSON.stringify(inv.expected));
      logEvent(db, 'init', { invoices: Object.keys(books.invoices) });
    });
  } finally {
    db.close();
  }
  return { outcome: 'initialized', state: STATE, invoices: Object.keys(books.invoices) };
}

function requireState() {
  if (!existsSync(DB_PATH)) throw new Error(`no state at ${STATE}: run "init" first`);
}

/** Ends a delivery with a final answer: event and inbox removal in one transaction. */
function finish(db, base, outcome, state, answer, extra = {}) {
  tx(db, () => {
    logEvent(db, outcome, { ...base, state, answer, ...extra });
    db.prepare('DELETE FROM inbox WHERE delivery_id = ?').run(base.deliveryId);
  });
  return { ...base, outcome, state, answer, ...extra };
}

/** One delivery of a receipt (file contents) for invoice `ref` of the books. */
async function deliver(db, ref, receiptText, deliveryId) {
  const sha = createHash('sha256').update(receiptText).digest('hex');
  const id = deliveryId ?? createHash('sha256').update(`${ref}\n${sha}`).digest('hex').slice(0, 16);
  const base = { ref, deliveryId: id, receiptSha256: sha };

  // Written down on arrival: a process killed during the check leaves it in the inbox for `retry`.
  tx(db, () => {
    const r = db.prepare('INSERT INTO inbox (delivery_id, ref, receipt, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING').run(id, ref, receiptText, now());
    if (r.changes) logEvent(db, 'received', base);
  });

  const row = db.prepare('SELECT expected FROM invoices WHERE ref = ?').get(ref);
  if (!row) return finish(db, base, 'rejected', 'unknown_ref', `No invoice ${ref} in the books.`);
  const expected = JSON.parse(row.expected);
  let receipt;
  try {
    receipt = JSON.parse(receiptText);
  } catch {
    return finish(db, base, 'rejected', 'invalid', 'The receipt is not JSON.');
  }

  // Already marked by this very payment: answered from the books, without the chain (the claims match the books and
  // the payment is the one that was verified when the mark was made).
  const done = db.prepare('SELECT * FROM settlements WHERE ref = ?').get(ref);
  if (done && validateReceipt(receipt).ok && compareClaims(receipt, expected).length === 0
    && settlementId(receipt) === done.settlement_id && receipt.payment.txHash.toLowerCase() === done.tx_hash.toLowerCase()) {
    return finish(db, base, 'already_settled', 'settle', `${ref} was already marked paid by this payment (tx ${done.tx_hash}, delivery ${done.delivery_id}); nothing changed.`);
  }

  // The check reads the chain outside any transaction: it only decides whether a mark is ALLOWED.
  const r = await checkReceipt({ rpc: rpc(), receipt, expected });

  if (r.decision === 'retry') {
    // No evidence either way: the invoice stays open. The policy decides when (and whether) to check again.
    return tx(db, () => {
      const q = db.prepare('SELECT attempts FROM inbox WHERE delivery_id = ?').get(id);
      const attempts = (q?.attempts ?? 0) + 1;
      const parked = attempts >= MAX_ATTEMPTS;
      const next = parked ? null : new Date(Date.now() + Math.min(RETRY_BASE_S * 2 ** (attempts - 1), 3600) * 1000).toISOString();
      db.prepare('UPDATE inbox SET attempts = ?, last_state = ?, last_answer = ?, next_attempt_at = ?, parked = ? WHERE delivery_id = ?').run(attempts, r.state, r.answer, next, parked ? 1 : 0, id);
      const outcome = parked ? 'needs_review' : 'queued';
      logEvent(db, outcome, { ...base, state: r.state, attempts, nextAttemptAt: next, answer: r.answer, ...(r.uncertainty ? { uncertainty: r.uncertainty } : {}) });
      return { ...base, outcome, state: r.state, attempts, ...(next ? { nextAttemptAt: next } : {}), answer: parked ? `${r.answer} After ${attempts} checks without evidence the delivery is parked for review: the invoice stays open and is not checked again automatically.` : r.answer, ...(r.uncertainty ? { uncertainty: r.uncertainty } : {}) };
    });
  }
  if (r.decision === 'reject') return finish(db, base, 'rejected', r.state, r.answer, r.differences ? { differences: r.differences } : {});

  // settle: the mark, its event and the inbox removal in one transaction, after re-reading the books (another process
  // may have marked it meanwhile). The UNIQUE constraints are the last guard.
  const sid = settlementId(receipt);
  const result = tx(db, () => {
    const already = db.prepare('SELECT settlement_id, tx_hash, delivery_id FROM settlements WHERE ref = ?').get(ref);
    let out;
    if (already) {
      out = already.settlement_id === sid
        ? { outcome: 'already_settled', state: 'settle', answer: `${ref} was already marked paid by this payment (tx ${already.tx_hash}, delivery ${already.delivery_id}); nothing changed.` }
        : { outcome: 'rejected', state: 'conflict', answer: `${ref} is already marked paid by another payment (${already.settlement_id}); this one (${sid}) is NOT applied. Investigate a possible double payment.` };
    } else {
      const usedBy = db.prepare('SELECT ref FROM settlements WHERE settlement_id = ?').get(sid);
      if (usedBy) {
        out = { outcome: 'rejected', state: 'payment_already_used', answer: `This payment already settled ${usedBy.ref}; it cannot settle ${ref} too.` };
      } else {
        db.prepare('INSERT INTO settlements (ref, settlement_id, tx_hash, block_number, finalized_block, receipt_sha256, delivery_id, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ref, sid, r.proof.txHash, r.proof.blockNumber, r.proof.finalizedBlock ?? null, sha, id, now());
        out = { outcome: 'settled', state: 'settle', answer: r.answer };
      }
    }
    logEvent(db, out.outcome, { ...base, state: out.state, settlementId: sid, answer: out.answer });
    db.prepare('DELETE FROM inbox WHERE delivery_id = ?').run(id);
    return out;
  });
  return { ...base, settlementId: sid, ...result };
}

async function retry(db) {
  const rows = db.prepare('SELECT delivery_id, ref, receipt FROM inbox WHERE parked = 0 AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY received_at, delivery_id').all(now());
  const results = [];
  for (const q of rows) results.push(await deliver(db, q.ref, q.receipt, q.delivery_id));
  return { outcome: 'retried', count: results.length, results };
}

function status(db) {
  const invoices = Object.fromEntries(db.prepare('SELECT i.ref, s.tx_hash, s.block_number, s.settlement_id, s.settled_at FROM invoices i LEFT JOIN settlements s ON s.ref = i.ref ORDER BY i.ref').all()
    .map((x) => [x.ref, x.tx_hash ? { status: 'paid', txHash: x.tx_hash, blockNumber: x.block_number, settlementId: x.settlement_id, settledAt: x.settled_at } : { status: 'open' }]));
  const settlements = db.prepare('SELECT COUNT(*) AS n FROM settlements').get().n;
  const settledEvents = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'settled'").get().n;
  const inbox = db.prepare('SELECT delivery_id AS deliveryId, ref, attempts, last_state AS lastState, next_attempt_at AS nextAttemptAt, parked FROM inbox ORDER BY received_at').all()
    .map((q) => ({ ...q, parked: q.parked === 1 }));
  return { outcome: 'status', state: STATE, invoices, settlements, settledEvents, inbox };
}

const EXIT = { settled: 0, already_settled: 0, initialized: 0, exists: 0, status: 0, queued: 3, needs_review: 4, rejected: 2 };

const [cmd, a1, a2] = process.argv.slice(2);
let db;
try {
  let r;
  if (cmd === 'init') r = init();
  else if (['deliver', 'retry', 'status'].includes(cmd) && (cmd !== 'deliver' || (a1 && a2))) {
    requireState();
    db = open();
    r = cmd === 'deliver' ? await deliver(db, a1, readFileSync(a2, 'utf8')) : cmd === 'retry' ? await retry(db) : status(db);
  } else {
    console.error('usage: node ap.mjs init | deliver <ref> <receipt.json> | retry | status');
    process.exitCode = 1;
  }
  if (r) {
    console.log(`RESULT ${JSON.stringify(r)}`);
    // exitCode, not process.exit(): exiting with fetch sockets still open crashes Node on Windows (0xC0000409).
    const worst = (rs) => (rs.some((x) => x.outcome === 'queued') ? 3 : rs.some((x) => x.outcome === 'needs_review') ? 4 : rs.some((x) => x.outcome === 'rejected') ? 2 : 0);
    process.exitCode = cmd === 'retry' ? worst(r.results) : EXIT[r.outcome] ?? 1;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}
