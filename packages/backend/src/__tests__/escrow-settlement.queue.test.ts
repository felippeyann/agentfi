/**
 * Escrow settlement queue — job ids must be accepted by BullMQ.
 *
 * Regression for the bug the C5a fork rehearsal found: settlement jobs were
 * added with `jobId = "<action>:<jobId>"`, which BullMQ 5 rejects ("Custom Id
 * cannot contain :" — a `:` is only tolerated in ids that split into exactly
 * three parts). Every `complete`/`reject`/`claimRefund` enqueue threw, so no
 * ERC-8183 job could ever be settled, refunded on cancellation or expired.
 * The orchestrator unit tests inject a fake `settlement.add`, so they never
 * reached BullMQ's validation; this test runs the real one.
 *
 * `Queue` is replaced by an in-memory fake (no Redis) whose `add` builds a
 * real `bullmq` `Job` and calls its `validateOptions` — the exact check that
 * throws inside `Queue.add`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** BullMQ's (protected) option check, the one `Queue.add` runs before writing to Redis. */
interface Validatable {
  validateOptions(jobData: { data: string }): void;
}

const { fakeQueues } = vi.hoisted(() => ({ fakeQueues: new Map<string, unknown>() }));

vi.mock('../config/env.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  // Enough of a Queue for `new Job(...)` (key builder + names); never connects.
  const stubQueue = {
    keys: {},
    toKey: (type: string) => `bull:escrow-settlement:${type}`,
    qualifiedName: 'bull:escrow-settlement',
    opts: {},
    client: Promise.resolve({}),
  };

  interface StoredJob {
    name: string;
    data: unknown;
    opts: Record<string, unknown>;
    state: string;
    getState(): Promise<string>;
    remove(): Promise<void>;
  }

  class FakeQueue {
    readonly jobs = new Map<string, StoredJob>();
    readonly added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
    constructor(public readonly name: string) {
      fakeQueues.set(name, this);
    }
    async getJob(id: string): Promise<StoredJob | undefined> {
      return this.jobs.get(id);
    }
    async add(name: string, data: unknown, opts: Record<string, unknown> = {}): Promise<void> {
      // The real BullMQ validation `Queue.add` runs before touching Redis.
      const job = new actual.Job(stubQueue as never, name, data, opts as never);
      // `validateOptions` is protected in the typings; it is what `Queue.add` runs.
      (job as unknown as Validatable).validateOptions({ data: JSON.stringify(data) });
      const id = String(opts['jobId']);
      const stored: StoredJob = {
        name,
        data,
        opts,
        state: opts['delay'] ? 'delayed' : 'waiting',
        getState: async () => stored.state,
        remove: async () => {
          this.jobs.delete(id);
        },
      };
      this.jobs.set(id, stored);
      this.added.push({ name, data, opts });
    }
  }

  return { ...actual, Queue: FakeQueue, Worker: class {} };
});

import { Job } from 'bullmq';
import { addSettlementJob, ESCROW_SETTLEMENT_QUEUE_NAME, settlementJobId } from '../queues/escrow-settlement.queue.js';
import type { EscrowSettlementJobData } from '../services/job/escrow-erc8183.service.js';

interface FakeQueueView {
  jobs: Map<string, { state: string }>;
  added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }>;
}

const JOB_ID = 'cmuyqnys40005m3t2p75n03bk'; // a Prisma cuid, as in the rehearsal

function queue(): FakeQueueView {
  return fakeQueues.get(ESCROW_SETTLEMENT_QUEUE_NAME) as FakeQueueView;
}

/** BullMQ's own verdict on a custom job id. */
function bullmqAccepts(jobId: string): boolean {
  const stub = { keys: {}, toKey: (t: string) => t, qualifiedName: 'bull:q', opts: {}, client: Promise.resolve({}) };
  try {
    (new Job(stub as never, 'settle', {}, { jobId } as never) as unknown as Validatable).validateOptions({ data: '{}' });
    return true;
  } catch {
    return false;
  }
}

describe('escrow settlement job ids (C5a regression)', () => {
  beforeEach(() => {
    queue().jobs.clear();
    queue().added.length = 0;
  });

  it('the former "<action>:<jobId>" form is rejected by BullMQ (the bug)', () => {
    expect(bullmqAccepts(`settle:${JOB_ID}`)).toBe(false);
  });

  it.each<EscrowSettlementJobData['action']>(['settle', 'reject', 'claimRefund'])('%s ids are accepted by BullMQ and unique per action', (action) => {
    const id = settlementJobId({ jobId: JOB_ID, action });
    expect(id).toBe(`${action}-${JOB_ID}`);
    expect(id).not.toContain(':');
    expect(bullmqAccepts(id)).toBe(true);
  });

  it('enqueues settle with the evaluation delay, reject and claimRefund without one', async () => {
    await addSettlementJob({ jobId: JOB_ID, action: 'settle' }, { delayMs: 20_000 });
    await addSettlementJob({ jobId: JOB_ID, action: 'reject', reason: 'cancelled' });
    await addSettlementJob({ jobId: JOB_ID, action: 'claimRefund' });

    expect(queue().added).toEqual([
      { name: 'settle', data: { jobId: JOB_ID, action: 'settle' }, opts: { jobId: `settle-${JOB_ID}`, delay: 20_000 } },
      { name: 'reject', data: { jobId: JOB_ID, action: 'reject', reason: 'cancelled' }, opts: { jobId: `reject-${JOB_ID}` } },
      { name: 'claimRefund', data: { jobId: JOB_ID, action: 'claimRefund' }, opts: { jobId: `claimRefund-${JOB_ID}` } },
    ]);
  });

  it('does not re-add an action that is still queued, but replaces a completed or failed one', async () => {
    await addSettlementJob({ jobId: JOB_ID, action: 'settle' });
    await addSettlementJob({ jobId: JOB_ID, action: 'settle' });
    expect(queue().added).toHaveLength(1);

    queue().jobs.get(`settle-${JOB_ID}`)!.state = 'failed';
    await addSettlementJob({ jobId: JOB_ID, action: 'settle' });
    expect(queue().added).toHaveLength(2);
  });
});
