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
 *   reverted   mined but failed: no money moved; the invoice needs the operator
 */
import { DatabaseSync } from 'node:sqlite';

export type PaymentStatus = 'refused' | 'signed' | 'broadcast' | 'confirmed' | 'reverted';

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

  update(invoiceId: string, fields: Partial<Pick<PaymentRow, 'status' | 'block_number' | 'log_index' | 'reason' | 'what_to_do'>>): void {
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

  /** Base units committed today (UTC) by rows that may move money: confirmed, broadcast or signed. */
  committedToday(now = new Date()): bigint {
    const day = now.toISOString().slice(0, 10);
    const rows = this.db
      .prepare("SELECT amount FROM payments WHERE status IN ('signed','broadcast','confirmed') AND substr(created_at, 1, 10) = ?")
      .all(day) as { amount: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  }

  close(): void {
    this.db.close();
  }
}
