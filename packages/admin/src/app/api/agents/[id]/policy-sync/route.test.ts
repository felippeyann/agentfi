import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasAdminSessionMock } = vi.hoisted(() => ({
  hasAdminSessionMock: vi.fn(),
}));

vi.mock('../../../../../lib/session', () => ({
  hasAdminSession: hasAdminSessionMock,
}));

import { GET, POST } from './route';

const ctx = { params: Promise.resolve({ id: 'agent-1' }) };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('S8 — admin policy-sync proxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hasAdminSessionMock.mockReset();
  });

  it('401 without a session, for both methods, and the backend is never called', async () => {
    hasAdminSessionMock.mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect((await POST(new Request('http://localhost/api/agents/agent-1/policy-sync', { method: 'POST' }), ctx)).status).toBe(401);
    expect((await GET(new Request('http://localhost/api/agents/agent-1/policy-sync'), ctx)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST forwards NO body to the backend sync route (nothing the browser sends is signed) and keeps its status', async () => {
    hasAdminSessionMock.mockResolvedValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'pending', transactions: [] }, 202));

    const res = await POST(
      new Request('http://localhost/api/agents/agent-1/policy-sync', {
        method: 'POST',
        body: JSON.stringify({ actions: [{ to: '0x00000000000000000000000000000000000000a9', data: '0xdeadbeef' }] }),
      }),
      ctx,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'pending', transactions: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/admin\/agents\/agent-1\/policy\/sync$/);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('GET proxies the on-chain view and passes refusals through', async () => {
    hasAdminSessionMock.mockResolvedValue(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'refused', code: 'POLICY_SYNC_WALLET_MODE' }, 409));

    const res = await GET(new Request('http://localhost/api/agents/agent-1/policy-sync'), ctx);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'POLICY_SYNC_WALLET_MODE' });
  });
});
