// Types for receipt.js (portable receipt + the consumer's read-only check), so the TypeScript tests can import it.
import type { PageVerdict, Rpc } from './verify.js';

export const RECEIPT_FORMAT: 'agentfi.invoice-receipt';
export const RECEIPT_VERSION: 1;

export interface Receipt {
  format: 'agentfi.invoice-receipt';
  version: 1;
  note: string;
  network: { chainId: number; caip2: string };
  vault: string;
  token: string;
  invoice: { id: string; vendorId: string; vendorBytes32: string; invoiceKey: string };
  payee: string;
  amount: { units: string; decimals: 6; display: string };
  payment: {
    txHash: string;
    blockNumber: number;
    blockHash: string;
    blockTime?: string;
    agent: string;
    events: (
      | { name: 'InvoiceSettled'; address: string; logIndex: number }
      | { name: 'Transfer'; address: string; logIndex: number; from: string; to: string; value: string }
    )[];
  };
  finality: { rule: 'finalized'; finalizedBlockAtIssue?: number };
  issued: { at: string; by: string; rpc?: string };
  explorer?: string;
}

/** The consumer's own record of the invoice it expects to be paid. */
export interface ExpectedInvoice {
  chainId: number;
  vault: string;
  token: string;
  invoiceId: string;
  vendorId: string;
  payee: string;
  amountUnits: string;
}

export type ReceiptState = 'settle' | 'divergent' | 'not_paid' | 'mismatch' | 'pending' | 'inconclusive' | 'invalid';
export interface ReceiptCheck {
  state: ReceiptState;
  decision: 'settle' | 'retry' | 'reject';
  /** false exactly when decision is 'retry': the chain gave no evidence either way. */
  conclusive: boolean;
  /** For an invoice your vault has not settled: what the node said about the receipt's own transaction and block. */
  evidence?: 'transaction' | 'block' | 'unavailable';
  uncertainty?: 'node_behind_or_receipt_invalid';
  chainTx?: { blockNumber: number; blockHash: string; status: string };
  answer: string;
  checks: { ok: boolean; what: string }[];
  differences?: { field: string; expected: unknown; receipt?: unknown; chain?: unknown }[];
  source?: 'receipt' | 'chain';
  settlementId?: string;
  proof?: { txHash: string; blockNumber: number; blockHash?: string; finalizedBlock?: number };
  verdict?: PageVerdict;
}

export function buildReceipt(v: PageVerdict, o?: { rpcUrl?: string; issuedAt?: string }): Receipt;
export function settlementId(r: Receipt): string;
export function validateReceipt(r: unknown): { ok: boolean; problems: string[] };
export function validateExpected(x: unknown): { ok: boolean; problems: string[] };
export function compareClaims(r: Receipt, x: ExpectedInvoice): { field: string; expected: unknown; receipt: unknown }[];
export function checkReceipt(o: { rpc: Rpc; receipt: unknown; expected: unknown }): Promise<ReceiptCheck>;
