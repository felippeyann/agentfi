import { NextResponse } from 'next/server';
import { adminSessionUser } from '../../../../../../lib/session';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';

/**
 * BFF proxy for POST /admin/jobs/:id/resolve (C3d, decision D9): the
 * operator's decision on an ERC-8183 job held for review.
 *
 * Forwards `{ decision, verdict?, note }` with the x-admin-secret (never sent
 * to the browser) and adds the signed-in operator as `operator`, so the
 * backend records who decided. A client-supplied `operator` is ignored.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const operator = await adminSessionUser();
  if (!operator) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const res = await fetch(`${API_URL}/admin/jobs/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body: JSON.stringify({
        decision: body['decision'],
        ...(body['verdict'] !== undefined ? { verdict: body['verdict'] } : {}),
        note: body['note'],
        operator,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Job resolve proxy failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
