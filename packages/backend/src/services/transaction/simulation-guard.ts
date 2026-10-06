/**
 * Simulation guard — defense in depth against a mock simulation ever
 * authorising a transaction in production.
 *
 * SimulatorService already refuses to produce a mock outside development/
 * test, but every caller that acts on `sim.success` must ALSO run this check
 * so a regression (or a hand-built result) cannot slip through.
 *
 * Kept in its own module (not simulator.service.ts) so tests that
 * `vi.mock` the simulator module keep the guard's real behaviour.
 */

import type { FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { isProductionLikeEnv } from '../../config/runtime-env.js';
import type { SimulationResult } from './simulator.service.js';

export const SIMULATION_UNAVAILABLE_MESSAGE = 'Simulation unavailable in production';

export class SimulationUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super(SIMULATION_UNAVAILABLE_MESSAGE);
    this.name = 'SimulationUnavailableError';
  }
}

/**
 * A simulation result may authorise a transaction unless it is a mock and
 * the process runs in a production-like environment (`production` or
 * `staging` — the same set `SimulatorService` refuses to mock in, via
 * `isProductionLikeEnv`, so guard and simulator can never disagree).
 */
export function isSimulationUsable(sim: Pick<SimulationResult, '_isMock'>): boolean {
  return !(sim._isMock === true && isProductionLikeEnv(env.NODE_ENV));
}

/** Throws SimulationUnavailableError (statusCode 503) for an unusable result. */
export function assertSimulationUsable(sim: Pick<SimulationResult, '_isMock'>): void {
  if (!isSimulationUsable(sim)) {
    throw new SimulationUnavailableError();
  }
}

/**
 * Route-handler flavour: replies HTTP 503 `{ error }` and returns false for
 * an unusable result, mirroring the `ensureChainAllowed` pattern.
 */
export function ensureSimulationUsable(
  sim: Pick<SimulationResult, '_isMock'>,
  reply: FastifyReply,
): boolean {
  if (isSimulationUsable(sim)) return true;
  reply.code(503).send({ error: SIMULATION_UNAVAILABLE_MESSAGE });
  return false;
}
