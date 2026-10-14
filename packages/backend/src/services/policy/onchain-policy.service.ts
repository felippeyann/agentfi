import { getAddress, type Address, encodeFunctionData, parseUnits } from 'viem';
import { AGENT_POLICY_MODULE_ABI_FULL } from '../../abi/AgentPolicyModule.abi.js';

/** `AgentPolicyModule` ABI, generated from the Solidity source (`npm run abi:policy`). */
export const AGENT_POLICY_MODULE_ABI = AGENT_POLICY_MODULE_ABI_FULL;

/**
 * Encode-only helpers for `AgentPolicyModule` calls.
 *
 * Who may SEND them (S8): the module accepts `setPolicy`, the whitelist
 * updates, `emergencyPause` and `resume` only from its immutable `operator` or
 * from `msg.sender == safe`. Never through `AgentExecutor` — there the
 * executor is `msg.sender` and every one of these reverts `Unauthorized`
 * (reproduced on Anvil in `policy-sync.contracts.anvil.ts`). The backend's
 * own sync (`policy-sync.service.ts`, `POST /admin/agents/:id/policy/sync`)
 * derives its calls from the stored policy in `policy-sync.ts`; these helpers
 * remain for callers that hand calldata to the operator key out of band.
 */
export class OnChainPolicyService {
  async buildSyncPolicyCalldata(params: {
    safeAddress: Address;
    maxValuePerTxEth: string;
    cooldownSeconds: number;
    active: boolean;
    expiresAt?: Date | null;
  }): Promise<`0x${string}`> {
    const maxValueWei = parseUnits(params.maxValuePerTxEth, 18);
    const expiresAtUnix = params.expiresAt ? Math.floor(params.expiresAt.getTime() / 1000) : 0;

    return encodeFunctionData({
      abi: AGENT_POLICY_MODULE_ABI,
      functionName: 'setPolicy',
      args: [
        params.safeAddress,
        {
          maxValuePerTx: maxValueWei,
          cooldownBetweenTx: BigInt(params.cooldownSeconds),
          active: params.active,
        },
        BigInt(expiresAtUnix),
      ],
    });
  }

  /** `AgentPolicyModule.emergencyPause(safe)` — flips the policy to `active = false`. Encode-only. */
  async buildEmergencyPauseCalldata(params: { safeAddress: Address }): Promise<`0x${string}`> {
    return encodeFunctionData({
      abi: AGENT_POLICY_MODULE_ABI,
      functionName: 'emergencyPause',
      args: [getAddress(params.safeAddress)],
    });
  }

  /** `AgentPolicyModule.resume(safe)` — undoes `emergencyPause`. Encode-only. */
  async buildResumeCalldata(params: { safeAddress: Address }): Promise<`0x${string}`> {
    return encodeFunctionData({
      abi: AGENT_POLICY_MODULE_ABI,
      functionName: 'resume',
      args: [getAddress(params.safeAddress)],
    });
  }

  async buildUpdateWhitelistCalldata(params: {
    type: 'contract' | 'token';
    safeAddress: Address;
    addresses: string[];
    allowed: boolean[];
  }): Promise<`0x${string}`> {
    return encodeFunctionData({
      abi: AGENT_POLICY_MODULE_ABI,
      functionName: params.type === 'contract' ? 'updateContractWhitelist' : 'updateTokenWhitelist',
      args: [
        params.safeAddress,
        params.addresses.map((a) => getAddress(a)),
        params.allowed,
      ],
    });
  }
}
