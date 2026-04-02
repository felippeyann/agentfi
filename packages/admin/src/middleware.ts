import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

const ADMIN_ALLOW_REMOTE = process.env['ADMIN_ALLOW_REMOTE'] === 'true';
const NEXTAUTH_SECRET = process.env['NEXTAUTH_SECRET'];

function isLoopbackHost(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // Keep the existing local-only default unless explicitly overridden.
  if (!ADMIN_ALLOW_REMOTE) {
    const host = request.headers.get('host') ?? '';
    if (!isLoopbackHost(host)) {
      return new NextResponse(
        'Admin UI is local-only. Set ADMIN_ALLOW_REMOTE=true to allow remote access.',
        { status: 403 },
      );
    }
  }

  // NextAuth endpoints must remain public.
  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  const token = await getToken({ req: request, secret: NEXTAUTH_SECRET });

  if (pathname === '/login') {
    if (token) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.next();
  }

  if (token) return NextResponse.next();

  const loginUrl = new URL('/login', request.url);
  const callbackUrl = `${pathname}${search}`;
  loginUrl.searchParams.set('callbackUrl', callbackUrl);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
