/**
 * Policy tools (Q8) through the real tools/call dispatcher, with the HTTP
 * client mocked: update_policy passes the USD per-spend cap and the
 * recipient whitelist through under their backend names, validates them
 * before anything is sent, and get_policy exposes both fields (with the
 * same "no policy" placeholder as the other limits).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../api-client.js', async () => {
  const { ApiError } = await import('../api-error.js');
  return { api: apiMock, ApiError };
});

import { callTool, listTools } from '../server.js';

const AGENT_ID = 'cl0000000000000000000agent1';
const PAYEE = '0x00000000000000000000000000000000000000b0';
const log = vi.fn();

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  log.mockReset();
});

describe('update_policy (Q8 fields)', () => {
  it('advertises max_value_per_tx_usd and allowed_recipients', () => {
    const tool = listTools().find((t) => t.name === 'update_policy')!;
    const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['max_value_per_tx_eth', 'max_value_per_tx_usd', 'allowed_contracts', 'allowed_recipients', 'reason']),
    );
    expect(tool.description).toMatch(/max_value_per_tx_usd/);
    expect(tool.description).toMatch(/allowed_recipients/);
  });

  it('sends maxValuePerTxUsd and allowedRecipients to PATCH /v1/agents/:id/policy', async () => {
    apiMock.get.mockResolvedValue({ id: AGENT_ID });
    apiMock.patch.mockResolvedValue({ maxValuePerTxUsd: '5', allowedRecipients: [PAYEE] });

    const result = await callTool(
      'update_policy',
      { max_value_per_tx_usd: '5', allowed_recipients: [PAYEE], reason: 'mission-scoped payee' },
      { log },
    );

    expect(result.isError).toBeFalsy();
    expect(apiMock.patch).toHaveBeenCalledWith(`/v1/agents/${AGENT_ID}/policy`, {
      maxValuePerTxEth: undefined,
      maxValuePerTxUsd: '5',
      allowedTokens: undefined,
      allowedContracts: undefined,
      allowedRecipients: [PAYEE],
      reason: 'mission-scoped payee',
    });
    expect(payloadOf(result)).toMatchObject({ success: true, updatedPolicy: { maxValuePerTxUsd: '5' } });
  });

  it.each([
    [{ max_value_per_tx_usd: '1e3' }, 'max_value_per_tx_usd'],
    [{ max_value_per_tx_usd: '' }, 'max_value_per_tx_usd'],
    [{ allowed_recipients: ['payee'] }, 'allowed_recipients'],
  ])('refuses %j before calling the backend (INVALID_INPUT)', async (input, path) => {
    const result = await callTool('update_policy', { ...input, reason: 'x' }, { log });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(JSON.stringify(payloadOf(result))).toContain(path);
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });
});

describe('get_policy (Q8 fields)', () => {
  it('returns the stored policy with both new fields', async () => {
    const policy = {
      maxValuePerTxEth: '0.5',
      maxValuePerTxUsd: '20',
      maxDailyVolumeUsd: '100',
      allowedContracts: [],
      allowedRecipients: [PAYEE],
      allowedTokens: [],
      cooldownSeconds: 0,
      active: true,
    };
    apiMock.get.mockResolvedValue({ policy, tier: 'FREE', billing: null });
    const payload = payloadOf(await callTool('get_policy', {}, { log }));
    expect(payload['policy']).toMatchObject({ maxValuePerTxUsd: '20', allowedRecipients: [PAYEE] });
  });

  it('without a policy row, both new fields read as unrestricted', async () => {
    apiMock.get.mockResolvedValue({ policy: null, tier: 'FREE', billing: null });
    const payload = payloadOf(await callTool('get_policy', {}, { log }));
    expect(payload['policy']).toMatchObject({ maxValuePerTxUsd: 'unlimited (no policy set)', allowedRecipients: [] });
  });
});
