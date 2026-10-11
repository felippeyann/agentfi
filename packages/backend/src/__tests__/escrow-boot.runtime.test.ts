/**
 * Unit tests — boot wiring of the C3d checks (`config/escrow-boot.runtime.ts`):
 * the escrow / ReputationHook deployment check exits the process in
 * production / staging on a mismatch and only logs in development, and the
 * API ↔ worker capability exchange through Redis reports drift. env, the
 * contract table, the RPC client, the logger and ioredis are mocked.
 */
import { vi } from 'vitest';

const { state, logged, redisStore } = vi.hoisted(() => ({
  state: {
    nodeEnv: 'production',
    hookAcp: '0x00000000000000000000000000000000000E5C20',
    trustedEvaluator: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    readFails: false,
  },
  logged: { error: [] as string[], warn: [] as string[], info: [] as string[] },
  redisStore: new Map<string, string>(),
}));

vi.mock('../config/env.js', () => ({
  get env() {
    return { NODE_ENV: state.nodeEnv, REDIS_URL: 'redis://mock:6379/0' };
  },
  configuredEscrowChainIds: [84532],
  escrowEvaluatorAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
}));
vi.mock('../config/contracts.js', () => ({
  getContracts: () => ({ agentJobEscrow: '0x00000000000000000000000000000000000E5C20', reputationHook: '0x000000000000000000000000000000000000400C' }),
  resolveIdentityRegistry: () => '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  resolveReputationRegistry: () => '0x8004B663056A597Dffe9eCcC1965A193B7388713',
}));
vi.mock('../config/chains.js', () => ({
  createChainPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (state.readFails) throw new Error('rpc down');
      return {
        token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        acp: state.hookAcp,
        trustedEvaluator: state.trustedEvaluator,
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      }[functionName];
    },
  }),
}));
vi.mock('../api/middleware/logger.js', () => ({
  logger: {
    info: (_o: unknown, m?: string) => logged.info.push(String(m ?? _o)),
    warn: (_o: unknown, m?: string) => logged.warn.push(String(m ?? _o)),
    error: (_o: unknown, m?: string) => logged.error.push(String(m ?? _o)),
    fatal: () => undefined,
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    on() {}
    async connect() {}
    async set(key: string, value: string) {
      redisStore.set(key, value);
      return 'OK';
    }
    async get(key: string) {
      return redisStore.get(key) ?? null;
    }
    disconnect() {}
  },
}));

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { announceProcessCapabilities, processCapabilities, runEscrowBootCheck } from '../config/escrow-boot.runtime.js';

const OTHER = '0x1111111111111111111111111111111111111111';
let exitSpy: { mockRestore(): void; mock: { calls: unknown[][] } };
let consoleSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

beforeEach(() => {
  state.nodeEnv = 'production';
  state.hookAcp = '0x00000000000000000000000000000000000E5C20';
  state.trustedEvaluator = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  state.readFails = false;
  logged.error.length = 0;
  logged.warn.length = 0;
  logged.info.length = 0;
  redisStore.clear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  exitSpy.mockRestore();
  consoleSpy.mockRestore();
});

describe('runEscrowBootCheck', () => {
  it('a matching deployment boots and is logged as verified', async () => {
    const verdict = await runEscrowBootCheck('api');
    expect(verdict).toMatchObject({ fatal: null, verified: [84532] });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logged.info.join('\n')).toMatch(/match the configuration/);
  });

  it.each(['production', 'staging'])('NODE_ENV=%s: a hook deployed for another escrow (acp) exits with code 1', async (nodeEnv) => {
    state.nodeEnv = nodeEnv;
    state.hookAcp = OTHER;
    await runEscrowBootCheck('worker');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(consoleSpy.mock.calls[0]?.[0])).toMatch(/^FATAL: .*acp\(\)/);
  });

  it('NODE_ENV=development: the same mismatch is a loud error and the process boots', async () => {
    state.nodeEnv = 'development';
    state.trustedEvaluator = OTHER;
    const verdict = await runEscrowBootCheck('api');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(verdict?.fatal).toBeNull();
    expect(logged.error.join('\n')).toMatch(/would be FATAL in production\/staging.*trustedEvaluator/);
  });

  it('an unreadable chain is an error in production too, never fatal and never "verified"', async () => {
    state.readFails = true;
    const verdict = await runEscrowBootCheck('api');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ verified: [], unreadable: [84532] });
    expect(logged.error.join('\n')).toMatch(/could not be verified/);
  });
});

describe('announceProcessCapabilities', () => {
  it('logs what the process runs; the second process to boot reports drift with the first', async () => {
    // The worker booted without the evaluator key (no settlement worker) …
    const workerCaps = { ...processCapabilities('worker', { transactionWorker: true, paymentRecovery: true, settlementWorker: false }), evaluator: null };
    expect(await announceProcessCapabilities(workerCaps)).toEqual([]);
    expect(logged.info.join('\n')).toMatch(/worker process: .*settlement worker off/);
    // … then the API boots with it and creates escrow jobs.
    const drift = await announceProcessCapabilities(processCapabilities('api', { transactionWorker: false, paymentRecovery: false, settlementWorker: false }));
    expect(drift).toEqual(expect.arrayContaining([expect.stringMatching(/neither process runs the settlement worker/), expect.stringMatching(/evaluator differs/)]));
    expect(logged.error.join('\n')).toMatch(/CONFIG DRIFT between the API and the worker/);
  });
});
