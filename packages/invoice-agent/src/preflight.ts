/**
 * `npm run preflight -- [options]`: read-only checks before a public session. Needs NO private key and
 * sends nothing: only `eth_*` reads on the RPC and GETs on the explorer.
 *
 *   --network aevum            QDay Aevum Testnet defaults (chain 44005, official RPC, explorer, tUSD8) [default]
 *   --rpc URL --chain-id N --token 0x… --explorer URL|none   override or describe another network
 *   --payer 0x…                the payer's PUBLIC address: tQDAY and tUSD8 balances, nonces
 *   --vendor 0x… --amount 1    with --payer: gas estimate of transfer(vendor, amount) and its cost in tQDAY
 *   --max-finalized-lag-min N  fail if the node's finalized block is more than N minutes behind the head
 *
 * Exit 0 when every check passed, 1 otherwise. Every line says what was read and from where.
 */
import { createPublicClient, formatEther, getAddress, http, type Address, type Hex } from 'viem';
import { ERC20_ABI, makeChain } from './chain.js';
import { KNOWN_NETWORKS } from './config.js';
import { formatUnits6, toBaseUnits } from './invoice.js';

export interface PreflightOptions {
  rpcUrl: string;
  chainId: number;
  token: Address;
  explorerUrl: string | null;
  gasSymbol: string;
  expectedDecimals: number;
  payer?: Address;
  vendor?: Address;
  amount: string;
  /** Fail when the node's finalized block is further behind the head than this (the session could not confirm in time). */
  maxFinalizedLagSec?: number;
}

export interface PreflightResult {
  ok: boolean;
  lines: string[];
  head?: bigint;
  gasCostWei?: bigint;
}

const SAFETY = 3n; // the payer should hold at least 3× the estimated gas cost

export async function preflight(o: PreflightOptions): Promise<PreflightResult> {
  const lines: string[] = [];
  let ok = true;
  const pass = (good: boolean, what: string) => {
    lines.push(`${good ? '✓' : '✗'} ${what}`);
    if (!good) ok = false;
    return good;
  };
  const info = (what: string) => lines.push(`  ${what}`);
  const client = createPublicClient({ chain: makeChain({ rpcUrl: o.rpcUrl, chainId: o.chainId, token: o.token }), transport: http(o.rpcUrl, { timeout: 20_000 }) });
  const result: PreflightResult = { ok: false, lines };

  // 1. The network the node says it serves.
  const nodeChain = await client.getChainId();
  if (!pass(nodeChain === o.chainId, `RPC ${o.rpcUrl} serves chain ${nodeChain} (expected ${o.chainId}) [eth_chainId]`)) return { ...result, ok: false };
  const clientVersion = await client.request({ method: 'web3_clientVersion' as never }).catch(() => 'unknown');
  info(`node: ${String(clientVersion)}`);
  const [latest, finalized] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' })]);
  result.head = latest.number;
  const old = await client.getBlock({ blockNumber: latest.number > 50n ? latest.number - 50n : 0n });
  const blockTime = latest.number > old.number ? Number(latest.timestamp - old.timestamp) / Number(latest.number - old.number) : 0;
  info(`head block ${latest.number} (${new Date(Number(latest.timestamp) * 1000).toISOString()}), average block time over the last 50 blocks ${blockTime.toFixed(2)} s`);
  pass(finalized.number <= latest.number, `the node answers "finalized": block ${finalized.number}, ${latest.number - finalized.number} blocks (${Number(latest.timestamp - finalized.timestamp)} s) behind the head [eth_getBlockByNumber("finalized")] — a receipt is confirmed only once its block is at or below it`);

  if (o.maxFinalizedLagSec !== undefined) {
    const lag = Number(latest.timestamp - finalized.timestamp);
    pass(lag <= o.maxFinalizedLagSec, `the finalized block is ${Math.round(lag / 60)} min behind the head, within the session's wait of ${Math.round(o.maxFinalizedLagSec / 60)} min (otherwise a payment would stay pending past the session)`);
  }

  // 2. The token.
  const code = await client.getCode({ address: o.token });
  pass(!!code && code.length > 2, `token ${o.token} has contract code (${code ? (code.length - 2) / 2 : 0} bytes) [eth_getCode]`);
  const read = <T>(functionName: 'decimals' | 'symbol' | 'name') => client.readContract({ address: o.token, abi: ERC20_ABI, functionName }) as Promise<T>;
  const [decimals, symbol, name] = await Promise.all([read<number>('decimals'), read<string>('symbol').catch(() => '?'), read<string>('name').catch(() => '?')]);
  pass(Number(decimals) === o.expectedDecimals, `decimals() = ${decimals} (expected ${o.expectedDecimals}); symbol() = ${symbol}; name() = ${name} [eth_call]`);

  // 3. The explorer (a third party can check the receipt there).
  if (o.explorerUrl) {
    const base = o.explorerUrl.replace(/\/$/, '');
    try {
      const t = (await (await fetch(`${base}/api/v2/tokens/${o.token}`)).json()) as { decimals?: string; symbol?: string; name?: string };
      pass(Number(t.decimals) === o.expectedDecimals && t.symbol === symbol, `explorer ${base} knows the token: ${t.name} (${t.symbol}), ${t.decimals} decimals [GET /api/v2/tokens/<token>]`);
      const eb = (await (await fetch(`${base}/api?module=block&action=eth_block_number`)).json()) as { result?: string };
      const explorerHead = BigInt(eb.result ?? '0x0');
      const gap = latest.number > explorerHead ? latest.number - explorerHead : explorerHead - latest.number;
      pass(gap < 600n, `explorer follows the same chain: its head ${explorerHead}, the RPC's ${latest.number} (${gap} apart) [GET /api?module=block&action=eth_block_number]`);
      info(`a transaction will be at ${base}/tx/<hash>; the token at ${base}/token/${o.token}`);
    } catch (e) {
      pass(false, `explorer ${base} did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    info('no explorer for this network (local chain): receipts are checked with `ops verify` only');
  }

  // 4. The payer and vendor (public addresses only).
  if (o.payer) {
    const [native, units, nLatest, nPending] = await Promise.all([
      client.getBalance({ address: o.payer }),
      client.readContract({ address: o.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [o.payer] }) as Promise<bigint>,
      client.getTransactionCount({ address: o.payer, blockTag: 'latest' }),
      client.getTransactionCount({ address: o.payer, blockTag: 'pending' }),
    ]);
    const amount = toBaseUnits(o.amount);
    info(`payer ${o.payer}: ${formatEther(native)} ${o.gasSymbol}, ${formatUnits6(units)} ${symbol}, nonce ${nLatest} (pending ${nPending})`);
    pass(units >= amount, `payer holds at least the invoice amount ${o.amount} ${symbol}`);
    pass(nPending === nLatest, `payer has no transaction waiting in the node's mempool (nonce latest ${nLatest} = pending ${nPending})`);
    if (o.vendor) {
      info(`vendor ${o.vendor}: ${formatUnits6((await client.readContract({ address: o.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [o.vendor] })) as bigint)} ${symbol}`);
      try {
        const gas = await client.estimateContractGas({ address: o.token, abi: ERC20_ABI, functionName: 'transfer', args: [o.vendor, amount], account: o.payer });
        const fees = await client.estimateFeesPerGas();
        const cost = gas * fees.maxFeePerGas;
        result.gasCostWei = cost;
        info(`gas for transfer(${o.vendor}, ${o.amount} ${symbol}) from the payer: ${gas} units × max fee ${fees.maxFeePerGas} wei = at most ${formatEther(cost)} ${o.gasSymbol} [eth_estimateGas, eth_feeHistory]`);
        pass(native >= cost * SAFETY, `payer holds at least ${SAFETY}× that gas (${formatEther(cost * SAFETY)} ${o.gasSymbol})`);
      } catch (e) {
        pass(false, `gas estimate failed (the transfer would revert from this payer?): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    } else {
      info('add --vendor 0x… to estimate the gas of the payment');
    }
  } else {
    info('add --payer 0x… (public address) to check balances and the mempool, and --vendor 0x… for the gas estimate');
  }
  return { ...result, ok };
}

function args(argv: string[]) {
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const network = get('network') ?? (get('rpc') ? undefined : 'aevum');
  const known = network === 'aevum' ? KNOWN_NETWORKS[44005]! : undefined;
  if (network && !known) throw new Error(`unknown --network ${network} (known: aevum)`);
  const rpcUrl = get('rpc') ?? known?.rpcUrl;
  const chainId = Number(get('chain-id') ?? (known ? 44005 : NaN));
  const token = get('token') ?? known?.tUSD8;
  if (!rpcUrl || !Number.isSafeInteger(chainId) || !token) throw new Error('needs --network aevum, or --rpc, --chain-id and --token');
  const explorer = get('explorer');
  const addr = (v: string | undefined) => (v ? getAddress(v) : undefined);
  const payer = addr(get('payer'));
  const vendor = addr(get('vendor'));
  return {
    rpcUrl,
    chainId,
    token: getAddress(token),
    explorerUrl: explorer === 'none' ? null : (explorer ?? known?.explorerUrl ?? null),
    gasSymbol: known?.gasSymbol ?? 'ETH',
    expectedDecimals: Number(get('decimals') ?? known?.tUSD8Decimals ?? 6),
    ...(payer ? { payer } : {}),
    ...(vendor ? { vendor } : {}),
    amount: get('amount') ?? '1',
    ...(get('max-finalized-lag-min') ? { maxFinalizedLagSec: Number(get('max-finalized-lag-min')) * 60 } : {}),
  } satisfies PreflightOptions;
}

const isMain = process.argv[1] && /preflight\.ts$/.test(process.argv[1]);
if (isMain) {
  (async () => {
    const o = args(process.argv.slice(2));
    console.log(`Preflight (read-only, no key) · chain ${o.chainId} · ${o.rpcUrl} · token ${o.token}${o.payer ? ` · payer ${o.payer}` : ''}${o.vendor ? ` · vendor ${o.vendor}` : ''}`);
    const r = await preflight(o);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? 'PREFLIGHT OK' : 'PREFLIGHT FAILED: do not start the session');
    process.exitCode = r.ok ? 0 : 1;
  })().catch((e) => {
    console.error(`PREFLIGHT ERROR: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    process.exitCode = 1;
  });
}

export type { Hex };
