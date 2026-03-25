import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Server
  API_PORT: z.coerce.number().default(3000),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
