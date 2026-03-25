// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

/// @dev Simple counter contract for testing batch execution
contract MockTarget {
    uint256 public counter;
    bool public shouldRevert;

    function increment() external payable {
        if (shouldRevert) revert("MockTarget: forced revert");
        counter++;
    }

    function setShouldRevert(bool _revert) external {
        shouldRevert = _revert;
    }

    function getCounter() external view returns (uint256) {
        return counter;
    }

    receive() external payable {}
}

contract AgentExecutorTest is Test {
    AgentPolicyModule public policyModule;
    AgentExecutor public executor;
    MockTarget public target;

    address operator = address(0xABCD);
    address safe = address(0x1234);

    function setUp() public {
        policyModule = new AgentPolicyModule(operator);
        executor = new AgentExecutor(address(policyModule), address(0xFEE1), 0);
        target = new MockTarget();

        vm.deal(safe, 100 ether);
    }

    // -------------------------------------------------------------------------
    // executeBatch
    // -------------------------------------------------------------------------

    function test_ExecuteBatch_SingleAction() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(target.counter(), 1);
    }

    function test_ExecuteBatch_MultipleActions() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](3);
        for (uint256 i = 0; i < 3; i++) {
            actions[i] = AgentExecutor.Action({
                target: address(target),
                value: 0,
                data: abi.encodeWithSelector(MockTarget.increment.selector)
            });
        }

        vm.prank(safe);
        executor.executeBatch(actions);

        assertEq(target.counter(), 3);
    }

    function test_ExecuteBatch_EmptyActions_Reverts() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](0);

        vm.prank(safe);
        vm.expectRevert(AgentExecutor.InvalidActions.selector);
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_FailingAction_RevertsAll() public {
        target.setShouldRevert(true);

        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](2);
        actions[0] = AgentExecutor.Action({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });
        actions[1] = AgentExecutor.Action({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert();
        executor.executeBatch(actions);

        // Counter should still be 0 (atomicity)
        assertEq(target.counter(), 0);
    }

    function test_ExecuteBatch_ZeroAddressTarget_Reverts() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({target: address(0), value: 0, data: ""});

        vm.prank(safe);
        vm.expectRevert(AgentExecutor.ZeroAddress.selector);
        executor.executeBatch(actions);
    }

    function test_ExecuteBatch_WithETHValue() public {
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(target),
            value: 1 ether,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        executor.executeBatch{value: 1 ether}(actions);

        assertEq(target.counter(), 1);
        assertEq(address(target).balance, 1 ether);
    }

    // -------------------------------------------------------------------------
    // Policy enforcement via executeBatch
    // -------------------------------------------------------------------------

    function test_ExecuteBatch_PolicyPaused_Reverts() public {
        // Set policy and pause it
        AgentPolicyModule.AgentPolicy memory policy = AgentPolicyModule.AgentPolicy({
            maxValuePerTx: 1 ether,
            cooldownBetweenTx: 0,
            allowedContracts: new address[](0),
            allowedTokens: new address[](0),
            active: true
        });

        vm.prank(operator);
        policyModule.setPolicy(safe, policy);

        vm.prank(operator);
        policyModule.emergencyPause(safe);

        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        executor.executeBatch(actions);
    }

    // -------------------------------------------------------------------------
    // executeSingle
    // -------------------------------------------------------------------------

    function test_ExecuteWithCheck_NoSelectorCheck() public {
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        executor.executeSingle(action);

        assertEq(target.counter(), 1);
    }

    function test_ExecuteWithCheck_FailingAction_Reverts() public {
        target.setShouldRevert(true);

        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(MockTarget.increment.selector)
        });

        vm.prank(safe);
        vm.expectRevert();
        executor.executeSingle(action);
    }
}
