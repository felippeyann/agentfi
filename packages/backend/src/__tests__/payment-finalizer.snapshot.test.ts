/**
 * Unit tests — payment-finalizer revenue snapshot capture (Phase 2 of #71).
 *
 * Validates that on a CONFIRMED outcome the finalizer:
 *   1. Resolves the reward to USD via the price oracle.
 *   2. Persists `rewardUsd` and `rewardPriceUsd` on the same write that
 *      flips the Job to COMPLETED (single round-trip, no race).
 *   3. Writes NULL for both columns when the oracle is unresolved (oracle
 *      returns 0). PnLService relies on NULL meaning "fall back to live"
 *      vs. a non-null '0' meaning "legitimately free job".
 *
 * The finalizer imports a singleton `db` and notification service, so we
 * vi.mock those modules. The price service is exercised end-to-end against
 * a stubbed `fetch`, so we also catch any wiring regression in the
 * resolveRewardUsd helper.
 */
import { vi } from 'vitest';

// config/env.ts calls process.exit() on missing required env vars at module
// load time. Hoisted-stub the ones the logger import chain transitively
// requires so this test runs cleanly outside CI.
vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearPriceCache } from '../services/transaction/price.service.js';

const ETH_USD = 2500;

// ── Module-level mocks (must be set up before importing finalizer) ────────

const jobUpdateMock = vi.fn().mockResolvedValue({});
const jobFindUniqueMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    job: {
      findUnique: jobFindUniqueMock,
      update: jobUpdateMock,
    },
  },
}));

vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: class {
    recordJobOutcome = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../services/policy/escrow.service.js', () => ({
  releaseJobEscrow: vi.fn().mockResolvedValue(undefined),
  markEscrowReleased: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/notification.service.js', () => ({
  notificationService: {
    notify: vi.fn().mockResolvedValue(undefined),
  },
}));

// Imported AFTER vi.mock so the mocks are in effect.
const { finalizeA2APaymentJob } = await import(
  '../services/job/payment-finalizer.service.js'
);

// ── Test setup ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

function stubOracle(price: number) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ethereum: { usd: price } }),
  });
}

beforeEach(() => {
  jobUpdateMock.mockReset().mockResolvedValue({});
  jobFindUniqueMock.mockReset();
  clearPriceCache();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('finalizeA2APaymentJob — revenue snapshot capture', () => {
  it('writes rewardUsd and rewardPriceUsd alongside COMPLETED on the same update', async () => {
    stubOracle(ETH_USD);
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-1',
      status: 'PAYMENT_PENDING',
      providerId: 'provider-1',
      requesterId: 'requester-1',
      reservationStatus: 'PENDING',
      reward: { amount: '0.01', token: 'ETH', chainId: 1 },
      provider: { name: 'Provider' },
    });

    await finalizeA2APaymentJob({
      jobId: 'job-1',
      outcome: 'CONFIRMED',
      transactionId: 'tx-1',
    });

    expect(jobUpdateMock).toHaveBeenCalledTimes(1);
    const call = jobUpdateMock.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'job-1' });
    expect(call.data.status).toBe('COMPLETED');
    // 0.01 ETH @ $2500 = $25.00
    expect(parseFloat(call.data.rewardUsd)).toBeCloseTo(25, 2);
    expect(parseFloat(call.data.rewardPriceUsd)).toBeCloseTo(2500, 2);
  });

  it('persists NULL snapshot when the price oracle is unresolved', async () => {
    // Oracle returns 0 → resolveRewardUsd reports resolved:false → finalizer
    // must write NULL (not '0') so PnLService can fall back to live pricing
    // and surface a warning instead of locking in a bogus zero.
    stubOracle(0);
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-2',
      status: 'PAYMENT_PENDING',
      providerId: 'provider-1',
      requesterId: 'requester-1',
      reservationStatus: 'PENDING',
      reward: { amount: '0.01', token: 'ETH', chainId: 1 },
      provider: { name: 'Provider' },
    });

    await finalizeA2APaymentJob({
      jobId: 'job-2',
      outcome: 'CONFIRMED',
      transactionId: 'tx-2',
    });

    const call = jobUpdateMock.mock.calls[0][0];
    expect(call.data.status).toBe('COMPLETED');
    expect(call.data.rewardUsd).toBeNull();
    expect(call.data.rewardPriceUsd).toBeNull();
  });

  it('does not write a snapshot on FAILED outcomes (escrow refund path)', async () => {
    stubOracle(ETH_USD);
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-3',
      status: 'PAYMENT_PENDING',
      providerId: 'provider-1',
      requesterId: 'requester-1',
      reservationStatus: 'PENDING',
      reward: { amount: '0.01', token: 'ETH', chainId: 1 },
      provider: { name: 'Provider' },
    });

    await finalizeA2APaymentJob({
      jobId: 'job-3',
      outcome: 'FAILED',
      transactionId: 'tx-3',
      reason: 'reverted',
    });

    const call = jobUpdateMock.mock.calls[0][0];
    expect(call.data.status).toBe('PAYMENT_FAILED');
    // No snapshot fields on the FAILED branch — this is a refund, not revenue.
    expect(call.data.rewardUsd).toBeUndefined();
    expect(call.data.rewardPriceUsd).toBeUndefined();
  });

  it('idempotency guard still skips when Job is already terminal', async () => {
    jobFindUniqueMock.mockResolvedValue({
      id: 'job-4',
      status: 'COMPLETED', // already finalized by an earlier call
      providerId: 'provider-1',
      requesterId: 'requester-1',
      reservationStatus: 'RELEASED',
      reward: { amount: '0.01', token: 'ETH', chainId: 1 },
      provider: { name: 'Provider' },
    });

    await finalizeA2APaymentJob({
      jobId: 'job-4',
      outcome: 'CONFIRMED',
      transactionId: 'tx-4',
    });

    // No write — guard returns before snapshot capture or status flip.
    expect(jobUpdateMock).not.toHaveBeenCalled();
  });
});
