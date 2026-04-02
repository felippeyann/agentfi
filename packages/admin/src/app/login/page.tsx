"use client";

import { FormEvent, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');

    const result = await signIn('credentials', {
      username,
      password,
      callbackUrl,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('Invalid username or password');
      return;
    }

    router.push(result?.url ?? callbackUrl);
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-brand-border bg-brand-black/70 p-8 shadow-2xl shadow-black/30 backdrop-blur">
        <h1 className="text-2xl font-semibold text-white">Operator Login</h1>
        <p className="mt-2 text-sm text-gray-400">
          Authenticate to access the AgentFi admin dashboard.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-sm text-gray-300" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full rounded-lg border border-brand-border bg-black/40 px-3 py-2 text-white outline-none ring-brand-accent transition focus:ring-2"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-gray-300" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-brand-border bg-black/40 px-3 py-2 text-white outline-none ring-brand-accent transition focus:ring-2"
              required
            />
          </div>

          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-brand-accent px-4 py-2 font-medium text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
