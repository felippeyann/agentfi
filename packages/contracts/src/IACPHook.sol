// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IACPHook
 * @notice ERC-8183 (Agentic Commerce) per-job hook interface, verbatim from the published EIP
 *         text (2026-03-13 revision).
 *
 * @dev A hook is fixed per job at `createJob` and is invoked by the escrow around exactly six
 *      actions: `setProvider`, `setBudget`, `fund`, `submit`, `complete` and `reject`.
 *      `claimRefund` is never hooked, so a hook can never block a refund after expiry.
 *
 *      - `beforeAction` runs before any state change of the action. It MAY revert to gate the
 *        action (the whole transaction reverts).
 *      - `afterAction` runs after all state changes and token transfers of the action, in the
 *        same transaction. A revert here also reverts the action.
 *
 *      `data` encoding per selector (ERC-8183 table):
 *        - `setProvider` → `abi.encode(address provider, bytes optParams)` (optParams is empty)
 *        - `setBudget`   → `abi.encode(uint256 amount, bytes optParams)`
 *        - `fund`        → `optParams` as passed by the client (raw, not re-encoded)
 *        - `submit`      → `abi.encode(bytes32 deliverable, bytes optParams)`
 *        - `complete`    → `abi.encode(bytes32 reason, bytes optParams)`
 *        - `reject`      → `abi.encode(bytes32 reason, bytes optParams)`
 *
 *      ERC-165 expectation: implementations MUST also expose
 *      `supportsInterface(bytes4 interfaceId) external view returns (bool)` and return `true`
 *      for `type(IACPHook).interfaceId` (the XOR of the two selectors below). The escrow
 *      checks this at `createJob` and rejects hooks that do not advertise the interface.
 *      Hooks SHOULD restrict both functions to the escrow (`onlyACP`) and SHOULD be
 *      non-upgradeable so that the behaviour attached to a job cannot change after funding.
 */
interface IACPHook {
    /**
     * @notice Called by the escrow before the state change of a hookable action.
     * @param jobId The job the action applies to.
     * @param selector The 4-byte selector of the escrow function being executed.
     * @param data Action-specific payload (see the encoding table in the contract NatSpec).
     */
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    /**
     * @notice Called by the escrow after the state change and token transfers of a hookable action.
     * @param jobId The job the action applies to.
     * @param selector The 4-byte selector of the escrow function being executed.
     * @param data Action-specific payload (same bytes as passed to `beforeAction`).
     */
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
