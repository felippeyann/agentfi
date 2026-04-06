// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentPolicyModule} from "./AgentPolicyModule.sol";

/**
 * @title AgentExecutor
 * @notice Atomic batch executor for AI agent operations.
 *         Collects protocol fees on every execution and forwards them to the fee wallet.
 *
 * Fee model:
 *   - Fee is taken from msg.value on each executeBatch call
 *   - feeBps is set at deploy time (e.g. 30 = 0.30%)
 *   - Fee is forwarded atomically to feeWallet in the same transaction
 *
 * Atomicity guarantee: if any action fails, the entire batch reverts —
 * including the fee transfer, so fees are never collected on failed txs.
 */
contract AgentExecutor {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event BatchExecuted(address indexed caller, uint256 actionCount, uint256 feePaid);
    event ActionExecuted(address indexed target, uint256 value, bool success);
    event FeeCollected(address indexed feeWallet, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ActionFailed(uint256 index, address target, bytes returnData);
    error InvalidActions();
    error ZeroAddress();
    error FeeTransferFailed();
    error InsufficientValueForFee(uint256 sent, uint256 required);

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /**
     * @notice A single action in a batch.
     */
    struct Action {
        address target;
        uint256 value;
        address token; // Optional: token involved in the operation (address(0) for ETH/none)
        bytes   data;
    }

    // -------------------------------------------------------------------------
    // Immutable state
    // -------------------------------------------------------------------------

    AgentPolicyModule public immutable policyModule;

    /// @notice Wallet that receives protocol fees.
    address public immutable feeWallet;

    /// @notice Fee in basis points (e.g. 30 = 0.30%).
    uint256 public immutable feeBps;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _policyModule, address _feeWallet, uint256 _feeBps) {
        if (_policyModule == address(0)) revert ZeroAddress();
        if (_feeWallet    == address(0)) revert ZeroAddress();
        policyModule = AgentPolicyModule(_policyModule);
        feeWallet    = _feeWallet;
        feeBps       = _feeBps;
    }

    // -------------------------------------------------------------------------
    // Fee calculation
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the fee amount for a given gross ETH value.
     */
    function calculateFee(uint256 grossValue) public view returns (uint256) {
        return (grossValue * feeBps) / BPS_DENOMINATOR;
    }

    // -------------------------------------------------------------------------
    // Execution
    // -------------------------------------------------------------------------

    /**
     * @notice Executes a batch of actions atomically, collecting a protocol fee.
     *
     * @dev msg.value must cover the sum of all action values PLUS the fee.
     *      Fee = (total action value * feeBps) / 10000
     *      Fee is forwarded to feeWallet in the same transaction.
     *      If any action fails, entire batch reverts including fee transfer.
     *
     * @param actions Array of actions to execute in order.
     */
    function executeBatch(Action[] calldata actions) external payable {
        if (actions.length == 0) revert InvalidActions();

        // Calculate total value being deployed across all actions
        uint256 totalActionValue = 0;
        for (uint256 i = 0; i < actions.length; i++) {
            if (actions[i].target == address(0)) revert ZeroAddress();
            totalActionValue += actions[i].value;
        }

        // Calculate and collect fee on total action value
        uint256 fee = calculateFee(totalActionValue);
        if (msg.value < totalActionValue + fee) {
            revert InsufficientValueForFee(msg.value, totalActionValue + fee);
        }

        // Execute all actions
        for (uint256 i = 0; i < actions.length; i++) {
            Action calldata action = actions[i];

            // Validate against policy if one exists
            if (policyModule.hasPolicy(msg.sender)) {
                policyModule.validateTransaction(msg.sender, action.target, action.value, action.token);
            }

            (bool success, bytes memory returnData) = action.target.call{value: action.value}(
                action.data
            );

            if (!success) revert ActionFailed(i, action.target, returnData);

            emit ActionExecuted(action.target, action.value, true);
        }

        // Forward fee to operator — after all actions succeed
        if (fee > 0) {
            (bool feeOk, ) = feeWallet.call{value: fee}("");
            if (!feeOk) revert FeeTransferFailed();
            emit FeeCollected(feeWallet, fee);
        }

        // Refund any excess ETH to caller
        uint256 excess = msg.value - totalActionValue - fee;
        if (excess > 0) {
            (bool refundOk, ) = msg.sender.call{value: excess}("");
            if (!refundOk) revert FeeTransferFailed();
        }

        emit BatchExecuted(msg.sender, actions.length, fee);
    }

    /**
     * @notice Executes a single action with fee collection.
     */
    function executeSingle(Action calldata action) external payable {
        if (action.target == address(0)) revert ZeroAddress();

        uint256 fee = calculateFee(action.value);
        if (msg.value < action.value + fee) {
            revert InsufficientValueForFee(msg.value, action.value + fee);
        }

        if (policyModule.hasPolicy(msg.sender)) {
            policyModule.validateTransaction(msg.sender, action.target, action.value, action.token);
        }

        (bool success, bytes memory returnData) = action.target.call{value: action.value}(
            action.data
        );
        if (!success) revert ActionFailed(0, action.target, returnData);

        if (fee > 0) {
            (bool feeOk, ) = feeWallet.call{value: fee}("");
            if (!feeOk) revert FeeTransferFailed();
            emit FeeCollected(feeWallet, fee);
        }

        uint256 excess = msg.value - action.value - fee;
        if (excess > 0) {
            (bool refundOk, ) = msg.sender.call{value: excess}("");
            if (!refundOk) revert FeeTransferFailed();
        }

        emit ActionExecuted(action.target, action.value, true);
    }
}
