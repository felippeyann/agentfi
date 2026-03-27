import { NextResponse } from 'next/server';

const BACKEND_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const res = await fetch(`${BACKEND_URL}/admin/agents/${params.id}/pause`, {
    method: 'POST',
    headers: { 'x-admin-secret': ADMIN_SECRET },
  });

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to toggle agent' }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
