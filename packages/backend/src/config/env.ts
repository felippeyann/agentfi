import { z } from 'zod';
import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { describeLegacyContract, findLegacyContractConfig } from './contracts.js';

/** Chains the ERC-8183 escrow can be configured on (one address pair per chain). */
export const ESCROW_CHAIN_IDS = [1, 8453, 42161, 137, 84532] as const;

// dotenv and docker `env_file` deliver a blank `KEY=` line as "", which a
// format-constrained optional field would reject and abort boot. Treat blank
// as unset for every optional escrow variable (same trick as X402_FACILITATOR_URL).
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalAddress = (label: string) =>
  z.preprocess(
    blankToUndefined,
    z.string().regex(/^0x[0-9a-fA-F]{40}$/, `${label} must be a 0x Ethereum address`).optional(),
  );

const escrowAddressFields = Object.fromEntries(
  ESCROW_CHAIN_IDS.flatMap((chainId) => [
    [`AGENT_JOB_ESCROW_ADDRESS_${chainId}`, optionalAddress(`AGENT_JOB_ESCROW_ADDRESS_${chainId}`)],
    [`REPUTATION_HOOK_ADDRESS_${chainId}`, optionalAddress(`REPUTATION_HOOK_ADDRESS_${chainId}`)],
  ]),
) as Record<
  `AGENT_JOB_ESCROW_ADDRESS_${(typeof ESCROW_CHAIN_IDS)[number]}` | `REPUTATION_HOOK_ADDRESS_${(typeof ESCROW_CHAIN_IDS)[number]}`,
  ReturnType<typeof optionalAddress>
>;

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
  // Base Sepolia (testnet). No hard-coded defaults any more: the former
  // testnet deployment used the pre-October-2026 AgentExecutor.Action struct
  // (see docs/operations/contract-deployment.md, "ABI versioning").
  POLICY_MODULE_ADDRESS_84532: z.string().optional(),
  EXECUTOR_ADDRESS_84532: z.string().optional(),
  ESCROW_MODULE_ADDRESS_84532: z.string().optional(),

  // ERC-8183 escrow (C3) — `AgentJobEscrow` / `ReputationHook` per chain, as
  // printed by `script/DeployEscrow.s.sol`. Setting an escrow address enables
  // the ERC-8183 flow for paid A2A jobs on that chain (USDC only, decision D8).
  ...escrowAddressFields,
  // Operator/backend signer that is the `evaluator` of every ERC-8183 job
  // (decision D5): it signs `complete` / `reject` / `claimRefund`. Required in
  // staging/production whenever an escrow address is configured; in
  // development the escrow flow is simply disabled without it (WARN at boot).
  ESCROW_EVALUATOR_PRIVATE_KEY: z.preprocess(
    blankToUndefined,
    z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'ESCROW_EVALUATOR_PRIVATE_KEY must be 0x + 64 hex chars').optional(),
  ),
  // `expiredAt = now + TTL` on `createJob`; `claimRefund` becomes possible after it.
  ESCROW_JOB_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  // Grace period between the provider's `submit` confirming and the evaluator
  // sending `complete`, during which the requester may `POST /v1/jobs/:id/contest`.
  ESCROW_EVALUATION_DELAY_SECONDS: z.coerce.number().int().min(0).default(0),
  // Public base URL of this API, used to build the ERC-8004 `feedbackURI`
  // (`<BACKEND_PUBLIC_URL>/v1/jobs/<id>/feedback.json`) and the on-chain job description.
  BACKEND_PUBLIC_URL: z.preprocess(
    blankToUndefined,
    z.string().url().default('http://localhost:3000'),
  ),

  // Revenue — fee collection wallet (0x Ethereum address)
  OPERATOR_FEE_WALLET: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid 0x Ethereum address'),

  // Stripe billing (optional — Stripe features disabled if not set)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),

  // Admin dashboard — required to protect /admin/* routes
  ADMIN_SECRET: z.string().min(32),
  ADMIN_ALLOW_REMOTE: z.enum(['true', 'false']).default('false'),

  // CORS — comma-separated allowed origins for the admin frontend in production.
  // Default: https://admin.agentfi.cc  Example: https://admin.agentfi.cc,https://app.agentfi.cc
  CORS_ORIGIN: z.string().optional(),

  // Safe smart wallet deployer — optional (falls back to Turnkey EOA if not set)
  SAFE_DEPLOYER_PRIVATE_KEY: z.string().optional(),

  // x402 facilitator override — optional. Defaults per chain live in
  // config/x402.ts (x402.org for Base Sepolia, CDP for Base). A blank value
  // (`X402_FACILITATOR_URL=` from dotenv/env_file) means "unset": `.optional()`
  // alone would reject "" against `.url()` and abort boot.
  X402_FACILITATOR_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),

  // POST /v1/jobs/:id/pay-resource outbound target policy (S4). By default
  // the backend refuses to fetch a URL whose host is, or resolves to, a
  // private / loopback / link-local / reserved address, in every
  // environment. `true` lifts that refusal for local development against a
  // resource server on loopback (DNS pinning and the no-redirect rule still
  // apply). Refused at boot in production and staging.
  RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS: z.preprocess(blankToUndefined, z.enum(['true', 'false']).default('false')),

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

  // Tenderly is optional, but without it production simulates every tx via a
  // plain eth_call/estimateGas dry-run (no trace, no state diff). Say so at
  // boot. A mock simulation is never used in production (see simulator.service).
  if (
    !parsed.data.TENDERLY_ACCESS_KEY ||
    !parsed.data.TENDERLY_ACCOUNT ||
    !parsed.data.TENDERLY_PROJECT
  ) {
    console.warn(
      'WARN: Tenderly is not configured (TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT); ' +
      'falling back to eth_call simulation (estimateGas dry-run) for every transaction.',
    );
  }
}

// Refuse to boot a production-like deployment with a known legacy executor
// (pre-October-2026 AgentExecutor.Action struct). Every transaction routed
// through it reverts, so a warning is not enough where real funds move. In
// development the API only warns (index.ts) and ExecutorService routes around
// it (config/contracts.ts `resolveExecutorAddress`).
if (parsed.data.NODE_ENV === 'production' || parsed.data.NODE_ENV === 'staging') {
  const legacyExecutors = findLegacyContractConfig(process.env).filter(
    (hit) => hit.contract === 'executor',
  );
  if (legacyExecutors.length > 0) {
    console.error(
      `FATAL: NODE_ENV=${parsed.data.NODE_ENV} cannot run with a legacy AgentExecutor configured. ` +
        legacyExecutors.map(describeLegacyContract).join(' '),
    );
    process.exit(1);
  }

  // The private-host override turns pay-resource into a way for any provider
  // agent to read internal services (cloud metadata, databases, the admin
  // API on loopback). Development / test only.
  if (parsed.data.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS === 'true') {
    console.error(
      `FATAL: RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true cannot run with NODE_ENV=${parsed.data.NODE_ENV}. ` +
        'It lets POST /v1/jobs/:id/pay-resource fetch private, loopback and link-local addresses ' +
        '(development / test only). Unset it or set it to false.',
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

// ERC-8183 evaluator signer (decision D5). Derive the address once at boot so
// every module (routes, orchestrator, settlement worker) agrees on who the
// evaluator is, and so operators can see it in the boot log and pass it as
// TRUSTED_EVALUATOR to DeployEscrow.s.sol.
const configuredEscrowChains = ESCROW_CHAIN_IDS.filter(
  (chainId) => Boolean(parsed.data[`AGENT_JOB_ESCROW_ADDRESS_${chainId}`]),
);
let derivedEvaluatorAddress: Address | null = null;
if (parsed.data.ESCROW_EVALUATOR_PRIVATE_KEY) {
  derivedEvaluatorAddress = privateKeyToAccount(parsed.data.ESCROW_EVALUATOR_PRIVATE_KEY as Hex).address;
}
if (
  configuredEscrowChains.length > 0 &&
  !derivedEvaluatorAddress &&
  (parsed.data.NODE_ENV === 'production' || parsed.data.NODE_ENV === 'staging')
) {
  console.error(
    `FATAL: NODE_ENV=${parsed.data.NODE_ENV} has AGENT_JOB_ESCROW_ADDRESS_${configuredEscrowChains[0]} set ` +
      'but no ESCROW_EVALUATOR_PRIVATE_KEY. The backend is the evaluator of every ERC-8183 job ' +
      '(decision D5) and cannot settle or refund escrowed USDC without it.',
  );
  process.exit(1);
}

export const env = parsed.data;

/** Address of the ERC-8183 evaluator signer, or null when no key is configured. */
export const escrowEvaluatorAddress: Address | null = derivedEvaluatorAddress;

/** Chain ids with an `AGENT_JOB_ESCROW_ADDRESS_<id>` configured (regardless of the evaluator key). */
export const configuredEscrowChainIds: readonly number[] = configuredEscrowChains;
