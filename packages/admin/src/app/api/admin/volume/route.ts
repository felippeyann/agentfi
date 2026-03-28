import { NextResponse } from 'next/server';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';
const ADMIN_SECRET = process.env['ADMIN_SECRET'] ?? '';

export async function GET() {
  try {
    const res = await fetch(`${API_URL}/admin/volume`, {
      headers: { 'x-admin-secret': ADMIN_SECRET },
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ volume: [] });
    const data = await res.json() as { volume: unknown[] };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ volume: [] });
  }
}
