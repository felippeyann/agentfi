/**
 * S6: every id a tool interpolates into a backend path is validated with the
 * X3a rule (`[A-Za-z0-9_-]{1,128}`) before the API is called — `agent_id` on
 * get_agent_manifest / get_agent_trust_report and `transaction_id` on
 * get_transaction_status, in addition to X3a's `job_id`. A structural check
 * keeps the rule on every `*_id` string input of every tool, so a new tool
 * cannot interpolate an unchecked id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../api-client.js', async () => {
  const { ApiError } = await import('../api-error.js');
  return { api: apiMock, ApiError };
});

import { ALL_TOOLS, callTool } from '../server.js';
import { PATH_ID_PATTERN } from '../path-ids.js';

const CUID = 'cm1x2y3z40000abcdjob00001';
const log = vi.fn();

/** Ids that would leave the intended route, add a query / fragment, or smuggle an encoded path. */
const HOSTILE_IDS = [
  '../agents/me',
  '..',
  `${CUID}/../../agents/me/sign-handshake`,
  `${CUID}?apiKey=x`,
  `${CUID}#frag`,
  '%2e%2e%2fagents%2fme',
  'a b',
  '',
  'x'.repeat(129),
];

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return unwrap(schema._def.innerType);
  return schema;
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  log.mockReset();
});

describe('ids interpolated into a path (S6)', () => {
  it.each([
    ['get_agent_manifest', 'agent_id', {}],
    ['get_agent_trust_report', 'agent_id', {}],
    ['get_transaction_status', 'transaction_id', {}],
  ] as const)('%s refuses a hostile %s before calling the API', async (tool, field, extra) => {
    for (const id of HOSTILE_IDS) {
      const result = await callTool(tool, { ...extra, [field]: id }, { log });

      expect(result.isError).toBe(true);
      expect(payloadOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        details: { issues: [expect.objectContaining({ path: field })] },
      });
    }
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('a well-formed id reaches the intended route', async () => {
    apiMock.get.mockResolvedValue({ id: CUID, status: 'CONFIRMED', type: 'SWAP', chainId: 8453, createdAt: 'now' });

    await callTool('get_agent_manifest', { agent_id: CUID }, { log });
    await callTool('get_agent_trust_report', { agent_id: CUID }, { log });
    await callTool('get_transaction_status', { transaction_id: CUID }, { log });

    expect(apiMock.get.mock.calls.map((call) => call[0])).toEqual([
      `/v1/agents/${CUID}/manifest`,
      `/v1/agents/${CUID}/trust-report`,
      `/v1/transactions/${CUID}`,
    ]);
  });

  it('post_job refuses a hostile provider_id before calling the API', async () => {
    const result = await callTool('post_job', { provider_id: '../agents/me', payload: {} }, { log });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('every *_id string input of every tool refuses path characters (structural guard)', () => {
    const checked: string[] = [];
    for (const tool of ALL_TOOLS) {
      const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, raw] of Object.entries(shape)) {
        const schema = unwrap(raw as z.ZodTypeAny);
        if (!key.endsWith('_id') || !(schema instanceof z.ZodString)) continue;
        checked.push(`${tool.name}.${key}`);
        for (const id of HOSTILE_IDS) {
          expect(schema.safeParse(id).success, `${tool.name}.${key} accepted ${JSON.stringify(id)}`).toBe(false);
        }
        expect(schema.safeParse(CUID).success, `${tool.name}.${key} refused a CUID`).toBe(true);
      }
    }
    // The ids S6 and X3a cover are all in the scan (sanity check of the guard itself).
    expect(checked).toEqual(
      expect.arrayContaining([
        'get_transaction_status.transaction_id',
        'get_agent_manifest.agent_id',
        'get_agent_trust_report.agent_id',
        'post_job.provider_id',
        'get_job.job_id',
        'update_job_status.job_id',
        'contest_job.job_id',
        'pay_for_resource.job_id',
        'pay_for_resource.payment_id',
        'execute_swap.simulation_id',
      ]),
    );
  });

  it('the shared pattern is the X3a job id rule', () => {
    expect(PATH_ID_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,128}$');
  });
});

describe('handshake tools (S6 envelope)', () => {
  it('verify_handshake forwards issued_at as issuedAt and requires it', async () => {
    apiMock.post.mockResolvedValue({ valid: true, address: '0x1111111111111111111111111111111111111111', verifiedVia: 'ecdsa' });
    const args = {
      message: 'deal #42',
      issued_at: 1_791_417_600,
      signature: `0x${'ab'.repeat(65)}`,
      address: '0x1111111111111111111111111111111111111111',
    };

    await callTool('verify_handshake', args, { log });
    expect(apiMock.post).toHaveBeenCalledWith('/v1/agents/verify-handshake', {
      message: 'deal #42',
      issuedAt: 1_791_417_600,
      signature: args.signature,
      address: args.address,
    });

    apiMock.post.mockClear();
    const { issued_at: _omit, ...missing } = args;
    const result = await callTool('verify_handshake', missing, { log });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('sign_handshake describes the envelope', async () => {
    const { listTools } = await import('../server.js');
    const description = listTools().find((t) => t.name === 'sign_handshake')?.description ?? '';
    expect(description).toMatch(/EIP-712/);
    expect(description).toMatch(/AgentFiHandshake/);
  });
});
