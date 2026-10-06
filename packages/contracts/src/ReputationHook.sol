// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {IACPHook} from "./IACPHook.sol";
import {IReputationRegistry} from "./IReputationRegistry.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";
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
 *      A feedback entry is written only when ALL of the following hold; otherwise the hook emits
 *      `FeedbackSkipped(jobId, reason)` and settlement proceeds untouched:
 *        - `"untrusted-evaluator"`: `job.evaluator` must be `trustedEvaluator` (the operator /
 *          backend signer, decision D5). Any client may name itself evaluator of its own job, so
 *          without this gate anyone could forge hook-signed feedback for free.
 *        - `"no-params"`: `optParams` must be non-empty.
 *        - `"not-submitted"`: on `reject`, the job must have been `Submitted` at some point.
 *        - `"payout-blocked"`: on `reject` with `reason == REASON_PAYOUT_BLOCKED` nothing is written:
 *          the evaluator is unwinding a job whose provider cannot receive the token (blacklist),
 *          which says nothing about the quality of the work.
 *        - `"no-agent-id"`: `providerAgentId(jobId)` must be set.
 *        - `"budget-too-small"`: `job.budget >= minFeedbackBudget`, so every written entry has
 *          paid a real platform fee (dust jobs round the fee down to zero).
 *        - `"bad-params"`: `optParams` must decode as `abi.encode(string feedbackURI, bytes32 feedbackHash)`.
 *        - `"agent-not-provider"`: the ERC-8004 Identity Registry must report
 *          `ownerOf(agentId) == job.provider` or `getAgentWallet(agentId) == job.provider`, so an
 *          id can only ever be rated through a job its own owner delivered.
 *      A registry failure (no code, revert, out of gas) emits `FeedbackFailed` instead and never
 *      reverts settlement either.
 *
 *      Because this contract is `msg.sender` of `giveFeedback`, it becomes the canonical
 *      `clientAddress`: consumers call `getSummary(agentId, [hookAddress], "agentfi.job", "")` to
 *      read only feedback backed by a settled escrow payment, written for a job evaluated by the
 *      trusted evaluator, for an identity the paid provider controls, above the minimum budget.
 *
 *      Feedback is otherwise immutable: the only correction path is `revokeFeedback`, callable by
 *      `trustedEvaluator` only (the same key that triggers the write), which forwards to the
 *      registry's `revokeFeedback` (only the original writer, i.e. this hook, may revoke).
 *      Non-upgradeable by design.
 */
contract ReputationHook is IACPHook {
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
    /// @notice Reserved `reject` reason: the provider cannot receive the payout (e.g. token
    ///         blacklist) and the job is being unwound. No negative feedback is written for it.
    bytes32 public constant REASON_PAYOUT_BLOCKED = keccak256("agentfi.payout-blocked");

    // =========================================================================
    // Immutables
    // =========================================================================

    /// @notice The `AgentJobEscrow` allowed to call this hook.
    address public immutable acp;
    /// @notice The ERC-8004 Reputation Registry written to.
    address public immutable reputationRegistry;
    /// @notice The ERC-8004 Identity Registry used to verify that an agent id belongs to the provider.
    address public immutable identityRegistry;
    /// @notice The only evaluator whose settlements produce feedback (operator / backend signer, D5).
    ///         Also the only address allowed to call `revokeFeedback`.
    address public immutable trustedEvaluator;
    /// @notice Minimum `job.budget` (token units) for feedback to be written.
    uint256 public immutable minFeedbackBudget;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Feedback was recorded in the registry.
    event FeedbackWritten(uint256 indexed jobId, uint256 indexed agentId, int128 value);
    /// @notice Feedback was intentionally not written. `reason` is one of "untrusted-evaluator",
    ///         "no-params", "not-submitted", "payout-blocked", "no-agent-id", "budget-too-small",
    ///         "bad-params", "agent-not-provider".
    event FeedbackSkipped(uint256 indexed jobId, bytes32 reason);
    /// @notice The registry call failed; settlement proceeded anyway. `reason` is the raw revert
    ///         data, or "no-code" / "no-identity-code" when a registry address has no code.
    event FeedbackFailed(uint256 indexed jobId, bytes reason);
    /// @notice A previously written entry was revoked in the registry by the trusted evaluator.
    event FeedbackRevoked(uint256 indexed agentId, uint64 indexed feedbackIndex);

    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice Caller is not the escrow.
    error OnlyACP();
    /// @notice Caller is not the trusted evaluator.
    error OnlyTrustedEvaluator();
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
     * @param identityRegistry_ Address of the ERC-8004 Identity Registry.
     * @param trustedEvaluator_ The only evaluator whose settlements are written as feedback.
     * @param minFeedbackBudget_ Minimum job budget (token units) for feedback to be written
     *        (deploy default 1_000_000 = 1 USDC; 0 disables the check).
     */
    constructor(
        address acp_,
        address reputationRegistry_,
        address identityRegistry_,
        address trustedEvaluator_,
        uint256 minFeedbackBudget_
    ) {
        if (
            acp_ == address(0) || reputationRegistry_ == address(0) || identityRegistry_ == address(0)
                || trustedEvaluator_ == address(0)
        ) revert ZeroAddress();
        acp = acp_;
        reputationRegistry = reputationRegistry_;
        identityRegistry = identityRegistry_;
        trustedEvaluator = trustedEvaluator_;
        minFeedbackBudget = minFeedbackBudget_;
    }

    // =========================================================================
    // IACPHook
    // =========================================================================

    /// @inheritdoc IACPHook
    /// @dev No-op: this hook never gates an action.
    function beforeAction(uint256, bytes4, bytes calldata) external view onlyACP {}

    /// @inheritdoc IACPHook
    /// @dev Writes ERC-8004 feedback for `complete` and for `reject` of a submitted job, subject to
    ///      the gates listed in the contract NatSpec. Runs after the escrow has paid the provider
    ///      and the evaluator and accrued the platform fee.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyACP {
        bool completed = selector == AgentJobEscrow.complete.selector;
        if (!completed && selector != AgentJobEscrow.reject.selector) return;

        AgentJobEscrow.Job memory job = AgentJobEscrow(acp).getJob(jobId);
        (bytes memory optParams, uint256 agentId, bytes32 skip) = _gate(jobId, completed, data, job);
        if (skip != bytes32(0)) {
            emit FeedbackSkipped(jobId, skip);
            return;
        }

        _write(jobId, job.provider, agentId, completed, optParams);
    }

    // =========================================================================
    // Correction path
    // =========================================================================

    /**
     * @notice Revokes an entry this hook wrote. Only `trustedEvaluator` may call. Reverts are
     *         bubbled from the registry (unknown index, already revoked).
     * @param agentId ERC-8004 identity id the entry was written for.
     * @param feedbackIndex 1-based index of the entry within (`agentId`, this hook), as emitted in
     *        the registry's `NewFeedback` event.
     */
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        if (msg.sender != trustedEvaluator) revert OnlyTrustedEvaluator();
        IReputationRegistry(reputationRegistry).revokeFeedback(agentId, feedbackIndex);
        emit FeedbackRevoked(agentId, feedbackIndex);
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

    /// @dev Cheap gates that need no external registry call. Returns a non-zero `skip` reason when
    ///      nothing must be written; otherwise the decoded `optParams` and the agent id to rate.
    function _gate(uint256 jobId, bool completed, bytes calldata data, AgentJobEscrow.Job memory job)
        internal
        view
        returns (bytes memory optParams, uint256 agentId, bytes32 skip)
    {
        if (job.evaluator != trustedEvaluator) return (optParams, 0, "untrusted-evaluator");

        bytes32 reason;
        (reason, optParams) = abi.decode(data, (bytes32, bytes));
        if (optParams.length == 0) return (optParams, 0, "no-params");

        AgentJobEscrow escrow = AgentJobEscrow(acp);
        if (!completed) {
            if (escrow.submittedAt(jobId) == 0) return (optParams, 0, "not-submitted");
            if (reason == REASON_PAYOUT_BLOCKED) return (optParams, 0, "payout-blocked");
        }

        agentId = escrow.providerAgentId(jobId);
        if (agentId == 0) return (optParams, 0, "no-agent-id");
        if (job.budget < minFeedbackBudget) return (optParams, 0, "budget-too-small");
    }

    /// @dev Decodes the feedback params, verifies identity ownership and writes to the registry.
    ///      Never reverts: every failure is reported through `FeedbackSkipped` / `FeedbackFailed`.
    function _write(uint256 jobId, address provider, uint256 agentId, bool completed, bytes memory optParams) internal {
        string memory feedbackURI;
        bytes32 feedbackHash;
        try this.decodeFeedbackParams(optParams) returns (string memory uri, bytes32 hash) {
            feedbackURI = uri;
            feedbackHash = hash;
        } catch {
            emit FeedbackSkipped(jobId, "bad-params");
            return;
        }

        if (identityRegistry.code.length == 0) {
            emit FeedbackFailed(jobId, bytes("no-identity-code"));
            return;
        }
        if (!_agentBelongsTo(agentId, provider)) {
            emit FeedbackSkipped(jobId, "agent-not-provider");
            return;
        }
        if (reputationRegistry.code.length == 0) {
            emit FeedbackFailed(jobId, bytes("no-code"));
            return;
        }

        int128 value = completed ? VALUE_COMPLETED : VALUE_REJECTED;
        string memory tag2 = completed ? TAG_COMPLETED : TAG_REJECTED;
        try IReputationRegistry(reputationRegistry)
            .giveFeedback(agentId, value, 0, TAG1, tag2, "", feedbackURI, feedbackHash) {
            emit FeedbackWritten(jobId, agentId, value);
        } catch (bytes memory reason) {
            emit FeedbackFailed(jobId, reason);
        }
    }

    /// @dev True when `ownerOf(agentId)` or `getAgentWallet(agentId)` on the Identity Registry equals
    ///      `provider`. Static calls with strict decoding: a revert (unknown id), empty or malformed
    ///      return data simply yields `false` and can never revert settlement.
    function _agentBelongsTo(uint256 agentId, address provider) internal view returns (bool) {
        return _identityReturns(abi.encodeCall(IIdentityRegistry.ownerOf, (agentId)), provider)
            || _identityReturns(abi.encodeCall(IIdentityRegistry.getAgentWallet, (agentId)), provider);
    }

    /// @dev Static call to the Identity Registry; true only when it returned exactly one word equal to `expected`.
    function _identityReturns(bytes memory callData, address expected) internal view returns (bool) {
        (bool ok, bytes memory ret) = identityRegistry.staticcall(callData);
        if (!ok || ret.length != 32) return false;
        return abi.decode(ret, (uint256)) == uint256(uint160(expected));
    }

    // =========================================================================
    // ERC-165
    // =========================================================================

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
