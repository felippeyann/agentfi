import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasAdminSessionMock } = vi.hoisted(() => ({
  hasAdminSessionMock: vi.fn(),
}));

vi.mock('../../../../../lib/session', () => ({
  hasAdminSession: hasAdminSessionMock,
}));

import { POST } from './route';

describe('admin agent pause route auth guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when session is missing', async () => {
    hasAdminSessionMock.mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await POST(new Request('http://localhost/api/agents/test/pause'), {
      params: { id: 'test-agent' },
    });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('returns proxied response when session is present', async () => {
    hasAdminSessionMock.mockResolvedValue(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await POST(new Request('http://localhost/api/agents/test/pause'), {
      params: { id: 'test-agent' },
    });
    const body = (await res.json()) as { success: boolean };

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });
});
