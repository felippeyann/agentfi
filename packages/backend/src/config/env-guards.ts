/**
 * Boot guards for unsafe environment combinations (S6, second adversarial
 * review 2026-10-08). Pure functions — no `env.ts` import, no side effects —
 * so the rules are unit-testable; `config/env.ts` applies them at boot and
 * `process.exit(1)`s on a FATAL.
 *
 * Rules (documented in `.env.example` and docs/operations/production-deploy.md):
 *
 * 1. Placeholder secrets: in production AND staging, a value shipped in
 *    `.env.example` (`your-…-here`, with an optional `sk_test_` / `whsec_` /
 *    `price_` prefix) or in `docker-compose.dev.yml` is FATAL for every key in
 *    `PLACEHOLDER_CHECKED_KEYS`. A placeholder `API_SECRET` lets anyone
 *    register agents and loosen policies, a placeholder `ADMIN_SECRET` opens
 *    the admin API, a placeholder `STRIPE_WEBHOOK_SECRET` lets anyone forge
 *    billing webhooks.
 * 2. Staging is as strict as production for wallets and secrets
 *    (`WALLET_PROVIDER=local` is FATAL in both).
 * 3. `RPC_URL_<chainId>`: https only in production and staging (plaintext RPC
 *    lets anyone on the path feed the backend false chain state); in
 *    development / test, http is accepted only for a loopback or private host
 *    (`localhost`, `127.0.0.0/8`, `::1`, RFC 1918, link-local, IPv6 ULA, a
 *    single-label name such as a compose service, or a `.localhost`,
 *    `.local`, `.internal`, `.lan`, `.home.arpa` name).
 * 4. `NODE_ENV` unset: the schema defaults to `development`, which turns every
 *    guard above off. A loud WARN is always printed; boot is REFUSED when the
 *    process runs in a container or on a hosting platform
 *    (`detectContainer`) AND the configuration looks like production
 *    (`productionSignals`). Set `NODE_ENV` explicitly to boot.
 */

import { existsSync } from 'node:fs';
import { isIP } from 'node:net';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** NODE_ENV values where the production guards apply. */
export const PRODUCTION_LIKE = new Set(['production', 'staging']);

// ── 1. Placeholder secrets ───────────────────────────────────────────────

/** Keys whose `.env.example` / dev-compose placeholder must never reach production or staging. */
export const PLACEHOLDER_CHECKED_KEYS = [
  'API_SECRET',
  'ADMIN_SECRET',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PRO_PRICE_ID',
  'ALCHEMY_API_KEY',
  'TURNKEY_API_PUBLIC_KEY',
  'TURNKEY_API_PRIVATE_KEY',
  'TURNKEY_ORGANIZATION_ID',
] as const;

/** `.env.example` style: `your-…-here`, optionally behind a provider prefix (`sk_test_`, `whsec_`, `price_`). */
const EXAMPLE_PLACEHOLDER = /^(?:[a-z]+_){0,2}your-[a-z0-9-]+-here$/i;

/** Literal placeholders shipped elsewhere (docker-compose.dev.yml: "NEVER use these in production"). */
export const KNOWN_PLACEHOLDER_VALUES: Readonly<Record<string, readonly string[]>> = {
  API_SECRET: ['your-api-secret-min-32-chars-here', 'dev-api-secret-min-32-chars-long-xxxxx'],
  ADMIN_SECRET: ['your-admin-secret-min-32-chars-here', 'dev-admin-secret-min-32-chars-long-yyyy'],
  ALCHEMY_API_KEY: ['stub'],
};

export function isPlaceholderValue(key: string, value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return EXAMPLE_PLACEHOLDER.test(trimmed) || (KNOWN_PLACEHOLDER_VALUES[key] ?? []).includes(trimmed);
}

/** Keys of `PLACEHOLDER_CHECKED_KEYS` that still hold a shipped placeholder. */
export function placeholderKeys(source: EnvSource): string[] {
  return PLACEHOLDER_CHECKED_KEYS.filter((key) => isPlaceholderValue(key, source[key]));
}

// ── 3. RPC_URL_<chainId> transport ───────────────────────────────────────

const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

function ipv4Octets(host: string): number[] | null {
  if (isIP(host) !== 4) return null;
  return host.split('.').map((part) => Number(part));
}

/**
 * Loopback or private-network host (IP literal or a name that cannot be a
 * public DNS name). Names are judged by their shape only — no DNS lookup at
 * boot: a public FQDN is never "private" here.
 */
export function isLoopbackOrPrivateHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets as [number, number, number, number];
    return (
      a === 127 || // loopback
      a === 10 || // RFC 1918
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // link-local
    );
  }
  if (isIP(host) === 6) {
    if (host === '::1') return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isLoopbackOrPrivateHost(mapped[1]!);
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host); // ULA fc00::/7, link-local fe80::/10
  }
  if (!host.includes('.')) return true; // single-label: a compose service / host alias, never public DNS
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Why `url` is not acceptable as an `RPC_URL_<chainId>` under `nodeEnv`, or
 * null when it is. Called after the schema has accepted it as an http(s) URL.
 */
export function rpcUrlProblem(url: string, nodeEnv: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol !== 'http:') return 'must be an http(s) URL';
  if (PRODUCTION_LIKE.has(nodeEnv)) {
    return `must use https with NODE_ENV=${nodeEnv} (plaintext RPC lets anyone on the path feed the backend false chain state)`;
  }
  if (!isLoopbackOrPrivateHost(parsed.hostname)) {
    return `uses plain http to a public host (${parsed.hostname}); http is accepted only for loopback / private hosts — use https`;
  }
  return null;
}

// ── 4. NODE_ENV unset ────────────────────────────────────────────────────

/** Environment variables set by container runtimes and hosting platforms. */
export const CONTAINER_ENV_MARKERS = [
  'KUBERNETES_SERVICE_HOST', // Kubernetes
  'container', // podman, systemd-nspawn, LXC
  'FLY_APP_NAME', // Fly.io
  'RAILWAY_ENVIRONMENT', // Railway
  'RAILWAY_ENVIRONMENT_NAME',
  'RENDER', // Render
  'DYNO', // Heroku
  'ECS_CONTAINER_METADATA_URI_V4', // AWS ECS / Fargate
  'ECS_CONTAINER_METADATA_URI',
  'K_SERVICE', // Cloud Run / Knative
] as const;

/** Files created by Docker / podman inside a container. */
export const CONTAINER_MARKER_FILES = ['/.dockerenv', '/run/.containerenv'] as const;

/** The first container / platform marker found, or null when the process does not look containerised. */
export function detectContainer(
  source: EnvSource,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  for (const file of CONTAINER_MARKER_FILES) {
    if (fileExists(file)) return file;
  }
  for (const key of CONTAINER_ENV_MARKERS) {
    if (source[key]) return key;
  }
  return null;
}

/** Mainnet chains: a contract address configured here means real funds. */
const MAINNET_CHAIN_IDS = [1, 8453, 42161, 137] as const;
const CONTRACT_ADDRESS_PREFIXES = [
  'POLICY_MODULE_ADDRESS',
  'EXECUTOR_ADDRESS',
  'ESCROW_MODULE_ADDRESS',
  'AGENT_JOB_ESCROW_ADDRESS',
  'REPUTATION_HOOK_ADDRESS',
  'IDENTITY_REGISTRY_ADDRESS',
] as const;

function isLocalUrl(value: string): boolean {
  try {
    return isLoopbackOrPrivateHost(new URL(value).hostname);
  } catch {
    return true;
  }
}

/**
 * Why the configuration looks like a production deployment (empty when it
 * does not). Any one signal is enough:
 *   - the Turnkey wallet provider (the default): real MPC keys;
 *   - a contract address on a mainnet chain (1, 8453, 42161, 137);
 *   - a live Stripe key (`sk_live_` / `rk_live_`);
 *   - `ADMIN_ALLOW_REMOTE=true`;
 *   - a public `BACKEND_PUBLIC_URL` (not loopback / private).
 */
export function productionSignals(source: EnvSource): string[] {
  const signals: string[] = [];
  const walletProvider = source['WALLET_PROVIDER']?.trim() || 'turnkey';
  if (walletProvider === 'turnkey') signals.push('WALLET_PROVIDER=turnkey (real MPC keys)');
  for (const prefix of CONTRACT_ADDRESS_PREFIXES) {
    for (const chainId of MAINNET_CHAIN_IDS) {
      if (source[`${prefix}_${chainId}`]?.trim()) signals.push(`${prefix}_${chainId} is set (mainnet)`);
    }
  }
  if (/^(?:sk|rk)_live_/.test(source['STRIPE_SECRET_KEY']?.trim() ?? '')) signals.push('STRIPE_SECRET_KEY is a live key');
  if (source['ADMIN_ALLOW_REMOTE'] === 'true') signals.push('ADMIN_ALLOW_REMOTE=true');
  const publicUrl = source['BACKEND_PUBLIC_URL']?.trim();
  if (publicUrl && !isLocalUrl(publicUrl)) signals.push(`BACKEND_PUBLIC_URL is public (${publicUrl})`);
  return signals;
}

export interface NodeEnvUnsetVerdict {
  /** Always printed when NODE_ENV is unset. */
  warning: string;
  /** Set when boot must be refused. */
  fatal: string | null;
}

/**
 * Verdict for an unset `NODE_ENV` (null when it is set). FATAL iff the
 * process looks containerised AND the configuration looks like production.
 */
export function nodeEnvUnsetVerdict(
  source: EnvSource,
  fileExists: (path: string) => boolean = existsSync,
): NodeEnvUnsetVerdict | null {
  if (source['NODE_ENV'] !== undefined) return null;
  const warning =
    'WARN: NODE_ENV is not set — running as NODE_ENV=development. Every production guard is OFF: placeholder ' +
    'secrets, WALLET_PROVIDER=local, plain-http RPC_URL_*, RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS, legacy executors, ' +
    'mock simulation. Set NODE_ENV=production, staging or development explicitly.';
  const container = detectContainer(source, fileExists);
  const signals = productionSignals(source);
  const fatal =
    container && signals.length > 0
      ? `FATAL: NODE_ENV is not set, the process runs in a container / on a hosting platform (${container}) and the ` +
        `configuration looks like production (${signals.join('; ')}). Refusing to boot as development with every ` +
        'production guard off. Set NODE_ENV=production (or staging), or NODE_ENV=development if this really is a ' +
        'development container.'
      : null;
  return { warning, fatal };
}
