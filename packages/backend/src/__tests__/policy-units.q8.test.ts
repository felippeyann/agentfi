/**
 * Q8 (owner decision, 2026-10-14) — explicit units and separate recipients.
 *
 * Before Q8 the policy had one per-transaction field, `maxValuePerTxEth`, and
 * one address list, `allowedContracts`, each read two ways:
 *   - `maxValuePerTxEth` capped native ETH on `/v1/transactions/*` AND was
 *     read as USD for USDC spends (x402 `pay-resource`, ERC-8183 escrow
 *     budgets) — `usdc-spend-policy.ts`;
 *   - `allowedContracts` was the call target (`tx.to`) of ordinary
 *     transactions (the list `AgentPolicyModule` enforces on-chain) AND the
 *     payee list of those USDC spends — while the recipient of an ERC-20
 *     transfer (`body.to`) was never checked at all.
 *
 * Q8 adds `maxValuePerTxUsd` (USD-denominated spends) and `allowedRecipients`
 * (every address that receives value from the agent). These tests pin the new
 * readings; on the pre-Q8 code they fail (the fields do not exist and the old
 * fields decide).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentPolicy, PrismaClient } from '@prisma/client';
import { evaluateUsdcSpend, type UsdcSpendPolicy } from '../services/policy/usdc-spend-policy.js';
import { PolicyService } from '../services/policy/policy.service.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SELLER = '0x00000000000000000000000000000000000000b0';
const OTHER = '0x00000000000000000000000000000000000000c1';
const ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const NOW = new Date('2026-10-14T12:00:00Z');

function usdcPolicy(overrides: Partial<UsdcSpendPolicy> = {}): UsdcSpendPolicy {
  return {
    active: true,
    expiresAt: null,
    maxValuePerTxUsd: '1.0',
    maxDailyVolumeUsd: '0',
    allowedTokens: [],
    allowedRecipients: [],
    ...overrides,
  };
}

function usdc(amount: bigint, recipient = SELLER) {
  return { amount, token: USDC, recipient, spentTodayMicroUsd: 0n, now: NOW };
}

function row(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    id: 'policy-1',
    agentId: 'agent-1',
    active: true,
    maxValuePerTxEth: '1.0',
    maxValuePerTxUsd: '1.0',
    maxOutflowPerTxUsd: null,
    maxValueForAutoApprovalEth: '1.0',
    maxDailyVolumeUsd: '0',
    allowedContracts: [],
    allowedRecipients: [],
    allowedTokens: [],
    cooldownSeconds: 0,
    expiresAt: null,
    pausedByOperatorAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function service(policy: AgentPolicy | null): PolicyService {
  const db = {
    agentPolicy: { findUnique: vi.fn().mockResolvedValue(policy) },
    dailyVolume: { findUnique: vi.fn().mockResolvedValue(null) },
    resourcePayment: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  return new PolicyService(db);
}

describe('Q8 — maxValuePerTxUsd caps USD-denominated spends; maxValuePerTxEth is ETH only', () => {
  it('a USDC spend is judged against maxValuePerTxUsd, never against the ETH field', () => {
    // A tiny ETH cap no longer refuses a 3 USDC payment …
    expect(evaluateUsdcSpend(usdcPolicy({ maxValuePerTxEth: '0.001', maxValuePerTxUsd: '5' } as never), usdc(3_000_000n))).toEqual({
      allowed: true,
    });
    // … and a large ETH cap no longer lets it through.
    const verdict = evaluateUsdcSpend(usdcPolicy({ maxValuePerTxEth: '100', maxValuePerTxUsd: '1' } as never), usdc(3_000_000n));
    expect(verdict).toMatchObject({ allowed: false, rule: 'maxValuePerTxUsd', limit: '1' });
  });

  it('a non-decimal stored maxValuePerTxUsd is unlimited (policy-numbers semantics, as the classifier assumes)', () => {
    expect(evaluateUsdcSpend(usdcPolicy({ maxValuePerTxUsd: 'unlimited' }), usdc(10n ** 12n)).allowed).toBe(true);
  });

  it('an ordinary transaction is still capped by maxValuePerTxEth (ETH), not by the USD field', async () => {
    const svc = service(row({ maxValuePerTxEth: '0.5', maxValuePerTxUsd: '1000000' }));
    const refused = await svc.validateTransaction({ agentId: 'agent-1', targetContract: SELLER, valueEth: '0.6' });
    expect(refused).toMatchObject({ allowed: false });
    expect(refused.reason).toContain('0.5 ETH');

    // The USD cap does not apply to /v1/transactions/* (open owner question).
    const svc2 = service(row({ maxValuePerTxEth: '10', maxValuePerTxUsd: '0' }));
    await expect(svc2.validateTransaction({ agentId: 'agent-1', targetContract: SELLER, valueEth: '1', valueUsd: '2000' })).resolves.toMatchObject({
      allowed: true,
    });
  });
});

describe('Q8 — allowedRecipients is the payee list; allowedContracts is the call target only', () => {
  it('a USDC spend checks the recipient against allowedRecipients, not allowedContracts', () => {
    // allowedContracts no longer restricts payees …
    expect(evaluateUsdcSpend(usdcPolicy({ allowedContracts: [OTHER] } as never), usdc(1n))).toEqual({ allowed: true });
    // … allowedRecipients does (case-insensitive).
    expect(evaluateUsdcSpend(usdcPolicy({ allowedRecipients: [SELLER.toUpperCase().replace('0X', '0x')] }), usdc(1n))).toEqual({
      allowed: true,
    });
    const verdict = evaluateUsdcSpend(usdcPolicy({ allowedRecipients: [OTHER] }), usdc(1n));
    expect(verdict).toMatchObject({ allowed: false, rule: 'allowedRecipients' });
    if (!verdict.allowed) expect(verdict.reason).toContain(SELLER);
  });

  it('an ERC-20 transfer: the token contract is the call target, body.to the recipient — both are checked', async () => {
    const svc = service(row({ allowedContracts: [USDC], allowedRecipients: [SELLER] }));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: USDC, tokenAddress: USDC, recipient: SELLER, valueEth: '0' }),
    ).resolves.toMatchObject({ allowed: true });

    // Before Q8 this passed: the recipient of an ERC-20 transfer was never checked.
    const refused = await svc.validateTransaction({ agentId: 'agent-1', targetContract: USDC, tokenAddress: USDC, recipient: OTHER, valueEth: '0' });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain('allowed recipients');
    expect(refused.reason).toContain(OTHER);
  });

  it('a native ETH transfer needs its `to` in allowedContracts (unchanged) AND in allowedRecipients when each is non-empty', async () => {
    const both = service(row({ allowedContracts: [SELLER], allowedRecipients: [SELLER] }));
    await expect(both.validateTransaction({ agentId: 'agent-1', targetContract: SELLER, recipient: SELLER, valueEth: '0.1' })).resolves.toMatchObject({
      allowed: true,
    });

    const contractsOnly = service(row({ allowedContracts: [OTHER], allowedRecipients: [] }));
    await expect(
      contractsOnly.validateTransaction({ agentId: 'agent-1', targetContract: SELLER, recipient: SELLER, valueEth: '0.1' }),
    ).resolves.toMatchObject({ allowed: false });

    const recipientsOnly = service(row({ allowedContracts: [], allowedRecipients: [OTHER] }));
    const refused = await recipientsOnly.validateTransaction({ agentId: 'agent-1', targetContract: SELLER, recipient: SELLER, valueEth: '0.1' });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain('allowed recipients');
  });

  it('an operation without a recipient (DeFi: swap, deposit, GMX…) is not judged against allowedRecipients', async () => {
    const svc = service(row({ allowedContracts: [ROUTER], allowedRecipients: [OTHER] }));
    await expect(svc.validateTransaction({ agentId: 'agent-1', targetContract: ROUTER, tokenAddress: USDC, valueEth: '0' })).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('an empty allowedRecipients list is unrestricted', async () => {
    const svc = service(row({ allowedRecipients: [] }));
    await expect(svc.validateTransaction({ agentId: 'agent-1', targetContract: USDC, recipient: OTHER, valueEth: '0' })).resolves.toMatchObject({
      allowed: true,
    });
    expect(evaluateUsdcSpend(usdcPolicy({ allowedRecipients: [] }), usdc(1n, OTHER))).toEqual({ allowed: true });
  });
});
