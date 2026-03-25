// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";

contract AgentPolicyModuleTest is Test {
    AgentPolicyModule public module;

    address operator = address(0xABCD);
    address safe = address(0x1234);
    address target = address(0x5678);
    address token = address(0x9ABC);
    address unauthorized = address(0xDEAD);

    AgentPolicyModule.AgentPolicy defaultPolicy;

    function setUp() public {
        module = new AgentPolicyModule(operator);

        defaultPolicy = AgentPolicyModule.AgentPolicy({
            maxValuePerTx: 1 ether,
            cooldownBetweenTx: 60,
            allowedContracts: new address[](0),
            allowedTokens: new address[](0),
            active: true
        });
    }

    // -------------------------------------------------------------------------
    // setPolicy
    // -------------------------------------------------------------------------

    function test_SetPolicy_ByOperator() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        AgentPolicyModule.AgentPolicy memory stored = module.getPolicy(safe);
        assertEq(stored.maxValuePerTx, 1 ether);
        assertEq(stored.cooldownBetweenTx, 60);
        assertTrue(stored.active);
    }

    function test_SetPolicy_BySafe() public {
        vm.prank(safe);
        module.setPolicy(safe, defaultPolicy);

        assertTrue(module.hasPolicy(safe));
    }

    function test_SetPolicy_Unauthorized() public {
        vm.prank(unauthorized);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.setPolicy(safe, defaultPolicy);
    }

    function test_SetPolicy_InvalidMaxValue() public {
        AgentPolicyModule.AgentPolicy memory invalidPolicy = defaultPolicy;
        invalidPolicy.maxValuePerTx = 0;

        vm.prank(operator);
        vm.expectRevert(AgentPolicyModule.InvalidPolicy.selector);
        module.setPolicy(safe, invalidPolicy);
    }

    function test_SetPolicy_ZeroAddress() public {
        vm.prank(operator);
        vm.expectRevert(AgentPolicyModule.ZeroAddress.selector);
        module.setPolicy(address(0), defaultPolicy);
    }

    // -------------------------------------------------------------------------
    // validateTransaction — happy paths
    // -------------------------------------------------------------------------

    function test_ValidateTransaction_NoPolicy_Passes() public {
        // No policy = no restrictions
        vm.prank(safe);
        module.validateTransaction(target, 0.5 ether, address(0));
        // Should not revert
    }

    function test_ValidateTransaction_WithinPolicy_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(target, 0.5 ether, address(0));
    }

    function test_ValidateTransaction_ZeroValue_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(target, 0, address(0));
    }

    // -------------------------------------------------------------------------
    // validateTransaction — policy violations
    // -------------------------------------------------------------------------

    function test_ValidateTransaction_ExceedsMaxValue_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ValueExceedsLimit.selector,
                2 ether,
                1 ether
            )
        );
        module.validateTransaction(target, 2 ether, address(0));
    }

    function test_ValidateTransaction_PolicyPaused_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        module.validateTransaction(target, 0, address(0));
    }

    function test_ValidateTransaction_ContractNotWhitelisted_Reverts() public {
        address[] memory allowed = new address[](1);
        allowed[0] = address(0x1111);

        AgentPolicyModule.AgentPolicy memory policy = defaultPolicy;
        policy.allowedContracts = allowed;

        vm.prank(operator);
        module.setPolicy(safe, policy);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.ContractNotWhitelisted.selector, target)
        );
        module.validateTransaction(target, 0, address(0));
    }

    function test_ValidateTransaction_ContractWhitelisted_Passes() public {
        address[] memory allowed = new address[](1);
        allowed[0] = target;

        AgentPolicyModule.AgentPolicy memory policy = defaultPolicy;
        policy.allowedContracts = allowed;

        vm.prank(operator);
        module.setPolicy(safe, policy);

        vm.prank(safe);
        module.validateTransaction(target, 0, address(0));
    }

    function test_ValidateTransaction_TokenNotWhitelisted_Reverts() public {
        address[] memory allowedTokens = new address[](1);
        allowedTokens[0] = address(0x2222);

        AgentPolicyModule.AgentPolicy memory policy = defaultPolicy;
        policy.allowedTokens = allowedTokens;

        vm.prank(operator);
        module.setPolicy(safe, policy);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.TokenNotWhitelisted.selector, token)
        );
        module.validateTransaction(target, 0, token);
    }

    // -------------------------------------------------------------------------
    // Cooldown
    // -------------------------------------------------------------------------

    function test_Cooldown_SecondTxTooEarly_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(target, 0, address(0));

        // Try again 30s later (cooldown is 60s)
        vm.warp(1030);
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.CooldownActive.selector, 30)
        );
        module.validateTransaction(target, 0, address(0));
    }

    function test_Cooldown_AfterCooldownPeriod_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(target, 0, address(0));

        // 61s later — past cooldown
        vm.warp(1061);
        vm.prank(safe);
        module.validateTransaction(target, 0, address(0));
    }

    // -------------------------------------------------------------------------
    // Kill switch
    // -------------------------------------------------------------------------

    function test_EmergencyPause_ByOperator() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        AgentPolicyModule.AgentPolicy memory policy = module.getPolicy(safe);
        assertFalse(policy.active);
    }

    function test_EmergencyPause_Unauthorized_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(unauthorized);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.emergencyPause(safe);
    }

    function test_Resume_AfterPause() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(operator);
        module.resume(safe);

        vm.prank(safe);
        module.validateTransaction(target, 0, address(0));
    }

    // -------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------

    function testFuzz_ValidateTransaction_ValueLimit(uint256 value) public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        if (value <= 1 ether) {
            vm.prank(safe);
            module.validateTransaction(target, value, address(0));
        } else {
            vm.prank(safe);
            vm.expectRevert(
                abi.encodeWithSelector(AgentPolicyModule.ValueExceedsLimit.selector, value, 1 ether)
            );
            module.validateTransaction(target, value, address(0));
        }
    }
}
