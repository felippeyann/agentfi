/**
 * X5 — `pay_agent` through the real tools/call dispatcher, with the HTTP
 * client mocked. The body the tool sends is checked against the route's
 * documented contract, read at run time from `docs/api/openapi.yaml`
 * (`TransferRequest`, the schema `api.generated.ts` is generated from), not
 * against a hand-written copy: `to` (not `recipient`), `token` = "ETH" or an
 * ERC-20 address (never a symbol), no keys the route would silently drop.
 *
 * The same payload against the real backend route and real Postgres:
 * packages/backend/src/__tests__/pay-agent.mcp.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { contractViolations, readComponentSchema } from './openapi-contract.js';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../api-client.js', async () => {
  const { ApiError } = await import('../api-error.js');
  return { api: apiMock, ApiError };
});

import { ApiError } from '../api-error.js';
import { callTool, listTools } from '../server.js';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BASE_SEPOLIA = 84532;
const BASE = 8453;
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const TRANSFER_REQUEST = readComponentSchema('TransferRequest');

const log = vi.fn();

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function pay(args: Record<string, unknown>) {
  return callTool(
    'pay_agent',
    { recipient_address: RECIPIENT, amount: '1.5', reason: 'paid for the risk report', ...args },
    { log },
  );
}

/** The one call the tool made: [path, body]. */
function sent(): [string, Record<string, unknown>] {
  expect(apiMock.post).toHaveBeenCalledTimes(1);
  const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
  return [path, body];
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  apiMock.post.mockResolvedValue({ transactionId: 'tx_1', status: 'QUEUED' });
  log.mockReset();
});

describe('the route contract the test reads (sanity)', () => {
  it('TransferRequest requires to, token and amount', () => {
    expect([...TRANSFER_REQUEST.required].sort()).toEqual(['amount', 'to', 'token']);
    expect(Object.keys(TRANSFER_REQUEST.properties).sort()).toEqual(['amount', 'chainId', 'idempotencyKey', 'to', 'token']);
  });
});

describe('pay_agent sends a TransferRequest (X5)', () => {
  it('native ETH: POST /v1/transactions/transfer with `to` and token "ETH", conforming to the spec', async () => {
    const result = await pay({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA, amount: '0.01' });

    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    const [path, body] = sent();
    expect(path).toBe('/v1/transactions/transfer');
    expect(contractViolations(body, TRANSFER_REQUEST)).toEqual([]);
    expect(body).toEqual({ to: RECIPIENT, token: 'ETH', amount: '0.01', chainId: BASE_SEPOLIA });
  });

  it('a symbol is resolved to its contract address through the token registry (USDC on Base Sepolia)', async () => {
    const result = await pay({ token_symbol: 'usdc', chain_id: BASE_SEPOLIA });

    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    const [, body] = sent();
    expect(contractViolations(body, TRANSFER_REQUEST)).toEqual([]);
    expect(body).toEqual({ to: RECIPIENT, token: USDC_BASE_SEPOLIA, amount: '1.5', chainId: BASE_SEPOLIA });
  });

  it('the registry is per chain: USDC on Base is the Base USDC', async () => {
    await pay({ token_symbol: 'USDC', chain_id: BASE });
    expect(sent()[1]['token']).toBe(USDC_BASE);
  });

  it('idempotency_key is passed as idempotencyKey', async () => {
    await pay({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA, idempotency_key: 'pay-report-2026-10-14-0001' });
    const [, body] = sent();
    expect(contractViolations(body, TRANSFER_REQUEST)).toEqual([]);
    expect(body['idempotencyKey']).toBe('pay-report-2026-10-14-0001');
  });

  it('reason is not sent (the route has no such field) and is echoed in the result', async () => {
    const result = await pay({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA });
    expect(sent()[1]).not.toHaveProperty('reason');
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ transactionId: 'tx_1', status: 'QUEUED', reason: 'paid for the risk report' });
  });
});

describe('pay_agent refuses before calling the API', () => {
  it('an unknown symbol on that chain, naming the known ones', async () => {
    const result = await pay({ token_symbol: 'DOGE', chain_id: BASE_SEPOLIA });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ code: 'INVALID_INPUT', tool: 'pay_agent' });
    expect(payload['error']).toMatch(/token_symbol: unknown token symbol "DOGE" on chain 84532/);
    expect(payload['error']).toMatch(/ETH, USDC, WETH/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('a symbol known on another chain only (USDT on Base Sepolia)', async () => {
    const result = await pay({ token_symbol: 'USDT', chain_id: BASE_SEPOLIA });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('a contract address in token_symbol (symbols only; transfer_token takes addresses)', async () => {
    const result = await pay({ token_symbol: USDC_BASE_SEPOLIA, chain_id: BASE_SEPOLIA });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('no chain_id (there is no default chain: it used to default to Ethereum mainnet)', async () => {
    const result = await pay({ token_symbol: 'ETH' });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(String(payloadOf(result)['error'])).toMatch(/chain_id/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('no token_symbol (there is no default token)', async () => {
    const result = await pay({ chain_id: BASE_SEPOLIA });
    expect(result.isError).toBe(true);
    expect(String(payloadOf(result)['error'])).toMatch(/token_symbol/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('a recipient that is not a 20-byte hex address', async () => {
    const result = await pay({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA, recipient_address: 'agent-42' });
    expect(result.isError).toBe(true);
    expect(String(payloadOf(result)['error'])).toMatch(/recipient_address/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('an amount that is not a plain decimal', async () => {
    const result = await pay({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA, amount: '1e18' });
    expect(result.isError).toBe(true);
    expect(String(payloadOf(result)['error'])).toMatch(/amount/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

describe('pay_agent backend refusals', () => {
  it('a policy refusal comes back as a 403 tool error with the backend reason', async () => {
    // The transfer route answers a policy refusal as `403 { error }` (sendPolicyRefusal).
    apiMock.post.mockRejectedValueOnce(
      new ApiError(403, { error: `Recipient ${RECIPIENT} is not in the agent's allowed recipients whitelist` }),
    );
    const result = await pay({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA });
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ status: 403, tool: 'pay_agent' });
    expect(String(payload['error'])).toMatch(/allowed recipients whitelist/);
  });
});

describe('pay_agent in tools/list', () => {
  it('requires recipient, amount, token, chain and reason', () => {
    const tool = listTools().find((t) => t.name === 'pay_agent');
    expect(tool?.inputSchema.required?.slice().sort()).toEqual(
      ['amount', 'chain_id', 'reason', 'recipient_address', 'token_symbol'].sort(),
    );
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('idempotency_key');
  });
});
