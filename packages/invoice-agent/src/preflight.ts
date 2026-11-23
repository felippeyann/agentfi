/**
 * `npm run preflight -- [options]`: read-only checks before a public session. Needs NO private key and
 * sends nothing: only `eth_*` reads on the RPC and GETs on the explorer.
 *
 *   --network aevum            QDay Aevum Testnet defaults (chain 44005, official RPC, explorer, tUSD8) [default]
 *   --rpc URL --chain-id N --token 0x… --explorer URL|none   override or describe another network
 *   --payer 0x…                the payer's PUBLIC address: tQDAY and tUSD8 balances, nonces
 *   --vendor 0x… --amount 1    with --payer: gas estimate of transfer(vendor, amount) and its cost in tQDAY
 *   --max-finalized-lag-min N  fail if the node's finalized block is more than N minutes behind the head
 *   --max-gas-cost 0.0001      the gas ceiling per transaction (native coin): fail if the transfer could cost more
 *                              [default 0.0001 on --network aevum]
 *   --vault 0x…                the payment goes through the operator's InvoiceMandate vault: --payer is then the AGENT's
 *                              public address (gas coin only). Reads the vault (code, operator, mandate vs agent / vendor /
 *                              payee, paused, expiry, limits, balance) and estimates payInvoice from the agent instead.
 *   --vendor-id vendor-1       the vendor id the vault names [vendor-1]   --invoice ID   the id whose payInvoice is estimated
 *
 * Exit 0 when every check passed, 1 otherwise. Every line says what was read and from where.
 */
import { createPublicClient, formatEther, getAddress, http, type Address, type Hex } from 'viem';
import { ERC20_ABI, makeChain, planTransfer } from './chain.js';
import { KNOWN_NETWORKS, parseGasCeiling } from './config.js';
import { formatUnits6, toBaseUnits } from './invoice.js';
import { readVault, VAULT_ABI, VaultRefusalError, vendorKey } from './vault.js';

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
  /** The operator's gas ceiling per transaction, wei: fail when the transfer could cost more. */
  maxGasCostWei?: bigint;
  /**
   * The operator's InvoiceMandate vault: the payment is then `vault.payInvoice` sent by the AGENT (`payer` is the agent's
   * public address, which needs only the gas coin) and the tUSD8 leave the vault. The vault's mandate must name this
   * agent, `vendorId` and `vendor` as payee, be unpaused and unexpired, and hold the amount within its limits.
   */
  vault?: Address;
  /** The vendor id as the mandate and the vault name it (default "vendor-1", the session's). */
  vendorId?: string;
  /** The invoice id whose payInvoice gas is estimated (an id the vault has settled makes the estimate revert). */
  invoiceId?: string;
}

export interface PreflightResult {
  ok: boolean;
  lines: string[];
  head?: bigint;
  gasCostWei?: bigint;
}

const SAFETY = 3n; // the payer should hold at least 3× the estimated gas cost
/** The gas ceiling proposed for the first Aevum session (native coin per transaction). */
export const DEFAULT_AEVUM_GAS_CEILING = '0.0001';

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

  // 4. The vault (only when the payment goes through one).
  const amount = toBaseUnits(o.amount);
  const vendorId = o.vendorId ?? 'vendor-1';
  if (o.vault) {
    const vcfg = { rpcUrl: o.rpcUrl, chainId: o.chainId, token: o.token, vault: o.vault };
    const vcode = await client.getCode({ address: o.vault });
    if (pass(!!vcode && vcode.length > 2, `vault ${o.vault} has contract code (${vcode ? (vcode.length - 2) / 2 : 0} bytes) [eth_getCode]`)) {
      const v = await readVault(vcfg);
      const [day, spentToday] = await Promise.all([
        client.readContract({ address: o.vault, abi: VAULT_ABI, functionName: 'day' }) as Promise<number>,
        client.readContract({ address: o.vault, abi: VAULT_ABI, functionName: 'spentToday' }) as Promise<number>,
      ]);
      const today = Number(latest.timestamp / 86_400n);
      const spent = Number(day) === today ? BigInt(spentToday) : 0n;
      info(`vault operator ${v.operator}; mandate: agent ${v.agent}, vendor "${v.vendorId}" → ${v.payTo}, ≤ ${formatUnits6(v.maxPerInvoice)} per invoice, ≤ ${formatUnits6(v.maxPerDay)} per UTC day (paid today ${formatUnits6(spent)}), until ${new Date(Number(v.expiresAt) * 1000).toISOString()} [eth_call mandate(), operator(), day(), spentToday()]`);
      pass(v.token === getAddress(o.token), `the vault's token is ${v.token} (expected ${o.token})`);
      if (o.payer) pass(v.agent === o.payer, `the vault's agent is ${v.agent}${v.agent === o.payer ? ', this agent' : `, NOT this agent ${o.payer}`}`);
      if (o.payer) pass(v.operator !== o.payer, 'the operator and the agent are different keys');
      if (o.vendor) pass(v.payTo === o.vendor, `the vault pays only ${v.payTo}${v.payTo === o.vendor ? ', this vendor' : `, NOT ${o.vendor}`}`);
      pass(v.vendor === vendorKey(vendorId), `the vault's vendor id is "${v.vendorId}" (the mandate's: "${vendorId}")`);
      pass(!v.paused, `the vault is ${v.paused ? 'PAUSED' : 'not paused'}`);
      pass(v.expiresAt > latest.timestamp, `the on-chain mandate ${v.expiresAt > latest.timestamp ? `expires in ${((Number(v.expiresAt) - Number(latest.timestamp)) / 3600).toFixed(1)} h` : 'has EXPIRED'}`);
      pass(amount <= v.maxPerInvoice && spent + amount <= v.maxPerDay, `${o.amount} ${symbol} is within the vault's cap per invoice and what is left of its daily limit (${formatUnits6(v.maxPerDay - (spent > v.maxPerDay ? v.maxPerDay : spent))})`);
      pass(v.balance >= amount, `the vault holds ${formatUnits6(v.balance)} ${symbol}, at least the invoice amount ${o.amount}`);
    }
  }

  // 5. The payer (the agent, with a vault) and vendor (public addresses only).
  if (o.payer) {
    const [native, units, nLatest, nPending] = await Promise.all([
      client.getBalance({ address: o.payer }),
      client.readContract({ address: o.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [o.payer] }) as Promise<bigint>,
      client.getTransactionCount({ address: o.payer, blockTag: 'latest' }),
      client.getTransactionCount({ address: o.payer, blockTag: 'pending' }),
    ]);
    const who = o.vault ? 'agent' : 'payer';
    info(`${who} ${o.payer}: ${formatEther(native)} ${o.gasSymbol}, ${formatUnits6(units)} ${symbol}, nonce ${nLatest} (pending ${nPending})`);
    if (!o.vault) pass(units >= amount, `payer holds at least the invoice amount ${o.amount} ${symbol}`);
    else info(`the agent needs no ${symbol}: the payment leaves the vault`);
    pass(nPending === nLatest, `${who} has no transaction waiting in the node's mempool (nonce latest ${nLatest} = pending ${nPending})`);
    if (o.vendor) {
      info(`vendor ${o.vendor}: ${formatUnits6((await client.readContract({ address: o.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [o.vendor] })) as bigint)} ${symbol}`);
      const invoiceId = o.invoiceId ?? 'PREFLIGHT-PROBE';
      const what = o.vault ? `vault.payInvoice("${invoiceId}", ${o.amount} ${symbol}) from the agent` : `transfer(${o.vendor}, ${o.amount} ${symbol}) from the payer`;
      try {
        // The SAME rule the signing path applies (chain.ts planTransfer): estimate + 20% margin, × maxFeePerGas.
        const plan = await planTransfer({ rpcUrl: o.rpcUrl, chainId: o.chainId, token: o.token, ...(o.vault ? { vault: o.vault } : {}) }, o.payer, o.vendor, amount, o.vault ? invoiceId : undefined);
        const cost = plan.maxCostWei;
        result.gasCostWei = cost;
        info(`gas for ${what}, as the agent will sign it: estimate ${plan.estimatedGas} + 20% = gas limit ${plan.gas} × max fee ${plan.maxFeePerGas} wei = at most ${cost} wei = ${formatEther(cost)} ${o.gasSymbol} [eth_estimateGas, eth_feeHistory]`);
        if (o.maxGasCostWei !== undefined) {
          info(`${o.vault ? 'vault payment' : 'transfer'} maximum ${formatEther(cost)} ${o.gasSymbol} · ceiling ${formatEther(o.maxGasCostWei)} ${o.gasSymbol}${o.vault ? ' (the ceiling is the owner\'s decision; the vault call costs more gas than a direct transfer)' : ''}`);
          pass(cost <= o.maxGasCostWei, `that maximum is within the ceiling of ${formatEther(o.maxGasCostWei)} ${o.gasSymbol} (${o.maxGasCostWei} wei) per transaction${cost <= o.maxGasCostWei ? `, ${o.maxGasCostWei - cost} wei to spare` : `: ${cost - o.maxGasCostWei} wei above`}. The agent checks it again on the transaction it signs, and refuses to sign above it`);
        }
        pass(native >= cost * SAFETY, `${who} holds at least ${SAFETY}× that gas (${formatEther(cost * SAFETY)} ${o.gasSymbol})`);
      } catch (e) {
        if (e instanceof VaultRefusalError) pass(false, `the vault would refuse ${what}: ${e.errorName}${e.args.length ? ` (${e.args.map(String).join(', ')})` : ''} [eth_estimateGas]`);
        else pass(false, `gas estimate failed (the ${o.vault ? 'vault call' : 'transfer'} would revert from this ${who}?): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
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
  const vault = addr(get('vault'));
  return {
    ...(vault ? { vault } : {}),
    ...(get('vendor-id') ? { vendorId: get('vendor-id')! } : {}),
    ...(get('invoice') ? { invoiceId: get('invoice')! } : {}),
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
    ...((get('max-gas-cost') ?? (known ? DEFAULT_AEVUM_GAS_CEILING : undefined)) ? { maxGasCostWei: parseGasCeiling(get('max-gas-cost') ?? DEFAULT_AEVUM_GAS_CEILING) } : {}),
  } satisfies PreflightOptions;
}

const isMain = process.argv[1] && /preflight\.ts$/.test(process.argv[1]);
if (isMain) {
  (async () => {
    const o = args(process.argv.slice(2));
    console.log(`Preflight (read-only, no key) · chain ${o.chainId} · ${o.rpcUrl} · token ${o.token}${o.vault ? ` · vault ${o.vault}` : ''}${o.payer ? ` · ${o.vault ? 'agent' : 'payer'} ${o.payer}` : ''}${o.vendor ? ` · vendor ${o.vendor}` : ''}`);
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
