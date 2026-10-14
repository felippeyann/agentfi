/**
 * `transfer_token` through the real tools/call dispatcher, with the HTTP
 * client mocked (follow-ups to the #181 review).
 *
 * P1: the transfer route reads token "ETH" as the chain's NATIVE asset — POL
 * on Polygon (137) — so "ETH" is refused where the native asset is not ETH,
 * as `pay_agent` does (`pay-agent.test.ts`).
 * P2: `to` is checked with the backend's address rule (viem strict
 * `isAddress`): a mixed-case address with a bad EIP-55 checksum is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../api-client.js', async () => {
  const { ApiError } = await import('../api-error.js');
  return { api: apiMock, ApiError };
});

import { callTool } from '../server.js';

const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

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
