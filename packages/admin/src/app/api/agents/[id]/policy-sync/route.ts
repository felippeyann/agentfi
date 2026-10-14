import { NextResponse } from 'next/server';
import { hasAdminSession } from '../../../../../lib/session';

const BACKEND_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';

/**
 * S8 — on-chain policy sync of one agent.
 *
 * GET  → backend GET  /admin/agents/:id/policy/onchain (stored vs on-chain policy)
 * POST → backend POST /admin/agents/:id/policy/sync    (push the STORED policy)
 *
 * The POST forwards no body: the backend derives the module calls from the
 * policy in its database and has the agent's own wallet send them straight to
 * AgentPolicyModule. Nothing the browser sends is signed.
 */
async function proxy(method: 'GET' | 'POST', id: string): Promise<NextResponse> {
  const authorized = await hasAdminSession();
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const suffix = method === 'GET' ? 'onchain' : 'sync';
  try {
    const res = await fetch(`${BACKEND_URL}/admin/agents/${encodeURIComponent(id)}/policy/${suffix}`, {
      method,
      headers: { 'x-admin-secret': ADMIN_SECRET },
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({ error: 'Invalid backend response' }));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error('Policy sync proxy failed:', err);
    return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
  }
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxy('GET', id);
}

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxy('POST', id);
}
