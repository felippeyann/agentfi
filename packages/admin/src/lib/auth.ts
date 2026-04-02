import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { logAdminAuthEvent } from './admin-audit';
import {
  clearLoginFailures,
  getLoginAttemptContext,
  getMaxLoginAttempts,
  isLoginBlocked,
  registerLoginFailure,
} from './login-rate-limit';

const ADMIN_USERNAME = process.env['ADMIN_USERNAME'] ?? 'admin';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? '';
const IS_PRODUCTION = process.env['NODE_ENV'] === 'production';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export const authOptions: NextAuthOptions = {
  secret: process.env['NEXTAUTH_SECRET'],
  useSecureCookies: IS_PRODUCTION,
  session: {
    strategy: 'jwt',
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: 60 * 15,
  },
  jwt: {
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  cookies: {
    sessionToken: {
      name: IS_PRODUCTION ? '__Secure-next-auth.session-token' : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: IS_PRODUCTION,
      },
    },
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'Operator Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        const username = credentials?.username?.trim() ?? '';
        const password = credentials?.password ?? '';
        const headers = req?.headers as Record<string, string | string[] | undefined> | undefined;
        const context = getLoginAttemptContext(headers);

        if (!ADMIN_PASSWORD) {
          logAdminAuthEvent({
            event: 'admin_login_config_invalid',
            username,
            ip: context.ip,
            userAgent: context.userAgent,
          });
          return null;
        }

        const blockState = isLoginBlocked(username, headers);
        if (blockState.blocked) {
          logAdminAuthEvent({
            event: 'admin_login_blocked',
            username,
            ip: context.ip,
            userAgent: context.userAgent,
            retryAfterMs: blockState.retryAfterMs,
            maxAttempts: getMaxLoginAttempts(),
          });
          return null;
        }

        if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
          const failureState = registerLoginFailure(username, headers);
          logAdminAuthEvent({
            event: 'admin_login_invalid_credentials',
            username,
            ip: context.ip,
            userAgent: context.userAgent,
            remainingAttempts: failureState.remainingAttempts,
            retryAfterMs: failureState.retryAfterMs,
            maxAttempts: getMaxLoginAttempts(),
          });
          return null;
        }

        clearLoginFailures(username, headers);
        logAdminAuthEvent({
          event: 'admin_login_success',
          username,
          ip: context.ip,
          userAgent: context.userAgent,
          maxAttempts: getMaxLoginAttempts(),
        });

        return {
          id: 'operator',
          name: ADMIN_USERNAME,
          email: `${ADMIN_USERNAME}@agentfi.local`,
        };
      },
    }),
  ],
};
