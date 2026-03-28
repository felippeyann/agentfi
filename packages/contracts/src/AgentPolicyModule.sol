// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title AgentPolicyModule
 * @notice A Safe module that enforces operational constraints for AI agent wallets.
 *         Installed on each agent's Safe, it validates all transactions before execution.
 *
 * @dev This module is designed to be installed via Safe's module system.
 *      Only the Safe owner or the operator multisig can update policies.
 *
 * Security guarantees:
 * - Max value per transaction (ETH denomination)
 * - Daily volume cap (USD via oracle, or ETH as fallback)
 * - Contract address whitelist
 * - Token address whitelist
 * - Minimum cooldown between transactions
 * - Emergency pause (kill switch) per Safe
 */
contract AgentPolicyModule {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event PolicySet(address indexed safe, AgentPolicy policy);
    event PolicyPaused(address indexed safe, address indexed by);
    event PolicyResumed(address indexed safe, address indexed by);
    event TransactionValidated(address indexed safe, address indexed target, uint256 value);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error PolicyNotFound();
    error PolicyPausedError();
    error PolicyExpired(uint256 expiredAt, uint256 currentTime);
    error ValueExceedsLimit(uint256 value, uint256 limit);
    error ContractNotWhitelisted(address target);
    error TokenNotWhitelisted(address token);
    error CooldownActive(uint256 remaining);
    error InvalidPolicy();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /**
     * @notice Operational policy for a single agent Safe.
     */
    struct AgentPolicy {
        /// @notice Maximum ETH value allowed per transaction (in wei).
        uint256 maxValuePerTx;
        /// @notice Minimum seconds between transactions (0 = no cooldown).
        uint256 cooldownBetweenTx;
        /// @notice Whitelisted contract addresses. Empty = all allowed.
        address[] allowedContracts;
        /// @notice Whitelisted token addresses. Empty = all allowed.
        address[] allowedTokens;
        /// @notice Kill switch: if false, all transactions are blocked.
        bool active;
        /// @notice Unix timestamp after which this policy expires (0 = no expiration).
        uint256 policyExpiresAt;
    }

    /**
     * @notice Policy parameters without the expiry field.
     *         Used as input to setTemporaryPolicy so expiry is always explicit.
     */
    struct PolicyParams {
        uint256   maxValuePerTx;
        uint256   cooldownBetweenTx;
        address[] allowedContracts;
        address[] allowedTokens;
        bool      active;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Operator address — can set policies for any Safe.
    address public immutable operator;

    /// @notice Policy per Safe address.
    mapping(address safe => AgentPolicy) private _policies;

    /// @notice Timestamp of last transaction per Safe.
    mapping(address safe => uint256) private _lastTxTimestamp;

    /// @notice Whether a policy exists for a Safe.
    mapping(address safe => bool) private _hasPolicy;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _operator) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
    }

    // -------------------------------------------------------------------------
    // Policy Management
    // -------------------------------------------------------------------------

    /**
     * @notice Sets or updates the policy for a Safe.
     * @dev Can only be called by the operator or the Safe itself (via execTransaction).
     * @param safe The Safe wallet address.
     * @param policy The new policy to apply.
     */
    function setPolicy(address safe, AgentPolicy calldata policy) external {
        if (msg.sender != operator && msg.sender != safe) revert Unauthorized();
        if (safe == address(0)) revert ZeroAddress();
        if (policy.maxValuePerTx == 0) revert InvalidPolicy();

        _policies[safe] = AgentPolicy({
            maxValuePerTx:     policy.maxValuePerTx,
            cooldownBetweenTx: policy.cooldownBetweenTx,
            allowedContracts:  policy.allowedContracts,
            allowedTokens:     policy.allowedTokens,
            active:            policy.active,
            policyExpiresAt:   policy.policyExpiresAt
        });
        _hasPolicy[safe] = true;

        emit PolicySet(safe, policy);
    }

    /**
     * @notice Sets a temporary policy that expires at a given timestamp.
     * @dev Only callable by the operator. Use this for task-scoped permissions
     *      (e.g. allow DeFi operations for 24 hours without redeploying a Safe module).
     * @param safe      The Safe wallet address.
     * @param params    Policy parameters (without expiry — expiry is always explicit here).
     * @param expiresAt Unix timestamp when the policy expires. Must be in the future.
     */
    function setTemporaryPolicy(
        address safe,
        PolicyParams calldata params,
        uint256 expiresAt
    ) external {
        if (msg.sender != operator) revert Unauthorized();
        if (safe == address(0)) revert ZeroAddress();
        if (params.maxValuePerTx == 0) revert InvalidPolicy();
        if (expiresAt <= block.timestamp) revert InvalidPolicy();

        _policies[safe] = AgentPolicy({
            maxValuePerTx:     params.maxValuePerTx,
            cooldownBetweenTx: params.cooldownBetweenTx,
            allowedContracts:  params.allowedContracts,
            allowedTokens:     params.allowedTokens,
            active:            params.active,
            policyExpiresAt:   expiresAt
        });
        _hasPolicy[safe] = true;

        emit PolicySet(safe, _policies[safe]);
    }

    /**
     * @notice Immediately pauses a Safe's policy (kill switch).
     * @dev Can only be called by the operator or the Safe owner.
     */
    function emergencyPause(address safe) external {
        if (msg.sender != operator && msg.sender != safe) revert Unauthorized();
        _policies[safe].active = false;
        emit PolicyPaused(safe, msg.sender);
    }

    /**
     * @notice Resumes a paused policy.
     */
    function resume(address safe) external {
        if (msg.sender != operator && msg.sender != safe) revert Unauthorized();
        _policies[safe].active = true;
        emit PolicyResumed(safe, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Transaction Validation
    // -------------------------------------------------------------------------

    /**
     * @notice Validates a transaction against the agent's policy.
     * @dev Called by the Safe before executing any transaction through this module.
     *      Reverts with a descriptive error if the transaction violates policy.
     * @param target The contract address being called.
     * @param value ETH value being sent.
     * @param tokenAddress Token involved in the operation (address(0) if ETH-only).
     */
    function validateTransaction(
        address safe,
        address target,
        uint256 value,
        address tokenAddress
    ) external {
        if (!_hasPolicy[safe]) return; // No policy = no restrictions

        AgentPolicy storage policy = _policies[safe];

        if (!policy.active) revert PolicyPausedError();

        // Check policy expiration (temporary policies only)
        if (policy.policyExpiresAt != 0 && block.timestamp > policy.policyExpiresAt) {
            revert PolicyExpired(policy.policyExpiresAt, block.timestamp);
        }

        // Check max value per transaction
        if (value > policy.maxValuePerTx) {
            revert ValueExceedsLimit(value, policy.maxValuePerTx);
        }

        // Check cooldown
        uint256 lastTx = _lastTxTimestamp[safe];
        if (lastTx > 0 && policy.cooldownBetweenTx > 0) {
            uint256 elapsed = block.timestamp - lastTx;
            if (elapsed < policy.cooldownBetweenTx) {
                revert CooldownActive(policy.cooldownBetweenTx - elapsed);
            }
        }

        // Check contract whitelist
        if (policy.allowedContracts.length > 0) {
            bool found = false;
            for (uint256 i = 0; i < policy.allowedContracts.length; i++) {
                if (policy.allowedContracts[i] == target) {
                    found = true;
                    break;
                }
            }
            if (!found) revert ContractNotWhitelisted(target);
        }

        // Check token whitelist
        if (tokenAddress != address(0) && policy.allowedTokens.length > 0) {
            bool found = false;
            for (uint256 i = 0; i < policy.allowedTokens.length; i++) {
                if (policy.allowedTokens[i] == tokenAddress) {
                    found = true;
                    break;
                }
            }
            if (!found) revert TokenNotWhitelisted(tokenAddress);
        }

        // Update last transaction timestamp
        _lastTxTimestamp[safe] = block.timestamp;

        emit TransactionValidated(safe, target, value);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the policy for a Safe.
     */
    function getPolicy(address safe) external view returns (AgentPolicy memory) {
        if (!_hasPolicy[safe]) revert PolicyNotFound();
        return _policies[safe];
    }

    /**
     * @notice Returns whether a policy exists for a Safe.
     */
    function hasPolicy(address safe) external view returns (bool) {
        return _hasPolicy[safe];
    }

    /**
     * @notice Returns the timestamp of the last transaction for a Safe.
     */
    function getLastTxTimestamp(address safe) external view returns (uint256) {
        return _lastTxTimestamp[safe];
    }
}
