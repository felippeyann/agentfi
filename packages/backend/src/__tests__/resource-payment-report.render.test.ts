/**
 * Unit tests — the operator's ledger text (`renderSpendReport`): a purchase
 * refused before signing must say, on the operator's screen, that no payment
 * authorization exists (the Linux rehearsal of 2026-11-18 found the nonce was
 * only visible in the database); a signed row must not say so.
 */
import { describe, expect, it } from 'vitest';
import { renderSpendReport, type AgentSpend, type PaymentLine } from '../services/payments/resource-payment-report.js';

function line(overrides: Partial<PaymentLine>): PaymentLine {
  return {
    paymentId: 'p1',
    url: 'http://127.0.0.1:1/report',
    status: 'settled',
    amount: '300000',
    amountUsdc: '0.3',
    payTo: '0x00000000000000000000000000000000000000b0',
    counted: true,
    money: 'proven',
    delivery: 'delivered',
    responseStatus: 200,
    resourceSha256: null,
    resourceBytes: null,
    txHash: '0xabc',
    authorizationNonce: '0x01',
    reservedAt: '2026-11-18T00:00:00.000Z',
    reason: null,
    action: null,
    reconcileNote: null,
    automatic: null,
    ...overrides,
  };
}

function report(payments: PaymentLine[]): AgentSpend[] {
  return [
    {
      agentId: 'a1',
      name: 'buyer',
      policy: { active: true, expiresAt: null, maxValuePerTxUsd: '0.50', maxDailyVolumeUsd: '3.00', allowedRecipients: [] },
      today: { day: '2026-11-18', x402CommittedUsd: '0.3', otherVolumeUsd: '0', remainingDailyUsd: '2.7' },
      jobs: [
        {
          jobId: 'j1',
          jobStatus: 'ACCEPTED',
          budgetUsdc: '5',
          committedUsdc: '0.3',
          provenUsdc: '0.3',
          reportedUsdc: '0',
          openUsdc: '0',
          remainingUsdc: '4.7',
          overCommitted: false,
          payments,
        },
      ],
      pendingActions: 0,
    },
  ];
}

describe('renderSpendReport: signature line', () => {
  it('a row refused before signing says no payment authorization exists', () => {
    const text = renderSpendReport(
      report([
        line({
          paymentId: 'blocked',
          status: 'failed_before_signing',
          counted: false,
          money: 'not-moved',
          delivery: 'unknown',
          responseStatus: null,
          txHash: null,
          authorizationNonce: null,
          reason: 'Payment of 0.6 USDC exceeds the policy',
        }),
      ]),
    );
    expect(text).toContain('signature: none (refused before signing: no payment authorization exists for this row)');
    expect(text.indexOf('reason: Payment of 0.6')).toBeLessThan(text.indexOf('signature: none'));
  });

  it('a signed row does not', () => {
    expect(renderSpendReport(report([line({})]))).not.toContain('signature: none');
  });
});
