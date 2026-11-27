// Types for verify.js (the page's read-only chain logic), so the TypeScript tests can import it.
export type Rpc = (method: string, params?: unknown[]) => Promise<any>;
export type PageState = 'paid_verified' | 'pending' | 'failed' | 'unknown_invoice' | 'mismatch' | 'cannot_verify_now';

export interface PageVerdict {
  invoiceId: string;
  vault: string;
  state: PageState;
  answer: string;
  next: string;
  checks: { ok: boolean; what: string }[];
  chainId?: number;
  explorer?: string;
  mandate?: { token: string; operator: string; agent: string; expiresAt: number; paused: boolean; payTo: string; maxPerInvoice: string; maxPerDay: string; vendor: string };
  otherVendorSettlement?: { settled: boolean; vendor: string; amount: string; amountUnits: string; blockNumber: number; agent: string; invoiceKey: string };
  settlement?: { settled: boolean; vendor: string; amount: string; amountUnits: string; blockNumber: number; agent: string; invoiceKey: string };
  event?: { txHash: string; logIndex: number; blockNumber: number; invoiceId: string; amountUnits: string; agent: string; vendor: string; vendorRaw: string; payTo: string };
  transfer?: { from: string; to: string; amount: string; logIndex: number; token: string };
  finality?: { rule: 'finalized'; block: number; blockHash?: string; blockTime?: string; finalizedBlock?: number; head: number; canonical: boolean };
}

export const DEFAULTS: { readonly rpcUrl: string; readonly chainId: number; readonly explorerUrl: string; readonly tUSD8: string };
export const SELECTORS: { readonly settlementOf: string; readonly findSettlement: string; readonly mandate: string; readonly token: string; readonly operator: string; readonly payInvoice: string };
export const TOPICS: { readonly invoiceSettled: string; readonly transfer: string };
export function isAddress(a: unknown): boolean;
export function encodeStringArg(s: string): string;
export function bytes32ToAscii(h: string): string;
export function encodeStringAndBytes32(s: string, b32: string): string;
export function vendorBytes32(id: string): string;
export function units6(v: bigint): string;
export function rpcClient(url: string, fetchImpl?: typeof fetch): Rpc;
export const ERRORS: { readonly [selector: string]: { readonly name: string; readonly args: readonly ('bytes32' | 'uint256' | 'address')[] } };
export const RESEND_OFFSET: number;
export function encodePayInvoice(invoiceId: string, vendorB32: string, payTo: string, amountUnits: string | bigint): string;
export interface DecodedRevert { name: string | null; selector: string | null; args: string[]; malformed?: true }
export function decodeRevert(data: unknown): DecodedRevert;
export type SimCallResult =
  | { kind: 'success'; returned: string }
  | { kind: 'revert'; data: string; error: DecodedRevert }
  | { kind: 'error'; message: string; noHistory: boolean };
export function describeSimCall(r: SimCallResult): string;
export type ResendState = 'proven' | 'inconclusive' | 'unavailable' | 'not_available';
export interface ResendSimulation {
  state: ResendState;
  answer: string;
  checks: { ok: boolean; what: string }[];
  settlementBlock?: number;
  invoiceKey?: string;
  call?: { function: 'payInvoice'; to: string; from: string; args: { invoiceId: string; vendor: string; vendorId: string; payTo: string; amountUnits: string } };
  query?: { block: number; blockTime: string; chosenBecause: string; latestBlock: number };
  result?: SimCallResult;
  control?: { block: number; blockTime?: string; result: SimCallResult; summary: string };
}
export function simulateResend(o: { rpc: Rpc; verdict: PageVerdict; offset?: number }): Promise<ResendSimulation>;
export function verifyInvoice(o: { rpc: Rpc; vault: string; invoiceId: string; vendorId?: string; chainId?: number; explorerUrl?: string; txHash?: string }): Promise<PageVerdict>;
