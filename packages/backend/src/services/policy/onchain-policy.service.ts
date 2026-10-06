import { getAddress, type Address, encodeFunctionData, parseUnits } from 'viem';
import { createChainPublicClient } from '../../config/chains.js';
import { getContracts } from '../../config/contracts.js';
import { logger } from '../../api/middleware/logger.js';

export const AGENT_POLICY_MODULE_ABI = [
  {
    name: 'setPolicy',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'safe', type: 'address' },
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'maxValuePerTx', type: 'uint256' },
          { name: 'cooldownBetweenTx', type: 'uint256' },
          { name: 'active', type: 'bool' },
        ],
      },
      { name: 'expiresAt', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'updateContractWhitelist',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'targets', type: 'address[]' },
      { name: 'allowed', type: 'bool[]' },
    ],
    outputs: [],
  },
  {
    name: 'updateTokenWhitelist',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'safe', type: 'address' },
      { name: 'tokens', type: 'address[]' },
      { name: 'allowed', type: 'bool[]' },
    ],
    outputs: [],
  },
  {
    name: 'emergencyPause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'safe', type: 'address' }],
    outputs: [],
  },
  {
    name: 'resume',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'safe', type: 'address' }],
    outputs: [],
  },
] as const;

export class OnChainPolicyService {
  /**
   * Syncs an Agent's policy to the on-chain AgentPolicyModule.
   * This is called by the operator or when a policy is updated in the DB.
   *
   * Note: The caller must be the operator (for direct calls) or the Safe (via execTransaction).
   * In our backend, we typically broadcast these from the operator wallet or via Safe multisig.
   */
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

  /**
   * Builds calldata for `AgentPolicyModule.emergencyPause(safe)` — the
   * on-chain kill switch. Flips the Safe's policy to `active = false` without
   * touching limits, expiry or whitelists.
   *
   * Like `buildSyncPolicyCalldata`, this only encodes; the operator (or the
   * Safe via execTransaction) must broadcast it. The backend never does.
   */
  async buildEmergencyPauseCalldata(params: { safeAddress: Address }): Promise<`0x${string}`> {
    return encodeFunctionData({
      abi: AGENT_POLICY_MODULE_ABI,
      functionName: 'emergencyPause',
      args: [getAddress(params.safeAddress)],
    });
  }

  /**
   * Builds calldata for `AgentPolicyModule.resume(safe)` — undoes
   * `emergencyPause` by setting `active = true`. Encode-only, see above.
   */
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
