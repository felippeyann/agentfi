/**
 * The agent's payment ledger (SQLite, `node:sqlite`): one row per invoice id, plus an append-only
 * event log. The row is the write-ahead record that makes a lost response recoverable: the signed
 * transaction (its raw bytes, hash and nonce) is committed BEFORE it is broadcast, so after a crash
 * the agent knows exactly which transaction would have paid the invoice and can look for it on-chain
 * instead of signing a new one.
 *
 * Status:
 *   refused    the mandate refused it; nothing was signed
 *   signed     signed and recorded, maybe not broadcast (a crash can stop between the two)
 *   broadcast  handed to the node; no receipt seen yet
 *   confirmed  mined, success, and the Transfer log matches (payer → payTo, exact amount)
 *   stuck      the payer's nonce is used on-chain but this transaction was not found: either another
 *              transaction took the nonce (no money moved) or the node has not indexed ours. Stays
 *              OPEN: re-checked on every resubmission and reconcile; never read as "no money moved"
 *   reverted   mined but failed: no tokens moved; the invoice needs the operator
 *
 * ONE agent process per ledger file: `acquireInstanceLock` refuses a second one (two processes
 * deciding on the same invoice id is how the same invoice gets paid twice).
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type PaymentStatus = 'refused' | 'signed' | 'broadcast' | 'stuck' | 'confirmed' | 'reverted';
/** Rows whose money may still move or may have moved: they count against limits and are reconciled. */
export const OPEN_STATUSES: readonly PaymentStatus[] = ['signed', 'broadcast', 'stuck'];

/**
 * Exclusive lock for the agent process on a ledger file (`<ledger>.lock` holding the pid). A lock
 * left by a process that no longer exists (a crash) is taken over. Returns the release function.
 */
export function acquireInstanceLock(ledgerPath: string): () => void {
  const lockPath = `${ledgerPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = (err as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive && pid !== process.pid) {
        throw new Error(`another agent process (pid ${pid}) holds the ledger ${ledgerPath}; only one may run (${lockPath})`);
      }
      unlinkSync(lockPath); // stale: its process is gone
    }
  }
  throw new Error(`could not take the ledger lock ${lockPath}`);
}

export interface PaymentRow {
  invoice_id: string;
  invoice_hash: string;
  vendor_id: string;
  pay_to: string;
  amount: string; // base units
  status: PaymentStatus;
  rule: string | null;
  reason: string | null;
  what_to_do: string | null;
  nonce: number | null;
  raw_tx: string | null;
  tx_hash: string | null;
  block_number: string | null;
  log_index: number | null;
  created_at: string;
  updated_at: string;
}

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS payments (
        invoice_id TEXT PRIMARY KEY,
        invoice_hash TEXT NOT NULL,
        vendor_id TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        rule TEXT, reason TEXT, what_to_do TEXT,
        nonce INTEGER, raw_tx TEXT, tx_hash TEXT UNIQUE, block_number TEXT, log_index INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, invoice_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT
      );
    `);
  }

  get(invoiceId: string): PaymentRow | undefined {
    return this.db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoiceId) as PaymentRow | undefined;
  }

  all(): PaymentRow[] {
    return this.db.prepare('SELECT * FROM payments ORDER BY created_at, invoice_id').all() as unknown as PaymentRow[];
  }

  /** Inserts a new row; returns false when the invoice id already exists (never overwrites). */
  insert(row: Omit<PaymentRow, 'created_at' | 'updated_at'>): boolean {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO payments (invoice_id, invoice_hash, vendor_id, pay_to, amount, status, rule, reason, what_to_do,
           nonce, raw_tx, tx_hash, block_number, log_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.invoice_id, row.invoice_hash, row.vendor_id, row.pay_to, row.amount, row.status, row.rule, row.reason, row.what_to_do,
        row.nonce, row.raw_tx, row.tx_hash, row.block_number, row.log_index, now, now);
    return Number(r.changes) === 1;
  }

  /** Removes a REFUSED row (nothing was signed for it) so a resubmission can be judged again. */
  deleteRefused(invoiceId: string): boolean {
    return Number(this.db.prepare("DELETE FROM payments WHERE invoice_id = ? AND status = 'refused'").run(invoiceId).changes) === 1;
  }

  update(invoiceId: string, fields: Partial<Pick<PaymentRow, 'status' | 'block_number' | 'log_index' | 'reason' | 'what_to_do' | 'rule'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE payments SET ${set}, updated_at = ? WHERE invoice_id = ?`).run(...keys.map((k) => fields[k] ?? null), new Date().toISOString(), invoiceId);
  }

  event(invoiceId: string, event: string, detail?: unknown): void {
    this.db.prepare('INSERT INTO events (at, invoice_id, event, detail) VALUES (?, ?, ?, ?)').run(
      new Date().toISOString(), invoiceId, event, detail === undefined ? null : JSON.stringify(detail));
  }

  events(invoiceId?: string): { at: string; invoice_id: string; event: string; detail: string | null }[] {
    return (invoiceId
      ? this.db.prepare('SELECT at, invoice_id, event, detail FROM events WHERE invoice_id = ? ORDER BY seq').all(invoiceId)
      : this.db.prepare('SELECT at, invoice_id, event, detail FROM events ORDER BY seq').all()) as never;
  }

  /** Base units committed today (UTC, by the day the payment was signed) by rows whose money moved or may move. */
  committedToday(now = new Date()): bigint {
    const day = now.toISOString().slice(0, 10);
    const rows = this.db
      .prepare("SELECT amount FROM payments WHERE status IN ('signed','broadcast','stuck','confirmed') AND substr(created_at, 1, 10) = ?")
      .all(day) as { amount: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  }

  close(): void {
    this.db.close();
  }
}
