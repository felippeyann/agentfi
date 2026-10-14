/**
 * S9 — the API side of the AgentExecutor / AgentPolicyModule gate
 * (`config/policy-stack-verification.runtime.ts`): a request that would route
 * a transaction through the chain's executor is refused with
 * `503 CONTRACTS_UNVERIFIED` + `Retry-After` while this process has not
 * verified that the executor and its module run this repository's build and
 * match the configured bindings — before anything is simulated, reserved or
 * written (a wrong executor address receives the whole value: reproduced on
 * Anvil).
 */
import type { FastifyReply } from 'fastify';
import { policyStackGate } from '../config/policy-stack-verification.runtime.js';
import { logger } from './middleware/logger.js';

/** Sends the 503 and returns the reply when the chain is not verified; null to go on. */
export function refuseUnverifiedContracts(reply: FastifyReply, chainId: number, what: string) {
  const gate = policyStackGate(chainId);
  if (gate.allowed) return null;
  logger.warn({ chainId, block: gate.block, reason: gate.reason, what }, 'Request refused — AgentExecutor / AgentPolicyModule not verified');
  return reply
    .code(503)
    .header('Retry-After', String(gate.retryAfterSeconds))
    .send({
      error: 'CONTRACTS_UNVERIFIED',
      code: 'CONTRACTS_UNVERIFIED',
      message:
        `The AgentExecutor / AgentPolicyModule of chain ${chainId} is not verified against this build right now (${gate.block}); ` +
        `${what} waits until it is. Nothing was reserved or changed — retry after the indicated delay.`,
      chainId,
      state: gate.block,
      retryAfterSeconds: gate.retryAfterSeconds,
    });
}
