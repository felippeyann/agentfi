#!/usr/bin/env node
/**
 * AgentFi — Swap Planner Example
 *
 * Shows the DeFi planning pipeline (policy + calldata + simulation)
 * against a running AgentFi backend, without broadcasting any transaction.
 *
 * Runs cleanly on the zero-credential dev stack:
 *   - No Alchemy key needed: fromToken is in KNOWN_DECIMALS (USDC Base)
 *     so decimals resolve without an on-chain read
 *   - No Tenderly key needed: simulator gracefully degrades and returns
 *     a mocked success with `_isMock: true`
 *   - No Turnkey needed: LocalWalletService (WALLET_PROVIDER=local)
 *
 * To graduate: set WALLET_PROVIDER=turnkey + ALCHEMY_API_KEY and switch
 * the last step from POST /v1/transactions/simulate to
 * POST /v1/transactions/swap — same request body, real execution.
 *
 * Usage (defaults match docker-compose.dev.yml):
 *   node examples/swap-planner/index.mjs
 *
 * Customize:
 *   AGENTFI_API_URL=... \
 *   AGENTFI_OPERATOR_SECRET=... \
 *   node examples/swap-planner/index.mjs
 */

const API_URL =
  process.env.AGENTFI_API_URL ?? 'http://localhost:3000';
const OPERATOR_SECRET =
  process.env.AGENTFI_OPERATOR_SECRET ??
  'dev-api-secret-min-32-chars-long-xxxxx';

// Base Mainnet addresses (AgentFi contracts are deployed on Base)
const BASE_CHAIN_ID = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const UNISWAP_V3_ROUTER_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481';

// ── fetch wrapper ──────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${options.method ?? 'GET'} ${path} → ${res.status}: ` +
        (typeof body === 'string' ? body : JSON.stringify(body)),
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function log(step, msg, detail) {
  const prefix = `\x1b[36m[${step}]\x1b[0m`;
  console.log(prefix, msg);
  if (detail !== undefined) console.log(detail);
}

// ── steps ──────────────────────────────────────────────────────────────────

async function registerAgent(name) {
  return api('/v1/agents', {
    method: 'POST',
    headers: { 'x-api-key': OPERATOR_SECRET },
    body: JSON.stringify({
      name,
      chainIds: [BASE_CHAIN_ID],
      tier: 'FREE',
      policy: {
        // 0.5 ETH per tx ceiling — simulates a conservative bot
        maxValuePerTxEth: '0.5',
        maxDailyVolumeUsd: '1000',
        // Only Uniswap V3 router is allowed; arbitrary contracts are blocked
        allowedContracts: [UNISWAP_V3_ROUTER_BASE],
        allowedTokens: [USDC_BASE, WETH_BASE],
        cooldownSeconds: 0,
      },
    }),
  });
}

async function getAgentMe(apiKey) {
  return api('/v1/agents/me', {
    headers: { 'x-api-key': apiKey },
  });
}

async function simulateSwap(apiKey, { fromToken, toToken, amountIn, chainId }) {
  return api('/v1/transactions/simulate', {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify({ fromToken, toToken, amountIn, chainId }),
  });
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('env', `API_URL = ${API_URL}`);

  log('1', 'Register an agent with a strict policy on Base');
  const agent = await registerAgent(`swap-planner-${Date.now()}`);
  log('1', `Agent ${agent.id} provisioned`);
  log('1', `  wallet address: ${agent.walletAddress}`);
  log('1', `  tier:           ${agent.tier}`);
  log('1', `  max per tx:     0.5 ETH`);
  log('1', `  allowed router: Uniswap V3 (${UNISWAP_V3_ROUTER_BASE})`);

  log('2', 'Inspect the agent record (policy lives in DB, checked off-chain)');
  const me = await getAgentMe(agent.apiKey);
  console.log('       chains:          ', me.chainIds);
  console.log('       tier:            ', me.tier);
  console.log('       policy:          ', {
    maxValuePerTxEth: me.policy?.maxValuePerTxEth,
    maxDailyVolumeUsd: me.policy?.maxDailyVolumeUsd,
    cooldownSeconds: me.policy?.cooldownSeconds,
  });
  console.log('       allowedContracts:', me.policy?.allowedContracts);
  console.log('       allowedTokens:   ', me.policy?.allowedTokens);

  log('3', 'Simulate swap: 10 USDC → WETH on Base via Uniswap V3');
  const sim = await simulateSwap(agent.apiKey, {
    fromToken: USDC_BASE,
    toToken: WETH_BASE,
    amountIn: '10',
    chainId: BASE_CHAIN_ID,
  });

  log('3', `Simulation result:`);
  console.log('       success:      ', sim.success);
  console.log('       gasEstimate:  ', sim.gasEstimate);
  console.log('       gasPrice:     ', sim.gasPrice);
  console.log('       simulationId: ', sim.simulationId);
  if (sim.simulationId?.startsWith('mock_')) {
    console.log(
      '       \x1b[33mnote\x1b[0m         : mocked result — set TENDERLY_ACCESS_KEY+ACCOUNT+PROJECT for real simulations',
    );
  }

  console.log('\n\x1b[32m✓ Planning pipeline completed.\x1b[0m');
  console.log(
    '\nWhat just happened:\n' +
      '  1. Agent is live in the DB with a policy bound to its Safe-address.\n' +
      '  2. The backend built valid Uniswap V3 calldata from your request.\n' +
      '  3. The simulator attested the call would succeed (mocked in dev).\n' +
      '  4. No funds moved. The swap was NOT broadcast.\n\n' +
      'To execute for real:\n' +
      '  - Set WALLET_PROVIDER=turnkey + valid TURNKEY_* + ALCHEMY_API_KEY\n' +
      '  - Change the endpoint from /v1/transactions/simulate to\n' +
      '    /v1/transactions/swap (same body).\n' +
      '  - Backend enqueues the signed tx; worker broadcasts; protocol fee\n' +
      '    is collected on-chain atomically via AgentExecutor.',
  );
}

main().catch((err) => {
  console.error('\n\x1b[31m✗ Example failed:\x1b[0m', err.message);
  if (err.body) console.error(err.body);
  process.exit(1);
});
