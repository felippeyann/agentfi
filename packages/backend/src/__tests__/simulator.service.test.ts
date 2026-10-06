/**
 * Unit tests — SimulatorService fallbacks + simulation guard (A2)
 *
 * A fake "mock" simulation must never approve a transaction in production:
 *  - production/staging + no Tenderly → real eth_call (estimateGas) dry-run
 *  - estimateGas revert → success:false with the revert reason
 *  - RPC/transport failure → throws "Simulation service unavailable …"
 *  - development/test + no Tenderly → mock, provider 'mock' (dev stack intact)
 *  - Tenderly configured → provider 'tenderly'
 *  - guard helpers reject a mock result under NODE_ENV=production
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  EstimateGasExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
} from 'viem';

// ── Module mocks ───────────────────────────────────────────────────────────

const { envState, estimateGasMock, createChainPublicClientMock } = vi.hoisted(() => {
  const estimateGasMock = vi.fn();
  return {
    // Mutable stand-in for config/env.ts — that module parses process.env at
    // import time and process.exit()s on missing vars, so it is replaced
    // wholesale and each test sets NODE_ENV / TENDERLY_* directly.
    envState: {
      env: {
        NODE_ENV: 'development',
        TENDERLY_ACCESS_KEY: undefined,
        TENDERLY_ACCOUNT: undefined,
        TENDERLY_PROJECT: undefined,
      } as {
        NODE_ENV: string;
        TENDERLY_ACCESS_KEY: string | undefined;
        TENDERLY_ACCOUNT: string | undefined;
        TENDERLY_PROJECT: string | undefined;
      },
    },
    estimateGasMock,
    createChainPublicClientMock: vi.fn(() => ({ estimateGas: estimateGasMock })),
  };
});

vi.mock('../config/env.js', () => ({ env: envState.env }));
vi.mock('../config/chains.js', () => ({
  createChainPublicClient: createChainPublicClientMock,
}));

import { SimulatorService } from '../services/transaction/simulator.service.js';
import {
  assertSimulationUsable,
  ensureSimulationUsable,
  isSimulationUsable,
  SimulationUnavailableError,
  SIMULATION_UNAVAILABLE_MESSAGE,
} from '../services/transaction/simulation-guard.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const PARAMS = {
  chainId: 8453,
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  data: '0xdeadbeef',
  value: 0n,
} as const;

function setEnv(nodeEnv: string, tenderly = false): void {
  envState.env.NODE_ENV = nodeEnv;
  envState.env.TENDERLY_ACCESS_KEY = tenderly ? 'key' : undefined;
  envState.env.TENDERLY_ACCOUNT = tenderly ? 'acct' : undefined;
  envState.env.TENDERLY_PROJECT = tenderly ? 'proj' : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv('development');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── SimulatorService — Tenderly NOT configured ─────────────────────────────

describe('SimulatorService.simulate without Tenderly', () => {
  it('(a) production: runs a real estimateGas dry-run, provider eth_call, no _isMock', async () => {
    setEnv('production');
    estimateGasMock.mockResolvedValue(21_000n);

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim.success).toBe(true);
    expect(sim.provider).toBe('eth_call');
    expect(sim._isMock).toBeUndefined();
    expect(sim.gasUsed).toBe('21000');
    expect(sim.simulationId).toMatch(/^ethcall_\d+$/);
    expect(createChainPublicClientMock).toHaveBeenCalledWith(PARAMS.chainId);
    expect(estimateGasMock).toHaveBeenCalledWith({
      account: PARAMS.from,
      to: PARAMS.to,
      data: PARAMS.data,
      value: PARAMS.value,
    });
  });

  it('staging is treated like production (eth_call, never mock)', async () => {
    setEnv('staging');
    estimateGasMock.mockResolvedValue(30_000n);

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim.provider).toBe('eth_call');
    expect(sim._isMock).toBeUndefined();
    expect(sim.simulationId).not.toMatch(/^mock_/);
  });

  it('passes the caller-supplied gasPrice through on success', async () => {
    setEnv('production');
    estimateGasMock.mockResolvedValue(21_000n);

    const sim = await new SimulatorService().simulate({ ...PARAMS, gasPrice: 5n });

    expect(sim.gasPrice).toBe('5');
  });

  it('(b) production: a revert from estimateGas → success false with the reason', async () => {
    setEnv('production');
    estimateGasMock.mockRejectedValue(
      new EstimateGasExecutionError(
        new ExecutionRevertedError({ message: 'execution reverted: insufficient balance' }),
        {},
      ),
    );

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim.success).toBe(false);
    expect(sim.error).toMatch(/insufficient balance/);
    expect(sim.provider).toBe('eth_call');
    expect(sim.gasUsed).toBe('0');
    expect(sim.gasPrice).toBe('0');
    expect(sim.simulationId).toMatch(/^ethcall_\d+$/);
    expect(sim._isMock).toBeUndefined();
  });

  it('(b) production: insufficient-funds node error → success false (not a throw)', async () => {
    setEnv('production');
    estimateGasMock.mockRejectedValue(new InsufficientFundsError());

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim.success).toBe(false);
    expect(sim.error).toMatch(/exceeds the balance/i);
    expect(sim.provider).toBe('eth_call');
  });

  it('(c) production: HTTP/RPC transport failure → throws "Simulation service unavailable"', async () => {
    setEnv('production');
    estimateGasMock.mockRejectedValue(
      new HttpRequestError({ url: 'https://rpc.example', details: 'fetch failed', status: 502 }),
    );

    await expect(new SimulatorService().simulate(PARAMS)).rejects.toThrow(
      /Simulation service unavailable[\s\S]*Transaction blocked for safety/,
    );
  });

  it('(c) production: timeout wrapped by viem → throws (never success)', async () => {
    setEnv('production');
    estimateGasMock.mockRejectedValue(
      new EstimateGasExecutionError(
        new TimeoutError({ body: {}, url: 'https://rpc.example' }),
        {},
      ),
    );

    await expect(new SimulatorService().simulate(PARAMS)).rejects.toThrow(
      /Simulation service unavailable/,
    );
  });

  it('(c) production: unclassifiable non-viem error → throws (unknown risk blocks)', async () => {
    setEnv('production');
    estimateGasMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(new SimulatorService().simulate(PARAMS)).rejects.toThrow(
      /Transaction blocked for safety/,
    );
  });

  it('(d) development: keeps the mock, provider mock, never touches the RPC', async () => {
    setEnv('development');

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim).toMatchObject({ success: true, provider: 'mock', _isMock: true });
    expect(sim.simulationId).toMatch(/^mock_\d+$/);
    expect(createChainPublicClientMock).not.toHaveBeenCalled();
    expect(estimateGasMock).not.toHaveBeenCalled();
  });

  it('test env behaves like development (mock)', async () => {
    setEnv('test');

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim.provider).toBe('mock');
    expect(sim._isMock).toBe(true);
  });

  it('reads NODE_ENV at call time, not at construction', async () => {
    setEnv('development');
    const svc = new SimulatorService();
    expect((await svc.simulate(PARAMS)).provider).toBe('mock');

    envState.env.NODE_ENV = 'production';
    estimateGasMock.mockResolvedValue(1n);
    expect((await svc.simulate(PARAMS)).provider).toBe('eth_call');
  });
});

// ── SimulatorService — Tenderly configured ─────────────────────────────────

describe('SimulatorService.simulate with Tenderly', () => {
  it('reports provider tenderly and never sets _isMock', async () => {
    setEnv('production', true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        simulation: { id: 'sim-1', status: true, gas_used: 50_000, gas_price: '7' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const sim = await new SimulatorService().simulate(PARAMS);

    expect(sim).toMatchObject({
      success: true,
      provider: 'tenderly',
      simulationId: 'sim-1',
      gasUsed: '50000',
      gasPrice: '7',
    });
    expect(sim._isMock).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createChainPublicClientMock).not.toHaveBeenCalled();
  });

  it('propagates Tenderly failure as a blocking error', async () => {
    setEnv('production', true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' }),
    );

    await expect(new SimulatorService().simulate(PARAMS)).rejects.toThrow(
      /Simulation service unavailable \(HTTP 503\)/,
    );
  });
});

// ── Simulation guard (defense in depth) ────────────────────────────────────

describe('simulation guard', () => {
  const mockSim = { _isMock: true };
  const realSim = {};

  it('rejects a mock result in production', () => {
    setEnv('production');

    expect(isSimulationUsable(mockSim)).toBe(false);
    expect(() => assertSimulationUsable(mockSim)).toThrow(SimulationUnavailableError);
    try {
      assertSimulationUsable(mockSim);
    } catch (err) {
      expect((err as SimulationUnavailableError).statusCode).toBe(503);
      expect((err as Error).message).toBe(SIMULATION_UNAVAILABLE_MESSAGE);
    }
  });

  it('accepts a mock result outside production (dev stack keeps working)', () => {
    setEnv('development');
    expect(isSimulationUsable(mockSim)).toBe(true);
    expect(() => assertSimulationUsable(mockSim)).not.toThrow();
  });

  it('accepts real (eth_call / tenderly) results in production', () => {
    setEnv('production');
    expect(isSimulationUsable(realSim)).toBe(true);
    expect(() => assertSimulationUsable(realSim)).not.toThrow();
  });

  it('ensureSimulationUsable replies 503 { error } and returns false for a mock in production', () => {
    setEnv('production');
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    const reply = { code } as unknown as FastifyReply;

    expect(ensureSimulationUsable(mockSim, reply)).toBe(false);
    expect(code).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith({ error: SIMULATION_UNAVAILABLE_MESSAGE });
  });

  it('ensureSimulationUsable is a no-op for usable results', () => {
    setEnv('production');
    const code = vi.fn();
    const reply = { code } as unknown as FastifyReply;

    expect(ensureSimulationUsable(realSim, reply)).toBe(true);
    expect(code).not.toHaveBeenCalled();
  });
});
