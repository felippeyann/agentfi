import { z } from 'zod';
import 'dotenv/config';

const transactionWorkerEnabledDefault: 'true' | 'false' =
  process.env['TRANSACTION_WORKER_ENABLED'] === 'true' ||
  process.env['TRANSACTION_WORKER_ENABLED'] === 'false'
    ? process.env['TRANSACTION_WORKER_ENABLED']
    : (process.env['NODE_ENV'] ?? 'development') === 'production'
      ? 'false'
      : 'true';

const envSchema = z.object({
  // Server
  // Railway injects PORT, fallback to API_PORT, then 3000
  API_PORT: z.coerce.number().default(parseInt(process.env['PORT'] ?? process.env['API_PORT'] ?? '3000')),
  API_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),

  // RPC
  ALCHEMY_API_KEY: z.string().min(1),
  INFURA_API_KEY: z.string().optional(),

  // Wallet Infrastructure
  // WALLET_PROVIDER=local uses in-memory viem keys — development only.
  // WALLET_PROVIDER=turnkey (default) requires the three TURNKEY_* vars below.
  WALLET_PROVIDER: z.enum(['turnkey', 'local']).default('turnkey'),
  TURNKEY_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_API_PRIVATE_KEY: z.string().optional(),
  TURNKEY_ORGANIZATION_ID: z.string().optional(),

  // Simulation
  TENDERLY_ACCESS_KEY: z.string().optional(),
  TENDERLY_ACCOUNT: z.string().optional(),
  TENDERLY_PROJECT: z.string().optional(),

  // Database (postgresql:// not accepted by z.url(), use .min(1))
  DATABASE_URL: z.string().min(1),

  // Redis (redis:// / rediss:// not accepted by z.url(), use .min(1))
  REDIS_URL: z.string().min(1),

  // Queue worker controls
  // Default behavior:
  // - production: disabled unless explicitly enabled (to avoid multiple API replicas polling Redis)
  // - non-production: enabled
  TRANSACTION_WORKER_ENABLED: z.enum(['true', 'false']).default(transactionWorkerEnabledDefault),
  TRANSACTION_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  TRANSACTION_WORKER_DRAIN_DELAY_SEC: z.coerce.number().int().positive().default(30),
  TRANSACTION_WORKER_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  TRANSACTION_WORKER_STOP_ON_REDIS_QUOTA: z.enum(['true', 'false']).default('true'),

  // Contracts
  POLICY_MODULE_ADDRESS_1: z.string().optional(),
  POLICY_MODULE_ADDRESS_8453: z.string().optional(),
  POLICY_MODULE_ADDRESS_42161: z.string().optional(),
  POLICY_MODULE_ADDRESS_137: z.string().optional(),
  EXECUTOR_ADDRESS_1: z.string().optional(),
  EXECUTOR_ADDRESS_8453: z.string().optional(),
  EXECUTOR_ADDRESS_42161: z.string().optional(),
  EXECUTOR_ADDRESS_137: z.string().optional(),

  // Revenue — fee collection wallet (0x Ethereum address)
  OPERATOR_FEE_WALLET: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid 0x Ethereum address'),

  // Stripe billing (optional — Stripe features disabled if not set)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),

  // Admin dashboard — required to protect /admin/* routes
  ADMIN_SECRET: z.string().min(1),
  ADMIN_ALLOW_REMOTE: z.enum(['true', 'false']).default('false'),

  // CORS — comma-separated allowed origins for the admin frontend in production.
  // Default: https://admin.agentfi.cc  Example: https://admin.agentfi.cc,https://app.agentfi.cc
  CORS_ORIGIN: z.string().optional(),

  // Safe smart wallet deployer — optional (falls back to Turnkey EOA if not set)
  SAFE_DEPLOYER_PRIVATE_KEY: z.string().optional(),

  // Rate-limit overrides (requests/minute per tier)
  RATE_LIMIT_FREE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PRO: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_ENTERPRISE: z.coerce.number().int().positive().default(3000),

  // Public self-registration limit (per IP, per hour).
  // Default 5/hour = 120/day per IP, which lets an evaluator poke around
  // without enabling industrial-scale scraping of wallet creations. Set to
  // 0 to effectively disable (any positive value is allowed; 0 rejects all).
  PUBLIC_REGISTRATION_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Reject known placeholder values in production to prevent accidental deploys
// with default .env.example credentials.
if (parsed.data.NODE_ENV === 'production') {
  const ADMIN_SECRET_PLACEHOLDER = 'your-admin-secret-min-32-chars-here';
  if (parsed.data.ADMIN_SECRET === ADMIN_SECRET_PLACEHOLDER) {
    console.error(
      'FATAL: ADMIN_SECRET is set to the .env.example placeholder value. ' +
      'Set a strong random secret before deploying to production.',
    );
    process.exit(1);
  }

  // Refuse to boot production with the local (in-memory) wallet provider —
  // it's development-only and would silently lose keys on every restart.
  if (parsed.data.WALLET_PROVIDER === 'local') {
    console.error(
      'FATAL: WALLET_PROVIDER=local is development-only and cannot run with NODE_ENV=production. ' +
      'Set WALLET_PROVIDER=turnkey and provide TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID.',
    );
    process.exit(1);
  }
}

// When WALLET_PROVIDER=turnkey, the three TURNKEY_* vars must be present —
// we relaxed them to optional at the schema level so local-mode boot works
// without credentials, but the turnkey path still needs them.
if (parsed.data.WALLET_PROVIDER === 'turnkey') {
  const missing = [
    ['TURNKEY_API_PUBLIC_KEY', parsed.data.TURNKEY_API_PUBLIC_KEY],
    ['TURNKEY_API_PRIVATE_KEY', parsed.data.TURNKEY_API_PRIVATE_KEY],
    ['TURNKEY_ORGANIZATION_ID', parsed.data.TURNKEY_ORGANIZATION_ID],
  ].filter(([, v]) => !v || (typeof v === 'string' && v.length === 0));

  if (missing.length > 0) {
    console.error(
      'Invalid environment variables: WALLET_PROVIDER=turnkey requires ' +
      missing.map(([k]) => k).join(', ') +
      '. Either supply those or set WALLET_PROVIDER=local (development only).',
    );
    process.exit(1);
  }
}

export const env = parsed.data;
