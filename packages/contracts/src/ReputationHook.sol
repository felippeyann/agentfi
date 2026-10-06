// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {IACPHook} from "./IACPHook.sol";
import {IReputationRegistry} from "./IReputationRegistry.sol";
import {AgentJobEscrow} from "./AgentJobEscrow.sol";

/**
 * @title ReputationHook
 * @notice ERC-8183 `IACPHook` that writes ERC-8004 reputation feedback for the provider of an
 *         AgentFi job in the same transaction as settlement.
 *
 * @dev Attached per job at `AgentJobEscrow.createJob`. Only `afterAction` for `complete` and
 *      `reject` does anything; every other selector is ignored and `beforeAction` is a no-op.
 *
 *      On `complete` it writes `value = 100`, on `reject` of a previously `Submitted` job it writes
 *      `value = 0` (the evaluator rejected delivered work). Rejections of jobs that were never
 *      submitted (client cancellation while Open, or evaluator rejection while Funded) write
 *      nothing: no work was evaluated. `claimRefund` is never hooked by the standard.
 *
 *      `optParams` of `complete`/`reject` must be `abi.encode(string feedbackURI, bytes32 feedbackHash)`,
 *      built by the backend from the feedback file it serves. Empty or malformed params, a missing
 *      `providerAgentId`, or a registry failure never revert settlement: the hook emits a
 *      `FeedbackSkipped` / `FeedbackFailed` event instead.
 *
 *      Because this contract is `msg.sender` of `giveFeedback`, it becomes the canonical
 *      `clientAddress`: consumers call `getSummary(agentId, [hookAddress], "agentfi.job", "")` to
 *      read only feedback backed by a settled escrow payment. Non-upgradeable by design.
 */
contract ReputationHook is IACPHook, IERC165 {
    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice ERC-8004 `tag1` used for every entry written by this hook.
    string public constant TAG1 = "agentfi.job";
    /// @notice ERC-8004 `tag2` for completed jobs.
    string public constant TAG_COMPLETED = "completed";
    /// @notice ERC-8004 `tag2` for jobs rejected after submission.
    string public constant TAG_REJECTED = "rejected";
    /// @notice Feedback value written on completion.
    int128 public constant VALUE_COMPLETED = 100;
    /// @notice Feedback value written on rejection of delivered work.
    int128 public constant VALUE_REJECTED = 0;

    // =========================================================================
    // Immutables
    // =========================================================================

    /// @notice The `AgentJobEscrow` allowed to call this hook.
    address public immutable acp;
    /// @notice The ERC-8004 Reputation Registry written to.
    address public immutable reputationRegistry;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Feedback was recorded in the registry.
    event FeedbackWritten(uint256 indexed jobId, uint256 indexed agentId, int128 value);
    /// @notice Feedback was intentionally not written ("no-params", "not-submitted", "no-agent-id", "bad-params").
    event FeedbackSkipped(uint256 indexed jobId, bytes32 reason);
    /// @notice The registry call failed; settlement proceeded anyway. `reason` is the raw revert data.
    event FeedbackFailed(uint256 indexed jobId, bytes reason);

    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice Caller is not the escrow.
    error OnlyACP();
    /// @notice A constructor argument was zero.
    error ZeroAddress();

    // =========================================================================
    // Modifiers
    // =========================================================================

    /// @dev Restricts hook entry points to the escrow.
    modifier onlyACP() {
        if (msg.sender != acp) revert OnlyACP();
        _;
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @param acp_ Address of the `AgentJobEscrow` this hook serves.
     * @param reputationRegistry_ Address of the ERC-8004 Reputation Registry.
     */
    constructor(address acp_, address reputationRegistry_) {
        if (acp_ == address(0) || reputationRegistry_ == address(0)) revert ZeroAddress();
        acp = acp_;
        reputationRegistry = reputationRegistry_;
    }

    // =========================================================================
    // IACPHook
    // =========================================================================

    /// @inheritdoc IACPHook
    /// @dev No-op: this hook never gates an action.
    function beforeAction(uint256, bytes4, bytes calldata) external view onlyACP {}

    /// @inheritdoc IACPHook
    /// @dev Writes ERC-8004 feedback for `complete` and for `reject` of a submitted job.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyACP {
        bool completed = selector == AgentJobEscrow.complete.selector;
        if (!completed && selector != AgentJobEscrow.reject.selector) return;

        (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
        if (optParams.length == 0) {
            emit FeedbackSkipped(jobId, "no-params");
            return;
        }

        AgentJobEscrow escrow = AgentJobEscrow(acp);
        if (!completed && escrow.submittedAt(jobId) == 0) {
            emit FeedbackSkipped(jobId, "not-submitted");
            return;
        }

        uint256 agentId = escrow.providerAgentId(jobId);
        if (agentId == 0) {
            emit FeedbackSkipped(jobId, "no-agent-id");
            return;
        }

        string memory feedbackURI;
        bytes32 feedbackHash;
        try this.decodeFeedbackParams(optParams) returns (string memory uri, bytes32 hash) {
            feedbackURI = uri;
            feedbackHash = hash;
        } catch {
            emit FeedbackSkipped(jobId, "bad-params");
            return;
        }

        int128 value = completed ? VALUE_COMPLETED : VALUE_REJECTED;
        string memory tag2 = completed ? TAG_COMPLETED : TAG_REJECTED;

        if (reputationRegistry.code.length == 0) {
            emit FeedbackFailed(jobId, bytes("no-code"));
            return;
        }

        try IReputationRegistry(reputationRegistry)
            .giveFeedback(agentId, value, 0, TAG1, tag2, "", feedbackURI, feedbackHash) {
            emit FeedbackWritten(jobId, agentId, value);
        } catch (bytes memory reason) {
            emit FeedbackFailed(jobId, reason);
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * @notice Decodes the `optParams` expected by this hook on `complete`/`reject`.
     * @dev External so the decoding can be wrapped in try/catch; reverts on malformed input.
     * @param optParams `abi.encode(string feedbackURI, bytes32 feedbackHash)`.
     * @return feedbackURI URI of the feedback file served by the backend.
     * @return feedbackHash keccak256 of that file.
     */
    function decodeFeedbackParams(bytes calldata optParams)
        external
        pure
        returns (string memory feedbackURI, bytes32 feedbackHash)
    {
        (feedbackURI, feedbackHash) = abi.decode(optParams, (string, bytes32));
    }

    // =========================================================================
    // ERC-165
    // =========================================================================

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
