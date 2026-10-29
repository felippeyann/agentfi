/**
 * Unit — review P3-5 (24/10): the escrow alert channel of the runtime (`escrow-erc8183.runtime.ts`,
 * `sendEscrowAlert` bound as `erc8183Deps().alert`) carries the alert's `severity` in the notification
 * metadata: `info` for an operator notice (P3-6 `evaluator-replaced-by-recovery`), `alert` by default.
 * The process singletons the module binds (DB, queues, lane lock) are mocked; nothing connects.
 */
import { vi } from 'vitest';

const { notified } = vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6391/15'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
  return { notified: [] as Array<{ type: string; agentId: string; message: string; metadata: Record<string, unknown> }> };
});

vi.mock('../services/notification.service.js', () => ({
  notificationService: {
    notify: async (payload: { type: string; agentId: string; message: string; metadata: Record<string, unknown> }) => {
      notified.push(payload);
    },
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../queues/transaction.queue.js', () => ({ transactionQueue: { add: async () => undefined } }));
vi.mock('../queues/escrow-settlement.queue.js', () => ({ addSettlementJob: async () => undefined }));
vi.mock('../services/transaction/wallet-lane.runtime.js', () => ({ walletLaneLock: {} }));
vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});

import { beforeEach, describe, expect, it } from 'vitest';
import { erc8183Deps } from '../services/job/escrow-erc8183.runtime.js';

describe('review P3-5 — severity in the escrow alert notification (runtime)', () => {
  beforeEach(() => {
    notified.length = 0;
  });

  it('an operator notice (severity info) is delivered as ESCROW_ALERT with metadata.severity = info, its kind and details', async () => {
    await erc8183Deps().alert!({
      kind: 'evaluator-replaced-by-recovery',
      severity: 'info',
      jobId: 'job-1',
      chainId: 84532,
      message: 'replaced by the recovery script (incident inc_1)',
      details: { replacedBy: '0xabc', recovery: { incidentId: 'inc_1' } },
    });
    expect(notified).toEqual([
      expect.objectContaining({
        type: 'ESCROW_ALERT',
        agentId: 'job-1',
        message: 'replaced by the recovery script (incident inc_1)',
        metadata: { kind: 'evaluator-replaced-by-recovery', severity: 'info', jobId: 'job-1', chainId: 84532, replacedBy: '0xabc', recovery: { incidentId: 'inc_1' } },
      }),
    ]);
  });

  it('an alert without severity is delivered with metadata.severity = alert (the default for every kind)', async () => {
    await erc8183Deps().alert!({ kind: 'evaluator-replaced', jobId: 'job-2', chainId: 84532, message: 'replaced in its nonce by an unknown transaction' });
    expect(notified).toHaveLength(1);
    expect(notified[0]!.metadata).toMatchObject({ kind: 'evaluator-replaced', severity: 'alert', jobId: 'job-2', chainId: 84532 });
  });

  // Found while writing this test: `...alert.details` was spread AFTER `severity`, so a detail could override it.
  it('a detail named "severity" cannot override the alert\'s own severity', async () => {
    await erc8183Deps().alert!({ kind: 'evaluator-replaced', message: 'm', details: { severity: 'info' } });
    expect(notified[0]!.metadata['severity']).toBe('alert');
  });
});
