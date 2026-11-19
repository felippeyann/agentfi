/** Configuration from the environment, shared by the server and the operator CLI. */
import type { Hex } from 'viem';
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
