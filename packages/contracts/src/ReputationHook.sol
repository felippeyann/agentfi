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
 * @dev Attached per job at `AgentJobEscrow.createJob`. `afterAction` acts on three selectors;
 *      every other selector is ignored and `beforeAction` is a no-op:
 *        - `submit`: binds the provider ADDRESS to one canonical ERC-8004 agent id (see "Identity").
 *        - `complete`: writes `value = 100`.
 *        - `reject`: writes `value = 0` ONLY for the trusted evaluator's explicit quality verdict on
 *          delivered work, i.e. `reason == REASON_QUALITY_REJECTED` on a previously `Submitted` job
 *          (decision D9, 2026-10-08). A requester's contest, a cancellation, a provider failure, a
 *          payout-blocked unwind or any other reason refunds the client and writes nothing
 *          (`"not-verdict"` / `"payout-blocked"` / `"not-submitted"`). `claimRefund` (expiry) is
 *          never hooked by the standard.
 *
 *      Identity (second adversarial review, 2026-10-08). A provider must not be able to dodge a
 *      negative verdict and keep collecting positive entries for the same identity, nor rotate
 *      identities per job. Re-reading the Identity Registry at settlement let a self-custodied
 *      provider do both: park the NFT on another address right before the verdict
 *      (`"agent-not-provider"`, then transfer it back) or bind a throwaway id to a job it knew was
 *      poor. Therefore:
 *        - The first time a provider address submits a job (evaluated by `trustedEvaluator`) whose
 *          `providerAgentId` the Identity Registry confirms (`ownerOf(agentId) == provider` or
 *          `getAgentWallet(agentId) == provider`), that id becomes `canonicalAgentId[provider]`
 *          for good (`CanonicalAgentIdSet`). First verified bind wins; it is never replaced.
 *        - Every settlement of that provider's jobs rates `canonicalAgentId[job.provider]`,
 *          whatever id the job carries, and does NOT re-read the Identity Registry: the provider
 *          controlled the id when it was bound, and later transfers or agent-wallet changes cannot
 *          detach it. An identity therefore stays attributed to every provider address that bound
 *          it (documented consequence: a buyer of an identity inherits it).
 *        - A provider without a canonical id is not rated (`"no-agent-id"` when the job carries no
 *          id, `"agent-not-provider"` when the id it carried did not verify at `submit`).
 *      Settlement never calls the Identity Registry; only the first verified `submit` of each
 *      provider address does.
 *
 *      Penalty. The ERC-8004 Reputation Registry refuses `giveFeedback` when the writer (this hook)
 *      is the owner or an approved operator of the agent id (anti-self-feedback). A provider could
 *      therefore approve this hook on the Identity Registry right before a verdict, let the
 *      negative write fail, and revoke the approval afterwards. When a verdict write is not
 *      recorded for ANY reason (`FeedbackFailed`: revert data, out of its gas cap, no code), the
 *      hook records it itself: `penalties[agentId]` is incremented (`AgentPenalized`) and no
 *      positive entry is ever written again for that id (`"penalized"`) until `trustedEvaluator`
 *      lifts it with `clearPenalties` (correction path for a registry outage; the revert data in
 *      `FeedbackFailed` shows who caused the failure). Negative verdicts keep being attempted.
 *
 *      A feedback entry is written only when ALL of the following hold; otherwise the hook emits
 *      `FeedbackSkipped(jobId, reason)` and settlement proceeds untouched (gates in this order):
 *        - `"untrusted-evaluator"`: `job.evaluator` must be `trustedEvaluator` (the operator /
 *          backend signer, decision D5). Any client may name itself evaluator of its own job, so
 *          without this gate anyone could forge hook-signed feedback for free.
 *        - `"no-params"`: `optParams` must be non-empty.
 *        - on `reject`: `"not-submitted"` (the job must have been `Submitted`), `"payout-blocked"`
 *          (`reason == REASON_PAYOUT_BLOCKED`: the provider cannot receive the token, which says
 *          nothing about the work) and `"not-verdict"` (`reason != REASON_QUALITY_REJECTED`).
 *        - `"no-agent-id"`: the provider has no canonical id and the job carries none.
 *        - `"budget-too-small"`: `job.budget >= minFeedbackBudget` (dust jobs cannot farm entries).
 *        - `"agent-not-provider"`: the provider has no canonical id (the id it bound did not verify).
 *        - on `complete`: `"penalized"` (`penalties[agentId] != 0`).
 *        - `"bad-params"`: `optParams` must decode as `abi.encode(string feedbackURI, bytes32 feedbackHash)`.
 *      A registry failure (no code, revert, out of its gas cap) emits `FeedbackFailed` instead (plus
 *      `AgentPenalized` for a verdict) and never reverts settlement either.
 *
 *      Gas policy (R3c). Registry behaviour must never block settlement (nor the provider's
 *      `submit`), so registry calls are wrapped — but a wrapped call that runs out of gas looks
 *      exactly like a failing registry, and `eth_estimateGas` returns the lowest limit at which the
 *      transaction succeeds (C5a fork rehearsal: estimate 246 770 gas → `FeedbackFailed`). Therefore:
 *        1. Every registry call forwards a fixed gas cap: `feedbackGasLimit` for `giveFeedback`,
 *           `identityCallGasLimit` for each Identity Registry static call. A registry that burns
 *           gas consumes at most its cap and yields `FeedbackFailed` / an unverified binding.
 *           Return data is never copied beyond 32 bytes (identity) / `MAX_REASON_LENGTH` bytes
 *           (revert data of `giveFeedback`), so a registry cannot make the hook itself expensive.
 *        2. Once the cheap gates above have passed and a write will be attempted, `_write` requires
 *           `gasleft() >= feedbackGasRequirement` and right before `giveFeedback` it requires that
 *           the call receives its full cap with `FEEDBACK_CALL_RESERVE` left for the outcome event
 *           and a penalty record; otherwise the whole `complete` / `reject` reverts with
 *           `InsufficientGasForFeedback`. Likewise the first verified bind on `submit` requires
 *           `gasleft() >= canonicalBindGasRequirement` before its two identity calls. These checks
 *           depend only on the gas the caller supplied, never on registry behaviour: an estimator
 *           converges on a limit at which the registry calls get their full caps, a deliberately
 *           under-gassed call fails loudly instead of losing the feedback or the binding, and a
 *           gas-burning or upgraded registry still cannot block settlement (it is bounded by the
 *           caps). Paths that skip never reach the checks. The hook does NOT revert when a registry
 *           consumed its whole cap: that would hand a third-party registry a way to block every
 *           settlement.
 *        3. `claimRefund` is not hooked by ERC-8183, so it stays the unconditional escape hatch for
 *           a funded job whatever this hook or the registries do.
 *      `decodeFeedbackParams` (self-call) is not capped: it is this contract's own `pure` code, its
 *      input comes only from `trustedEvaluator` (the `"untrusted-evaluator"` gate runs first), it
 *      runs after the guard with at least 63/64 of `feedbackGasRequirement`, and a malformed
 *      payload reverts immediately and returns the unused gas. A cap would bound nothing and would
 *      only add a way for a large but valid payload to be dropped as `"bad-params"`.
 *
 *      Because this contract is `msg.sender` of `giveFeedback`, it becomes the canonical
 *      `clientAddress`: consumers call `getSummary(agentId, [hookAddress], "agentfi.job", "")` to
 *      read only feedback written for a job escrowed and settled through `AgentJobEscrow`, decided
 *      by the trusted evaluator, delivered by an address that controlled the identity when it bound
 *      it, above the minimum budget. A `"completed"` entry also means a platform fee was accrued; a
 *      `"rejected"` entry means the trusted evaluator issued an explicit quality verdict and the
 *      client was refunded in full (no fee is taken on rejection). Consumers should also read
 *      `penalties(agentId)`: a non-zero value means negative verdicts the registry did not record.
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
    /// @notice ERC-8004 `tag2` for jobs rejected by an explicit quality verdict.
    string public constant TAG_REJECTED = "rejected";
    /// @notice Feedback value written on completion.
    int128 public constant VALUE_COMPLETED = 100;
    /// @notice Feedback value written for a quality verdict (`REASON_QUALITY_REJECTED`).
    int128 public constant VALUE_REJECTED = 0;
    /// @notice Reserved `reject` reason: the provider cannot receive the payout (e.g. token
    ///         blacklist) and the job is being unwound. No negative feedback is written for it.
    bytes32 public constant REASON_PAYOUT_BLOCKED = keccak256("agentfi.payout-blocked");
    /// @notice The only `reject` reason that writes negative feedback: the trusted evaluator's
    ///         explicit verdict that delivered work failed quality review (decision D9). Same
    ///         `agentfi.<kebab-case>` namespace as the backend's other settlement reasons
    ///         (`agentfi.completed`, `agentfi.contested`, `agentfi.cancelled`,
    ///         `agentfi.provider-failed`, `agentfi.payout-blocked`), and deliberately distinct from
    ///         `agentfi.contested`: a contest is the requester's claim, the verdict is the operator's
    ///         decision after reviewing it.
    bytes32 public constant REASON_QUALITY_REJECTED = keccak256("agentfi.quality-rejected");

    /// @notice Lowest accepted `feedbackGasLimit`. `giveFeedback` on the ERC-8004 Reputation Registry
    ///         v2.0.0 uses 179 416 gas for a first entry (Base Sepolia fork, C5a); a lower cap would make
    ///         every write fail.
    uint256 public constant MIN_FEEDBACK_GAS_LIMIT = 250_000;
    /// @notice Highest accepted `feedbackGasLimit` (keeps `feedbackGasRequirement` far below a block).
    uint256 public constant MAX_FEEDBACK_GAS_LIMIT = 2_000_000;
    /// @notice Lowest accepted `identityCallGasLimit`. `ownerOf` / `getAgentWallet` on the ERC-8004
    ///         Identity Registry v2.0.0 (UUPS proxy) use about 7 800 gas each from a cold start.
    uint256 public constant MIN_IDENTITY_CALL_GAS_LIMIT = 20_000;
    /// @notice Highest accepted `identityCallGasLimit`.
    uint256 public constant MAX_IDENTITY_CALL_GAS_LIMIT = 200_000;
    /// @notice Gas the hook keeps for its own work before `giveFeedback` (decoding `optParams`, the
    ///         registry code check, encoding the feedback call). Part of `feedbackGasRequirement`.
    uint256 public constant GAS_RESERVE = 50_000;
    /// @notice Gas the hook keeps around the `giveFeedback` call on top of `feedbackGasLimit` and
    ///         its 1/64: the CALL itself, copying at most `MAX_REASON_LENGTH` bytes of revert data,
    ///         the outcome event and, for a verdict that was not recorded, the penalty record (one
    ///         cold SSTORE and `AgentPenalized`). Part of `feedbackGasRequirement`.
    uint256 public constant FEEDBACK_CALL_RESERVE = 40_000;
    /// @notice Gas the hook keeps on `submit` around the two identity calls of a first bind: encoding
    ///         and issuing them, the `canonicalAgentId` SSTORE and `CanonicalAgentIdSet`. Part of
    ///         `canonicalBindGasRequirement`.
    uint256 public constant BIND_RESERVE = 40_000;
    /// @notice At most this many bytes of a failed `giveFeedback`'s revert data are copied into
    ///         `FeedbackFailed.reason`.
    uint256 public constant MAX_REASON_LENGTH = 256;

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
    ///         Also the only address allowed to call `revokeFeedback` and `clearPenalties`.
    address public immutable trustedEvaluator;
    /// @notice Minimum `job.budget` (token units) for feedback to be written.
    uint256 public immutable minFeedbackBudget;
    /// @notice Gas forwarded to `giveFeedback` (exactly this much: the hook reverts rather than
    ///         forward less).
    uint256 public immutable feedbackGasLimit;
    /// @notice Gas forwarded to each Identity Registry static call (`ownerOf`, `getAgentWallet`).
    uint256 public immutable identityCallGasLimit;
    /// @notice Minimum `gasleft()` inside `afterAction(complete|reject)` once a write will be
    ///         attempted: `feedbackGasLimit + feedbackGasLimit / 63 + 1 + FEEDBACK_CALL_RESERVE
    ///         + GAS_RESERVE`. Below it `complete` / `reject` revert with `InsufficientGasForFeedback`.
    uint256 public immutable feedbackGasRequirement;
    /// @notice Minimum `gasleft()` inside `afterAction(submit)` when a provider's first binding is
    ///         verified: `2 * identityCallGasLimit + identityCallGasLimit / 63 + 1 + BIND_RESERVE`.
    ///         Below it `submit` reverts with `InsufficientGasForFeedback`.
    uint256 public immutable canonicalBindGasRequirement;

    // =========================================================================
    // State
    // =========================================================================

    /// @notice The one ERC-8004 agent id this hook rates for a provider address (0 = none yet). Set
    ///         by the provider's first `submit` whose bound id the Identity Registry confirmed;
    ///         never changed afterwards.
    mapping(address provider => uint256 agentId) public canonicalAgentId;
    /// @notice Negative verdicts for an agent id that the Reputation Registry did not record. While
    ///         non-zero, no positive entry is written for the id.
    mapping(uint256 agentId => uint256 count) public penalties;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Feedback was recorded in the registry.
    event FeedbackWritten(uint256 indexed jobId, uint256 indexed agentId, int128 value);
    /// @notice Feedback was intentionally not written. `reason` is one of "untrusted-evaluator",
    ///         "no-params", "not-submitted", "payout-blocked", "not-verdict", "no-agent-id",
    ///         "budget-too-small", "agent-not-provider", "penalized", "bad-params".
    event FeedbackSkipped(uint256 indexed jobId, bytes32 reason);
    /// @notice The registry call failed; settlement proceeded anyway. `reason` is the revert data
    ///         (at most its first `MAX_REASON_LENGTH` bytes; empty when the registry ran out of its
    ///         gas cap), or "no-code" when the Reputation Registry address has no code.
    event FeedbackFailed(uint256 indexed jobId, bytes reason);
    /// @notice A previously written entry was revoked in the registry by the trusted evaluator.
    event FeedbackRevoked(uint256 indexed agentId, uint64 indexed feedbackIndex);
    /// @notice `provider`'s first verified binding: every later settlement of its jobs rates `agentId`.
    event CanonicalAgentIdSet(address indexed provider, uint256 indexed agentId, uint256 indexed jobId);
    /// @notice The id a provider without a canonical id bound to `jobId` was not confirmed by the
    ///         Identity Registry at `submit` (not the provider's, unknown id, registry failure).
    event AgentIdNotVerified(uint256 indexed jobId, address indexed provider, uint256 indexed agentId);
    /// @notice The negative verdict on `jobId` was not recorded by the registry: `agentId` now has
    ///         `penalties` unrecorded verdicts and gets no positive entries.
    event AgentPenalized(uint256 indexed agentId, uint256 indexed jobId, uint256 penalties);
    /// @notice The trusted evaluator lifted the penalty of `agentId` (`cleared` unrecorded verdicts).
    event PenaltiesCleared(uint256 indexed agentId, uint256 cleared);

    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice Caller is not the escrow.
    error OnlyACP();
    /// @notice Caller is not the trusted evaluator.
    error OnlyTrustedEvaluator();
    /// @notice A constructor argument was zero.
    error ZeroAddress();
    /// @notice `feedbackGasLimit` is outside [`MIN_FEEDBACK_GAS_LIMIT`, `MAX_FEEDBACK_GAS_LIMIT`].
    error InvalidFeedbackGasLimit(uint256 value);
    /// @notice `identityCallGasLimit` is outside [`MIN_IDENTITY_CALL_GAS_LIMIT`, `MAX_IDENTITY_CALL_GAS_LIMIT`].
    error InvalidIdentityCallGasLimit(uint256 value);
    /// @notice The transaction did not carry enough gas to attempt the registry calls with full gas
    ///         caps: the feedback write of `complete` / `reject`, or the identity check of a
    ///         provider's first `submit`. Retry with a higher gas limit.
    /// @param available `gasleft()` at the check.
    /// @param required Gas needed at that point.
    error InsufficientGasForFeedback(uint256 available, uint256 required);

    // =========================================================================
    // Modifiers
    // =========================================================================

    /// @dev Restricts hook entry points to the escrow.
    modifier onlyACP() {
        if (msg.sender != acp) revert OnlyACP();
        _;
    }

    /// @dev Restricts the correction paths to the trusted evaluator.
    modifier onlyTrustedEvaluator() {
        if (msg.sender != trustedEvaluator) revert OnlyTrustedEvaluator();
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
     * @param feedbackGasLimit_ Gas forwarded to `giveFeedback` (deploy default 500_000), within
     *        [`MIN_FEEDBACK_GAS_LIMIT`, `MAX_FEEDBACK_GAS_LIMIT`].
     * @param identityCallGasLimit_ Gas forwarded to each Identity Registry static call (deploy
     *        default 50_000), within [`MIN_IDENTITY_CALL_GAS_LIMIT`, `MAX_IDENTITY_CALL_GAS_LIMIT`].
     */
    constructor(
        address acp_,
        address reputationRegistry_,
        address identityRegistry_,
        address trustedEvaluator_,
        uint256 minFeedbackBudget_,
        uint256 feedbackGasLimit_,
        uint256 identityCallGasLimit_
    ) {
        if (
            acp_ == address(0) || reputationRegistry_ == address(0) || identityRegistry_ == address(0)
                || trustedEvaluator_ == address(0)
        ) revert ZeroAddress();
        if (feedbackGasLimit_ < MIN_FEEDBACK_GAS_LIMIT || feedbackGasLimit_ > MAX_FEEDBACK_GAS_LIMIT) {
            revert InvalidFeedbackGasLimit(feedbackGasLimit_);
        }
        if (identityCallGasLimit_ < MIN_IDENTITY_CALL_GAS_LIMIT || identityCallGasLimit_ > MAX_IDENTITY_CALL_GAS_LIMIT)
        {
            revert InvalidIdentityCallGasLimit(identityCallGasLimit_);
        }
        acp = acp_;
        reputationRegistry = reputationRegistry_;
        identityRegistry = identityRegistry_;
        trustedEvaluator = trustedEvaluator_;
        minFeedbackBudget = minFeedbackBudget_;
        feedbackGasLimit = feedbackGasLimit_;
        identityCallGasLimit = identityCallGasLimit_;
        feedbackGasRequirement = _feedbackCallRequirement(feedbackGasLimit_) + GAS_RESERVE;
        canonicalBindGasRequirement =
            2 * identityCallGasLimit_ + identityCallGasLimit_ / 63 + 1 + BIND_RESERVE;
    }

    // =========================================================================
    // IACPHook
    // =========================================================================

    /// @inheritdoc IACPHook
    /// @dev No-op: this hook never gates an action.
    function beforeAction(uint256, bytes4, bytes calldata) external view onlyACP {}

    /// @inheritdoc IACPHook
    /// @dev `submit`: verifies and records the provider's first binding (see "Identity" in the
    ///      contract NatSpec). `complete` / `reject`: writes ERC-8004 feedback subject to the gates
    ///      listed in the contract NatSpec; runs after the escrow has paid the provider and the
    ///      evaluator (or refunded the client) and accrued the platform fee. Reverts with
    ///      `InsufficientGasForFeedback` only when a registry call will be made and the caller
    ///      supplied too little gas for it (see the gas policy in the contract NatSpec).
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyACP {
        if (selector == AgentJobEscrow.submit.selector) {
            _bindOnSubmit(jobId);
            return;
        }
        bool completed = selector == AgentJobEscrow.complete.selector;
        if (!completed && selector != AgentJobEscrow.reject.selector) return;

        AgentJobEscrow.Job memory job = AgentJobEscrow(acp).getJob(jobId);
        (bytes memory optParams, uint256 agentId, bytes32 skip) = _gate(jobId, completed, data, job);
        if (skip != bytes32(0)) {
            emit FeedbackSkipped(jobId, skip);
            return;
        }

        _write(jobId, agentId, completed, optParams);
    }

    // =========================================================================
    // Correction paths
    // =========================================================================

    /**
     * @notice Revokes an entry this hook wrote. Only `trustedEvaluator` may call. Reverts are
     *         bubbled from the registry (unknown index, already revoked).
     * @param agentId ERC-8004 identity id the entry was written for.
     * @param feedbackIndex 1-based index of the entry within (`agentId`, this hook), as emitted in
     *        the registry's `NewFeedback` event.
     */
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external onlyTrustedEvaluator {
        IReputationRegistry(reputationRegistry).revokeFeedback(agentId, feedbackIndex);
        emit FeedbackRevoked(agentId, feedbackIndex);
    }

    /**
     * @notice Lifts the penalty of `agentId` so positive entries are written again. Only
     *         `trustedEvaluator` may call. Meant for verdicts the registry failed to record through
     *         no fault of the provider (outage, upgrade, gas cap): `FeedbackFailed.reason` of the
     *         penalizing job tells them apart from the anti-self-feedback refusal a provider causes
     *         by approving this hook.
     * @param agentId ERC-8004 identity id.
     */
    function clearPenalties(uint256 agentId) external onlyTrustedEvaluator {
        uint256 cleared = penalties[agentId];
        delete penalties[agentId];
        emit PenaltiesCleared(agentId, cleared);
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

    /// @dev On `submit` of a job evaluated by `trustedEvaluator` whose provider has no canonical id
    ///      yet: verifies the job's `providerAgentId` against the Identity Registry and, if it
    ///      belongs to the provider, makes it the provider's canonical id. Reverts only with
    ///      `InsufficientGasForFeedback` (caller's gas); a registry failure just leaves the binding
    ///      unverified (`AgentIdNotVerified`) and never blocks `submit`.
    function _bindOnSubmit(uint256 jobId) internal {
        AgentJobEscrow escrow = AgentJobEscrow(acp);
        AgentJobEscrow.Job memory job = escrow.getJob(jobId);
        if (job.evaluator != trustedEvaluator) return;
        address provider = job.provider;
        if (canonicalAgentId[provider] != 0) return;
        uint256 agentId = escrow.providerAgentId(jobId);
        if (agentId == 0) return;

        _requireGas(canonicalBindGasRequirement);
        if (_agentBelongsTo(agentId, provider)) {
            canonicalAgentId[provider] = agentId;
            emit CanonicalAgentIdSet(provider, agentId, jobId);
        } else {
            emit AgentIdNotVerified(jobId, provider, agentId);
        }
    }

    /// @dev Cheap gates that need no registry call. Returns a non-zero `skip` reason when nothing
    ///      must be written; otherwise the raw `optParams` and the agent id to rate.
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
            if (reason != REASON_QUALITY_REJECTED) return (optParams, 0, "not-verdict");
        }

        agentId = canonicalAgentId[job.provider];
        if (agentId == 0 && escrow.providerAgentId(jobId) == 0) return (optParams, 0, "no-agent-id");
        if (job.budget < minFeedbackBudget) return (optParams, 0, "budget-too-small");
        if (agentId == 0) return (optParams, 0, "agent-not-provider");
        if (completed && penalties[agentId] != 0) return (optParams, 0, "penalized");
    }

    /// @dev Decodes the feedback params and writes to the registry; a verdict that is not recorded
    ///      penalizes the id. Reverts only with `InsufficientGasForFeedback` (caller's gas); every
    ///      registry-side failure is reported through `FeedbackFailed`.
    function _write(uint256 jobId, uint256 agentId, bool completed, bytes memory optParams) internal {
        // Every outcome below depends on a call whose result could change with the gas left
        // (decode, giveFeedback, the penalty record): require enough for all of them up front.
        _requireGas(feedbackGasRequirement);

        string memory feedbackURI;
        bytes32 feedbackHash;
        try this.decodeFeedbackParams(optParams) returns (string memory uri, bytes32 hash) {
            feedbackURI = uri;
            feedbackHash = hash;
        } catch {
            emit FeedbackSkipped(jobId, "bad-params");
            return;
        }

        bool written;
        if (reputationRegistry.code.length == 0) {
            emit FeedbackFailed(jobId, bytes("no-code"));
        } else {
            written = _giveFeedback(jobId, agentId, completed, feedbackURI, feedbackHash);
        }
        if (!written && !completed) {
            uint256 count = ++penalties[agentId];
            emit AgentPenalized(agentId, jobId, count);
        }
    }

    /// @dev Calls `giveFeedback` with exactly `feedbackGasLimit` gas and emits the outcome.
    function _giveFeedback(
        uint256 jobId,
        uint256 agentId,
        bool completed,
        string memory feedbackURI,
        bytes32 feedbackHash
    ) internal returns (bool ok) {
        int128 value = completed ? VALUE_COMPLETED : VALUE_REJECTED;
        bytes memory callData = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (agentId, value, 0, TAG1, completed ? TAG_COMPLETED : TAG_REJECTED, "", feedbackURI, feedbackHash)
        );
        bytes memory reason;
        (ok, reason) = _callReputationRegistry(callData);
        if (ok) emit FeedbackWritten(jobId, agentId, value);
        else emit FeedbackFailed(jobId, reason);
    }

    /// @dev Low-level call to the Reputation Registry forwarding exactly `feedbackGasLimit`: reverts
    ///      with `InsufficientGasForFeedback` first if `gasleft()` could not cover the full cap under
    ///      EIP-150 plus `FEEDBACK_CALL_RESERVE` (whatever the size of the payload encoded before).
    ///      Copies at most `MAX_REASON_LENGTH` bytes of revert data and nothing on success.
    function _callReputationRegistry(bytes memory callData) internal returns (bool ok, bytes memory reason) {
        uint256 gasCap = feedbackGasLimit;
        _requireGas(_feedbackCallRequirement(gasCap));
        address registry = reputationRegistry;
        uint256 maxReason = MAX_REASON_LENGTH;
        assembly ("memory-safe") {
            ok := call(gasCap, registry, 0, add(callData, 0x20), mload(callData), 0x00, 0x00)
            if iszero(ok) {
                let size := returndatasize()
                if gt(size, maxReason) { size := maxReason }
                reason := mload(0x40)
                mstore(reason, size)
                returndatacopy(add(reason, 0x20), 0x00, size)
                mstore(0x40, add(add(reason, 0x20), and(add(size, 0x1f), not(0x1f))))
            }
        }
    }

    /// @dev True when `ownerOf(agentId)` or `getAgentWallet(agentId)` on the Identity Registry equals
    ///      `provider`. Gas-capped static calls with strict decoding: a revert (unknown id), no code,
    ///      running out of the cap, empty or malformed return data simply yields `false` and can
    ///      never revert `submit`.
    function _agentBelongsTo(uint256 agentId, address provider) internal view returns (bool) {
        return _identityReturns(abi.encodeCall(IIdentityRegistry.ownerOf, (agentId)), provider)
            || _identityReturns(abi.encodeCall(IIdentityRegistry.getAgentWallet, (agentId)), provider);
    }

    /// @dev Static call to the Identity Registry with `identityCallGasLimit` gas; true only when it
    ///      succeeded and returned exactly one word equal to `expected`. At most 32 bytes of return
    ///      data are copied (into scratch space).
    function _identityReturns(bytes memory callData, address expected) internal view returns (bool matched) {
        address registry = identityRegistry;
        uint256 gasCap = identityCallGasLimit;
        uint256 want = uint256(uint160(expected));
        assembly ("memory-safe") {
            let ok := staticcall(gasCap, registry, add(callData, 0x20), mload(callData), 0x00, 0x20)
            matched := and(ok, and(eq(returndatasize(), 0x20), eq(mload(0x00), want)))
        }
    }

    /// @dev Reverts with `InsufficientGasForFeedback` when `gasleft() < required`.
    function _requireGas(uint256 required) internal view {
        uint256 available = gasleft();
        if (available < required) revert InsufficientGasForFeedback(available, required);
    }

    /// @dev `gasleft()` needed right before the `giveFeedback` call so it receives `gasCap` in full:
    ///      under EIP-150 a CALL forwards at most `avail - avail / 64`, which is >= `gasCap` once
    ///      `avail >= gasCap + gasCap / 63 + 1`; `FEEDBACK_CALL_RESERVE` covers the CALL itself and
    ///      the work after it.
    function _feedbackCallRequirement(uint256 gasCap) internal pure returns (uint256) {
        return gasCap + gasCap / 63 + 1 + FEEDBACK_CALL_RESERVE;
    }

    // =========================================================================
    // ERC-165
    // =========================================================================

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
