/** Configuration from the environment, shared by the server and the operator CLI. */
import { parseEther, parseGwei, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { LOCAL_ANVIL_CHAIN_ID as ANVIL_CHAIN_ID, parseConfirmRule } from './finality.js';
import { loadMandate, type Mandate } from './mandate.js';
import type { ChainConfig } from './chain.js';
import type { FailPoint } from './payer.js';

export interface Config {
  rpcUrl: string;
  mandatePath: string;
  ledgerPath: string;
  port: number;
  /** Only the agent process has it; the operator CLI never needs it. */
  payerKey: Hex | undefined;
  failAt: FailPoint | undefined;
  mandate: Mandate;
  chain: ChainConfig;
}

/**
 * Foundry/Anvil's development accounts come from a published mnemonic: their keys are public. The
 * demo and the tests use them on a LOCAL chain; anything sent to them on a real network is swept by
 * bots. The agent refuses them (and the simulated crashes) on any chain other than Anvil's 31337.
 */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
let anvilAddresses: Set<string> | undefined;
export function isPublicAnvilKey(key: Hex): boolean {
  anvilAddresses ??= new Set(Array.from({ length: 20 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address.toLowerCase()));
  return anvilAddresses.has(privateKeyToAccount(key).address.toLowerCase());
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see packages/invoice-agent/README.md)`);
  return v;
}

export function loadConfig(): Config {
  const mandatePath = need('INVOICE_MANDATE');
  const mandate = loadMandate(mandatePath);
  const failAt = process.env['INVOICE_FAIL_AT']?.trim();
  if (failAt && failAt !== 'after-sign' && failAt !== 'after-broadcast') throw new Error('INVOICE_FAIL_AT must be after-sign or after-broadcast');
  const key = process.env['INVOICE_PAYER_KEY']?.trim();
  if (mandate.chainId !== ANVIL_CHAIN_ID) {
    if (key && isPublicAnvilKey(key as Hex)) {
      throw new Error(`INVOICE_PAYER_KEY is one of Anvil's public development keys: accepted only on a local Anvil chain (${ANVIL_CHAIN_ID}), not on chain ${mandate.chainId}`);
    }
    if (failAt) throw new Error(`INVOICE_FAIL_AT (simulated crashes) is accepted only on a local Anvil chain (${ANVIL_CHAIN_ID})`);
  }
  const confirmEnv = process.env['INVOICE_CONFIRMATION']?.trim();
  const confirm = confirmEnv ? parseConfirmRule(confirmEnv) : undefined;
  if (confirm?.kind === 'inclusion' && mandate.chainId !== ANVIL_CHAIN_ID) {
    throw new Error(`INVOICE_CONFIRMATION=inclusion is accepted only on a local Anvil chain (${ANVIL_CHAIN_ID}): on a public chain one block is not a confirmation`);
  }
  const known = KNOWN_NETWORKS[mandate.chainId];
  const explorerUrl = process.env['INVOICE_EXPLORER_URL']?.trim() || known?.explorerUrl;
  const fromEnv = process.env['INVOICE_LOGS_FROM_BLOCK']?.trim();
  if (fromEnv && !/^\d+$/.test(fromEnv)) throw new Error('INVOICE_LOGS_FROM_BLOCK must be a block number');
  const ceilingEnv = process.env['INVOICE_MAX_GAS_COST']?.trim();
  const maxGasCostWei = ceilingEnv ? parseGasCeiling(ceilingEnv) : undefined;
  const tipCapEnv = process.env['INVOICE_MAX_PRIORITY_FEE_GWEI']?.trim();
  const maxPriorityFeeWei = tipCapEnv ? parsePriorityFeeCap(tipCapEnv) : undefined;
  if (key && mandate.chainId !== ANVIL_CHAIN_ID && maxGasCostWei === undefined) {
    throw new Error(`INVOICE_MAX_GAS_COST is required on chain ${mandate.chainId}: the most one payment may cost in gas, in the native coin (e.g. 0.0001)`);
  }
  return {
    rpcUrl: need('INVOICE_RPC_URL'),
    mandatePath,
    ledgerPath: need('INVOICE_LEDGER'),
    port: Number(process.env['INVOICE_PORT'] ?? 8787),
    payerKey: key ? (key as Hex) : undefined,
    failAt: (failAt || undefined) as FailPoint | undefined,
    mandate,
    chain: {
      rpcUrl: need('INVOICE_RPC_URL'),
      chainId: mandate.chainId,
      token: mandate.token,
      ...(confirm ? { confirm } : {}),
      ...(explorerUrl ? { explorerUrl } : {}),
      ...(fromEnv ? { logsFromBlock: BigInt(fromEnv) } : {}),
      ...(maxGasCostWei !== undefined ? { maxGasCostWei } : {}),
      ...(maxPriorityFeeWei !== undefined ? { maxPriorityFeeWei } : {}),
      ...(mandate.vault ? { vault: mandate.vault, vaultVendorId: mandate.vendor.id } : {}),
    },
  };
}

/**
 * The operator's cap on the EIP-1559 tip (maxPriorityFeePerGas), in gwei as a plain decimal ("1", "0.5"; at most 9
 * decimals, above 0, at most 1000), to wei. Exact integer arithmetic (viem's parseGwei).
 */
export function parsePriorityFeeCap(v: string): bigint {
  if (!/^\d{1,4}(\.\d{1,9})?$/.test(v) || !/[1-9]/.test(v)) throw new Error(`the tip cap (INVOICE_MAX_PRIORITY_FEE_GWEI / --max-priority-fee-gwei) must be a plain decimal above 0 in gwei, e.g. 1; got "${v}"`);
  const wei = parseGwei(v);
  if (wei > parseGwei('1000')) throw new Error(`the tip cap must be at most 1000 gwei; got "${v}"`);
  return wei;
}

/**
 * The gas ceiling per transaction, in the native coin as a plain decimal ("0.0001"; at most 18
 * decimals, above 0), to wei. Exact integer arithmetic (viem's parseEther).
 */
export function parseGasCeiling(v: string): bigint {
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(v) || !/[1-9]/.test(v)) throw new Error(`INVOICE_MAX_GAS_COST must be a plain decimal above 0 in the native coin, e.g. 0.0001; got "${v}"`);
  return parseEther(v);
}

/**
 * Public networks this package knows, from the official QDay Builder Challenge page
 * (https://qday.io/builder-challenge) and its "Add QDay Aevum" wiki page, read 2026-11-19.
 */
export const KNOWN_NETWORKS: Record<number, { name: string; rpcUrl: string; explorerUrl: string; gasSymbol: string; tUSD8: string; tUSD8Decimals: number; faucet: string }> = {
  44005: {
    name: 'QDay Aevum Testnet',
    rpcUrl: 'https://rpc-test.qday.info',
    explorerUrl: 'https://explorer-test.qday.info',
    gasSymbol: 'tQDAY',
    tUSD8: '0x456569838f1d43009A91ebA4263147Afd7233483',
    tUSD8Decimals: 6,
    faucet: 'https://faucet.qday.info/en',
  },
};
