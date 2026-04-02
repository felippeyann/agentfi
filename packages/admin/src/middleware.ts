import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const ADMIN_ALLOW_REMOTE = process.env['ADMIN_ALLOW_REMOTE'] === 'true';

function isLoopbackHost(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
}

export function middleware(request: NextRequest): NextResponse {
  if (ADMIN_ALLOW_REMOTE) return NextResponse.next();

  const host = request.headers.get('host') ?? '';
  if (isLoopbackHost(host)) return NextResponse.next();

  return new NextResponse(
    'Admin UI is local-only. Set ADMIN_ALLOW_REMOTE=true to allow remote access.',
    { status: 403 },
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
