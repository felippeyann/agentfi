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
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LOCAL_TEST_USD8_ABI } from './generated/local-test-usd8.js';

export const ERC20_ABI = LOCAL_TEST_USD8_ABI;

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
  token: string;
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
}

/** Signs `token.transfer(to, amount)` from the payer key with the given nonce; nothing is sent. */
export async function signTransfer(cfg: ChainConfig, payerKey: Hex, to: string, amount: bigint, nonce: number): Promise<SignedTransfer> {
  const account = privateKeyToAccount(payerKey);
  const client = publicClientFor(cfg);
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(to), amount] });
  const gas = await client.estimateGas({ account: account.address, to: getAddress(cfg.token), data });
  const fees = await client.estimateFeesPerGas();
  const wallet = createWalletClient({ account, chain: makeChain(cfg), transport: http(cfg.rpcUrl) });
  const request = await wallet.prepareTransactionRequest({
    to: getAddress(cfg.token),
    data,
    nonce,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chain: makeChain(cfg),
  });
  const raw = await account.signTransaction(request as never);
  return { raw, hash: keccak256(raw), nonce };
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

export async function receiptOf(cfg: ChainConfig, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClientFor(cfg).getTransactionReceipt({ hash });
  } catch {
    return null;
  }
}

export async function isInMempool(cfg: ChainConfig, hash: Hex): Promise<boolean> {
  try {
    return (await publicClientFor(cfg).getTransaction({ hash })) !== null;
  } catch {
    return false;
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

/** Every token Transfer from `from` (optionally to `to`) since block 0: the operator's independent count. */
export async function transfersFrom(cfg: ChainConfig, from: string, to?: string): Promise<TransferLog[]> {
  const logs = await publicClientFor(cfg).getContractEvents({
    address: getAddress(cfg.token),
    abi: ERC20_ABI,
    eventName: 'Transfer',
    args: { from: getAddress(from), ...(to ? { to: getAddress(to) } : {}) },
    fromBlock: 0n,
    toBlock: 'latest',
  });
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
