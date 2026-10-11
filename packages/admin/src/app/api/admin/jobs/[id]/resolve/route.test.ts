import { beforeEach, describe, expect, it, vi } from 'vitest';

const { adminSessionUserMock } = vi.hoisted(() => ({
  adminSessionUserMock: vi.fn(),
}));

vi.mock('../../../../../../lib/session', () => ({
  adminSessionUser: adminSessionUserMock,
}));

import { POST } from './route';

const context = { params: Promise.resolve({ id: 'job-1' }) };

function request(body: unknown) {
  return new Request('http://localhost/api/admin/jobs/job-1/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('admin job resolve route (C3d operator review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without a session and never reaches the backend', async () => {
    adminSessionUserMock.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await POST(request({ decision: 'pay', note: 'ok' }), context);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('forwards the decision with the signed-in operator (a client-supplied operator is ignored) and relays the status', async () => {
    adminSessionUserMock.mockResolvedValue('alice@ops.test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'job-1', resolution: 'quality-rejected', queued: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await POST(
      request({ decision: 'refund', verdict: 'quality-rejected', note: 'off-brief', operator: 'mallory' }),
      context,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ resolution: 'quality-rejected' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/admin\/jobs\/job-1\/resolve$/);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      decision: 'refund',
      verdict: 'quality-rejected',
      note: 'off-brief',
      operator: 'alice@ops.test',
    });
    expect((init as RequestInit).headers).toMatchObject({ 'x-admin-secret': expect.any(String) });
    fetchSpy.mockRestore();
  });

  it('relays a backend refusal (409) with its body, and rejects a malformed body with 400', async () => {
    adminSessionUserMock.mockResolvedValue('alice@ops.test');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'SETTLEMENT_IN_PROGRESS', message: 'retry' }), { status: 409 }),
    );
    const refused = await POST(request({ decision: 'pay', note: 'ok ok' }), context);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'SETTLEMENT_IN_PROGRESS', message: 'retry' });

    const malformed = await POST(request('{not json'), context);
    expect(malformed.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
