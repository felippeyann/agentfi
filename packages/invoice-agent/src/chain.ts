/**
 * Everything the agent and the operator read from or send to the chain. The payment is a plain
 * ERC-20 `transfer(payTo, amount)` sent by the payer's own address (an EOA): the token contract moves
 * the balance and emits `Transfer(payer, payTo, amount)`. No escrow, no allowance, no relayer.
 *
 * The transaction is SIGNED LOCALLY first (`signTransfer`), so its hash is known before anything is
 * sent; broadcasting the same signed bytes again is harmless (same hash, same nonce: it can be mined
 * at most once).
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ConfirmRule } from './finality.js';
import { INVOICE_MANDATE_ABI } from './generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI } from './generated/local-test-usd8.js';
import { VaultRefusalError, vaultErrorOf } from './vault.js';

export const ERC20_ABI = LOCAL_TEST_USD8_ABI;

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
  token: string;
  /** When a payment counts as confirmed (see finality.ts). Default: inclusion on 31337, finalized elsewhere. */
  confirm?: ConfirmRule;
  /** Block explorer base URL (receipts link to `<explorer>/tx/<hash>`). */
  explorerUrl?: string;
  /** First block the operator's Transfer counts read (default 0). */
  logsFromBlock?: bigint;
  /** Most one payment transaction may cost in gas, wei (gas limit × maxFeePerGas). Required off 31337. */
  maxGasCostWei?: bigint;
  /**
   * The operator's InvoiceMandate vault (vault.ts), when the mandate names one: payments are then
   * `vault.payInvoice(invoiceId, amount)` and the tokens leave the vault, not the agent's address.
   */
  vault?: string;
}

/** Where the paid tokens come from: the vault when there is one, otherwise the payer's own address. */
export function fundsSource(cfg: ChainConfig, payer: string): string {
  return getAddress(cfg.vault ?? payer);
}

/** The payment call: `vault.payInvoice(invoiceId, amount)` with a vault, `token.transfer(to, amount)` without. */
export function paymentCall(cfg: ChainConfig, to: string, amount: bigint, invoiceId?: string): { to: `0x${string}`; data: Hex } {
  if (cfg.vault) {
    if (!invoiceId) throw new Error('a vault payment needs the invoice id');
    return { to: getAddress(cfg.vault), data: encodeFunctionData({ abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args: [invoiceId, amount] }) };
  }
  return { to: getAddress(cfg.token), data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(to), amount] }) };
}

export function makeChain(cfg: ChainConfig) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 44005 ? 'QDay Aevum Testnet' : `local-${cfg.chainId}`,
    nativeCurrency: { name: cfg.chainId === 44005 ? 'tQDAY' : 'ETH', symbol: cfg.chainId === 44005 ? 'tQDAY' : 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

export function publicClientFor(cfg: ChainConfig): PublicClient {
  return createPublicClient({ chain: makeChain(cfg), transport: http(cfg.rpcUrl) }) as PublicClient;
}

export interface SignedTransfer {
  raw: Hex;
  hash: Hex;
  nonce: number;
  /** gas × maxFeePerGas of the signed transaction, wei. */
  maxCostWei: bigint;
}

/**
 * The node behind INVOICE_RPC_URL must serve the mandate's chain: the key guard, the receipts and the
 * signatures all assume it. Checked at startup (agent and ops) and before every signature.
 */
export async function assertNodeChain(cfg: ChainConfig): Promise<void> {
  const actual = await publicClientFor(cfg).getChainId();
  if (actual !== cfg.chainId) {
    throw new Error(`the node at ${cfg.rpcUrl} serves chain ${actual}, but the mandate is for chain ${cfg.chainId}: nothing is signed or reported against the wrong chain`);
  }
}

/**
 * THE gas rule, shared by the preflight and the signing path (so what the operator is shown is what
 * the transaction will authorize): gas limit = the node's estimate + 20% margin (integer division),
 * maxFeePerGas and maxPriorityFeePerGas = viem's `estimateFeesPerGas()` (EIP-1559), and the most the
 * transaction can ever cost = gas limit × maxFeePerGas, in wei.
 */
export const GAS_MARGIN_NUM = 12n;
export const GAS_MARGIN_DEN = 10n;

export interface TransferPlan {
  data: Hex;
  estimatedGas: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** gas × maxFeePerGas, wei: the most this transaction can cost. */
  maxCostWei: bigint;
}

/**
 * With a vault, the call planned is `vault.payInvoice(invoiceId, amount)` (the same gas rule and ceiling apply), and
 * an estimate the vault reverts (already settled, paused, revoked, expired, above a limit) is a VaultRefusalError:
 * the chain has refused it before anything is signed.
 */
export async function planTransfer(cfg: ChainConfig, from: string, to: string, amount: bigint, invoiceId?: string): Promise<TransferPlan> {
  const client = publicClientFor(cfg);
  const call = paymentCall(cfg, to, amount, invoiceId);
  const data = call.data;
  let estimatedGas: bigint;
  try {
    estimatedGas = await client.estimateGas({ account: getAddress(from), to: call.to, data });
  } catch (e) {
    const refusal = cfg.vault ? vaultErrorOf(e) : undefined;
    if (refusal) throw new VaultRefusalError(refusal.name, refusal.args);
    throw e;
  }
  const fees = await client.estimateFeesPerGas();
  const gas = (estimatedGas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
  return { data, estimatedGas, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxCostWei: gas * fees.maxFeePerGas };
}

/** Thrown BEFORE signing when the prepared transaction could cost more than the operator's ceiling. Nothing was signed or sent. */
export class GasCeilingError extends Error {
  constructor(public maxCostWei: bigint, public ceilingWei: bigint, public gas: bigint, public maxFeePerGas: bigint) {
    super(`the transaction could cost up to ${maxCostWei} wei (gas ${gas} × max fee ${maxFeePerGas} wei), above the ceiling of ${ceilingWei} wei: not signed, not sent`);
  }
}

/** Counters for tests and the operator's evidence: signatures produced by this process. */
export const signingStats = { signatures: 0, ceilingRefusals: 0 };

/**
 * Signs `token.transfer(to, amount)` from the payer key with the given nonce; nothing is sent.
 * Immediately before signing, the EFFECTIVE fields of the prepared transaction (its gas limit and its
 * maxFeePerGas, or gasPrice for a legacy one) are multiplied and compared with `cfg.maxGasCostWei`:
 * above it, GasCeilingError and no signature.
 */
export async function signTransfer(cfg: ChainConfig, payerKey: Hex, to: string, amount: bigint, nonce: number, invoiceId?: string): Promise<SignedTransfer> {
  await assertNodeChain(cfg);
  const account = privateKeyToAccount(payerKey);
  const plan = await planTransfer(cfg, account.address, to, amount, invoiceId);
  const target = paymentCall(cfg, to, amount, invoiceId).to;
  const wallet = createWalletClient({ account, chain: makeChain(cfg), transport: http(cfg.rpcUrl) });
  const request = await wallet.prepareTransactionRequest({
    to: target,
    data: plan.data,
    nonce,
    gas: plan.gas,
    maxFeePerGas: plan.maxFeePerGas,
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    // Pinned here, never taken from the node (viem would otherwise ask the RPC to fill them).
    chainId: cfg.chainId,
    type: 'eip1559',
    chain: makeChain(cfg),
  });
  // Every field that ends up in the signed bytes is checked against what the agent decided.
  const r = request as { to?: string; data?: Hex; nonce?: number; chainId?: number; type?: string; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint; value?: bigint };
  const mismatch = [
    r.chainId !== cfg.chainId && `chainId ${r.chainId} ≠ ${cfg.chainId}`,
    r.type !== 'eip1559' && `type ${r.type} ≠ eip1559`,
    r.gasPrice !== undefined && 'a legacy gasPrice',
    (r.to ?? '').toLowerCase() !== target.toLowerCase() && `to ${r.to} ≠ ${cfg.vault ? 'the vault' : 'the token'} ${target}`,
    r.data !== plan.data && 'calldata changed',
    r.nonce !== nonce && `nonce ${r.nonce} ≠ ${nonce}`,
    (r.value ?? 0n) !== 0n && `value ${r.value} ≠ 0`,
    r.gas !== plan.gas && `gas ${r.gas} ≠ ${plan.gas}`,
    r.maxFeePerGas !== plan.maxFeePerGas && `maxFeePerGas ${r.maxFeePerGas} ≠ ${plan.maxFeePerGas}`,
    r.maxPriorityFeePerGas !== plan.maxPriorityFeePerGas && `maxPriorityFeePerGas ${r.maxPriorityFeePerGas} ≠ ${plan.maxPriorityFeePerGas}`,
  ].filter(Boolean);
  if (mismatch.length > 0) throw new Error(`the prepared transaction differs from what the agent decided (${mismatch.join('; ')}): not signed`);
  const maxCost = r.gas! * r.maxFeePerGas!;
  if (cfg.maxGasCostWei !== undefined && maxCost > cfg.maxGasCostWei) {
    signingStats.ceilingRefusals++;
    throw new GasCeilingError(maxCost, cfg.maxGasCostWei, r.gas!, r.maxFeePerGas!);
  }
  const raw = await account.signTransaction(request as never);
  signingStats.signatures++;
  return { raw, hash: keccak256(raw), nonce, maxCostWei: maxCost };
}

export async function broadcast(cfg: ChainConfig, raw: Hex): Promise<'sent' | 'already-known'> {
  const client = publicClientFor(cfg);
  try {
    await client.request({ method: 'eth_sendRawTransaction', params: [raw] });
    return 'sent';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The node already has (or already mined) these exact bytes: not an error for an idempotent rebroadcast.
    if (/already known|known transaction|already imported|nonce too low/i.test(msg)) return 'already-known';
    throw e;
  }
}

/**
 * The receipt, or null when the node says it has none. Any OTHER failure (timeout, 429, 503, a
 * node that cannot be reached) is thrown: "the RPC failed" must never be read as "not on-chain".
 */
export async function receiptOf(cfg: ChainConfig, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClientFor(cfg).getTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return null;
    throw e;
  }
}

/** Whether the node knows the transaction (mined or in its mempool). Transport failures are thrown. */
export async function isKnownToNode(cfg: ChainConfig, hash: Hex): Promise<boolean> {
  try {
    return (await publicClientFor(cfg).getTransaction({ hash })) !== null;
  } catch (e) {
    if (e instanceof TransactionNotFoundError) return false;
    throw e;
  }
}

/** The payer's next nonce as mined (`latest`) and as known to the node including its mempool (`pending`). */
export async function nonces(cfg: ChainConfig, payer: string): Promise<{ latest: number; pending: number }> {
  const c = publicClientFor(cfg);
  const [latest, pending] = await Promise.all([
    c.getTransactionCount({ address: getAddress(payer), blockTag: 'latest' }),
    c.getTransactionCount({ address: getAddress(payer), blockTag: 'pending' }),
  ]);
  return { latest, pending };
}

export interface TransferLog {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
}

/** The token Transfer logs in a receipt. */
export function transfersIn(cfg: ChainConfig, receipt: TransactionReceipt): TransferLog[] {
  const logs = parseEventLogs({ abi: ERC20_ABI, eventName: 'Transfer', logs: receipt.logs.filter((l) => getAddress(l.address) === getAddress(cfg.token)) });
  return logs.map((l) => ({
    txHash: l.transactionHash!,
    blockNumber: l.blockNumber!,
    logIndex: l.logIndex!,
    from: getAddress(l.args.from),
    to: getAddress(l.args.to),
    value: l.args.value,
  }));
}

/**
 * Every token Transfer from `from` (optionally to `to`) since `cfg.logsFromBlock` (block 0 by
 * default; on a public chain, a block before the payer's first payment): the operator's independent
 * count. Read in windows of `LOG_WINDOW` blocks, which public RPCs accept.
 */
const LOG_WINDOW = 50_000n;
export async function transfersFrom(cfg: ChainConfig, from: string, to?: string): Promise<TransferLog[]> {
  const client = publicClientFor(cfg);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const logs = [];
  for (let start = cfg.logsFromBlock ?? 0n; start <= head; start += LOG_WINDOW) {
    const end = start + LOG_WINDOW - 1n < head ? start + LOG_WINDOW - 1n : head;
    logs.push(...(await client.getContractEvents({
      address: getAddress(cfg.token),
      abi: ERC20_ABI,
      eventName: 'Transfer',
      args: { from: getAddress(from), ...(to ? { to: getAddress(to) } : {}) },
      fromBlock: start,
      toBlock: end,
    })));
  }
  return logs.map((l) => ({
    txHash: l.transactionHash!,
    blockNumber: l.blockNumber!,
    logIndex: l.logIndex!,
    from: getAddress(l.args.from!),
    to: getAddress(l.args.to!),
    value: l.args.value!,
  }));
}

export async function balanceOf(cfg: ChainConfig, who: string): Promise<bigint> {
  return (await publicClientFor(cfg).readContract({ address: getAddress(cfg.token), abi: ERC20_ABI, functionName: 'balanceOf', args: [getAddress(who)] })) as bigint;
}
