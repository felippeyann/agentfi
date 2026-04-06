/**
 * Simulation Cache — ties a Tenderly simulationId to the agent that ran it.
 *
 * When /simulate is called, the result is stored here with a short TTL.
 * When /swap is called, the simulationId is looked up to verify:
 *   - it was issued by this server (not fabricated by the client)
 *   - it belongs to the calling agent
 *   - the simulation was successful
 *
 * Uses ioredis with lazy connect so startup succeeds even if Redis is
 * temporarily unavailable — the get() call will throw and be handled by
 * the caller.
 */

import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

const SIMULATION_TTL_SECONDS = 10 * 60; // 10 minutes
const PREFIX = 'agentfi:sim:';

// Lazy singleton — one connection shared across all requests.
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return _redis;
}

export interface CachedSimulation {
  agentId: string;
  success: boolean;
  chainId: number;
}

/**
 * Stores a simulation result keyed by simulationId.
 * Fails silently if Redis is unavailable — the swap route will then reject
 * the simulationId as "not found", which is the safe default.
 */
export async function cacheSimulation(
  simulationId: string,
  data: CachedSimulation,
): Promise<void> {
  const key = `${PREFIX}${simulationId}`;
  await getRedis().set(key, JSON.stringify(data), 'EX', SIMULATION_TTL_SECONDS);
}

/**
 * Retrieves a cached simulation. Returns null if not found or expired.
 */
export async function getSimulation(
  simulationId: string,
): Promise<CachedSimulation | null> {
  const key = `${PREFIX}${simulationId}`;
  const raw = await getRedis().get(key);
  if (!raw) return null;
  return JSON.parse(raw) as CachedSimulation;
}
