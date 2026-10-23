/**
 * Unit tests — boot wiring of the C3d checks (`config/escrow-boot.runtime.ts`):
 * the escrow / ReputationHook deployment check exits the process in
 * production / staging on a mismatch and only logs in development, and the
 * API ↔ worker capability exchange through Redis reports drift. env, the
 * contract table, the RPC client, the logger and ioredis are mocked.
 */
import { vi } from 'vitest';

const { state, logged, redisStore, notified } = vi.hoisted(() => ({
  state: {
    nodeEnv: 'production',
    hookAcp: '0x00000000000000000000000000000000000E5C20',
    trustedEvaluator: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    readFails: false,
    hookHasCode: true,
    hookConfigured: true,
    servedChainId: 84532,
  },
  logged: { error: [] as string[], warn: [] as string[], info: [] as string[] },
  redisStore: new Map<string, string>(),
  notified: [] as Array<{ message: string; metadata: Record<string, unknown> }>,
}));

vi.mock('../config/env.js', () => ({
  get env() {
    return { NODE_ENV: state.nodeEnv, REDIS_URL: 'redis://mock:6379/0', ESCROW_CONFIG_VERIFIED_TTL_SECONDS: 600, ESCROW_CONFIG_RECHECK_SECONDS: 120 };
  },
  configuredEscrowChainIds: [84532],
  escrowEvaluatorAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
}));
vi.mock('../services/notification.service.js', () => ({
  notificationService: {
    notify: async (payload: { message: string; metadata: Record<string, unknown> }) => {
      notified.push(payload);
    },
  },
}));
vi.mock('../config/contracts.js', () => ({
  getContracts: () => ({
    agentJobEscrow: '0x00000000000000000000000000000000000E5C20',
    reputationHook: state.hookConfigured ? '0x000000000000000000000000000000000000400C' : undefined,
  }),
  resolveIdentityRegistry: () => '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  resolveReputationRegistry: () => '0x8004B663056A597Dffe9eCcC1965A193B7388713',
}));
vi.mock('../config/chains.js', async () => {
  const { EXPECTED_CONTRACT_CODE } = await import('../abi/contract-code.generated.js');
  return {
  createChainPublicClient: () => ({
    getChainId: async () => {
      if (state.readFails) throw new Error('rpc down');
      return state.servedChainId;
    },
    // S9: the escrow and the hook run this build's code (no code at the hook when `hookHasCode` is false).
    getCode: async ({ address }: { address: string }) => {
      if (state.readFails) throw new Error('rpc down');
      if (address.toLowerCase() === '0x00000000000000000000000000000000000e5c20') return EXPECTED_CONTRACT_CODE.AgentJobEscrow.runtime;
      if (address.toLowerCase() === '0x000000000000000000000000000000000000400c') {
        return state.hookHasCode ? EXPECTED_CONTRACT_CODE.ReputationHook.runtime : undefined;
      }
      return undefined;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (state.readFails) throw new Error('rpc down');
      if (!state.hookHasCode && functionName !== 'token') {
        // what viem's readContract throws for an address without code
        throw Object.assign(new Error('The contract function returned no data ("0x").'), {
          name: 'ContractFunctionExecutionError',
          cause: { name: 'ContractFunctionZeroDataError', shortMessage: `The contract function "${functionName}" returned no data ("0x").` },
        });
      }
      return {
        token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        acp: state.hookAcp,
        trustedEvaluator: state.trustedEvaluator,
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      }[functionName];
    },
  }),
  };
});
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
import {
  __stopEscrowRecheckForTests,
  alsoPublishAs,
  announceProcessCapabilities,
  processCapabilities,
  runEscrowBootCheck,
} from '../config/escrow-boot.runtime.js';
import { __resetEscrowVerificationForTests, escrowConfigGate, escrowVerificationSnapshot } from '../config/escrow-verification.runtime.js';

const OTHER = '0x1111111111111111111111111111111111111111';
let exitSpy: { mockRestore(): void; mock: { calls: unknown[][] } };
let consoleSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

beforeEach(() => {
  state.nodeEnv = 'production';
  state.hookAcp = '0x00000000000000000000000000000000000E5C20';
  state.trustedEvaluator = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  state.readFails = false;
  state.hookHasCode = true;
  state.hookConfigured = true;
  state.servedChainId = 84532;
  logged.error.length = 0;
  logged.warn.length = 0;
  logged.info.length = 0;
  notified.length = 0;
  redisStore.clear();
  __stopEscrowRecheckForTests();
  __resetEscrowVerificationForTests();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  __stopEscrowRecheckForTests();
  vi.useRealTimers();
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

  it.each(['production', 'staging'])('NODE_ENV=%s: no code at the hook address (wrong chain / typo) exits with code 1 — not "unreadable"', async (nodeEnv) => {
    state.nodeEnv = nodeEnv;
    state.hookHasCode = false;
    const verdict = await runEscrowBootCheck('api');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(verdict).toMatchObject({ unreadable: [] });
    // S9: the code identity answers first.
    expect(String(consoleSpy.mock.calls[0]?.[0])).toMatch(
      /^FATAL: .*REPUTATION_HOOK_ADDRESS_84532=0x[0-9a-fA-F]+ is not this build's ReputationHook: no code at the address/,
    );
  });

  it('NODE_ENV=development: no code at the hook address is a loud error and the process boots', async () => {
    state.nodeEnv = 'development';
    state.hookHasCode = false;
    await runEscrowBootCheck('worker');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logged.error.join('\n')).toMatch(
      /would be FATAL in production\/staging\): chain 84532: REPUTATION_HOOK_ADDRESS_84532=0x[0-9a-fA-F]+ is not this build's ReputationHook: no code/,
    );
  });

  it('a chain with an escrow but no hook is still checked (escrow.token())', async () => {
    state.hookConfigured = false;
    const verdict = await runEscrowBootCheck('api');
    expect(verdict).toMatchObject({ fatal: null, verified: [84532] });
    expect(logged.warn.join('\n')).toMatch(/only escrow\.token\(\) checked/);
  });

  it('an unreadable chain is an error in production too, never fatal and never "verified"', async () => {
    state.readFails = true;
    const verdict = await runEscrowBootCheck('api');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ verified: [], unreadable: [84532] });
    expect(logged.error.join('\n')).toMatch(/could not be verified/);
  });
});

describe('Q7 — per-process verification state, forever re-check, gate', () => {
  /** Lets the async re-check tick (setInterval callback → promises) run to completion. */
  async function tick(ms = 120_000) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it('before any read the gate refuses (not-verified-yet); a matching boot verifies the chain for the TTL; nothing alerted for a healthy boot', async () => {
    expect(escrowConfigGate(84532)).toMatchObject({ allowed: false, block: 'not-verified-yet', retryAfterSeconds: 120 });
    await runEscrowBootCheck('worker');
    expect(escrowConfigGate(84532)).toMatchObject({ allowed: true, chainId: 84532 });
    expect(escrowConfigGate(84532, new Date(Date.now() + 599_000)).allowed).toBe(true);
    expect(escrowConfigGate(84532, new Date(Date.now() + 601_000))).toMatchObject({ allowed: false, block: 'expired' });
    expect(escrowConfigGate(8453)).toMatchObject({ allowed: false, block: 'not-configured' });
    expect(notified).toHaveLength(0);
    expect(escrowVerificationSnapshot({ withReason: false })).toEqual([
      expect.objectContaining({ chainId: 84532, state: 'verified', allowed: true }),
    ]);
  });

  it('an unreadable chain at boot: unverified (never fatal), alerted once; the re-check verifies it later and alerts the recovery once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    state.readFails = true;
    await runEscrowBootCheck('api');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(escrowConfigGate(84532)).toMatchObject({ allowed: false, block: 'unverified', reason: expect.stringMatching(/could not be read: rpc down/) });
    expect(notified.map((n) => n.metadata['kind'])).toEqual(['escrow-config-unverified']);

    await tick(); // still down: no second alert
    await tick();
    expect(notified).toHaveLength(1);

    state.readFails = false;
    await tick();
    expect(escrowConfigGate(84532).allowed).toBe(true);
    expect(notified.map((n) => n.metadata['kind'])).toEqual(['escrow-config-unverified', 'escrow-config-verified']);
  });

  it('a failure after a success revokes the verification at once (the TTL does not keep it alive); re-checks go on forever (> 30 ticks)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await runEscrowBootCheck('worker');
    expect(escrowConfigGate(84532).allowed).toBe(true);

    state.readFails = true;
    await tick();
    expect(escrowConfigGate(84532)).toMatchObject({ allowed: false, block: 'unverified' });
    expect(notified.map((n) => n.metadata['kind'])).toEqual(['escrow-config-unverified']);

    for (let i = 0; i < 35; i++) await tick();
    expect(escrowConfigGate(84532).allowed).toBe(false);
    state.readFails = false;
    await tick();
    expect(escrowConfigGate(84532).allowed).toBe(true); // the 37th re-check still ran
    expect(notified).toHaveLength(2);
  });

  it.each(['production', 'staging'])('NODE_ENV=%s: an RPC serving another chain (eth_chainId) is a mismatch — FATAL', async (nodeEnv) => {
    state.nodeEnv = nodeEnv;
    state.servedChainId = 8453;
    await runEscrowBootCheck('api');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(consoleSpy.mock.calls[0]?.[0])).toMatch(/^FATAL: .*answers eth_chainId 8453, not 84532/);
  });

  it('NODE_ENV=development: a mismatch boots but blocks every escrow signature on the chain (state mismatch, alerted)', async () => {
    state.nodeEnv = 'development';
    state.trustedEvaluator = OTHER;
    await runEscrowBootCheck('worker');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(escrowConfigGate(84532)).toMatchObject({ allowed: false, block: 'mismatch', reason: expect.stringMatching(/trustedEvaluator/) });
    expect(notified.map((n) => n.metadata['kind'])).toEqual(['escrow-config-mismatch']);
  });

  it('production: a mismatch found by a later re-check is FATAL like at boot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await runEscrowBootCheck('worker');
    expect(exitSpy).not.toHaveBeenCalled();
    state.hookAcp = OTHER; // the hook at the configured address changed answer (redeployed / wrong contract)
    await tick();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(escrowConfigGate(84532)).toMatchObject({ allowed: false, block: 'mismatch' });
  });
});

describe('C3f item 4 — every check publishes this process\'s verification state (read by GET /admin/escrow/verification)', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('a matching boot of the worker publishes its chains as verified', async () => {
    await runEscrowBootCheck('worker');
    await flush();
    const report = JSON.parse(redisStore.get('agentfi:escrow-verification:worker') ?? 'null');
    expect(report).toMatchObject({ role: 'worker', recheckSeconds: expect.any(Number), chains: [expect.objectContaining({ chainId: 84532, state: 'verified', allowed: true })] });
    expect(Date.parse(report.publishedAt)).not.toBeNaN();
  });

  // #193 finding 2: with TRANSACTION_WORKER_ENABLED=true, index.ts runs the boot check as 'api'
  // and hosts the escrow settlement worker in the same process; GET /admin/escrow/verification
  // reads `:worker`, so that process must publish its state under `worker` too.
  it('#193 finding 2: the single process (index.ts, TRANSACTION_WORKER_ENABLED=true) hosts the settlement worker, so its state must also be published as `worker`', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    // index.ts: the boot check is always run as 'api' …
    expect(src).toMatch(/await runEscrowBootCheck\('api'\);/);
    // … and the same process starts the escrow settlement worker when TRANSACTION_WORKER_ENABLED=true,
    // then publishes as `worker` right after it started (never when it did not).
    expect(src).toMatch(/if \(env\.TRANSACTION_WORKER_ENABLED === 'true'\) \{[\s\S]{0,80}escrowSettlementWorker = startEscrowSettlementWorker/);
    expect(src).toMatch(/escrowSettlementWorker = startEscrowSettlementWorker\(erc8183Deps\);\s*(\/\/[^\n]*\n\s*)*alsoPublishAs\('worker'\);/);
    expect(src.match(/alsoPublishAs\('worker'\)/g)).toHaveLength(1);
    // What index.ts does at boot, then after starting the settlement worker:
    await runEscrowBootCheck('api');
    alsoPublishAs('worker');
    await flush();
    const { peerVerificationView } = await import('../config/escrow-verification-report.js');
    const api = peerVerificationView(redisStore.get('agentfi:escrow-verification:api') ?? null, new Date());
    const worker = peerVerificationView(redisStore.get('agentfi:escrow-verification:worker') ?? null, new Date());
    expect(api.state).toBe('reported');
    expect(worker.state).toBe('reported');
    expect(worker).toMatchObject({ chains: [expect.objectContaining({ chainId: 84532, state: 'verified', allowed: true })] });
  });

  it('#193 finding 2: in the single process every re-check renews both keys (api and worker) with the same state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await runEscrowBootCheck('api');
    alsoPublishAs('worker');
    await flush();
    redisStore.clear();
    state.readFails = true;
    await vi.advanceTimersByTimeAsync(120_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await flush();
    for (const key of ['agentfi:escrow-verification:api', 'agentfi:escrow-verification:worker']) {
      const report = JSON.parse(redisStore.get(key) ?? 'null');
      expect(report?.chains).toEqual([expect.objectContaining({ chainId: 84532, state: 'unverified', allowed: false })]);
    }
  });

  it('#193 finding 2: an API process that did not start the settlement worker never publishes `worker` (two-process topology unchanged)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await runEscrowBootCheck('api');
    await vi.advanceTimersByTimeAsync(120_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await flush();
    expect([...redisStore.keys()]).toEqual(['agentfi:escrow-verification:api']);
  });

  it('#193 finding 2: the separate worker process publishes only `worker`, as before (worker-process.ts does not call alsoPublishAs)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../worker-process.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/await runEscrowBootCheck\('worker'\);/);
    expect(src).not.toMatch(/alsoPublishAs/);
    await runEscrowBootCheck('worker');
    await flush();
    expect([...redisStore.keys()]).toEqual(['agentfi:escrow-verification:worker']);
  });

  it('an unreadable chain is published as unverified, with its reason', async () => {
    state.readFails = true;
    await runEscrowBootCheck('worker');
    await flush();
    const report = JSON.parse(redisStore.get('agentfi:escrow-verification:worker') ?? 'null');
    expect(report.chains).toEqual([expect.objectContaining({ chainId: 84532, state: 'unverified', allowed: false, reason: expect.any(String) })]);
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
