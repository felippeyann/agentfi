/**
 * `transfer_token` through the real tools/call dispatcher, with the HTTP
 * client mocked (follow-ups to the #181 review).
 *
 * P1: the transfer route reads token "ETH" as the chain's NATIVE asset — POL
 * on Polygon (137) — so "ETH" is refused where the native asset is not ETH,
 * as `pay_agent` does (`pay-agent.test.ts`).
 * P2: `to` is checked with the backend's address rule (viem strict
 * `isAddress`): a mixed-case address with a bad EIP-55 checksum is refused.
 *
 * X7: `transfer_token` takes an optional `idempotency_key` (same format and
 * validation as `pay_agent`) and sends it as the route's `idempotencyKey`;
 * every body is checked against the route contract read from
 * `docs/api/openapi.yaml` (`TransferRequest`). The retry against the real
 * route and real Postgres: packages/backend/src/__tests__/pay-agent.mcp.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { contractViolations, readComponentSchema } from './openapi-contract.js';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../api-client.js', async () => {
  const { ApiError } = await import('../api-error.js');
  return { api: apiMock, ApiError };
});

import { callTool, listTools } from '../server.js';

const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const TRANSFER_REQUEST = readComponentSchema('TransferRequest');

const log = vi.fn();

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function transfer(args: Record<string, unknown>) {
  return callTool('transfer_token', { to: TO, amount: '1', ...args }, { log });
}

beforeEach(() => {
  apiMock.post.mockReset();
  apiMock.post.mockResolvedValue({ transactionId: 'tx_1', status: 'QUEUED' });
  log.mockReset();
});

describe('transfer_token: native "ETH" only where the native asset is ETH (review of #181, P1)', () => {
  it('ETH on Polygon is refused INVALID_INPUT before any request (it would send POL)', async () => {
    const result = await transfer({ token: 'ETH', chain_id: 137 });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ code: 'INVALID_INPUT', tool: 'transfer_token' });
    expect(payload['error']).toMatch(/token: .*chain 137.*POL/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('lower-case "eth" on Polygon is refused too', async () => {
    const result = await transfer({ token: 'eth', chain_id: 137 });
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('ETH on a chain the server does not know is refused', async () => {
    const result = await transfer({ token: 'ETH', chain_id: 56 });
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('an ERC-20 on Polygon is unaffected', async () => {
    const result = await transfer({ token: 'USDC', chain_id: 137 });
    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    expect(apiMock.post).toHaveBeenCalledWith('/v1/transactions/transfer', {
      token: USDC_POLYGON,
      to: TO,
      amount: '1',
      chainId: 137,
    });
  });

  it.each([1, 8453, 84532, 42161])('native ETH stays accepted on chain %i', async (chainId) => {
    const result = await transfer({ token: 'ETH', chain_id: chainId });
    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    expect(apiMock.post).toHaveBeenCalledWith('/v1/transactions/transfer', { token: 'ETH', to: TO, amount: '1', chainId });
  });

  it('the default chain (1, Ethereum) still sends native ETH', async () => {
    const result = await transfer({ token: 'ETH' });
    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    expect(apiMock.post).toHaveBeenCalledWith('/v1/transactions/transfer', { token: 'ETH', to: TO, amount: '1', chainId: 1 });
  });
});

describe('transfer_token: `to` is checked with the backend\'s address rule (review of #181, P2)', () => {
  it('a mixed-case `to` with an invalid EIP-55 checksum is INVALID_INPUT, nothing sent', async () => {
    const result = await transfer({ token: 'ETH', chain_id: 8453, to: '0x70997970c51812dc3A010C7d01b50e0d17dc79C8' });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ code: 'INVALID_INPUT', tool: 'transfer_token' });
    expect(payload['error']).toMatch(/to: .*checksum/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('a `to` that is not an address is INVALID_INPUT, nothing sent', async () => {
    const result = await transfer({ token: 'ETH', chain_id: 8453, to: 'agent-42' });
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('an all-lowercase `to` is accepted and sent as given', async () => {
    const result = await transfer({ token: 'ETH', chain_id: 8453, to: TO.toLowerCase() });
    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    expect(apiMock.post).toHaveBeenCalledWith('/v1/transactions/transfer', {
      token: 'ETH',
      to: TO.toLowerCase(),
      amount: '1',
      chainId: 8453,
    });
  });
});

/** The one call the tool made: [path, body]. */
function sent(): [string, Record<string, unknown>] {
  expect(apiMock.post).toHaveBeenCalledTimes(1);
  const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
  return [path, body];
}

describe('transfer_token: idempotency_key (X7)', () => {
  // The route accepts `idempotencyKey` (TransferRequest); before X7 the tool
  // had no way to send one, so a client retry after a timeout transferred twice.
  const KEY = 'transfer-report-2026-10-17-0001';

  it('the route contract the test reads: TransferRequest defines idempotencyKey (string, optional)', () => {
    expect(TRANSFER_REQUEST.properties['idempotencyKey']).toEqual({ type: 'string' });
    expect(TRANSFER_REQUEST.required).not.toContain('idempotencyKey');
  });

  it('idempotency_key is sent as idempotencyKey, the body conforming to TransferRequest', async () => {
    const result = await transfer({ token: 'ETH', chain_id: 8453, idempotency_key: KEY });

    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    const [path, body] = sent();
    expect(path).toBe('/v1/transactions/transfer');
    expect(contractViolations(body, TRANSFER_REQUEST)).toEqual([]);
    expect(body).toEqual({ token: 'ETH', to: TO, amount: '1', chainId: 8453, idempotencyKey: KEY });
  });

  it('an ERC-20 transfer carries the key too', async () => {
    await transfer({ token: 'USDC', chain_id: 137, idempotency_key: KEY });
    const [, body] = sent();
    expect(contractViolations(body, TRANSFER_REQUEST)).toEqual([]);
    expect(body).toEqual({ token: USDC_POLYGON, to: TO, amount: '1', chainId: 137, idempotencyKey: KEY });
  });

  it('without idempotency_key no idempotencyKey is sent (the body still conforms)', async () => {
    await transfer({ token: 'ETH', chain_id: 8453 });
    const [, body] = sent();
    expect(contractViolations(body, TRANSFER_REQUEST)).toEqual([]);
    expect(body).not.toHaveProperty('idempotencyKey');
  });

  it.each([
    ['too short (15 chars)', 'abcdefghijklmno'],
    ['too long (129 chars)', 'a'.repeat(129)],
    ['a character outside [A-Za-z0-9_-]', 'transfer-2026-10-17/0001'],
    ['whitespace', 'transfer 2026 10 17 0001'],
  ])('a malformed key (%s) is INVALID_INPUT, nothing sent — same rule as pay_agent', async (_label, key) => {
    const result = await transfer({ token: 'ETH', chain_id: 8453, idempotency_key: key });

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ code: 'INVALID_INPUT', tool: 'transfer_token' });
    expect(String(payload['error'])).toMatch(/idempotency_key/);
    expect(apiMock.post).not.toHaveBeenCalled();

    // pay_agent applies the same rule to the same value.
    const viaPayAgent = await callTool(
      'pay_agent',
      { recipient_address: TO, amount: '1', token_symbol: 'ETH', chain_id: 8453, reason: 'same rule', idempotency_key: key },
      { log },
    );
    expect(payloadOf(viaPayAgent)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('the boundary lengths (16 and 128 chars) are accepted', async () => {
    for (const key of ['a'.repeat(16), 'A_-9'.repeat(32)]) {
      apiMock.post.mockClear();
      const result = await transfer({ token: 'ETH', chain_id: 8453, idempotency_key: key });
      expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
      expect(sent()[1]['idempotencyKey']).toBe(key);
    }
  });

  it('a replay answered with the stored transaction (200, `id` instead of `transactionId`) still reports its transactionId', async () => {
    // The route answers a known key with the stored row — the GET /v1/transactions/:id view.
    apiMock.post.mockResolvedValueOnce({ id: 'tx_first', status: 'CONFIRMED', type: 'TRANSFER', chainId: 8453 });

    const result = await transfer({ token: 'ETH', chain_id: 8453, idempotency_key: KEY });

    expect(result.isError, JSON.stringify(payloadOf(result))).toBeFalsy();
    expect(payloadOf(result)).toMatchObject({ transactionId: 'tx_first', status: 'CONFIRMED' });
  });

  it('tools/list: idempotency_key is an optional string whose description says to reuse it on a retry', () => {
    const tool = listTools().find((t) => t.name === 'transfer_token');
    expect(tool?.inputSchema.required ?? []).not.toContain('idempotency_key');
    const property = (tool?.inputSchema.properties ?? {})['idempotency_key'] as { type?: string; description?: string } | undefined;
    expect(property).toMatchObject({ type: 'string' });
    expect(property?.description).toMatch(/16-128/);
    expect(property?.description).toMatch(/same key/i);
    expect(tool?.description).toMatch(/idempotency_key/);
    expect(tool?.description).toMatch(/reuse/i);
  });
});
