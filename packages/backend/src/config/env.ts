import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Server
  // Railway injects PORT, fallback to API_PORT, then 3000
  API_PORT: z.coerce.number().default(parseInt(process.env['PORT'] ?? process.env['API_PORT'] ?? '3000')),
  API_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),

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

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

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

  // CORS — comma-separated allowed origins for the admin frontend in production.
  // Default: https://admin.agentfi.cc  Example: https://admin.agentfi.cc,https://app.agentfi.cc
  CORS_ORIGIN: z.string().optional(),

  // Safe smart wallet deployer — optional (falls back to Turnkey EOA if not set)
  SAFE_DEPLOYER_PRIVATE_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
