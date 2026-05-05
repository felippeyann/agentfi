import { NextResponse } from 'next/server';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';

/**
 * BFF proxy for POST /admin/jobs/:id/reconcile.
 *
 * Forwards the {action, reason} body to the backend with the operator's
 * x-admin-secret. Mirrors the existing pattern in
 * /api/transactions/[id]/approve so we never ship ADMIN_SECRET to the
 * browser.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const body = await request.text();
    const res = await fetch(`${API_URL}/admin/jobs/${id}/reconcile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      body,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    console.error('Job reconcile proxy failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
