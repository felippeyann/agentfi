// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IReputationRegistry
 * @notice Minimal view of the ERC-8004 (Trustless Agents) Reputation Registry used by AgentFi.
 *
 * @dev Signatures taken verbatim from the 2026-01-25 revision of the EIP (the earlier
 *      `feedbackAuth` parameter was removed). The hook needs `giveFeedback` (settlement) and
 *      `revokeFeedback` (operator correction); reads (`getSummary`, `readAllFeedback`) are done
 *      off-chain by the backend.
 *
 *      Registry addresses (CREATE2, same on every chain where it is deployed):
 *        - Ethereum mainnet / Base (8453):     0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *        - Sepolia / Base Sepolia (84532):     0x8004B663056A597Dffe9eCcC1965A193B7388713
 */
interface IReputationRegistry {
    /**
     * @notice Revokes a feedback entry previously written by `msg.sender` (the `clientAddress`).
     * @dev Only the original writer may revoke, which is why `ReputationHook` must forward the call.
     * @param agentId ERC-8004 identity id the entry was written for.
     * @param feedbackIndex 1-based index of the entry within (`agentId`, `msg.sender`).
     */
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

    /**
     * @notice Records feedback about an agent. `msg.sender` becomes the `clientAddress` of the entry.
     * @dev The registry reverts if `msg.sender` is the owner or an operator of `agentId`
     *      (anti-self-feedback gate). `endpoint`, `feedbackURI` and `feedbackHash` are only
     *      emitted, not stored.
     * @param agentId ERC-8004 identity id of the agent being rated.
     * @param value Feedback value (interpretation defined by `tag1`/`tag2`).
     * @param valueDecimals Decimals of `value`.
     * @param tag1 Primary tag (AgentFi uses "agentfi.job").
     * @param tag2 Secondary tag (AgentFi uses "completed" or "rejected").
     * @param endpoint Optional endpoint the feedback refers to (AgentFi passes "").
     * @param feedbackURI URI of the off-chain feedback file.
     * @param feedbackHash keccak256 of the feedback file.
     */
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
