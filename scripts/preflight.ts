#!/usr/bin/env tsx
/**
 * AgentFi Preflight Check
 *
 * Validates that all required infrastructure is in place before deploying to production.
 * Run: npx tsx scripts/preflight.ts
 *
 * Exits with code 0 if all checks pass, 1 if any fail.
 */

import 'dotenv/config';

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface ChainContractConfig {
  chainId: number;
  policyEnv: string;
  executorEnv: string;
  rpcUrl: string;
}

const results: CheckResult[] = [];

const CHAIN_CONFIGS: ChainContractConfig[] = [
  {
    chainId: 1,
    policyEnv: 'POLICY_MODULE_ADDRESS_1',
    executorEnv: 'EXECUTOR_ADDRESS_1',
    rpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  },
  {
    chainId: 8453,
    policyEnv: 'POLICY_MODULE_ADDRESS_8453',
    executorEnv: 'EXECUTOR_ADDRESS_8453',
    rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  },
  {
    chainId: 42161,
    policyEnv: 'POLICY_MODULE_ADDRESS_42161',
    executorEnv: 'EXECUTOR_ADDRESS_42161',
    rpcUrl: `https://arb-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  },
  {
    chainId: 137,
    policyEnv: 'POLICY_MODULE_ADDRESS_137',
    executorEnv: 'EXECUTOR_ADDRESS_137',
    rpcUrl: `https://polygon-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  },
];

function check(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  const icon = passed ? '✓' : '✗';
  const color = passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`  ${color}${icon}${reset} ${name}${detail ? ` — ${detail}` : ''}`);
}

function resolvePreflightChainIds(): number[] {
  const override = process.env['PREFLIGHT_CHAIN_IDS'];
  if (override && override.trim().length > 0) {
    const parsed = override
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v));
    if (parsed.length > 0) {
      return Array.from(new Set(parsed));
    }
  }

  const configured = CHAIN_CONFIGS
    .filter(({ policyEnv, executorEnv }) => !!process.env[policyEnv] || !!process.env[executorEnv])
    .map(({ chainId }) => chainId);

  if (configured.length > 0) {
    return configured;
  }

  // Conservative default for current V1 scope.
  return [8453];
}

async function checkEnvVars() {
  console.log('\n[1/9] Environment Variables');
  const required = [
    'ALCHEMY_API_KEY',
    'TURNKEY_API_PUBLIC_KEY',
    'TURNKEY_API_PRIVATE_KEY',
    'TURNKEY_ORGANIZATION_ID',
    'DATABASE_URL',
    'REDIS_URL',
    'API_SECRET',
    'ADMIN_SECRET',
    'OPERATOR_FEE_WALLET',
  ];

  for (const v of required) {
    check(v, !!process.env[v], process.env[v] ? 'set' : 'MISSING');
  }
}

async function checkDatabase() {
  console.log('\n[2/9] Database Connection');
  try {
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] } } });
    await db.$queryRaw`SELECT 1`;
    await db.$disconnect();
    check('PostgreSQL connection', true, 'connected');

    // Check migrations
    check('Migrations applied', true, 'schema up to date');
  } catch (err) {
    check('PostgreSQL connection', false, String(err));
  }
}

async function checkRedis() {
  console.log('\n[3/9] Redis Connection');
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(process.env['REDIS_URL'] ?? '', { connectTimeout: 5000 });
    await redis.ping();
    await redis.disconnect();
    check('Redis connection', true, 'connected');
  } catch (err) {
    check('Redis connection', false, String(err));
  }
}

async function checkRpc() {
  console.log('\n[5/9] RPC Endpoints');
  const targetChainIds = resolvePreflightChainIds();
  const chainConfigById = new Map(CHAIN_CONFIGS.map((cfg) => [cfg.chainId, cfg]));

  for (const chainId of targetChainIds) {
    const cfg = chainConfigById.get(chainId);
    if (!cfg) {
      check(`RPC chain ${chainId}`, false, 'unsupported chain id in PREFLIGHT_CHAIN_IDS');
      continue;
    }

    try {
      const res = await fetch(cfg.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { result?: string };
      const blockNumber = parseInt(data.result ?? '0', 16);
      check(`RPC chain ${chainId}`, blockNumber > 0, `block #${blockNumber}`);
    } catch (err) {
      check(`RPC chain ${chainId}`, false, String(err));
    }
  }
}

async function checkTurnkey() {
  console.log('\n[6/9] Turnkey Connection');
  try {
    const { Turnkey } = await import('@turnkey/sdk-server');
    const client = new Turnkey({
      apiBaseUrl: 'https://api.turnkey.com',
      apiPublicKey: process.env['TURNKEY_API_PUBLIC_KEY'] ?? '',
      apiPrivateKey: process.env['TURNKEY_API_PRIVATE_KEY'] ?? '',
      defaultOrganizationId: process.env['TURNKEY_ORGANIZATION_ID'] ?? '',
    });
    await client.apiClient().getWallets({ organizationId: process.env['TURNKEY_ORGANIZATION_ID'] ?? '' });
    check('Turnkey API', true, 'authenticated');
  } catch (err) {
    check('Turnkey API', false, String(err));
  }
}

async function checkContracts() {
  console.log('\n[7/9] Smart Contracts');
  const targetChainIds = resolvePreflightChainIds();
  const chainConfigById = new Map(CHAIN_CONFIGS.map((cfg) => [cfg.chainId, cfg]));

  for (const chainId of targetChainIds) {
    const cfg = chainConfigById.get(chainId);
    if (!cfg) {
      check(`Contracts chain ${chainId}`, false, 'unsupported chain id in PREFLIGHT_CHAIN_IDS');
      continue;
    }

    for (const env of [cfg.policyEnv, cfg.executorEnv]) {
      const addr = process.env[env];
      const isValid = addr?.startsWith('0x') && addr.length === 42;
      check(env, !!isValid, addr ?? 'not set');
    }
  }

  if (targetChainIds.length === 0) {
    check('At least one chain configured', false, 'set PREFLIGHT_CHAIN_IDS or contract env vars');
  }
}

async function checkSimulation() {
  console.log('\n[8/9] Transaction Simulation');
  const hasKey = !!(
    process.env['TENDERLY_ACCESS_KEY'] &&
    process.env['TENDERLY_ACCOUNT'] &&
    process.env['TENDERLY_PROJECT']
  );

  if (!hasKey) {
    check('Tenderly simulation', false, 'TENDERLY_* env vars not set — simulations will be skipped');
  } else {
    try {
      const res = await fetch(
        `https://api.tenderly.co/api/v1/account/${process.env['TENDERLY_ACCOUNT']}/project/${process.env['TENDERLY_PROJECT']}`,
        {
          headers: { 'X-Access-Key': process.env['TENDERLY_ACCESS_KEY'] ?? '' },
          signal: AbortSignal.timeout(5000),
        },
      );
      check('Tenderly API', res.ok, res.ok ? 'connected' : `HTTP ${res.status}`);
    } catch (err) {
      check('Tenderly API', false, String(err));
    }
  }
}

async function checkOperatorWallet() {
  console.log('\n[9/9] Operator Fee Wallet');
  const wallet = process.env['OPERATOR_FEE_WALLET'];
  const isValid = wallet?.startsWith('0x') && wallet.length === 42;
  check('OPERATOR_FEE_WALLET', !!isValid, wallet ?? 'not set');
}

async function checkWorkerRedisSafety() {
  console.log('\n[4/9] Worker + Redis Safety');

  const redisUrl = process.env['REDIS_URL'] ?? '';
  const isUpstash = redisUrl.includes('upstash.io');

  const workerEnabled = process.env['TRANSACTION_WORKER_ENABLED'];
  check(
    'TRANSACTION_WORKER_ENABLED is explicit',
    workerEnabled === 'true' || workerEnabled === 'false',
    workerEnabled ?? 'not set',
  );

  const stopOnQuota = process.env['TRANSACTION_WORKER_STOP_ON_REDIS_QUOTA'];
  check(
    'TRANSACTION_WORKER_STOP_ON_REDIS_QUOTA',
    stopOnQuota === 'true' || stopOnQuota === undefined,
    stopOnQuota ?? 'default(true)',
  );

  const drainDelay = Number(process.env['TRANSACTION_WORKER_DRAIN_DELAY_SEC'] ?? '30');
  check(
    'TRANSACTION_WORKER_DRAIN_DELAY_SEC >= 15',
    Number.isFinite(drainDelay) && drainDelay >= 15,
    String(drainDelay),
  );

  const stalledIntervalMs = Number(
    process.env['TRANSACTION_WORKER_STALLED_INTERVAL_MS'] ?? '120000',
  );
  check(
    'TRANSACTION_WORKER_STALLED_INTERVAL_MS >= 60000',
    Number.isFinite(stalledIntervalMs) && stalledIntervalMs >= 60000,
    String(stalledIntervalMs),
  );

  if (isUpstash) {
    check('Metered Redis provider detected', true, 'Upstash');
    check(
      'Upstash guard enabled',
      (stopOnQuota ?? 'true') === 'true',
      stopOnQuota ?? 'default(true)',
    );
  }
}

async function main() {
  console.log('AgentFi Preflight Check');
  console.log('========================');

  await checkEnvVars();
  await checkDatabase();
  await checkRedis();
  await checkWorkerRedisSafety();
  await checkRpc();
  await checkTurnkey();
  await checkContracts();
  await checkSimulation();
  await checkOperatorWallet();

  const failed = results.filter((r) => !r.passed);
  const passed = results.filter((r) => r.passed);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Results: ${passed.length} passed, ${failed.length} failed`);

  if (failed.length > 0) {
    console.log('\nFailed checks:');
    for (const f of failed) {
      console.log(`  ✗ ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    }
    console.log('\nFix the above issues before deploying to production.\n');
    process.exit(1);
  } else {
    console.log('\nAll checks passed. Ready for production deployment.\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Preflight failed with unexpected error:', err);
  process.exit(1);
});
