// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/**
 * @title EscrowModule
 * @notice Holds funds in escrow for A2A job payments. Requester locks collateral
 *         when creating a job; on completion the operator releases funds to the
 *         provider; on failure/cancellation funds return to the requester.
 *
 * Design goals:
 *   - Funds are custodied on-chain, not in a database.
 *   - Only the operator can release or refund (mirrors AgentPolicyModule's trust model).
 *   - Supports both native ETH and ERC-20 tokens.
 *   - Each escrow is identified by a unique bytes32 jobId.
 *   - Emergency withdraw by operator for stuck funds.
 *
 * Lifecycle:
 *   lock()    → LOCKED      Requester deposits funds
 *   release() → RELEASED    Operator sends funds to provider
 *   refund()  → REFUNDED    Operator returns funds to requester
 */
contract EscrowModule {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event EscrowLocked(bytes32 indexed jobId, address indexed requester, address token, uint256 amount);
    event EscrowReleased(bytes32 indexed jobId, address indexed provider, address token, uint256 amount);
    event EscrowRefunded(bytes32 indexed jobId, address indexed requester, address token, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error EscrowAlreadyExists(bytes32 jobId);
    error EscrowNotFound(bytes32 jobId);
    error EscrowNotLocked(bytes32 jobId);
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();
    error InsufficientValue(uint256 sent, uint256 required);

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum EscrowStatus { NONE, LOCKED, RELEASED, REFUNDED }

    struct Escrow {
        address requester;
        address provider;
        address token;      // address(0) for native ETH
        uint256 amount;
        EscrowStatus status;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public immutable operator;

    mapping(bytes32 jobId => Escrow) private _escrows;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _operator) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
    }

    // -------------------------------------------------------------------------
    // Lock — requester deposits funds
    // -------------------------------------------------------------------------

    /**
     * @notice Lock funds in escrow for a job. For ETH, send exact amount as msg.value.
     *         For ERC-20, approve this contract first, then call with token address.
     * @param jobId Unique identifier for the A2A job.
     * @param provider Address that receives funds on release.
     * @param token Token address (address(0) for native ETH).
     * @param amount Amount to escrow.
     */
    function lock(
        bytes32 jobId,
        address provider,
        address token,
        uint256 amount
    ) external payable {
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_escrows[jobId].status != EscrowStatus.NONE) revert EscrowAlreadyExists(jobId);

        if (token == address(0)) {
            if (msg.value < amount) revert InsufficientValue(msg.value, amount);
        } else {
            bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
            if (!ok) revert TransferFailed();
        }

        // Effects before interactions (CEI pattern — prevents reentrancy)
        _escrows[jobId] = Escrow({
            requester: msg.sender,
            provider: provider,
            token: token,
            amount: amount,
            status: EscrowStatus.LOCKED
        });

        emit EscrowLocked(jobId, msg.sender, token, amount);

        // Refund excess ETH after state is committed
        if (token == address(0) && msg.value > amount) {
            (bool ok, ) = msg.sender.call{value: msg.value - amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    // -------------------------------------------------------------------------
    // Release — operator sends funds to provider
    // -------------------------------------------------------------------------

    /**
     * @notice Release escrowed funds to the provider. Only callable by operator.
     * @param jobId The job whose escrow to release.
     */
    function release(bytes32 jobId) external {
        if (msg.sender != operator) revert Unauthorized();

        Escrow storage escrow = _escrows[jobId];
        if (escrow.status == EscrowStatus.NONE) revert EscrowNotFound(jobId);
        if (escrow.status != EscrowStatus.LOCKED) revert EscrowNotLocked(jobId);

        escrow.status = EscrowStatus.RELEASED;

        _transfer(escrow.token, escrow.provider, escrow.amount);

        emit EscrowReleased(jobId, escrow.provider, escrow.token, escrow.amount);
    }

    // -------------------------------------------------------------------------
    // Refund — operator returns funds to requester
    // -------------------------------------------------------------------------

    /**
     * @notice Refund escrowed funds to the requester. Only callable by operator.
     * @param jobId The job whose escrow to refund.
     */
    function refund(bytes32 jobId) external {
        if (msg.sender != operator) revert Unauthorized();

        Escrow storage escrow = _escrows[jobId];
        if (escrow.status == EscrowStatus.NONE) revert EscrowNotFound(jobId);
        if (escrow.status != EscrowStatus.LOCKED) revert EscrowNotLocked(jobId);

        escrow.status = EscrowStatus.REFUNDED;

        _transfer(escrow.token, escrow.requester, escrow.amount);

        emit EscrowRefunded(jobId, escrow.requester, escrow.token, escrow.amount);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    function getEscrow(bytes32 jobId) external view returns (Escrow memory) {
        return _escrows[jobId];
    }

    function getEscrowStatus(bytes32 jobId) external view returns (EscrowStatus) {
        return _escrows[jobId].status;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _transfer(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            bool ok = IERC20(token).transfer(to, amount);
            if (!ok) revert TransferFailed();
        }
    }

    receive() external payable {}
}
