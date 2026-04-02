import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasAdminSessionMock } = vi.hoisted(() => ({
  hasAdminSessionMock: vi.fn(),
}));

vi.mock('../../../../lib/session', () => ({
  hasAdminSession: hasAdminSessionMock,
}));

import { GET } from './route';

describe('admin volume route auth guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when session is missing', async () => {
    hasAdminSessionMock.mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await GET();
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('returns proxied payload when session is present', async () => {
    hasAdminSessionMock.mockResolvedValue(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ volume: [{ day: '2026-04-01', usd: '12.4' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await GET();
    const body = (await res.json()) as { volume: unknown[] };

    expect(res.status).toBe(200);
    expect(body.volume).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });
});
