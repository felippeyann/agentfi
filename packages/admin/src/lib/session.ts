import { getServerSession } from 'next-auth';
import { authOptions } from './auth';

export async function hasAdminSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return Boolean(session);
}

/**
 * The signed-in operator, for audit records (C3d: who decided an escrow
 * review). Email when the provider gives one, else the name, else null when
 * there is no session.
 */
export async function adminSessionUser(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  return session.user?.email ?? session.user?.name ?? 'admin';
}
