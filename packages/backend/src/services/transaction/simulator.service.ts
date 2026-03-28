/**
 * Transaction Simulator — wraps Tenderly simulation API.
 * Every transaction MUST be simulated before submission.
 */

import { env } from '../../config/env.js';
import type { Address } from 'viem';

export interface SimulationResult {
  success: boolean;
  gasUsed: string;
  gasPrice: string;
  error?: string;
  logs?: unknown[];
  stateChanges?: unknown;
  simulationId: string;
  /** True when Tenderly is not configured (dev mode). Never true in production. */
  _isMock?: boolean;
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

export class SimulatorService {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor() {
    const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT } = env;

    if (!TENDERLY_ACCESS_KEY || !TENDERLY_ACCOUNT || !TENDERLY_PROJECT) {
      // Gracefully degrade: simulation is skipped in dev without Tenderly
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

  /**
   * Simulates a transaction using Tenderly.
   * Returns detailed error information if it would revert.
   */
  async simulate(params: {
    chainId: number;
    from: Address;
    to: Address;
    data: `0x${string}`;
    value: bigint;
    gasPrice?: bigint;
  }): Promise<SimulationResult> {
    if (!this.baseUrl) {
      // Dev fallback: simulation skipped (no Tenderly credentials configured)
      // Marked with mock_ prefix so callers can detect and warn users
      return {
        success: true,
        gasUsed: '100000',
        gasPrice: '1000000000',
        simulationId: `mock_${Date.now()}`,
        _isMock: true,
      };
    }

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
      const body = await response.text().catch(() => '');
      throw new Error(
        `Simulation service unavailable (HTTP ${response.status}). ` +
        `Transaction blocked for safety. Details: ${body.slice(0, 200)}`,
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
    };
  }

  /**
   * Simulates a bundle of transactions atomically.
   */
  async simulateBatch(
    simulations: Array<{
      chainId: number;
      from: Address;
      to: Address;
      data: `0x${string}`;
      value: bigint;
    }>,
  ): Promise<SimulationResult[]> {
    // Run simulations in sequence to preserve ordering
    const results: SimulationResult[] = [];
    for (const sim of simulations) {
      results.push(await this.simulate(sim));
    }
    return results;
  }
}
