#!/usr/bin/env node
/**
 * AgentFi — ERC-8183 escrow example (two agents, USDC, ERC-8004 feedback)
 *
 * The happy path of a paid agent-to-agent job on a chain where the AgentFi
 * backend has the ERC-8183 `AgentJobEscrow` configured (task X1 groundwork):
 *
 *   1. Register (or reuse) two agents: a requester and a provider
 *   2. Make sure their wallets are funded: USDC for the requester's budget,
 *      a little native ETH for gas on both wallets
 *   3. Requester creates a job with a USDC reward → the backend escrows it
 *      on-chain from the requester's wallet: createJob → setBudget →
 *      approve → fund
 *   4. Provider accepts (only possible once the budget is locked)
 *   5. The provider's wallet gets an ERC-8004 identity on its first funded
 *      job and binds it to the escrow job (setProviderAgentId)
 *   6. Provider delivers → submit(keccak256(result)) → the backend evaluator
 *      completes → USDC released minus the 30 bps platform fee, and the
 *      escrow's ReputationHook writes ERC-8004 feedback in the same tx
 *
 * AGENTFI_FLOW=cancel runs the failure path instead: after step 3 the
 * requester cancels → evaluator reject → the full budget is refunded.
 *
 * Zero dependencies (Node 22 native fetch). It never sees a private key:
 * the agents' wallets live in the backend (Turnkey or the dev-only local
 * provider); this script only calls the AgentFi REST API and, to read
 * balances, a JSON-RPC endpoint.
 *
 * Usage — see README.md:
 *   AGENTFI_API_URL=http://127.0.0.1:3155 \
 *   AGENTFI_OPERATOR_SECRET=<backend API_SECRET> \
 *   AGENTFI_RPC_URL=http://127.0.0.1:8546 AGENTFI_FORK_FUNDING=true \
 *   node examples/escrow-erc8183/index.mjs
 */

const env = process.env;
const API_URL = (env.AGENTFI_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const OPERATOR_SECRET = env.AGENTFI_OPERATOR_SECRET ?? 'dev-api-secret-min-32-chars-long-xxxxx';
const CHAIN_ID = Number(env.AGENTFI_CHAIN_ID ?? 84532);
const REWARD_USDC = env.AGENTFI_REWARD_USDC ?? '1.0'; // ≥ 1 USDC: the hook's minFeedbackBudget
const REQUESTER_API_KEY = env.AGENTFI_REQUESTER_API_KEY; // optional: reuse already-funded agents
const PROVIDER_API_KEY = env.AGENTFI_PROVIDER_API_KEY;
const FORK_FUNDING = env.AGENTFI_FORK_FUNDING === 'true';
// `happy` (default) or `cancel`: the requester cancels once the budget is
// locked → evaluator reject → full refund (C5's failure path).
const FLOW = env.AGENTFI_FLOW ?? 'happy';
if (!['happy', 'cancel'].includes(FLOW)) {
  console.error(`AGENTFI_FLOW must be "happy" or "cancel" (got "${FLOW}")`);
  process.exit(1);
}
const POLL_MS = Number(env.AGENTFI_POLL_INTERVAL_MS ?? 3000);
const FUNDING_TIMEOUT_MS = Number(env.AGENTFI_FUNDING_TIMEOUT_SEC ?? 900) * 1000;
const STEP_TIMEOUT_MS = Number(env.AGENTFI_STEP_TIMEOUT_SEC ?? 600) * 1000;

const CHAINS = {
  84532: { name: 'Base Sepolia', rpc: 'https://sepolia.base.org', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', explorer: 'https://sepolia.basescan.org' },
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', explorer: 'https://basescan.org' },
};
const chain = CHAINS[CHAIN_ID];
if (!chain && !(env.AGENTFI_RPC_URL && env.AGENTFI_USDC_ADDRESS)) {
  console.error(`Chain ${CHAIN_ID} has no defaults here: set AGENTFI_RPC_URL and AGENTFI_USDC_ADDRESS.`);
  process.exit(1);
}
const RPC_URL = env.AGENTFI_RPC_URL ?? chain.rpc;
const USDC = env.AGENTFI_USDC_ADDRESS ?? chain.usdc;
const EXPLORER = FORK_FUNDING ? null : chain?.explorer ?? null;

const MIN_GAS_WEI = 500_000_000_000_000n; // 0.0005 ETH — a few escrow / identity txs on Base
const usdcUnits = (amount) => {
  const [whole, frac = ''] = String(amount).split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
};
const BUDGET_UNITS = usdcUnits(REWARD_USDC);
const fmtUsdc = (units) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')} USDC`;
const fmtEth = (wei) => `${Number(wei) / 1e18} ETH`;
const color = (code, text) => (env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);

function log(step, msg) {
  console.log(color('36', `[${step}]`), msg);
}

// ── AgentFi REST API ───────────────────────────────────────────────────────

async function api(path, { method = 'GET', apiKey, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function registerAgent(name) {
  const agent = await api('/v1/agents', {
    method: 'POST',
    apiKey: OPERATOR_SECRET,
    body: { name, chainIds: [CHAIN_ID] },
  });
  return { id: agent.id, name: agent.name, apiKey: agent.apiKey, address: agent.safeAddress };
}

async function loadAgent(apiKey) {
  const me = await api('/v1/agents/me', { apiKey });
  if (!me.chainIds?.includes(CHAIN_ID)) throw new Error(`agent ${me.id} does not list chain ${CHAIN_ID} in chainIds`);
  return { id: me.id, name: me.name, apiKey, address: me.walletAddress }; // walletAddress = the agent's safeAddress
}

const getJob = (apiKey, id) => api(`/v1/jobs/${id}`, { apiKey });

async function waitForJob(apiKey, id, what, done, { failOn = defaultFailure } = {}) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let lastLine = '';
  for (;;) {
    const job = await getJob(apiKey, id);
    const line = `status=${job.status} onChain=${job.escrow?.onChainStatus} binding=${job.escrow?.providerAgentIdStatus ?? '-'}`;
    if (line !== lastLine) {
      console.log(`       ${line}`);
      lastLine = line;
    }
    if (done(job)) return job;
    const failure = failOn(job);
    if (failure) throw new Error(`${what}: ${failure}`);
    if (Date.now() > deadline) throw new Error(`${what}: timed out (${line})`);
    await sleep(POLL_MS);
  }
}

function defaultFailure(job) {
  if (job.escrow?.onChainStatus === 'FAILED') return `escrow funding failed: ${job.escrow.escrowError}`;
  if (job.status === 'FAILED' || job.status === 'PAYMENT_FAILED' || job.status === 'CANCELLED') {
    return `job ${job.status}: ${job.escrow?.escrowError ?? 'no escrow error recorded'}`;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JSON-RPC (balances; cheat codes only on a local fork) ──────────────────

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ethBalance = async (address) => BigInt(await rpc('eth_getBalance', [address, 'latest']));
const usdcBalance = async (address) =>
  BigInt(await rpc('eth_call', [{ to: USDC, data: `0x70a08231${word(address)}` }, 'latest'])); // balanceOf(address)

/**
 * Local Anvil fork only: gas via anvil_setBalance, USDC through the token's
 * own mint path — impersonate FiatToken's masterMinter, configureMinter a
 * throwaway minter, impersonate it and mint. No keys involved.
 */
async function forkFund(address, { usdc = 0n, eth }) {
  const host = new URL(RPC_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`AGENTFI_FORK_FUNDING=true needs a local Anvil fork as AGENTFI_RPC_URL (got ${RPC_URL})`);
  }
  await rpc('anvil_setBalance', [address, `0x${eth.toString(16)}`]);
  if (usdc === 0n) return;
  const masterMinter = `0x${(await rpc('eth_call', [{ to: USDC, data: '0x35d99f35' }, 'latest'])).slice(-40)}`; // masterMinter()
  const minter = '0x00000000000000000000000000000000000c5a01';
  const send = async (from, data) => {
    await rpc('anvil_impersonateAccount', [from]);
    await rpc('anvil_setBalance', [from, '0x56bc75e2d63100000']);
    const hash = await rpc('eth_sendTransaction', [{ from, to: USDC, data }]);
    await rpc('anvil_stopImpersonatingAccount', [from]);
    for (let i = 0; i < 50; i++) {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (receipt) {
        if (receipt.status !== '0x1') throw new Error(`fork funding tx ${hash} reverted`);
        return;
      }
      await sleep(100);
    }
    throw new Error(`fork funding tx ${hash} not mined`);
  };
  await send(masterMinter, `0x4e44d956${word(minter)}${word(usdc.toString(16))}`); // configureMinter(minter, usdc)
  await send(minter, `0x40c10f19${word(address)}${word(usdc.toString(16))}`); // mint(address, usdc)
}

async function ensureFunded(requester, provider) {
  if (FORK_FUNDING) {
    const missingUsdc = BUDGET_UNITS - (await usdcBalance(requester.address));
    await forkFund(requester.address, { usdc: missingUsdc > 0n ? missingUsdc : 0n, eth: 10n ** 17n });
    await forkFund(provider.address, { eth: 10n ** 17n });
    log('2', `Fork funding: requester ${fmtUsdc(await usdcBalance(requester.address))} + 0.1 ETH, provider 0.1 ETH`);
    return;
  }

  const needs = async () => {
    const [usdc, reqEth, provEth] = await Promise.all([usdcBalance(requester.address), ethBalance(requester.address), ethBalance(provider.address)]);
    const missing = [];
    if (usdc < BUDGET_UNITS) missing.push(`requester ${requester.address} needs ${fmtUsdc(BUDGET_UNITS)} (has ${fmtUsdc(usdc)})`);
    if (reqEth < MIN_GAS_WEI) missing.push(`requester ${requester.address} needs ≥ ${fmtEth(MIN_GAS_WEI)} for gas (has ${fmtEth(reqEth)})`);
    if (provEth < MIN_GAS_WEI) missing.push(`provider ${provider.address} needs ≥ ${fmtEth(MIN_GAS_WEI)} for gas (has ${fmtEth(provEth)})`);
    return missing;
  };

  let missing = await needs();
  if (missing.length === 0) {
    log('2', 'Wallets already funded.');
    return;
  }
  log('2', `Fund the agent wallets on ${chain?.name ?? `chain ${CHAIN_ID}`} (testnet faucets: Circle USDC faucet, Coinbase/Alchemy Base Sepolia ETH faucet):`);
  for (const line of missing) console.log(`       - ${line}`);
  console.log(`       Waiting up to ${FUNDING_TIMEOUT_MS / 1000}s… (re-run later with AGENTFI_REQUESTER_API_KEY / AGENTFI_PROVIDER_API_KEY to reuse these agents)`);
  console.log(`       requester API key: ${requester.apiKey}`);
  console.log(`       provider  API key: ${provider.apiKey}`);
  const deadline = Date.now() + FUNDING_TIMEOUT_MS;
  while (missing.length > 0) {
    if (Date.now() > deadline) throw new Error(`wallets not funded in time:\n  ${missing.join('\n  ')}`);
    await sleep(10_000);
    missing = await needs();
  }
  log('2', 'Funding detected.');
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('env', `API ${API_URL} · chain ${CHAIN_ID} · RPC ${RPC_URL} · USDC ${USDC} · reward ${REWARD_USDC} USDC · flow ${FLOW}${FORK_FUNDING ? ' · fork funding' : ''}`);

  log('1', REQUESTER_API_KEY && PROVIDER_API_KEY ? 'Reuse the requester and provider agents' : 'Register a requester and a provider agent');
  const stamp = Date.now();
  const requester = REQUESTER_API_KEY ? await loadAgent(REQUESTER_API_KEY) : await registerAgent(`escrow-requester-${stamp}`);
  const provider = PROVIDER_API_KEY ? await loadAgent(PROVIDER_API_KEY) : await registerAgent(`escrow-provider-${stamp}`);
  log('1', `requester ${requester.id} wallet ${requester.address}`);
  log('1', `provider  ${provider.id} wallet ${provider.address}`);

  await ensureFunded(requester, provider);
  const providerUsdcBefore = await usdcBalance(provider.address);

  log('3', `Requester hires the provider for ${REWARD_USDC} USDC (escrowed on-chain)`);
  const created = await api('/v1/jobs', {
    method: 'POST',
    apiKey: requester.apiKey,
    body: {
      providerId: provider.id,
      payload: { task: 'Summarise the last 24h of Base Sepolia activity', format: 'markdown' },
      reward: { amount: REWARD_USDC, token: 'USDC', chainId: CHAIN_ID },
    },
  });
  if (!created.escrow) {
    throw new Error(`the backend did not escrow this job on chain ${CHAIN_ID} (no AGENT_JOB_ESCROW_ADDRESS_${CHAIN_ID} / ESCROW_EVALUATOR_PRIVATE_KEY?)`);
  }
  log('3', `job ${created.id} · evaluator ${created.escrow.evaluator} · createJob → setBudget → approve → fund`);
  const funded = await waitForJob(requester.apiKey, created.id, 'funding', (job) => job.escrow?.onChainStatus === 'FUNDED');
  log('3', `funded: on-chain job #${funded.escrow.onChainJobId} on ${funded.escrow.contract}`);

  if (FLOW === 'cancel') {
    const requesterLocked = await usdcBalance(requester.address);
    log('4', 'Requester cancels the funded job → evaluator reject → full refund');
    await api(`/v1/jobs/${created.id}`, { method: 'PATCH', apiKey: requester.apiKey, body: { status: 'CANCELLED' } });
    const refunded = await waitForJob(requester.apiKey, created.id, 'refund', (job) => job.escrow?.onChainStatus === 'REJECTED', {
      failOn: (job) => (job.escrow?.onChainStatus === 'FAILED' ? `escrow: ${job.escrow.escrowError}` : null),
    });
    const back = (await usdcBalance(requester.address)) - requesterLocked;
    console.log('');
    console.log(`       on-chain job      #${refunded.escrow.onChainJobId} (${refunded.escrow.contract}) → Rejected`);
    console.log(`       refund tx         ${refunded.escrow.settleTxHash}${EXPLORER ? `  ${EXPLORER}/tx/${refunded.escrow.settleTxHash}` : ''}`);
    console.log(`       requester got     ${fmtUsdc(back)} back (budget ${fmtUsdc(BUDGET_UNITS)}) · feedback ${refunded.escrow.feedbackStatus}`);
    console.log('');
    console.log(color('32', '✓ Escrow cancellation refunded end to end.'));
    return;
  }

  log('4', 'Provider accepts the funded job');
  await api(`/v1/jobs/${created.id}`, { method: 'PATCH', apiKey: provider.apiKey, body: { status: 'ACCEPTED' } });

  log('5', 'Provider wallet: ERC-8004 identity (register on first funded job) + setProviderAgentId');
  const bound = await waitForJob(provider.apiKey, created.id, 'identity binding', (job) => ['BOUND', 'FAILED', 'SKIPPED'].includes(job.escrow?.providerAgentIdStatus));
  if (bound.escrow.providerAgentIdStatus === 'BOUND') {
    log('5', `bound ERC-8004 agent #${bound.escrow.providerAgentId}`);
  } else {
    log('5', color('33', `binding ${bound.escrow.providerAgentIdStatus} (${bound.escrow.providerAgentIdError}) — payment proceeds, the hook will skip feedback`));
  }

  log('6', 'Provider delivers → submit → evaluator complete');
  await api(`/v1/jobs/${created.id}`, {
    method: 'PATCH',
    apiKey: provider.apiKey,
    body: { status: 'COMPLETED', result: { summary: 'Activity was steady; nothing unusual.', confidence: 0.7 } },
  });
  const done = await waitForJob(requester.apiKey, created.id, 'settlement', (job) => job.status === 'COMPLETED');

  const e = done.escrow;
  const received = (await usdcBalance(provider.address)) - providerUsdcBefore;
  const feedbackUrl = `${API_URL}/v1/jobs/${created.id}/feedback.json`;
  const feedbackRes = await fetch(feedbackUrl);
  console.log('');
  console.log(`       on-chain job      #${e.onChainJobId} (${e.contract})`);
  console.log(`       settle tx         ${e.settleTxHash}${EXPLORER ? `  ${EXPLORER}/tx/${e.settleTxHash}` : ''}`);
  console.log(`       provider received ${fmtUsdc(received)} (budget ${fmtUsdc(BUDGET_UNITS)} − platform fee ${fmtUsdc(BigInt(e.platformFeeAmount ?? '0'))})`);
  console.log(`       ERC-8004 agent    #${e.providerAgentId ?? '-'} · feedback ${e.feedbackStatus}`);
  console.log(`       feedback file     ${feedbackUrl} → HTTP ${feedbackRes.status}`);
  console.log('');
  if (e.feedbackStatus !== 'written') {
    console.log(color('33', `Note: feedback ${e.feedbackStatus} — see docs/architecture/erc-8004-integration.md §4 for the hook's gates.`));
  }
  console.log(color('32', '✓ Escrow flow completed end to end.'));
}

main().catch((err) => {
  console.error(color('31', '\n✗ Example failed:'), err.message);
  process.exit(1);
});
