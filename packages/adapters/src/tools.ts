/**
 * The tool catalog shared by every adapter (OpenAI function calling, LangChain).
 *
 * Two tiers:
 *
 *  - ALPHA (default): what a payer agent needs for the x402 first experience.
 *    `agentfi_pay_for_resource` (the one tool that spends) plus two read-only
 *    tools. There is NO tool that approves, rejects, pauses, edits a policy,
 *    changes a budget, reconciles a payment or registers an agent: those are
 *    operator actions and must never reach the paying agent.
 *
 *  - LEGACY (opt-in with `legacyDefi: true`): the pre-alpha DeFi tools (swap,
 *    transfer, Aave). Not part of the alpha path; they move funds outside any
 *    job budget. Kept so existing users are not broken, not recommended.
 *
 * Adapters only translate. Financial rules (budget, policy, idempotency,
 * reconciliation) are enforced by the AgentFi backend.
 */
import type { AgentFiClient } from './client.js';
import {
  PAY_RESOURCE_DESCRIPTION,
  PAY_RESOURCE_PARAMETERS,
  PAY_RESOURCE_TOOL_NAME,
  payForResource,
  type PayResourceArgs,
} from './pay-resource.js';

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: readonly string[];
}

export interface AgentFiToolDef {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  tier: 'alpha' | 'legacy';
  run: (client: AgentFiClient, args: Record<string, unknown>) => Promise<unknown>;
}

const chainId = { type: 'number', description: 'Chain ID: 1=Ethereum, 8453=Base, 42161=Arbitrum, 137=Polygon, 84532=Base Sepolia', default: 1 };

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${key} is required`);
  return v;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const TOOL_CATALOG: readonly AgentFiToolDef[] = [
  // ── ALPHA ───────────────────────────────────────────────────────────────
  {
    name: PAY_RESOURCE_TOOL_NAME,
    description: PAY_RESOURCE_DESCRIPTION,
    parameters: PAY_RESOURCE_PARAMETERS as unknown as JsonSchemaObject,
    tier: 'alpha',
    run: (client, args) => payForResource(client, args as unknown as PayResourceArgs),
  },
  {
    name: 'agentfi_get_job',
    description:
      'Read-only. Returns one job you are the requester or provider of (status, reward, payload). Use it to confirm the job is ACCEPTED before paying a resource. It does not show payments: the state of a payment is in the pay_for_resource answer.',
    parameters: { type: 'object', properties: { job_id: { type: 'string', description: 'Job ID' } }, required: ['job_id'] },
    tier: 'alpha',
    run: (client, args) => {
      const id = str(args, 'job_id');
      if (!SAFE_ID.test(id)) throw new Error('job_id has invalid characters');
      return client.get(`/v1/jobs/${encodeURIComponent(id)}`);
    },
  },
  {
    name: 'agentfi_get_wallet_info',
    description: "Read-only. Returns the agent's wallet address and token balances.",
    parameters: { type: 'object', properties: { chain_id: chainId } },
    tier: 'alpha',
    run: (client, args) => {
      const cid = args['chain_id'];
      return client.get(`/v1/wallet/balance${cid ? `?chainId=${encodeURIComponent(String(cid))}` : ''}`);
    },
  },

  // ── LEGACY (opt-in) ─────────────────────────────────────────────────────
  {
    name: 'agentfi_simulate_swap',
    description: '[LEGACY, not part of the alpha path] Simulates a Uniswap V3 swap; returns a simulation_id required by agentfi_execute_swap.',
    parameters: {
      type: 'object',
      properties: {
        from_token: { type: 'string', description: 'Token to sell (address or symbol)' },
        to_token: { type: 'string', description: 'Token to buy (address or symbol)' },
        amount_in: { type: 'string', description: 'Amount in human-readable units e.g. "1.5"' },
        chain_id: chainId,
        slippage_tolerance: { type: 'number', description: 'Max slippage % e.g. 0.5', default: 0.5 },
      },
      required: ['from_token', 'to_token', 'amount_in'],
    },
    tier: 'legacy',
    run: (client, a) =>
      client.post('/v1/transactions/simulate', {
        fromToken: a['from_token'], toToken: a['to_token'], amountIn: a['amount_in'],
        chainId: a['chain_id'] ?? 1, slippageTolerance: a['slippage_tolerance'] ?? 0.5,
      }),
  },
  {
    name: 'agentfi_execute_swap',
    description: '[LEGACY, not part of the alpha path] Executes a Uniswap V3 swap. Requires the simulation_id of agentfi_simulate_swap. Moves funds outside any job budget; pass the same idempotency_key when retrying.',
    parameters: {
      type: 'object',
      properties: {
        from_token: { type: 'string', description: 'Token to sell' },
        to_token: { type: 'string', description: 'Token to buy' },
        amount_in: { type: 'string', description: 'Amount to sell' },
        chain_id: chainId,
        slippage_tolerance: { type: 'number', description: 'Max slippage % e.g. 0.5', default: 0.5 },
        simulation_id: { type: 'string', description: 'simulation_id from agentfi_simulate_swap' },
        idempotency_key: { type: 'string', description: 'Reuse the same key when retrying' },
      },
      required: ['from_token', 'to_token', 'amount_in', 'simulation_id'],
    },
    tier: 'legacy',
    run: (client, a) =>
      client.post('/v1/transactions/swap', {
        fromToken: a['from_token'], toToken: a['to_token'], amountIn: a['amount_in'],
        chainId: a['chain_id'] ?? 1, slippageTolerance: a['slippage_tolerance'] ?? 0.5,
        simulationId: a['simulation_id'],
        ...(a['idempotency_key'] !== undefined ? { idempotencyKey: a['idempotency_key'] } : {}),
      }),
  },
  {
    name: 'agentfi_transfer_token',
    description: '[LEGACY, not part of the alpha path] Transfers ETH or an ERC-20 token to an address. Moves funds outside any job budget.',
    parameters: {
      type: 'object',
      properties: {
        token: { type: 'string', description: '"ETH" for the native asset, or an ERC-20 contract address' },
        to: { type: 'string', description: 'Destination address' },
        amount: { type: 'string', description: 'Amount in human-readable units' },
        chain_id: chainId,
      },
      required: ['token', 'to', 'amount'],
    },
    tier: 'legacy',
    run: (client, a) =>
      client.post('/v1/transactions/transfer', { token: a['token'], to: a['to'], amount: a['amount'], chainId: a['chain_id'] ?? 1 }),
  },
  {
    name: 'agentfi_deposit_aave',
    description: '[LEGACY, not part of the alpha path] Supplies an asset to Aave V3.',
    parameters: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'ERC-20 token address to supply' },
        amount: { type: 'string', description: 'Amount to supply' },
        chain_id: chainId,
      },
      required: ['asset', 'amount'],
    },
    tier: 'legacy',
    run: (client, a) =>
      client.post('/v1/transactions/deposit', { asset: a['asset'], amount: a['amount'], chainId: a['chain_id'] ?? 1 }),
  },
  {
    name: 'agentfi_get_transaction_status',
    description: '[LEGACY] Read-only. Status of a transaction submitted by the legacy swap/transfer/deposit tools.',
    parameters: { type: 'object', properties: { transaction_id: { type: 'string', description: 'transaction_id returned by those tools' } }, required: ['transaction_id'] },
    tier: 'legacy',
    run: (client, a) => {
      const id = str(a, 'transaction_id');
      if (!SAFE_ID.test(id)) throw new Error('transaction_id has invalid characters');
      return client.get(`/v1/transactions/${encodeURIComponent(id)}`);
    },
  },
];

/** Tools enabled for a config: alpha only, plus legacy when `legacyDefi` is true. */
export function enabledTools(opts: { legacyDefi?: boolean } = {}): AgentFiToolDef[] {
  return TOOL_CATALOG.filter((t) => t.tier === 'alpha' || opts.legacyDefi === true);
}

/** Runs one tool by name; errors become `{ error }` (never thrown into the model loop). */
export async function runTool(
  client: AgentFiClient,
  name: string,
  args: Record<string, unknown>,
  opts: { legacyDefi?: boolean } = {},
): Promise<string> {
  const tool = enabledTools(opts).find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown or disabled AgentFi tool: ${name}` });
  try {
    return JSON.stringify(await tool.run(client, args));
  } catch (err) {
    // Non-pay tools: a non-2xx answer arrives as AgentFiApiError; keep status and body.
    const e = err as { status?: number; body?: unknown; message?: string };
    return JSON.stringify(e.status !== undefined ? { httpStatus: e.status, ...(e.body as object) } : { error: e.message ?? String(err) });
  }
}
