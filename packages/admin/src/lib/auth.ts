import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GitHubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
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

// Known placeholder values from .env.example that must not be used in production
const KNOWN_CREDENTIAL_PLACEHOLDERS = new Set([
  'change-this-before-production',
  'your-admin-password-here',
]);

/**
 * Returns true if the password is a known .env.example placeholder or empty.
 * Prevents accidental production deployments with default credentials.
 */
function isWeakAdminPassword(password: string): boolean {
  return !password || KNOWN_CREDENTIAL_PLACEHOLDERS.has(password);
}

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

// Optional OIDC — comma-separated email allowlist (only these emails can sign in via OAuth)
const ADMIN_OAUTH_ALLOWLIST = (process.env['ADMIN_OAUTH_ALLOWLIST'] ?? '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function buildOAuthProviders(): NextAuthOptions['providers'] {
  const providers: NextAuthOptions['providers'] = [];

  if (process.env['GITHUB_CLIENT_ID'] && process.env['GITHUB_CLIENT_SECRET']) {
    providers.push(
      GitHubProvider({
        clientId: process.env['GITHUB_CLIENT_ID'],
        clientSecret: process.env['GITHUB_CLIENT_SECRET'],
      }),
    );
  }

  if (process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET']) {
    providers.push(
      GoogleProvider({
        clientId: process.env['GOOGLE_CLIENT_ID'],
        clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
      }),
    );
  }

  return providers;
}

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
    ...buildOAuthProviders(),
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

        if (IS_PRODUCTION && isWeakAdminPassword(ADMIN_PASSWORD)) {
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
  callbacks: {
    async signIn({ user, account }) {
      // Credentials provider — already validated above
      if (account?.provider === 'credentials') return true;

      // OAuth providers — enforce email allowlist
      const email = user.email?.toLowerCase();
      if (!email) return false;
      if (ADMIN_OAUTH_ALLOWLIST.length === 0) {
        // No allowlist configured — reject all OAuth logins to prevent unauthorized access
        console.warn(`[admin-auth] OAuth login rejected: no ADMIN_OAUTH_ALLOWLIST configured (email: ${email})`);
        return false;
      }
      if (!ADMIN_OAUTH_ALLOWLIST.includes(email)) {
        console.warn(`[admin-auth] OAuth login rejected: ${email} not in allowlist`);
        return false;
      }
      return true;
    },
  },
};
