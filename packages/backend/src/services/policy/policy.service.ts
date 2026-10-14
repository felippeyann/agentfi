import type { PrismaClient, AgentPolicy } from '@prisma/client';
import { getAddress, type Address } from 'viem';
import { OnChainPolicyService } from './onchain-policy.service.js';
import { parsePolicyDecimal } from './policy-numbers.js';
import { countedUsd, type SpendPricing } from './spend-pricing.js';
import { judgeOutflowCap } from './outflow-cap.js';
import { resourcePaymentSpentToday } from '../payments/resource-payment-ledger.js';

export interface PolicyValidationResult {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
  /**
   * Q9: `PRICE_UNAVAILABLE` when the refusal is that a component of the spend
   * has no trusted price while a daily limit — or the outflow cap — applies
   * (the routes answer 503). §5-6: `USD_CAP_NOT_CONFIGURED` when an ordinary
   * outflow meets a policy without `maxOutflowPerTxUsd` (403), and
   * `POLICY_VIOLATION` with `rule` / `limit` when it exceeds it (403). Absent
   * for every other policy refusal (403).
   */
  code?: 'PRICE_UNAVAILABLE' | 'USD_CAP_NOT_CONFIGURED' | 'POLICY_VIOLATION';
  /** §5-6: the rule that refused (`maxOutflowPerTxUsd`), when `code` is set by it. */
  rule?: string;
  /** The stored limit that refused, as stored. */
  limit?: string;
}

/** What `PolicyService.resumeByOperator` did to the policy row. */
export type OperatorResumeOutcome =
  /** The policy was inactive because the operator pause flipped it; it is active again. */
  | 'reactivated'
  /** Nothing to do — the policy was already active. */
  | 'already_active'
  /** Inactive, but not because of the operator pause — left inactive on purpose. */
  | 'left_inactive'
  /** The agent has no policy row (no restrictions apply). */
  | 'no_policy';

export class PolicyService {
  public onChain: OnChainPolicyService;

  constructor(private db: PrismaClient) {
    this.onChain = new OnChainPolicyService();
  }

  /**
   * Validates a proposed transaction against the agent's policy (off-chain check).
   * This runs before on-chain validation to fail fast and save gas.
   *
   * Writes nothing (A6). The daily volume is only pre-checked here, read-only,
   * so a request that cannot fit fails before simulating; the binding check
   * and the reservation happen when the Transaction row is created
   * (`createTransactionWithVolume` in `daily-volume.ts`), atomically with it.
   * A refusal here or any failure between here and the row therefore leaves
   * nothing to give back.
   */
  async validateTransaction(params: {
    agentId: string;
    /** The call target (`tx.to`) — judged against `allowedContracts`, as on-chain. */
    targetContract: Address;
    /**
     * The address that RECEIVES value from this transaction (Q8), judged
     * against `allowedRecipients` when that list is non-empty: a native or
     * ERC-20 transfer's `to`, the legacy A2A payee, a batch action carrying
     * native value. Omitted for operations whose value goes to the agent's
     * own position (swap, deposits, GMX…): no recipient check.
     */
    recipient?: Address;
    tokenAddress?: Address;
    valueEth: string; // as decimal string, e.g. "0.5"
    valueUsd?: string; // as decimal string, e.g. "150.00"
    /**
     * Q9: the spend's pricing (`spend-pricing.ts`). When given, its counted
     * USD replaces `valueUsd`, and an UNPRICED spend is refused
     * (`code: PRICE_UNAVAILABLE`) while the policy has a daily limit — before
     * the caller simulates or reserves anything.
     */
    pricing?: SpendPricing;
    /**
     * §5-6: this spend is an ORDINARY OUTFLOW (value leaves the agent's
     * wallet: transfer, swap / Curve input, deposit, GMX collateral, the
     * legacy A2A payment). Its `pricing` is then judged against
     * `maxOutflowPerTxUsd` (`outflow-cap.ts`); without `pricing` it counts as
     * unpriced. Omitted / false for what is not an outflow (withdrawals, a GMX
     * close) — the batch route judges its total itself.
     */
    outflow?: boolean;
    lastTxTimestamp?: number; // unix seconds
    /**
     * The spend is already counted elsewhere — the legacy A2A payment, whose
     * Job reserved the reward at creation (`reserveJobEscrow`). Skips the
     * daily pre-check so the reward is not judged twice.
     */
    dailyVolumeAccounted?: boolean;
  }): Promise<PolicyValidationResult> {
    const policy = await this.db.agentPolicy.findUnique({
      where: { agentId: params.agentId },
    });

    if (!policy) return { allowed: true, requiresApproval: false }; // no policy = no restrictions
    if (!policy.active) return { allowed: false, reason: 'Agent policy is paused (kill switch active)' };

    // Check temporary policy expiration
    if (policy.expiresAt && policy.expiresAt < new Date()) {
      return {
        allowed: false,
        reason: `Agent policy expired at ${policy.expiresAt.toISOString()}. Update the policy to continue.`,
      };
    }

    // Check max value per tx. The limit is read through the same parser the
    // authority classifier uses (`parsePolicyDecimal`), so a value the API
    // edge would reject can never mean "0" here and "unlimited" there.
    // `null` (unparsable stored value) is unlimited — identical to the
    // classifier, which is why an agent can never write such a value.
    const value = parseFloat(params.valueEth);
    const maxValue = parsePolicyDecimal(policy.maxValuePerTxEth);
    if (maxValue !== null && value > maxValue) {
      return {
        allowed: false,
        reason: `Transaction value ${params.valueEth} ETH exceeds policy limit of ${policy.maxValuePerTxEth} ETH`,
      };
    }

    // §5-6 (replaces the Q8 seam): an ordinary outflow is capped by
    // `maxOutflowPerTxUsd` at its priced USD value; NULL blocks it with a
    // diagnostic, an unpriced one is refused while the cap is set
    // (`outflow-cap.ts`). `maxValuePerTxUsd` keeps capping USDC x402 /
    // escrow only.
    if (params.outflow) {
      const cap = judgeOutflowCap(policy, params.pricing);
      if (!cap.allowed) {
        return { allowed: false, code: cap.code, rule: cap.rule, reason: cap.reason, ...(cap.limit !== undefined ? { limit: cap.limit } : {}) };
      }
    }

    // Check human-in-the-loop approval threshold
    let requiresApproval = false;
    const approvalThreshold = parsePolicyDecimal(policy.maxValueForAutoApprovalEth);
    if (approvalThreshold !== null && value > approvalThreshold) {
      requiresApproval = true;
    }

    // Check contract whitelist — the call target, as AgentPolicyModule
    // enforces on-chain (a native transfer's call target is its recipient).
    if (policy.allowedContracts.length > 0) {
      const normalizedTarget = getAddress(params.targetContract);
      const normalizedWhitelist = policy.allowedContracts.map((a) => getAddress(a));
      if (!normalizedWhitelist.includes(normalizedTarget)) {
        return {
          allowed: false,
          reason: `Contract ${params.targetContract} is not in the agent's allowed contracts whitelist`,
        };
      }
    }

    // Check recipient whitelist (Q8, off-chain only). Compared
    // case-insensitively without checksumming, so a malformed stored entry
    // can only fail to match — never throw.
    if (params.recipient && (policy.allowedRecipients?.length ?? 0) > 0) {
      const recipient = params.recipient.toLowerCase();
      if (!policy.allowedRecipients.some((entry) => entry.trim().toLowerCase() === recipient)) {
        return {
          allowed: false,
          reason: `Recipient ${params.recipient} is not in the agent's allowed recipients whitelist`,
        };
      }
    }

    // Check token whitelist
    if (params.tokenAddress && policy.allowedTokens.length > 0) {
      const normalizedToken = getAddress(params.tokenAddress);
      const normalizedWhitelist = policy.allowedTokens.map((a) => getAddress(a));
      if (!normalizedWhitelist.includes(normalizedToken)) {
        return {
          allowed: false,
          reason: `Token ${params.tokenAddress} is not in the agent's allowed tokens whitelist`,
        };
      }
    }

    // Check cooldown
    if (params.lastTxTimestamp && policy.cooldownSeconds > 0) {
      const elapsed = Math.floor(Date.now() / 1000) - params.lastTxTimestamp;
      if (elapsed < policy.cooldownSeconds) {
        const remaining = policy.cooldownSeconds - elapsed;
        return {
          allowed: false,
          reason: `Cooldown active. ${remaining} seconds remaining before next transaction is allowed`,
        };
      }
    }

    // Pre-check max daily volume in USD (0 or unparsable = no daily limit, same
    // as the classifier). Read-only: the binding check runs under the agent
    // lock when the row is created (daily-volume.ts).
    const dailyLimitUsd = parsePolicyDecimal(policy.maxDailyVolumeUsd) ?? 0;
    if (dailyLimitUsd > 0 && !params.dailyVolumeAccounted) {
      // Q9: a spend that cannot be priced would count as 0 — refuse it.
      if (params.pricing?.status === 'unpriced') {
        return {
          allowed: false,
          code: 'PRICE_UNAVAILABLE',
          reason:
            `${params.pricing.reason}. The daily volume limit of ${policy.maxDailyVolumeUsd} USD cannot be checked, ` +
            'so the spend is refused (it would otherwise count as 0).',
        };
      }
      const now = new Date();
      const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const incomingVolumeUsd = parseFloat(params.pricing ? countedUsd(params.pricing) : params.valueUsd ?? '0');
      // x402 payments (pay-resource, P6) are not in DailyVolume: they count
      // from their ledger rows (counted states, reserved today), so one daily
      // limit covers both paths.
      const x402TodayUsd = Number(await resourcePaymentSpentToday(this.db, params.agentId, now)) / 1e6;
      const committed = await this.db.dailyVolume.findUnique({
        where: { agentId_date: { agentId: params.agentId, date: today } },
        select: { volumeUsd: true },
      });
      const currentVolumeUsd = parseFloat(committed?.volumeUsd ?? '0') + x402TodayUsd;

      if (currentVolumeUsd + incomingVolumeUsd > dailyLimitUsd) {
        return {
          allowed: false,
          reason: `Daily volume limit of ${policy.maxDailyVolumeUsd} USD would be exceeded. Current: ${currentVolumeUsd.toFixed(2)}, requested: ${incomingVolumeUsd.toFixed(2)}`,
        };
      }
    }

    return { allowed: true, requiresApproval };
  }

  /**
   * Upserts the agent's policy. Omitted fields keep their current value (or the
   * schema default when the row is created). Authority checks (who may loosen
   * what) live in `policy-authority.ts` and the route handler — this is a raw write.
   */
  async setPolicy(
    agentId: string,
    policy: Partial<Omit<AgentPolicy, 'id' | 'agentId' | 'updatedAt'>>,
  ): Promise<AgentPolicy> {
    // An explicit `active` write supersedes the admin pause's bookkeeping:
    // whatever the flag is from here on was not set by the pause, so a later
    // admin resume must not undo it. See pauseByOperator / resumeByOperator.
    const data =
      policy.active === undefined ? policy : { ...policy, pausedByOperatorAt: null };
    return this.db.agentPolicy.upsert({
      where: { agentId },
      create: { agentId, ...data },
      update: data,
    });
  }

  async getPolicy(agentId: string): Promise<AgentPolicy | null> {
    return this.db.agentPolicy.findUnique({ where: { agentId } });
  }

  /**
   * Emergency kill switch — immediately disables the agent's policy.
   *
   * This is the *independent* deactivation path (agent soft-delete via
   * DELETE /v1/agents/:id). It clears `pausedByOperatorAt` so an admin
   * resume never re-activates a policy the agent itself switched off.
   */
  async emergencyPause(agentId: string): Promise<void> {
    await this.db.agentPolicy.updateMany({
      where: { agentId },
      data: { active: false, pausedByOperatorAt: null },
    });
  }

  /**
   * Admin kill switch (POST /admin/agents/:id/pause). Deactivates the policy
   * only if it is currently active and stamps `pausedByOperatorAt`, so that
   * `resumeByOperator` can undo exactly this flip and nothing else. A policy
   * that is already inactive is left untouched — and unstamped.
   *
   * @returns `true` when this call deactivated the policy.
   */
  async pauseByOperator(agentId: string, now: Date = new Date()): Promise<boolean> {
    const { count } = await this.db.agentPolicy.updateMany({
      where: { agentId, active: true },
      data: { active: false, pausedByOperatorAt: now },
    });
    return count > 0;
  }

  /**
   * Undo of `pauseByOperator`: re-activates the policy only while
   * `pausedByOperatorAt` is set, then clears the stamp. The write is a single
   * conditional `updateMany`, so a concurrent explicit `active` write (which
   * clears the stamp) can never be undone by this. When nothing changed, the
   * returned outcome says why so the route can tell the operator.
   */
  async resumeByOperator(agentId: string): Promise<OperatorResumeOutcome> {
    const { count } = await this.db.agentPolicy.updateMany({
      where: { agentId, active: false, pausedByOperatorAt: { not: null } },
      data: { active: true, pausedByOperatorAt: null },
    });
    if (count > 0) return 'reactivated';

    const policy = await this.db.agentPolicy.findUnique({
      where: { agentId },
      select: { active: true },
    });
    if (!policy) return 'no_policy';
    return policy.active ? 'already_active' : 'left_inactive';
  }
}
