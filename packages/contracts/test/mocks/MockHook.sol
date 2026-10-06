// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IACPHook} from "../../src/IACPHook.sol";
import {AgentJobEscrow} from "../../src/AgentJobEscrow.sol";

/// @dev Records every hook call in order, with the job status, a watched token balance, the escrow
///      balance and the accrued platform fees at call time. Can be told to revert in `beforeAction`
///      and/or `afterAction`.
contract MockHook is IACPHook {
    struct Call {
        bool isBefore;
        uint256 jobId;
        bytes4 selector;
        bytes data;
        AgentJobEscrow.JobStatus status;
        uint256 watchedBalance;
        uint256 escrowBalance;
        uint256 pendingFees;
    }

    AgentJobEscrow public immutable escrow;
    IERC20 public immutable token;

    address public watched;
    bool public revertBefore;
    bool public revertAfter;
    Call[] internal _calls;

    error HookRevert(string phase);

    constructor(AgentJobEscrow escrow_, address token_) {
        escrow = escrow_;
        token = IERC20(token_);
    }

    function setWatched(address watched_) external {
        watched = watched_;
    }

    function setRevertBefore(bool v) external {
        revertBefore = v;
    }

    function setRevertAfter(bool v) external {
        revertAfter = v;
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function getCall(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }

    function lastCall() external view returns (Call memory) {
        return _calls[_calls.length - 1];
    }

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external {
        if (revertBefore) revert HookRevert("before");
        _record(true, jobId, selector, data);
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external {
        if (revertAfter) revert HookRevert("after");
        _record(false, jobId, selector, data);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _record(bool isBefore, uint256 jobId, bytes4 selector, bytes calldata data) internal {
        // Field-by-field storage writes keep the stack shallow in unoptimized (coverage) builds.
        Call storage c = _calls.push();
        c.isBefore = isBefore;
        c.jobId = jobId;
        c.selector = selector;
        c.data = data;
        c.status = escrow.getJob(jobId).status;
        c.watchedBalance = watched == address(0) ? 0 : token.balanceOf(watched);
        c.escrowBalance = token.balanceOf(address(escrow));
        c.pendingFees = escrow.pendingPlatformFees();
    }
}

/// @dev Implements the hook functions but denies the interface via ERC-165.
contract NoERC165Hook is IACPHook {
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}

    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
}

/// @dev Implements the hook functions but has no `supportsInterface` at all (cannot inherit
///      `IACPHook`, which now requires it).
contract NoSupportsInterfaceHook {
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}
}

/// @dev Returns a non-boolean word from `supportsInterface` (malformed ERC-165).
contract GarbageERC165Hook {
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}

    function supportsInterface(bytes4) external pure returns (bytes32) {
        return bytes32(uint256(2));
    }
}

/// @dev "Yes-man": claims to support every interface, including `0xffffffff` (invalid per ERC-165).
contract YesManHook is IACPHook {
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @dev Returns two words from `supportsInterface` (oversized return data).
contract WideReturnERC165Hook {
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}

    function supportsInterface(bytes4) external pure returns (bool, bool) {
        return (true, false);
    }
}

/// @dev Returns `true` for `IACPHook` but reverts on the mandatory `0xffffffff` probe.
contract RevertsOnInvalidIdHook is IACPHook {
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        require(interfaceId != 0xffffffff, "unsupported");
        return interfaceId == type(IACPHook).interfaceId;
    }
}

/// @dev Malicious hook: re-enters the escrow with `attackData` from `beforeAction` or `afterAction`
///      (whichever is selected) and records the result instead of bubbling the revert.
contract ReentrantHook is IACPHook {
    address public target;
    bytes public attackData;
    bool public attackInBefore;
    bool public attacked;
    bool public lastReentryOk;
    bytes public lastReentryData;

    function setAttack(address target_, bytes calldata attackData_, bool inBefore) external {
        target = target_;
        attackData = attackData_;
        attackInBefore = inBefore;
        attacked = false;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external {
        if (attackInBefore) _attack();
    }

    function afterAction(uint256, bytes4, bytes calldata) external {
        if (!attackInBefore) _attack();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _attack() internal {
        if (attacked || target == address(0)) return;
        attacked = true;
        (lastReentryOk, lastReentryData) = target.call(attackData);
    }
}
