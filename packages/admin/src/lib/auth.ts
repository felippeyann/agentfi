import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';

const ADMIN_USERNAME = process.env['ADMIN_USERNAME'] ?? 'admin';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? '';

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 8,
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
      async authorize(credentials) {
        if (!ADMIN_PASSWORD) return null;

        const username = credentials?.username?.trim() ?? '';
        const password = credentials?.password ?? '';

        if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
          return null;
        }

        return {
          id: 'operator',
          name: ADMIN_USERNAME,
          email: `${ADMIN_USERNAME}@agentfi.local`,
        };
      },
    }),
  ],
};
