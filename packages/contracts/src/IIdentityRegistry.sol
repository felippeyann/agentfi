// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IIdentityRegistry
 * @notice Minimal view of the ERC-8004 (Trustless Agents) Identity Registry used by AgentFi.
 *
 * @dev The Identity Registry is an ERC-721: `ownerOf(agentId)` is the standard token owner and
 *      `getAgentWallet(agentId)` is the ERC-8004 agent wallet (set via `setAgentWallet`). Both
 *      revert for unknown ids. `ReputationHook` accepts an agent id for a job only when one of
 *      the two equals `job.provider`, so nobody can attach somebody else's identity to a job.
 *
 *      Registry addresses (CREATE2, same on every chain where it is deployed):
 *        - Ethereum mainnet / Base (8453):     0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *        - Sepolia / Base Sepolia (84532):     0x8004A818BFB912233c491871b3d84c89A494BD9e
 */
interface IIdentityRegistry {
    /// @notice ERC-721 owner of the agent identity. Reverts for unknown ids.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice ERC-8004 agent wallet bound to the identity. Reverts for unknown ids.
    function getAgentWallet(uint256 agentId) external view returns (address);
}
