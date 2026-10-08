/**
 * Job tools (X3a) through the real tools/call dispatcher, with the HTTP
 * client mocked: post_job never sends a paid job without a chain and pays in
 * USDC by default; get_job / check_outbox / contest_job hit the right routes;
 * escrow business refusals come back as structured errors; a job id can only
 * ever address a job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock('../api-client.js', async () => {
  const { ApiError } = await import('../api-error.js');
  return { api: apiMock, ApiError };
});

import { ApiError } from '../api-error.js';
import { callTool, listTools } from '../server.js';

const CHAIN_ID = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PROVIDER_ID = 'cl0000000000000000000prov1';
const JOB_ID = 'cm1x2y3z40000abcdjob00001';

const log = vi.fn();

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** What the backend answers for an escrowed job (toJobResponse). */
function escrowedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    requesterId: 'cl0000000000000000000req01',
    providerId: PROVIDER_ID,
    status: 'PENDING',
    payload: { task: 'summarise' },
    reward: { amount: '1.5', token: 'USDC', chainId: CHAIN_ID },
    result: null,
    escrow: {
      kind: 'erc8183',
      chainId: CHAIN_ID,
      contract: '0x00000000000000000000000000000000000E5C20',
      onChainJobId: '7',
      onChainStatus: 'FUNDED',
      budgetAmount: '1500000',
      budgetToken: USDC,
      settleTxHash: null,
      feedbackStatus: null,
      contestedAt: null,
      escrowError: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  log.mockReset();
});

describe('post_job (X3a: a paid job names its chain, USDC by default)', () => {
  it('refuses a reward without chain_id before calling the API', async () => {
    const result = await callTool(
      'post_job',
      { provider_id: PROVIDER_ID, payload: { task: 'summarise' }, reward_amount: '1.5' },
      { log },
    );

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ code: 'INVALID_INPUT', tool: 'post_job' });
    expect(payload['error']).toMatch(/^Invalid input: chain_id: required when reward_amount is set/);
    expect(payload['details']).toEqual({
      issues: [expect.objectContaining({ path: 'chain_id', code: 'custom' })],
    });
    expect(payload['recommendation']).toMatch(/^Fix the input parameters/);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('refuses chain_id or reward_token without reward_amount (no silent free job)', async () => {
    for (const extra of [{ chain_id: CHAIN_ID }, { reward_token: 'USDC' }]) {
      const result = await callTool('post_job', { provider_id: PROVIDER_ID, payload: {}, ...extra }, { log });
      expect(result.isError, JSON.stringify(extra)).toBe(true);
      expect(payloadOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        details: { issues: [expect.objectContaining({ path: 'reward_amount' })] },
      });
    }
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('refuses a reward_amount that is not a plain decimal', async () => {
    const result = await callTool(
      'post_job',
      { provider_id: PROVIDER_ID, payload: {}, reward_amount: '1.5 USDC', chain_id: CHAIN_ID },
      { log },
    );
    expect(payloadOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { issues: [expect.objectContaining({ path: 'reward_amount' })] },
    });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('sends chainId and token "USDC" by default and returns the job with its escrow object', async () => {
    const created = escrowedJob({ escrow: { ...escrowedJob().escrow, onChainStatus: 'CREATING', onChainJobId: null } });
    apiMock.post.mockResolvedValue(created);

    const result = await callTool(
      'post_job',
      { provider_id: PROVIDER_ID, payload: { task: 'summarise' }, reward_amount: '1.5', chain_id: CHAIN_ID },
      { log },
    );

    expect(result.isError).toBeUndefined();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    expect(apiMock.post).toHaveBeenCalledWith('/v1/jobs', {
      providerId: PROVIDER_ID,
      payload: { task: 'summarise' },
      reward: { amount: '1.5', token: 'USDC', chainId: CHAIN_ID },
    });
    expect(payloadOf(result)).toEqual(created);
  });

  it('passes an explicit reward_token and a signature through', async () => {
    apiMock.post.mockResolvedValue(escrowedJob());

    await callTool(
      'post_job',
      {
        provider_id: PROVIDER_ID,
        payload: {},
        reward_amount: '2',
        chain_id: 8453,
        reward_token: USDC,
        signature: '0xsig',
      },
      { log },
    );

    expect(apiMock.post).toHaveBeenCalledWith('/v1/jobs', {
      providerId: PROVIDER_ID,
      payload: {},
      reward: { amount: '2', token: USDC, chainId: 8453 },
      signature: '0xsig',
    });
  });

  it('posts a free job without any reward (no chain, no token)', async () => {
    apiMock.post.mockResolvedValue({ ...escrowedJob(), reward: {}, escrow: null });

    await callTool('post_job', { provider_id: PROVIDER_ID, payload: { task: 'x' } }, { log });

    expect(apiMock.post).toHaveBeenCalledWith('/v1/jobs', { providerId: PROVIDER_ID, payload: { task: 'x' } });
  });

  it('passes ERC8183_USDC_ONLY through as a structured error', async () => {
    const body = {
      error: 'ERC8183_USDC_ONLY',
      message: `Jobs on chain ${CHAIN_ID} are escrowed in USDC; set reward.token to "USDC" or ${USDC}`,
      chainId: CHAIN_ID,
      escrowToken: USDC,
    };
    apiMock.post.mockRejectedValue(new ApiError(400, body));

    const result = await callTool(
      'post_job',
      { provider_id: PROVIDER_ID, payload: {}, reward_amount: '0.01', chain_id: CHAIN_ID, reward_token: 'ETH' },
      { log },
    );

    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({
      error: 'AgentFi API error 400: ERC8183_USDC_ONLY',
      code: 'ERC8183_USDC_ONLY',
      status: 400,
      details: { message: body.message, chainId: CHAIN_ID, escrowToken: USDC },
      tool: 'post_job',
    });
    expect(payload['traceId']).toMatch(/^[0-9a-f]{12}$/);
    expect(apiMock.post).toHaveBeenCalledWith('/v1/jobs', expect.objectContaining({
      reward: { amount: '0.01', token: 'ETH', chainId: CHAIN_ID },
    }));
  });

  it('keeps the backend VALIDATION_FAILED details (e.g. an older client without chainId)', async () => {
    const details = [{ code: 'invalid_type', path: ['reward', 'chainId'], message: 'reward.chainId is required for a paid job' }];
    apiMock.post.mockRejectedValue(new ApiError(400, { error: 'Validation failed', code: 'VALIDATION_FAILED', details }));

    const payload = payloadOf(
      await callTool('post_job', { provider_id: PROVIDER_ID, payload: {}, reward_amount: '1', chain_id: CHAIN_ID }, { log }),
    );

    expect(payload).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: { details } });
  });

  it('lists chain_id in tools/list, with only provider_id and payload always required', () => {
    const tool = listTools().find((t) => t.name === 'post_job');
    expect(tool?.inputSchema.properties).toHaveProperty('chain_id', expect.objectContaining({ type: 'number' }));
    expect(tool?.inputSchema.required).toEqual(['provider_id', 'payload']);
    expect(tool?.description).toMatch(/chain_id/);
    expect(tool?.description).toMatch(/FUNDED/);
    expect(tool?.description).toMatch(/USDC/);
  });
});

describe('get_job / check_outbox / check_inbox', () => {
  it('get_job reads GET /v1/jobs/:id and returns the escrow object', async () => {
    const job = escrowedJob({ status: 'PAYMENT_PENDING', escrow: { ...escrowedJob().escrow, onChainStatus: 'SUBMITTED' } });
    apiMock.get.mockResolvedValue(job);

    const result = await callTool('get_job', { job_id: JOB_ID }, { log });

    expect(apiMock.get).toHaveBeenCalledWith(`/v1/jobs/${JOB_ID}`);
    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)['escrow']).toMatchObject({ kind: 'erc8183', onChainStatus: 'SUBMITTED' });
  });

  it('check_outbox reads GET /v1/jobs/outbox', async () => {
    apiMock.get.mockResolvedValue({ jobs: [escrowedJob()] });

    const result = await callTool('check_outbox', {}, { log });

    expect(apiMock.get).toHaveBeenCalledWith('/v1/jobs/outbox');
    expect(payloadOf(result)).toEqual({ jobs: [escrowedJob()] });
  });

  it('check_inbox reads GET /v1/jobs/inbox', async () => {
    apiMock.get.mockResolvedValue({ jobs: [] });

    await callTool('check_inbox', {}, { log });

    expect(apiMock.get).toHaveBeenCalledWith('/v1/jobs/inbox');
  });

  it('get_job keeps a 403 / 404 from the backend', async () => {
    apiMock.get.mockRejectedValue(new ApiError(404, { error: 'Job not found' }));

    const payload = payloadOf(await callTool('get_job', { job_id: JOB_ID }, { log }));

    expect(payload).toMatchObject({ error: 'AgentFi API error 404: Job not found', status: 404 });
  });
});

describe('contest_job', () => {
  it('posts to /v1/jobs/:id/contest with the reason', async () => {
    const contested = escrowedJob({
      status: 'PAYMENT_PENDING',
      escrow: { ...escrowedJob().escrow, onChainStatus: 'SUBMITTED', contestedAt: '2026-10-07T12:00:00.000Z' },
    });
    apiMock.post.mockResolvedValue(contested);

    const result = await callTool('contest_job', { job_id: JOB_ID, reason: 'summary misses section 3' }, { log });

    expect(apiMock.post).toHaveBeenCalledWith(`/v1/jobs/${JOB_ID}/contest`, { reason: 'summary misses section 3' });
    expect(payloadOf(result)['escrow']).toMatchObject({ contestedAt: '2026-10-07T12:00:00.000Z' });
  });

  it('sends an empty body without a reason', async () => {
    apiMock.post.mockResolvedValue(escrowedJob());

    await callTool('contest_job', { job_id: JOB_ID }, { log });

    expect(apiMock.post).toHaveBeenCalledWith(`/v1/jobs/${JOB_ID}/contest`, {});
  });

  it('refuses a reason over 500 characters before calling the API', async () => {
    const result = await callTool('contest_job', { job_id: JOB_ID, reason: 'x'.repeat(501) }, { log });

    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('passes CONTEST_NOT_ALLOWED through as a structured 409', async () => {
    const body = {
      error: 'CONTEST_NOT_ALLOWED',
      message: 'A job can only be contested while PAYMENT_PENDING, SUBMITTED on-chain and not yet settled',
      status: 'PAYMENT_PENDING',
      onChainStatus: 'SETTLING',
      contestedAt: null,
    };
    apiMock.post.mockRejectedValue(new ApiError(409, body));

    const payload = payloadOf(await callTool('contest_job', { job_id: JOB_ID }, { log }));

    expect(payload).toMatchObject({
      code: 'CONTEST_NOT_ALLOWED',
      status: 409,
      details: { message: body.message, status: 'PAYMENT_PENDING', onChainStatus: 'SETTLING', contestedAt: null },
      recommendation: expect.stringMatching(/conflicts with the current state/),
    });
  });
});

describe('update_job_status', () => {
  it('patches /v1/jobs/:id with the status and result', async () => {
    apiMock.patch.mockResolvedValue(escrowedJob({ status: 'PAYMENT_PENDING' }));

    await callTool('update_job_status', { job_id: JOB_ID, status: 'COMPLETED', result: { summary: 'ok' } }, { log });

    expect(apiMock.patch).toHaveBeenCalledWith(`/v1/jobs/${JOB_ID}`, { status: 'COMPLETED', result: { summary: 'ok' } });
  });

  it('describes the escrow gate and the settlement in tools/list', () => {
    const tools = listTools();
    expect(tools.find((t) => t.name === 'update_job_status')?.description).toMatch(/ESCROW_NOT_FUNDED/);
    expect(tools.find((t) => t.name === 'check_inbox')?.description).toMatch(/FUNDED/);
  });
});

describe('job ids can only address a job', () => {
  it.each([
    ['get_job', { job_id: '../agents/me' }],
    ['update_job_status', { job_id: '../agents/me/manifest', status: 'CANCELLED' }],
    ['contest_job', { job_id: `${JOB_ID}/../../agents/me/sign-handshake#` }],
    ['pay_for_resource', { job_id: `${JOB_ID}?x=1`, url: 'https://api.example.com/data' }],
  ])('%s refuses a job_id with path characters before calling the API', async (tool, args) => {
    const result = await callTool(tool, args, { log });

    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({
      code: 'INVALID_INPUT',
      details: { issues: [expect.objectContaining({ path: 'job_id' })] },
    });
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });
});
