/**
 * Runtime environment classification shared by the simulator and its guard.
 *
 * Lives in its own tiny module (no `env.ts` import, no side effects) so that
 * `simulation-guard.ts` and `simulator.service.ts` agree on what "production-
 * like" means without the guard having to import the simulator module —
 * tests `vi.mock` the simulator and must keep the guard's real behaviour.
 */

/** Environments where a mock simulation must never authorise a transaction. */
const PRODUCTION_LIKE_ENVS: ReadonlySet<string> = new Set(['production', 'staging']);

export function isProductionLikeEnv(nodeEnv: string): boolean {
  return PRODUCTION_LIKE_ENVS.has(nodeEnv);
}
