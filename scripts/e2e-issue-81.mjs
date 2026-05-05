#!/usr/bin/env node
/**
 * E2E validation for issue #81 (and PR #83 fix).
 *
 * Reproduces the exact scenario from the issue: two agents (Alice provider,
 * Bob requester), paid A2A job, on-chain payment guaranteed to fail (deploy
 * must be running with a stub Alchemy URL). Polls the Job until it leaves
 * PAYMENT_PENDING, then asserts:
 *
 *   status            === 'PAYMENT_FAILED'
 *   reservationStatus === 'CANCELLED'   (escrow refunded, NOT 'RELEASED')
 *
 * Usage:
 *   AGENTFI_API_URL=https://agentfi-backend.fly.dev \
 *   AGENTFI_OPERATOR_SECRET=<API_SECRET from fly secrets> \
 *   node scripts/e2e-issue-81.mjs
 *
 * Optional env:
 *   REWARD_AMOUNT=0.001   (default)
 *   REWARD_TOKEN=ETH      (default)
 *   REWARD_CHAIN_ID=8453  (Base mainnet by default — stub Alchemy makes
 *                          on-chain failure deterministic regardless)
 *   POLL_TIMEOUT_SEC=120  (how long to wait for payment to settle)
 *
 * Telegram check is manual — confirm a TRANSACTION_FAILED message lands
 * in the configured ops channel after the script finishes.
 */

const API_URL = process.env.AGENTFI_API_URL ?? 'http://localhost:3000';
const OPERATOR_SECRET =
  process.env.AGENTFI_OPERATOR_SECRET ??
  'dev-api-secret-min-32-chars-long-xxxxx';

const REWARD_AMOUNT = process.env.REWARD_AMOUNT ?? '0.001';
const REWARD_TOKEN = process.env.REWARD_TOKEN ?? 'ETH';
const REWARD_CHAIN_ID = Number(process.env.REWARD_CHAIN_ID ?? 8453);
const POLL_TIMEOUT_SEC = Number(process.env.POLL_TIMEOUT_SEC ?? 120);

// ── tiny fetch wrapper ─────────────────────────────────────────────────────
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

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function log(step, msg) {
  console.log(`${c.cyan(`[${step}]`)} ${msg}`);
}

// ── steps ──────────────────────────────────────────────────────────────────

async function registerAgent(name) {
  return api('/v1/agents', {
    method: 'POST',
    headers: { 'x-api-key': OPERATOR_SECRET },
    body: JSON.stringify({
      name,
      chainIds: [REWARD_CHAIN_ID],
      tier: 'FREE',
    }),
  });
}

async function createPaidJob(requesterApiKey, providerId) {
  return api('/v1/jobs', {
    method: 'POST',
    headers: { 'x-api-key': requesterApiKey },
    body: JSON.stringify({
      providerId,
      payload: { test: 'issue-81-e2e', timestamp: Date.now() },
      reward: {
        amount: REWARD_AMOUNT,
        token: REWARD_TOKEN,
        chainId: REWARD_CHAIN_ID,
      },
    }),
  });
}

async function patchJob(apiKey, jobId, body) {
  return api(`/v1/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
}

async function getJob(apiKey, jobId) {
  return api(`/v1/jobs/${jobId}`, {
    headers: { 'x-api-key': apiKey },
  });
}

async function pollUntilSettled(apiKey, jobId) {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_SEC * 1000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const job = await getJob(apiKey, jobId);
    if (job.status !== lastStatus) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(
        'poll',
        `t=${elapsed}s status=${c.yellow(job.status)} reservationStatus=${job.reservationStatus ?? '—'}`,
      );
      lastStatus = job.status;
    }
    if (job.status !== 'PAYMENT_PENDING') {
      return job;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `Polling timed out after ${POLL_TIMEOUT_SEC}s — Job still in PAYMENT_PENDING. ` +
      `Either the Tx worker is down, or the on-chain confirmation window > ${POLL_TIMEOUT_SEC}s.`,
  );
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('env', `API_URL = ${API_URL}`);
  log('env', `reward = ${REWARD_AMOUNT} ${REWARD_TOKEN} on chain ${REWARD_CHAIN_ID}`);
  log(
    'env',
    c.dim(
      'Backend must be running with a stub ALCHEMY_API_KEY so the on-chain Tx fails deterministically.',
    ),
  );

  log('1', 'Register Alice (provider) and Bob (requester)');
  const ts = Date.now();
  const alice = await registerAgent(`alice-issue81-${ts}`);
  const bob = await registerAgent(`bob-issue81-${ts}`);
  log('1', `Alice = ${alice.id}`);
  log('1', `Bob   = ${bob.id}`);

  log('2', `Bob creates a paid job hiring Alice (${REWARD_AMOUNT} ${REWARD_TOKEN})`);
  let job;
  try {
    job = await createPaidJob(bob.apiKey, alice.id);
  } catch (err) {
    if (err.status === 400 && /escrow/i.test(JSON.stringify(err.body))) {
      console.error(
        c.red('\n✗ Escrow reservation failed — Bob has no balance for the reward.'),
      );
      console.error(
        c.dim(
          '  This is a wallet-provisioning issue, not the bug under test. ' +
            'Either fund Bob or run against the local-wallet provider.',
        ),
      );
      throw err;
    }
    throw err;
  }
  log('2', `Job created: ${job.id} status=${job.status}`);

  log('3', 'Alice accepts and completes (paid path → PAYMENT_PENDING → worker)');
  await patchJob(alice.apiKey, job.id, { status: 'ACCEPTED' });
  await patchJob(alice.apiKey, job.id, {
    status: 'COMPLETED',
    result: { ok: true, source: 'e2e-issue-81' },
  });

  log('4', `Polling Job ${job.id} until it leaves PAYMENT_PENDING (max ${POLL_TIMEOUT_SEC}s)`);
  const finalJob = await pollUntilSettled(bob.apiKey, job.id);

  // ── assertions ─────────────────────────────────────────────────────────────
  log('5', 'Asserting expected post-fix state');
  const expected = { status: 'PAYMENT_FAILED', reservationStatus: 'CANCELLED' };
  const actual = {
    status: finalJob.status,
    reservationStatus: finalJob.reservationStatus,
  };

  console.log('       expected:', expected);
  console.log('       actual:  ', actual);

  const statusOk = actual.status === expected.status;
  const reservationOk = actual.reservationStatus === expected.reservationStatus;

  if (statusOk && reservationOk) {
    console.log(
      c.green(
        '\n✓ Issue #81 fix verified: paid A2A job with failing on-chain tx settled to PAYMENT_FAILED with escrow refunded.',
      ),
    );
    console.log(
      c.dim(
        '  Manual: confirm a TRANSACTION_FAILED notification landed in the ops Telegram/Discord channel.',
      ),
    );
    process.exit(0);
  }

  console.log(c.red('\n✗ Issue #81 fix did NOT take effect.'));
  if (!statusOk) {
    console.log(
      c.red(
        `  status: expected ${expected.status}, got ${actual.status} — ` +
          `the Job lifecycle is still being driven by queue resolution, not on-chain outcome.`,
      ),
    );
  }
  if (!reservationOk) {
    console.log(
      c.red(
        `  reservationStatus: expected ${expected.reservationStatus}, got ${actual.reservationStatus} — ` +
          `escrow was consumed instead of refunded (= ghost completion).`,
      ),
    );
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(c.red('\n✗ E2E aborted:'), err.message);
  if (err.body) console.error(err.body);
  process.exit(2);
});
