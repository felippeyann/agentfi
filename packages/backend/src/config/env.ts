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
  TURNKEY_API_PUBLIC_KEY: z.string().min(1),
  TURNKEY_API_PRIVATE_KEY: z.string().min(1),
  TURNKEY_ORGANIZATION_ID: z.string().min(1),

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
}

export const env = parsed.data;
