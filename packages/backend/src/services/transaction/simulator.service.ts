/**
 * Transaction Simulator — wraps the Tenderly simulation API.
 * Every transaction MUST be simulated before submission.
 *
 * Provider selection:
 *   - Tenderly configured (all three TENDERLY_* vars)  → provider 'tenderly'
 *   - Not configured, NODE_ENV production/staging     → provider 'eth_call'
 *     (a real dry-run via viem `estimateGas` against the chain RPC)
 *   - Not configured, NODE_ENV development/test       → provider 'mock'
 *     (always-success stub; keeps the zero-credential dev stack working)
 *
 * A mock result is never produced in production or staging. Callers must
 * additionally run `assertSimulationUsable` / `ensureSimulationUsable`
 * (services/transaction/simulation-guard.ts) as defense in depth.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  ResourceNotFoundRpcError,
  ResourceUnavailableRpcError,
  TimeoutError,
  UnknownRpcError,
  WebSocketRequestError,
} from 'viem';
import type { Address } from 'viem';
import { env } from '../../config/env.js';
import { createChainPublicClient } from '../../config/chains.js';
import { isProductionLikeEnv } from '../../config/runtime-env.js';

// Re-exported so existing importers keep working; the implementation moved
// to config/runtime-env.ts so simulation-guard.ts can share it.
export { isProductionLikeEnv };

export type SimulationProvider = 'tenderly' | 'eth_call' | 'mock';

export interface SimulationResult {
  success: boolean;
  gasUsed: string;
  gasPrice: string;
  error?: string;
  logs?: unknown[];
  stateChanges?: unknown;
  simulationId: string;
  /** Which engine produced this result. */
  provider: SimulationProvider;
  /**
   * True only for the development/test stub. Never set in production or
   * staging — those fall back to an eth_call dry-run when Tenderly is absent.
   */
  _isMock?: boolean;
}

export interface SimulationParams {
  chainId: number;
  from: Address;
  to: Address;
  data: `0x${string}`;
  value: bigint;
  gasPrice?: bigint;
}

interface TenderlySimulationRequest {
  network_id: string;
  from: Address;
  to: Address;
  input: string;
  value: string;
  gas?: number;
  gas_price?: string;
  save?: boolean;
  save_if_fails?: boolean;
}

/** JSON-RPC error code nodes use for "execution reverted" (EIP-1474 / geth). */
const EXECUTION_REVERTED_RPC_CODE = 3;

/**
 * Finds the execution revert inside a viem error chain, if there is one.
 *
 * This MUST be checked before `isRpcTransportFailure`: many RPC providers
 * wrap a revert in a `-32603 Internal error` envelope, so viem produces
 * `EstimateGasExecutionError → ExecutionRevertedError → InternalRpcError →
 * RpcRequestError`. Walking that chain for transport errors first would find
 * the `InternalRpcError` and misreport a plain revert as "service
 * unavailable". A revert is a genuine negative simulation result, never an
 * outage.
 */
function findExecutionRevert(err: unknown): BaseError | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk(
    (e) =>
      e instanceof ExecutionRevertedError ||
      e instanceof ContractFunctionRevertedError ||
      (e as { code?: unknown }).code === EXECUTION_REVERTED_RPC_CODE,
  );
  return revert instanceof BaseError ? revert : null;
}

/**
 * Distinguishes "the RPC could not answer" (transport / provider failure —
 * the transaction must be BLOCKED because its outcome is unknown) from
 * "the RPC answered that the transaction would fail" (a genuine negative
 * simulation result). Anything we cannot classify is treated as a
 * transport failure, which is the conservative choice: unknown risk → block.
 *
 * Callers must run `findExecutionRevert` first (see its doc comment).
 */
function isRpcTransportFailure(err: unknown): boolean {
  if (err instanceof BaseError) {
    const transportFailure = err.walk(
      (e) =>
        e instanceof HttpRequestError ||
        e instanceof WebSocketRequestError ||
        e instanceof TimeoutError ||
        e instanceof InternalRpcError ||
        e instanceof LimitExceededRpcError ||
        e instanceof ResourceUnavailableRpcError ||
        e instanceof ResourceNotFoundRpcError ||
        e instanceof UnknownRpcError,
    );
    // Any other viem error (ExecutionRevertedError, InsufficientFundsError,
    // ContractFunctionRevertedError, nonce/gas/fee node errors, ...) is the
    // node telling us the tx itself is invalid → a failed simulation.
    return transportFailure !== null;
  }
  // Non-viem errors (e.g. a raw `TypeError: fetch failed`) carry no
  // structured meaning — treat as unavailable unless they clearly describe
  // an execution failure.
  const message = err instanceof Error ? err.message : String(err);
  return !/revert|insufficient funds|out of gas|intrinsic gas|nonce too/i.test(message);
}

function describeSimulationError(err: unknown): string {
  if (err instanceof BaseError) {
    const detail = err.details && err.details !== err.shortMessage ? ` (${err.details})` : '';
    return `${err.shortMessage}${detail}`.slice(0, 500);
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export class SimulatorService {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor() {
    const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT } = env;

    if (!TENDERLY_ACCESS_KEY || !TENDERLY_ACCOUNT || !TENDERLY_PROJECT) {
      // Tenderly not configured: simulate() picks eth_call or mock per NODE_ENV.
      this.baseUrl = '';
      this.headers = {};
      return;
    }

    this.baseUrl = `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}`;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Access-Key': TENDERLY_ACCESS_KEY,
    };
  }

  /** True when the three TENDERLY_* vars are present. */
  get hasTenderly(): boolean {
    return this.baseUrl !== '';
  }

  /**
   * Simulates a transaction. Uses Tenderly when configured; otherwise a real
   * eth_call/estimateGas dry-run in production/staging, or a mock in
   * development/test. Returns detailed error information if it would revert.
   */
  async simulate(params: SimulationParams): Promise<SimulationResult> {
    if (!this.hasTenderly) {
      // NODE_ENV is read at call time (not cached) so the decision always
      // reflects the running process.
      if (isProductionLikeEnv(env.NODE_ENV)) {
        return this.simulateWithEthCall(params);
      }
      // Dev/test fallback: simulation skipped (no Tenderly credentials).
      // Marked with mock_ prefix + _isMock so callers can detect and warn.
      return {
        success: true,
        gasUsed: '100000',
        gasPrice: '1000000000',
        simulationId: `mock_${Date.now()}`,
        provider: 'mock',
        _isMock: true,
      };
    }

    return this.simulateWithTenderly(params);
  }

  /**
   * Real dry-run against the chain RPC via `eth_estimateGas` (which executes
   * the call and reverts on failure, like eth_call). No trace/state diff, but
   * it is a genuine execution — never a fabricated success.
   */
  private async simulateWithEthCall(params: SimulationParams): Promise<SimulationResult> {
    const simulationId = `ethcall_${Date.now()}`;
    // Unsupported chain IDs throw here and propagate unchanged on purpose.
    const publicClient = createChainPublicClient(params.chainId);

    let gasUsed: bigint;
    try {
      gasUsed = await publicClient.estimateGas({
        account: params.from,
        to: params.to,
        data: params.data,
        value: params.value,
      });
    } catch (err) {
      // 1. The node answered "this would revert" — a failed simulation, with
      //    the revert reason, even when the RPC wrapped it in -32603.
      const revert = findExecutionRevert(err);
      if (revert) {
        return {
          success: false,
          error: describeSimulationError(err),
          simulationId,
          gasUsed: '0',
          gasPrice: '0',
          provider: 'eth_call',
        };
      }
      // 2. The node could not answer — BLOCK the transaction.
      //    Never silently approve in production; unknown outcome means unknown risk.
      if (isRpcTransportFailure(err)) {
        throw new Error(
          `Simulation service unavailable (eth_call RPC failure on chain ${params.chainId}). ` +
          `Transaction blocked for safety. Details: ${describeSimulationError(err).slice(0, 200)}`,
        );
      }
      // 3. Any other node error (insufficient funds, nonce, gas, fee…) — the
      //    tx itself is invalid: a failed simulation.
      return {
        success: false,
        error: describeSimulationError(err),
        simulationId,
        gasUsed: '0',
        gasPrice: '0',
        provider: 'eth_call',
      };
    }

    return {
      success: true,
      gasUsed: gasUsed.toString(),
      gasPrice: params.gasPrice?.toString() ?? '0',
      simulationId,
      provider: 'eth_call',
    };
  }

  private async simulateWithTenderly(params: SimulationParams): Promise<SimulationResult> {
    const body: TenderlySimulationRequest = {
      network_id: params.chainId.toString(),
      from: params.from,
      to: params.to,
      input: params.data,
      value: params.value.toString(),
      save: true,
      save_if_fails: true,
    };

    if (params.gasPrice) {
      body.gas_price = params.gasPrice.toString();
    }

    const response = await fetch(`${this.baseUrl}/simulate`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ simulation: body }),
    });

    if (!response.ok) {
      // Tenderly unavailable or misconfigured — BLOCK the transaction.
      // Never silently approve in production; a failed simulation means unknown risk.
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Simulation service unavailable (HTTP ${response.status}). ` +
        `Transaction blocked for safety. Details: ${errorBody.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as {
      simulation: {
        id: string;
        status: boolean;
        gas_used: number;
        gas_price: string;
        error_message?: string;
      };
    };

    const sim = json.simulation;
    return {
      success: sim.status,
      gasUsed: sim.gas_used.toString(),
      gasPrice: sim.gas_price,
      ...(sim.error_message !== undefined ? { error: sim.error_message } : {}),
      simulationId: sim.id,
      provider: 'tenderly',
    };
  }

  /**
   * Simulates a bundle of transactions atomically.
   */
  async simulateBatch(simulations: SimulationParams[]): Promise<SimulationResult[]> {
    // Run simulations in sequence to preserve ordering
    const results: SimulationResult[] = [];
    for (const sim of simulations) {
      results.push(await this.simulate(sim));
    }
    return results;
  }
}
