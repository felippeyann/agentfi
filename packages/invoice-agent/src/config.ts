/** Configuration from the environment, shared by the server and the operator CLI. */
import type { Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
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
export const ANVIL_CHAIN_ID = 31337;
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
  return {
    rpcUrl: need('INVOICE_RPC_URL'),
    mandatePath,
    ledgerPath: need('INVOICE_LEDGER'),
    port: Number(process.env['INVOICE_PORT'] ?? 8787),
    payerKey: key ? (key as Hex) : undefined,
    failAt: (failAt || undefined) as FailPoint | undefined,
    mandate,
    chain: { rpcUrl: need('INVOICE_RPC_URL'), chainId: mandate.chainId, token: mandate.token },
  };
}
