// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {IACPHook} from "./IACPHook.sol";

/**
 * @title AgentJobEscrow
 * @notice ERC-8183 (Agentic Commerce) job escrow for AgentFi: a client funds a job in a single
 *         ERC-20 token, a provider submits a deliverable, and an evaluator decides whether the
 *         budget is released to the provider or refunded to the client.
 *
 * @dev The ERC-8183 surface (types, events, functions, transitions and hook data encoding) is
 *      implemented verbatim from the published EIP text (2026-03-13 revision) so third-party
 *      tooling and indexers work unchanged. AgentFi-specific extensions are grouped in their own
 *      section at the end of the contract and never alter the standard semantics.
 *
 *      State machine (the only valid transitions):
 *        Open      → Funded     client `fund`
 *        Open      → Rejected   client `reject`
 *        Funded    → Submitted  provider `submit`
 *        Funded    → Rejected   evaluator `reject` (full refund)
 *        Submitted → Completed  evaluator `complete` (payment released minus fees)
 *        Submitted → Rejected   evaluator `reject` (full refund)
 *        Funded    → Expired    anyone `claimRefund` once `block.timestamp >= expiredAt` (full refund)
 *        Submitted → Expired    anyone `claimRefund` once `block.timestamp >= expiredAt` (full refund)
 *
 *      Funding: one ERC-20 token per contract (USDC), pulled with `transferFrom` in `fund`.
 *      Fee-on-transfer tokens are rejected (the received amount must equal the budget).
 *      Native ETH is not supported by the standard; legacy ETH jobs stay on `EscrowModule`.
 *
 *      Fees: on `complete` the provider receives `budget - platformFee - evaluatorFee`, where
 *      `platformFee = budget * platformFeeBP / 10_000` goes to `feeWallet` and
 *      `evaluatorFee = budget * evaluatorFeeBP / 10_000` goes to the evaluator. Both bps are
 *      immutable and their sum is below 10_000. No fee is taken on rejection or expiry.
 *
 *      Hooks: one optional `IACPHook` per job, fixed at `createJob` and checked via ERC-165.
 *      `beforeAction` runs before the state change and `afterAction` after the transfers for
 *      exactly `setProvider`, `setBudget`, `fund`, `submit`, `complete` and `reject`.
 *      `claimRefund` is never hooked.
 *
 *      Security: every state-changing function is non-reentrant; token transfers tolerate
 *      missing or `false` return values; the operator can only pause job creation and funding
 *      (never settlement or refunds) and can never move funds.
 */
contract AgentJobEscrow {
    // =========================================================================
    // ERC-8183 — types
    // =========================================================================

    /// @notice Lifecycle status of a job, as defined by ERC-8183.
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    /// @notice On-chain job record, as defined by ERC-8183.
    struct Job {
        /// @notice Sequential job id (starts at 1; 0 is never a valid job).
        uint256 id;
        /// @notice Address that created and funds the job.
        address client;
        /// @notice Address that delivers the work and receives the payment. May be zero until `setProvider`.
        address provider;
        /// @notice Address that decides after submission (may equal the client; never zero).
        address evaluator;
        /// @notice Free-form description or URI/hash of the off-chain task payload.
        string description;
        /// @notice Amount of `token` escrowed on `fund`; proposed via `setBudget` while Open.
        uint256 budget;
        /// @notice Unix timestamp from which `claimRefund` becomes available for Funded/Submitted jobs.
        uint256 expiredAt;
        /// @notice Current status.
        JobStatus status;
        /// @notice Optional `IACPHook` fixed at creation (zero for none).
        address hook;
    }

    // =========================================================================
    // ERC-8183 — events (verbatim)
    // =========================================================================

    /// @notice Emitted when a job is created.
    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    /// @notice Emitted when the client sets or changes the provider while the job is Open.
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    /// @notice Emitted when the client or provider sets the budget while the job is Open.
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    /// @notice Emitted when the client funds the job (Open → Funded).
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    /// @notice Emitted when the provider submits a deliverable (Funded → Submitted).
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    /// @notice Emitted when the evaluator accepts the deliverable (Submitted → Completed).
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    /// @notice Emitted when the job is rejected by the client (Open) or the evaluator (Funded/Submitted).
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    /// @notice Emitted when a Funded/Submitted job is expired through `claimRefund`.
    event JobExpired(uint256 indexed jobId);
    /// @notice Emitted when the provider is paid on completion (net of fees).
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    /// @notice Emitted when a non-zero evaluator fee is paid on completion.
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    /// @notice Emitted when the client is refunded in full (rejection after funding, or expiry).
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    // =========================================================================
    // AgentFi extension — events
    // =========================================================================

    /// @notice Emitted when the client attaches an ERC-8004 agent id to the job's provider.
    event ProviderAgentIdSet(uint256 indexed jobId, uint256 indexed agentId);
    /// @notice Emitted when a non-zero platform fee is paid to `feeWallet` on completion.
    event PlatformFeePaid(uint256 indexed jobId, address indexed feeWallet, uint256 amount);
    /// @notice Emitted when the operator pauses job creation and funding.
    event Paused(address indexed by);
    /// @notice Emitted when the operator lifts the pause.
    event Unpaused(address indexed by);

    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice A required address argument was zero.
    error ZeroAddress();
    /// @notice The token address has no code.
    error NotAContract(address account);
    /// @notice `platformFeeBP + evaluatorFeeBP` must be below 10_000.
    error InvalidFees(uint256 platformFeeBP, uint256 evaluatorFeeBP);
    /// @notice No job exists with this id.
    error JobNotFound(uint256 jobId);
    /// @notice The action is not allowed in the job's current status.
    error InvalidStatus(uint256 jobId, JobStatus status);
    /// @notice The caller does not hold the role required for this action.
    error Unauthorized();
    /// @notice The provider is zero, equal to the client, or equal to the evaluator.
    error InvalidProvider(address provider);
    /// @notice The evaluator must be a non-zero address.
    error InvalidEvaluator();
    /// @notice `expiredAt` must be strictly in the future at creation.
    error InvalidExpiry(uint256 expiredAt);
    /// @notice `fund` requires a provider to be set.
    error ProviderNotSet(uint256 jobId);
    /// @notice `fund` requires a non-zero budget.
    error ZeroBudget(uint256 jobId);
    /// @notice `fund` front-running guard: the stored budget differs from `expectedBudget`.
    error BudgetMismatch(uint256 expected, uint256 actual);
    /// @notice `fund` is not allowed once `expiredAt` has been reached.
    error FundingWindowClosed(uint256 jobId, uint256 expiredAt);
    /// @notice `claimRefund` is only available once `expiredAt` has been reached.
    error NotExpired(uint256 jobId, uint256 expiredAt);
    /// @notice The hook does not advertise `IACPHook` via ERC-165.
    error UnsupportedHook(address hook);
    /// @notice An ERC-20 transfer reverted or returned `false`.
    error TransferFailed();
    /// @notice The amount received on `fund` differs from the budget (fee-on-transfer token).
    error FeeOnTransferNotSupported(uint256 expected, uint256 received);
    /// @notice A state-changing function was re-entered.
    error ReentrantCall();
    /// @notice Job creation and funding are paused by the operator.
    error EnforcedPause();
    /// @notice `unpause` was called while not paused.
    error ExpectedPause();

    // =========================================================================
    // Constants and immutables
    // =========================================================================

    /// @dev Basis-point denominator for fee math.
    uint256 private constant BPS_DENOMINATOR = 10_000;
    /// @dev Gas cap for the ERC-165 probe at `createJob` (EIP-165 recommends <= 30_000).
    uint256 private constant ERC165_GAS = 30_000;
    /// @dev Reentrancy guard states.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /// @notice The single ERC-20 token this escrow accepts (USDC on Base).
    address public immutable token;
    /// @notice Receiver of the platform fee on completion.
    address public immutable feeWallet;
    /// @notice Address allowed to pause/unpause job creation and funding. Cannot move funds.
    address public immutable operator;
    /// @notice Platform fee in basis points, taken from the budget on completion only.
    uint256 public immutable platformFeeBP;
    /// @notice Evaluator fee in basis points, taken from the budget on completion only.
    uint256 public immutable evaluatorFeeBP;

    // =========================================================================
    // State
    // =========================================================================

    /// @dev Number of jobs created; also the id of the last job.
    uint256 private _jobCount;
    /// @dev Job records by id.
    mapping(uint256 jobId => Job) private _jobs;
    /// @notice AgentFi extension: ERC-8004 agent id of the provider, set by the client (0 = none).
    mapping(uint256 jobId => uint256 agentId) public providerAgentId;
    /// @notice AgentFi extension: timestamp of `submit` (0 = the job was never submitted).
    mapping(uint256 jobId => uint256 timestamp) public submittedAt;
    /// @notice AgentFi extension: whether job creation and funding are paused.
    bool public paused;
    /// @dev Reentrancy guard.
    uint256 private _reentrancyStatus = NOT_ENTERED;

    // =========================================================================
    // Modifiers
    // =========================================================================

    /// @dev Simple single-entry reentrancy guard shared by all state-changing functions.
    modifier nonReentrant() {
        if (_reentrancyStatus == ENTERED) revert ReentrantCall();
        _reentrancyStatus = ENTERED;
        _;
        _reentrancyStatus = NOT_ENTERED;
    }

    /// @dev Blocks the action while paused. Applied to `createJob` and `fund` only.
    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @param token_ ERC-20 token escrowed by this contract (must have code).
     * @param feeWallet_ Receiver of the platform fee.
     * @param operator_ Address that may pause/unpause creation and funding.
     * @param evaluatorFeeBP_ Evaluator fee in basis points (AgentFi default 0).
     * @param platformFeeBP_ Platform fee in basis points (AgentFi default 30).
     */
    constructor(
        address token_,
        address feeWallet_,
        address operator_,
        uint256 evaluatorFeeBP_,
        uint256 platformFeeBP_
    ) {
        if (token_ == address(0) || feeWallet_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        if (token_.code.length == 0) revert NotAContract(token_);
        if (platformFeeBP_ + evaluatorFeeBP_ >= BPS_DENOMINATOR) revert InvalidFees(platformFeeBP_, evaluatorFeeBP_);

        token = token_;
        feeWallet = feeWallet_;
        operator = operator_;
        evaluatorFeeBP = evaluatorFeeBP_;
        platformFeeBP = platformFeeBP_;
    }

    // =========================================================================
    // ERC-8183 — job lifecycle
    // =========================================================================

    /**
     * @notice Creates a job in `Open` status. `msg.sender` becomes the client.
     * @dev Not hookable. Reverts while paused.
     * @param provider Provider address, or zero to set later with `setProvider`.
     * @param evaluator Evaluator address (non-zero; may equal the client).
     * @param expiredAt Unix timestamp (strictly in the future) from which `claimRefund` is available.
     * @param description Free-form description or URI/hash of the off-chain task payload.
     * @param hook Optional `IACPHook` (must support ERC-165 for `IACPHook`), or zero.
     * @return jobId The new job id (sequential, starting at 1).
     */
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        if (evaluator == address(0)) revert InvalidEvaluator();
        if (provider != address(0) && (provider == msg.sender || provider == evaluator)) {
            revert InvalidProvider(provider);
        }
        if (expiredAt <= block.timestamp) revert InvalidExpiry(expiredAt);
        if (hook != address(0) && !_supportsHookInterface(hook)) revert UnsupportedHook(hook);

        jobId = ++_jobCount;
        _jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: hook
        });

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    /**
     * @notice Sets the provider of an `Open` job. Only the client may call.
     * @dev Hook data: `abi.encode(address provider, bytes optParams)` with empty optParams.
     * @param jobId The job.
     * @param provider_ New provider (non-zero, not the client, not the evaluator).
     */
    function setProvider(uint256 jobId, address provider_) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open) revert InvalidStatus(jobId, job.status);
        if (msg.sender != job.client) revert Unauthorized();
        if (provider_ == address(0) || provider_ == job.client || provider_ == job.evaluator) {
            revert InvalidProvider(provider_);
        }

        bytes memory data = abi.encode(provider_, bytes(""));
        _hookBefore(job.hook, jobId, this.setProvider.selector, data);

        job.provider = provider_;
        emit ProviderSet(jobId, provider_);

        _hookAfter(job.hook, jobId, this.setProvider.selector, data);
    }

    /**
     * @notice Sets the budget of an `Open` job. The client or the provider may call.
     * @dev Hook data: `abi.encode(uint256 amount, bytes optParams)`. A zero amount is accepted
     *      here but `fund` requires a non-zero budget.
     * @param jobId The job.
     * @param amount Budget in `token` units.
     * @param optParams Opaque parameters forwarded to the hook.
     */
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open) revert InvalidStatus(jobId, job.status);
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();

        bytes memory data = abi.encode(amount, optParams);
        _hookBefore(job.hook, jobId, this.setBudget.selector, data);

        job.budget = amount;
        emit BudgetSet(jobId, amount);

        _hookAfter(job.hook, jobId, this.setBudget.selector, data);
    }

    /**
     * @notice Funds an `Open` job: pulls `budget` of `token` from the client (Open → Funded).
     * @dev Front-running guard: reverts unless `job.budget == expectedBudget`. Requires a provider,
     *      a non-zero budget and `block.timestamp < expiredAt`. Fee-on-transfer tokens are rejected.
     *      Hook data: `optParams` as given. Reverts while paused.
     * @param jobId The job.
     * @param expectedBudget The budget the client agreed to.
     * @param optParams Opaque parameters forwarded to the hook.
     */
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant whenNotPaused {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open) revert InvalidStatus(jobId, job.status);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet(jobId);
        uint256 budget = job.budget;
        if (budget == 0) revert ZeroBudget(jobId);
        if (budget != expectedBudget) revert BudgetMismatch(expectedBudget, budget);
        if (block.timestamp >= job.expiredAt) revert FundingWindowClosed(jobId, job.expiredAt);

        _hookBefore(job.hook, jobId, this.fund.selector, optParams);

        job.status = JobStatus.Funded;
        emit JobFunded(jobId, msg.sender, budget);

        _pullExact(msg.sender, budget);

        _hookAfter(job.hook, jobId, this.fund.selector, optParams);
    }

    /**
     * @notice Submits a deliverable for a `Funded` job (Funded → Submitted). Only the provider may call.
     * @dev Hook data: `abi.encode(bytes32 deliverable, bytes optParams)`. Records `submittedAt`.
     * @param jobId The job.
     * @param deliverable Hash or identifier of the delivered work.
     * @param optParams Opaque parameters forwarded to the hook.
     */
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Funded) revert InvalidStatus(jobId, job.status);
        if (msg.sender != job.provider) revert Unauthorized();

        bytes memory data = abi.encode(deliverable, optParams);
        _hookBefore(job.hook, jobId, this.submit.selector, data);

        job.status = JobStatus.Submitted;
        submittedAt[jobId] = block.timestamp;
        emit JobSubmitted(jobId, msg.sender, deliverable);

        _hookAfter(job.hook, jobId, this.submit.selector, data);
    }

    /**
     * @notice Accepts a `Submitted` job (Submitted → Completed) and releases the budget. Only the evaluator may call.
     * @dev Pays `budget - platformFee - evaluatorFee` to the provider, `platformFee` to `feeWallet`
     *      and `evaluatorFee` to the evaluator. Hook data: `abi.encode(bytes32 reason, bytes optParams)`.
     * @param jobId The job.
     * @param reason Hash of the human-readable reason.
     * @param optParams Opaque parameters forwarded to the hook (AgentFi: feedback URI and hash).
     */
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Submitted) revert InvalidStatus(jobId, job.status);
        if (msg.sender != job.evaluator) revert Unauthorized();

        bytes memory data = abi.encode(reason, optParams);
        _hookBefore(job.hook, jobId, this.complete.selector, data);

        job.status = JobStatus.Completed;
        emit JobCompleted(jobId, msg.sender, reason);

        uint256 budget = job.budget;
        uint256 platformFee = (budget * platformFeeBP) / BPS_DENOMINATOR;
        uint256 evaluatorFee = (budget * evaluatorFeeBP) / BPS_DENOMINATOR;
        uint256 payout = budget - platformFee - evaluatorFee;

        _safeTransfer(job.provider, payout);
        emit PaymentReleased(jobId, job.provider, payout);

        if (platformFee > 0) {
            _safeTransfer(feeWallet, platformFee);
            emit PlatformFeePaid(jobId, feeWallet, platformFee);
        }
        if (evaluatorFee > 0) {
            _safeTransfer(job.evaluator, evaluatorFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evaluatorFee);
        }

        _hookAfter(job.hook, jobId, this.complete.selector, data);
    }

    /**
     * @notice Rejects a job. The client may reject while `Open` (no funds involved); the evaluator
     *         may reject while `Funded` or `Submitted`, which refunds the client in full.
     * @dev Hook data: `abi.encode(bytes32 reason, bytes optParams)`.
     * @param jobId The job.
     * @param reason Hash of the human-readable reason.
     * @param optParams Opaque parameters forwarded to the hook (AgentFi: feedback URI and hash).
     */
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _getJob(jobId);
        JobStatus status = job.status;
        if (status == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (status == JobStatus.Funded || status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert InvalidStatus(jobId, status);
        }

        bytes memory data = abi.encode(reason, optParams);
        _hookBefore(job.hook, jobId, this.reject.selector, data);

        job.status = JobStatus.Rejected;
        emit JobRejected(jobId, msg.sender, reason);

        if (status != JobStatus.Open) {
            uint256 amount = job.budget;
            _safeTransfer(job.client, amount);
            emit Refunded(jobId, job.client, amount);
        }

        _hookAfter(job.hook, jobId, this.reject.selector, data);
    }

    /**
     * @notice Expires a `Funded` or `Submitted` job once `block.timestamp >= expiredAt` and refunds
     *         the client in full. Anyone may call. Never hooked and never pausable.
     * @param jobId The job.
     */
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        JobStatus status = job.status;
        if (status != JobStatus.Funded && status != JobStatus.Submitted) revert InvalidStatus(jobId, status);
        if (block.timestamp < job.expiredAt) revert NotExpired(jobId, job.expiredAt);

        job.status = JobStatus.Expired;
        emit JobExpired(jobId);

        uint256 amount = job.budget;
        _safeTransfer(job.client, amount);
        emit Refunded(jobId, job.client, amount);
    }

    /**
     * @notice Returns the job record. Unknown ids return an empty struct (`client == address(0)`).
     * @param jobId The job.
     */
    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // =========================================================================
    // AgentFi extension — outside the ERC-8183 surface
    // =========================================================================

    /**
     * @notice Attaches the provider's ERC-8004 agent id to a job so settlement outcomes can be
     *         attributed to an on-chain identity (read by `ReputationHook`). Only the client may
     *         call, while the job is `Open` or `Funded`. Not hooked.
     * @param jobId The job.
     * @param agentId ERC-8004 identity id (0 clears it).
     */
    function setProviderAgentId(uint256 jobId, uint256 agentId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open && job.status != JobStatus.Funded) revert InvalidStatus(jobId, job.status);
        if (msg.sender != job.client) revert Unauthorized();

        providerAgentId[jobId] = agentId;
        emit ProviderAgentIdSet(jobId, agentId);
    }

    /**
     * @notice Pauses `createJob` and `fund`. Settlement (`submit`, `complete`, `reject`) and
     *         refunds (`claimRefund`) are never affected. Only the operator may call.
     */
    function pause() external {
        if (msg.sender != operator) revert Unauthorized();
        if (paused) revert EnforcedPause();
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Lifts the pause. Only the operator may call.
     */
    function unpause() external {
        if (msg.sender != operator) revert Unauthorized();
        if (!paused) revert ExpectedPause();
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Number of jobs created so far. Job ids run from 1 to `jobCount()`.
     */
    function jobCount() external view returns (uint256) {
        return _jobCount;
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /// @dev Returns the storage record of an existing job or reverts with `JobNotFound`.
    function _getJob(uint256 jobId) internal view returns (Job storage job) {
        job = _jobs[jobId];
        if (job.client == address(0)) revert JobNotFound(jobId);
    }

    /// @dev Calls `beforeAction` on the hook, if any.
    function _hookBefore(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook != address(0)) IACPHook(hook).beforeAction(jobId, selector, data);
    }

    /// @dev Calls `afterAction` on the hook, if any.
    function _hookAfter(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook != address(0)) IACPHook(hook).afterAction(jobId, selector, data);
    }

    /// @dev ERC-165 probe for `IACPHook`, tolerant of EOAs and contracts without `supportsInterface`.
    function _supportsHookInterface(address hook) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            hook.staticcall{gas: ERC165_GAS}(abi.encodeCall(IERC165.supportsInterface, (type(IACPHook).interfaceId)));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    /// @dev Pulls exactly `amount` of `token` from `from`; rejects fee-on-transfer behaviour.
    function _pullExact(address from, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        _callToken(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransferNotSupported(amount, received);
    }

    /// @dev Sends `amount` of `token` to `to`, tolerating tokens that return nothing.
    function _safeTransfer(address to, uint256 amount) internal {
        _callToken(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// @dev Low-level token call: reverts on call failure or on an explicit `false` return value.
    function _callToken(bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert TransferFailed();
    }
}
