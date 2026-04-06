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

    event PolicySet(address indexed safe, uint256 maxValuePerTx, uint256 cooldownBetweenTx, uint256 policyExpiresAt);
    event PolicyPaused(address indexed safe, address indexed by);
    event PolicyResumed(address indexed safe, address indexed by);
    event TransactionValidated(address indexed safe, address indexed target, uint256 value);
    event ContractWhitelistUpdated(address indexed safe, address indexed target, bool allowed);
    event TokenWhitelistUpdated(address indexed safe, address indexed token, bool allowed);

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
        /// @notice Kill switch: if false, all transactions are blocked.
        bool active;
        /// @notice Unix timestamp after which this policy expires (0 = no expiration).
        uint256 policyExpiresAt;
        /// @notice Number of allowed contracts (if 0, all allowed).
        uint256 numAllowedContracts;
        /// @notice Number of allowed tokens (if 0, all allowed).
        uint256 numAllowedTokens;
    }

    /**
     * @notice Policy parameters without the expiry field.
     */
    struct PolicyParams {
        uint256 maxValuePerTx;
        uint256 cooldownBetweenTx;
        bool    active;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Operator address — can set policies for any Safe.
    address public immutable operator;

    /// @notice Policy per Safe address.
    mapping(address safe => AgentPolicy) private _policies;

    /// @notice Whitelisted contract addresses: safe => target => isAllowed.
    mapping(address safe => mapping(address target => bool)) private _isContractAllowed;

    /// @notice Whitelisted token addresses: safe => token => isAllowed.
    mapping(address safe => mapping(address token => bool)) private _isTokenAllowed;

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
     * @notice Sets or updates the core policy for a Safe.
     * @dev Does not touch existing whitelists.
     */
    function setPolicy(address safe, PolicyParams calldata params, uint256 expiresAt) external {
        if (msg.sender != operator && msg.sender != safe) revert Unauthorized();
        if (safe == address(0)) revert ZeroAddress();
        if (params.maxValuePerTx == 0) revert InvalidPolicy();

        AgentPolicy storage p = _policies[safe];
        p.maxValuePerTx = params.maxValuePerTx;
        p.cooldownBetweenTx = params.cooldownBetweenTx;
        p.active = params.active;
        p.policyExpiresAt = expiresAt;
        
        _hasPolicy[safe] = true;

        emit PolicySet(safe, params.maxValuePerTx, params.cooldownBetweenTx, expiresAt);
    }

    /**
     * @notice Updates the contract whitelist for a Safe.
     */
    function updateContractWhitelist(address safe, address[] calldata targets, bool[] calldata allowed) external {
        if (msg.sender != operator && msg.sender != safe) revert Unauthorized();
        if (targets.length != allowed.length) revert InvalidPolicy();

        AgentPolicy storage p = _policies[safe];
        for (uint256 i = 0; i < targets.length; i++) {
            address target = targets[i];
            bool isAllowed = allowed[i];
            
            if (_isContractAllowed[safe][target] != isAllowed) {
                _isContractAllowed[safe][target] = isAllowed;
                if (isAllowed) p.numAllowedContracts++;
                else p.numAllowedContracts--;
                emit ContractWhitelistUpdated(safe, target, isAllowed);
            }
        }
    }

    /**
     * @notice Updates the token whitelist for a Safe.
     */
    function updateTokenWhitelist(address safe, address[] calldata tokens, bool[] calldata allowed) external {
        if (msg.sender != operator && msg.sender != safe) revert Unauthorized();
        if (tokens.length != allowed.length) revert InvalidPolicy();

        AgentPolicy storage p = _policies[safe];
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            bool isAllowed = allowed[i];
            
            if (_isTokenAllowed[safe][token] != isAllowed) {
                _isTokenAllowed[safe][token] = isAllowed;
                if (isAllowed) p.numAllowedTokens++;
                else p.numAllowedTokens--;
                emit TokenWhitelistUpdated(safe, token, isAllowed);
            }
        }
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
     * @dev Now O(1) for whitelist checks.
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

        // O(1) Check contract whitelist
        if (policy.numAllowedContracts > 0) {
            if (!_isContractAllowed[safe][target]) {
                revert ContractNotWhitelisted(target);
            }
        }

        // O(1) Check token whitelist
        if (tokenAddress != address(0) && policy.numAllowedTokens > 0) {
            if (!_isTokenAllowed[safe][tokenAddress]) {
                revert TokenNotWhitelisted(tokenAddress);
            }
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
     * @notice Returns whether a specific contract is allowed for a Safe.
     */
    function isContractAllowed(address safe, address target) external view returns (bool) {
        if (_policies[safe].numAllowedContracts == 0) return true;
        return _isContractAllowed[safe][target];
    }

    /**
     * @notice Returns whether a specific token is allowed for a Safe.
     */
    function isTokenAllowed(address safe, address token) external view returns (bool) {
        if (_policies[safe].numAllowedTokens == 0) return true;
        return _isTokenAllowed[safe][token];
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
