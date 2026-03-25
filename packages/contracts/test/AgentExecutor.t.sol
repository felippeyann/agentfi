// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

// =============================================================================
// Helper contracts
// =============================================================================

/// @dev Accepts ETH and counts calls.
contract MockTarget {
    uint256 public counter;
    bool    public shouldRevert;

    event Received(address sender, uint256 value);

    function increment() external payable {
        if (shouldRevert) revert("MockTarget: forced revert");
        counter++;
        emit Received(msg.sender, msg.value);
    }

    function setShouldRevert(bool _r) external { shouldRevert = _r; }

    receive() external payable {}
}

/// @dev Rejects all incoming ETH — used to make fee transfer fail.
contract RejectETH {
    receive() external payable { revert("RejectETH: not accepting ETH"); }
    fallback() external payable { revert("RejectETH: not accepting ETH"); }
}

/// @dev Re-entrancy attacker that calls executeBatch again from inside a call.
contract ReentrantTarget {
    AgentExecutor public executor;
    bool public attacked;

    constructor(AgentExecutor _executor) {
        executor = _executor;
    }

    function attack() external payable {
        if (attacked) return;
        attacked = true;

        // Try to re-enter executeBatch with a simple action pointing back here
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(this),
            value:  0,
            data:   abi.encodeWithSelector(ReentrantTarget.noop.selector)
        });

        // A nested executeBatch call — if no guard, this would recurse
        try executor.executeBatch(actions) {} catch {}
    }

    function noop() external payable {}

    receive() external payable {}
}

// =============================================================================
// AgentExecutorTest
// =============================================================================

contract AgentExecutorTest is Test {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    AgentPolicyModule public policyModule;
    AgentExecutor     public executor;
    MockTarget        public mockTarget;

    address internal operator  = address(0xABCD);
    address internal safe      = address(0x1234);
    address internal feeWallet = address(0xFEE1);

    uint256 internal constant FEE_BPS = 30; // 0.30 %
    uint256 internal constant BPS     = 10_000;

    // -------------------------------------------------------------------------
    // setUp
    // -------------------------------------------------------------------------

    function setUp() public {
        policyModule = new AgentPolicyModule(operator);
        executor     = new AgentExecutor(address(policyModule), feeWallet, FEE_BPS);
        mockTarget   = new MockTarget();

        vm.deal(safe, 100 ether);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _feeFor(uint256 value) internal pure returns (uint256) {
        return (value * FEE_BPS) / BPS;
    }

    /// Build a single-action array calling mockTarget.increment() with value.
    function _incrementAction(uint256 value)
        internal
        view
        returns (AgentExecutor.Action[] memory actions)
    {
        actions    = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(mockTarget),
            value:  value,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });
    }

    function _defaultPolicy() internal pure returns (AgentPolicyModule.AgentPolicy memory) {
        return AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 0,
            allowedContracts:  new address[](0),
            allowedTokens:     new address[](0),
            active:            true
        });
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    function test_Constructor_SetsImmutables() public view {
        assertEq(address(executor.policyModule()), address(policyModule));
        assertEq(executor.feeWallet(), feeWallet);
        assertEq(executor.feeBps(), FEE_BPS);
    }

    function test_Constructor_ZeroPolicyModule_Reverts() public {
        vm.expectRevert(AgentExecutor.ZeroAddress.selector);
        new AgentExecutor(address(0), feeWallet, FEE_BPS);
    }

    function test_Constructor_ZeroFeeWallet_Reverts() public {
        vm.expectRevert(AgentExecutor.ZeroAddress.selector);
        new AgentExecutor(address(policyModule), address(0), FEE_BPS);
    }

    function test_Constructor_ZeroFeeBps_IsAllowed() public {
        AgentExecutor e = new AgentExecutor(address(policyModule), feeWallet, 0);
        assertEq(e.feeBps(), 0);
    }

    // =========================================================================
    // calculateFee
    // =========================================================================

    function test_CalculateFee_30Bps_Correct() public view {
        // 30 bps on 1 ETH = 0.003 ETH
        assertEq(executor.calculateFee(1 ether), 0.003 ether);
    }

    function test_CalculateFee_ZeroValue() public view {
        assertEq(executor.calculateFee(0), 0);
    }

    function test_CalculateFee_ZeroFeeBps() public {
        AgentExecutor noFeeExecutor = new AgentExecutor(
            address(policyModule), feeWallet, 0
        );
        assertEq(noFeeExecutor.calculateFee(100 ether), 0);
    }

    // =========================================================================
    // executeBatch — input validation
    // =========================================================================

    function test_ExecuteBatch_EmptyActions_Reverts() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](0);

        vm.prank(safe);
        vm.expectRevert(AgentExecutor.InvalidActions.selector);
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_ZeroAddressTarget_Reverts() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({target: address(0), value: 0, data: ""});

        vm.prank(safe);
        vm.expectRevert(AgentExecutor.ZeroAddress.selector);
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_ZeroAddressInSecondAction_Reverts() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](2);
        actions[0] = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });
        actions[1] = AgentExecutor.Action({target: address(0), value: 0, data: ""});

        vm.prank(safe);
        vm.expectRevert(AgentExecutor.ZeroAddress.selector);
        executor.executeBatch(actions);
    }

    // =========================================================================
    // executeBatch — fee math
    // =========================================================================

    function test_ExecuteBatch_InsufficientValueForFee_Reverts() public {
        // Sending exactly the action value but forgetting the fee
        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee = _feeFor(1 ether);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.InsufficientValueForFee.selector,
                1 ether,           // sent
                1 ether + fee      // required
            )
        );
        executor.executeBatch{value: 1 ether}(actions);
    }

    function test_ExecuteBatch_ExactValue_Succeeds() public {
        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee   = _feeFor(1 ether);
        uint256 total = 1 ether + fee;

        vm.prank(safe);
        executor.executeBatch{value: total}(actions);

        assertEq(mockTarget.counter(), 1);
    }

    function test_ExecuteBatch_FeeForwardedToFeeWallet() public {
        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee   = _feeFor(1 ether);
        uint256 total = 1 ether + fee;

        uint256 before = feeWallet.balance;
        vm.prank(safe);
        executor.executeBatch{value: total}(actions);

        assertEq(feeWallet.balance - before, fee);
    }

    function test_ExecuteBatch_ZeroFee_NoFeeTransfer() public {
        AgentExecutor e = new AgentExecutor(address(policyModule), feeWallet, 0);
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        uint256 before = feeWallet.balance;
        vm.prank(safe);
        e.executeBatch(actions);

        assertEq(feeWallet.balance, before); // no fee collected
    }

    function test_ExecuteBatch_ExcessETH_RefundedToCaller() public {
        AgentExecutor.Action[] memory actions = _incrementAction(0);
        uint256 overpay = 2 ether; // fee is 0 (no action value), overpay is pure excess

        uint256 before = safe.balance;
        vm.prank(safe);
        executor.executeBatch{value: overpay}(actions);

        // The safe should have received back the excess (minus 0 fee on 0 value)
        assertEq(safe.balance, before - overpay + overpay); // net: safe.balance unchanged
    }

    function test_ExecuteBatch_ExcessETH_PartialOverpay() public {
        // Action: send 1 ETH to target. Fee = 0.003 ETH. Total required = 1.003 ETH.
        // We send 1.5 ETH → excess = 0.497 ETH should be refunded.
        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee      = _feeFor(1 ether);
        uint256 required = 1 ether + fee;
        uint256 sent     = 1.5 ether;

        uint256 callerBefore = safe.balance;
        vm.prank(safe);
        executor.executeBatch{value: sent}(actions);

        uint256 callerAfter = safe.balance;
        assertEq(callerBefore - callerAfter, required); // only required was spent
    }

    // =========================================================================
    // executeBatch — multi-action fee accumulation
    // =========================================================================

    function test_ExecuteBatch_MultipleFreeActions() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](3);
        for (uint256 i = 0; i < 3; i++) {
            actions[i] = AgentExecutor.Action({
                target: address(mockTarget), value: 0,
                data: abi.encodeWithSelector(MockTarget.increment.selector)
            });
        }

        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(mockTarget.counter(), 3);
    }

    function test_ExecuteBatch_MultiplePaidActions_FeeOnTotal() public {
        // Two actions each sending 1 ETH → total = 2 ETH, fee = 0.006 ETH
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](2);
        actions[0] = AgentExecutor.Action({
            target: address(mockTarget), value: 1 ether,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });
        actions[1] = AgentExecutor.Action({
            target: address(mockTarget), value: 1 ether,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        uint256 totalActionValue = 2 ether;
        uint256 fee   = _feeFor(totalActionValue);
        uint256 total = totalActionValue + fee;

        uint256 feeBefore = feeWallet.balance;
        vm.prank(safe);
        executor.executeBatch{value: total}(actions);

        assertEq(mockTarget.counter(), 2);
        assertEq(feeWallet.balance - feeBefore, fee);
    }

    // =========================================================================
    // executeBatch — atomicity
    // =========================================================================

    function test_ExecuteBatch_FailingAction_RevertsAll() public {
        mockTarget.setShouldRevert(true);

        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](2);
        actions[0] = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });
        actions[1] = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert();
        executor.executeBatch(actions);

        // Counter must still be 0 — full atomicity
        assertEq(mockTarget.counter(), 0);
    }

    function test_ExecuteBatch_FailingAction_RevertsBubbles() public {
        mockTarget.setShouldRevert(true);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        // ActionFailed error with index=0 and target=mockTarget
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.ActionFailed.selector,
                uint256(0),
                address(mockTarget),
                abi.encodeWithSignature("Error(string)", "MockTarget: forced revert")
            )
        );
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_FeeNotCollected_OnFailure() public {
        mockTarget.setShouldRevert(true);

        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee   = _feeFor(1 ether);
        uint256 total = 1 ether + fee;

        uint256 feeBefore = feeWallet.balance;
        vm.prank(safe);
        vm.expectRevert();
        executor.executeBatch{value: total}(actions);

        // Fee must NOT have been collected
        assertEq(feeWallet.balance, feeBefore);
    }

    // =========================================================================
    // executeBatch — events
    // =========================================================================

    function test_ExecuteBatch_EmitsBatchExecuted() public {
        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        vm.expectEmit(true, false, false, true);
        emit AgentExecutor.BatchExecuted(safe, 1, 0); // fee = 0 on value=0
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_EmitsActionExecuted() public {
        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        vm.expectEmit(true, false, false, true);
        emit AgentExecutor.ActionExecuted(address(mockTarget), 0, true);
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_EmitsFeeCollected() public {
        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee   = _feeFor(1 ether);
        uint256 total = 1 ether + fee;

        vm.prank(safe);
        vm.expectEmit(true, false, false, true);
        emit AgentExecutor.FeeCollected(feeWallet, fee);
        executor.executeBatch{value: total}(actions);
    }

    // =========================================================================
    // executeBatch — feeWallet rejection
    // =========================================================================

    function test_ExecuteBatch_FeeWalletRejectsETH_Reverts() public {
        RejectETH rejecter = new RejectETH();
        AgentExecutor e = new AgentExecutor(
            address(policyModule), address(rejecter), FEE_BPS
        );

        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee   = _feeFor(1 ether);
        uint256 total = 1 ether + fee;

        vm.deal(address(this), total);
        vm.expectRevert(AgentExecutor.FeeTransferFailed.selector);
        e.executeBatch{value: total}(actions);
    }

    // =========================================================================
    // executeBatch — policy enforcement
    // =========================================================================

    function test_ExecuteBatch_NoPolicyForSafe_NoRestrictions() public {
        // safe has no policy — should execute freely
        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(mockTarget.counter(), 1);
    }

    function test_ExecuteBatch_PolicyPaused_Reverts() public {
        vm.prank(operator);
        policyModule.setPolicy(safe, _defaultPolicy());

        vm.prank(operator);
        policyModule.emergencyPause(safe);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_PolicyValueExceeded_Reverts() public {
        // Policy allows max 0.5 ETH, action sends 1 ETH
        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     0.5 ether,
            cooldownBetweenTx: 0,
            allowedContracts:  new address[](0),
            allowedTokens:     new address[](0),
            active:            true
        });
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        AgentExecutor.Action[] memory actions = _incrementAction(1 ether);
        uint256 fee   = _feeFor(1 ether);
        uint256 total = 1 ether + fee;

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ValueExceedsLimit.selector,
                1 ether,
                0.5 ether
            )
        );
        executor.executeBatch{value: total}(actions);
    }

    function test_ExecuteBatch_PolicyContractNotWhitelisted_Reverts() public {
        address[] memory allowed = new address[](1);
        allowed[0] = address(0x9999); // some other contract

        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 0,
            allowedContracts:  allowed,
            allowedTokens:     new address[](0),
            active:            true
        });
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ContractNotWhitelisted.selector,
                address(mockTarget)
            )
        );
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_PolicyAllowsContract_Passes() public {
        address[] memory allowed = new address[](1);
        allowed[0] = address(mockTarget);

        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 0,
            allowedContracts:  allowed,
            allowedTokens:     new address[](0),
            active:            true
        });
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(mockTarget.counter(), 1);
    }

    function test_ExecuteBatch_PolicyCooldown_Reverts() public {
        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 60,
            allowedContracts:  new address[](0),
            allowedTokens:     new address[](0),
            active:            true
        });
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.warp(1000);
        vm.prank(safe);
        executor.executeBatch(actions); // first tx — sets timestamp

        // Second tx too soon
        vm.warp(1030);
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.CooldownActive.selector, 30)
        );
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_PolicyCooldown_AfterExpiry_Passes() public {
        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 60,
            allowedContracts:  new address[](0),
            allowedTokens:     new address[](0),
            active:            true
        });
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.warp(1000);
        vm.prank(safe);
        executor.executeBatch(actions);

        vm.warp(1061);
        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(mockTarget.counter(), 2);
    }

    /// @dev After a policy is resumed, execution succeeds again.
    function test_ExecuteBatch_PolicyResumed_Passes() public {
        vm.prank(operator);
        policyModule.setPolicy(safe, _defaultPolicy());

        vm.prank(operator);
        policyModule.emergencyPause(safe);

        vm.prank(operator);
        policyModule.resume(safe);

        AgentExecutor.Action[] memory actions = _incrementAction(0);

        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(mockTarget.counter(), 1);
    }

    // =========================================================================
    // executeSingle — basic behavior
    // =========================================================================

    function test_ExecuteSingle_Succeeds() public {
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget),
            value:  0,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        executor.executeSingle(action);

        assertEq(mockTarget.counter(), 1);
    }

    function test_ExecuteSingle_ZeroAddressTarget_Reverts() public {
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(0), value: 0, data: ""
        });

        vm.prank(safe);
        vm.expectRevert(AgentExecutor.ZeroAddress.selector);
        executor.executeSingle(action);
    }

    function test_ExecuteSingle_InsufficientValueForFee_Reverts() public {
        uint256 actionValue = 1 ether;
        uint256 fee = _feeFor(actionValue);

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget),
            value:  actionValue,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.InsufficientValueForFee.selector,
                actionValue,          // sent (no fee included)
                actionValue + fee     // required
            )
        );
        executor.executeSingle{value: actionValue}(action);
    }

    function test_ExecuteSingle_ExactValue_Succeeds() public {
        uint256 actionValue = 1 ether;
        uint256 fee   = _feeFor(actionValue);
        uint256 total = actionValue + fee;

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget),
            value:  actionValue,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        executor.executeSingle{value: total}(action);

        assertEq(mockTarget.counter(), 1);
        assertEq(address(mockTarget).balance, actionValue);
    }

    function test_ExecuteSingle_FeeForwarded() public {
        uint256 actionValue = 1 ether;
        uint256 fee   = _feeFor(actionValue);
        uint256 total = actionValue + fee;

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget),
            value:  actionValue,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        uint256 before = feeWallet.balance;
        vm.prank(safe);
        executor.executeSingle{value: total}(action);

        assertEq(feeWallet.balance - before, fee);
    }

    function test_ExecuteSingle_ExcessETH_Refunded() public {
        // Action: 0 value, fee = 0. Sending 1 ETH → entire 1 ETH is excess.
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        uint256 callerBefore = safe.balance;
        vm.prank(safe);
        executor.executeSingle{value: 1 ether}(action);

        // safe balance unchanged: sent 1 ETH, got 1 ETH refunded
        assertEq(safe.balance, callerBefore);
    }

    function test_ExecuteSingle_FailingAction_Reverts() public {
        mockTarget.setShouldRevert(true);

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert();
        executor.executeSingle(action);
    }

    function test_ExecuteSingle_EmitsEvents() public {
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectEmit(true, false, false, true);
        emit AgentExecutor.ActionExecuted(address(mockTarget), 0, true);
        executor.executeSingle(action);
    }

    // =========================================================================
    // executeSingle — policy enforcement
    // =========================================================================

    function test_ExecuteSingle_PolicyPaused_Reverts() public {
        vm.prank(operator);
        policyModule.setPolicy(safe, _defaultPolicy());

        vm.prank(operator);
        policyModule.emergencyPause(safe);

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        executor.executeSingle(action);
    }

    function test_ExecuteSingle_PolicyValueExceeded_Reverts() public {
        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     0.5 ether,
            cooldownBetweenTx: 0,
            allowedContracts:  new address[](0),
            allowedTokens:     new address[](0),
            active:            true
        });
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        uint256 actionValue = 1 ether;
        uint256 fee   = _feeFor(actionValue);
        uint256 total = actionValue + fee;

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget),
            value:  actionValue,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ValueExceedsLimit.selector,
                1 ether,
                0.5 ether
            )
        );
        executor.executeSingle{value: total}(action);
    }

    function test_ExecuteSingle_NoPolicyForSafe_NoRestrictions() public {
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget), value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        executor.executeSingle(action);

        assertEq(mockTarget.counter(), 1);
    }

    // =========================================================================
    // receive() — ETH acceptance
    // =========================================================================

    function test_Receive_AcceptsETH() public {
        (bool ok, ) = address(executor).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(executor).balance, 1 ether);
    }

    // =========================================================================
    // Fuzz tests
    // =========================================================================

    function testFuzz_CalculateFee_Correctness(uint256 value) public view {
        // fee = value * feeBps / 10000, must not overflow for realistic values
        value = bound(value, 0, 1_000_000 ether);
        uint256 expected = (value * FEE_BPS) / BPS;
        assertEq(executor.calculateFee(value), expected);
    }

    function testFuzz_ExecuteBatch_SingleNoValueAction(address randomCaller) public {
        vm.assume(randomCaller != address(0));
        vm.assume(randomCaller.code.length == 0); // EOA — so refund succeeds

        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(mockTarget),
            value:  0,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.deal(randomCaller, 10 ether);
        vm.prank(randomCaller);
        executor.executeBatch(actions);

        assertEq(mockTarget.counter(), 1);
    }

    function testFuzz_ExecuteSingle_FeeAlwaysCoversCost(uint256 actionValue) public {
        actionValue = bound(actionValue, 0, 50 ether);
        uint256 fee   = executor.calculateFee(actionValue);
        uint256 total = actionValue + fee;

        vm.deal(address(this), total + 1 ether); // extra to avoid underflow in test

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(mockTarget),
            value:  actionValue,
            data:   abi.encodeWithSelector(MockTarget.increment.selector)
        });

        uint256 feeBefore = feeWallet.balance;
        executor.executeSingle{value: total}(action);

        if (fee > 0) {
            assertEq(feeWallet.balance - feeBefore, fee);
        } else {
            assertEq(feeWallet.balance, feeBefore);
        }
    }
}
