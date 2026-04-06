// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";

contract AgentPolicyModuleTest is Test {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    AgentPolicyModule public module;

    address internal operator    = address(0xABCD);
    address internal safe        = address(0x1234);
    address internal safe2       = address(0x5678);
    address internal targetAddr  = address(0x9ABC);
    address internal tokenAddr   = address(0xDEF0);
    address internal unauthorized = address(0xDEAD);

    /// Default open policy (no whitelists, 60 s cooldown, 1 ETH max)
    AgentPolicyModule.PolicyParams internal defaultPolicy;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _makeParams(
        uint256 maxValue,
        uint256 cooldown,
        bool active
    ) internal pure returns (AgentPolicyModule.PolicyParams memory) {
        return AgentPolicyModule.PolicyParams({
            maxValuePerTx:     maxValue,
            cooldownBetweenTx: cooldown,
            active:            active
        });
    }

    // -------------------------------------------------------------------------
    // setUp
    // -------------------------------------------------------------------------

    function setUp() public {
        module = new AgentPolicyModule(operator);

        defaultPolicy = _makeParams(
            1 ether,       // maxValuePerTx
            60,            // cooldownBetweenTx
            true           // active
        );
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    function test_Constructor_SetsOperator() public view {
        assertEq(module.operator(), operator);
    }

    function test_Constructor_ZeroOperator_Reverts() public {
        vm.expectRevert(AgentPolicyModule.ZeroAddress.selector);
        new AgentPolicyModule(address(0));
    }

    // =========================================================================
    // setPolicy — access control
    // =========================================================================

    function test_SetPolicy_ByOperator_Succeeds() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        assertTrue(module.hasPolicy(safe));
    }

    function test_SetPolicy_BySafe_Succeeds() public {
        vm.prank(safe);
        module.setPolicy(safe, defaultPolicy, 0);

        assertTrue(module.hasPolicy(safe));
    }

    function test_SetPolicy_ByUnauthorized_Reverts() public {
        vm.prank(unauthorized);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.setPolicy(safe, defaultPolicy, 0);
    }

    /// @dev A different Safe cannot set policy for another Safe.
    function test_SetPolicy_BySafe2_ForSafe1_Reverts() public {
        vm.prank(safe2);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.setPolicy(safe, defaultPolicy, 0);
    }

    // =========================================================================
    // setPolicy — validation
    // =========================================================================

    function test_SetPolicy_ZeroSafeAddress_Reverts() public {
        vm.prank(operator);
        vm.expectRevert(AgentPolicyModule.ZeroAddress.selector);
        module.setPolicy(address(0), defaultPolicy, 0);
    }

    function test_SetPolicy_ZeroMaxValue_Reverts() public {
        AgentPolicyModule.PolicyParams memory bad = _makeParams(
            0,             // invalid
            60,
            true
        );
        vm.prank(operator);
        vm.expectRevert(AgentPolicyModule.InvalidPolicy.selector);
        module.setPolicy(safe, bad, 0);
    }

    function test_SetPolicy_ZeroCooldown_IsAllowed() public {
        AgentPolicyModule.PolicyParams memory p = _makeParams(
            1 ether, 0, true
        );
        vm.prank(operator);
        module.setPolicy(safe, p, 0);

        assertEq(module.getPolicy(safe).cooldownBetweenTx, 0);
    }

    function test_SetPolicy_InactivePolicy_IsAllowed() public {
        AgentPolicyModule.PolicyParams memory p = _makeParams(
            1 ether, 0, false
        );
        vm.prank(operator);
        module.setPolicy(safe, p, 0);

        assertFalse(module.getPolicy(safe).active);
    }

    // =========================================================================
    // setPolicy — stored values
    // =========================================================================

    function test_SetPolicy_StoresValuesCorrectly() public {
        AgentPolicyModule.PolicyParams memory p = _makeParams(
            2 ether, 120, true
        );

        vm.prank(operator);
        module.setPolicy(safe, p, 1000);

        AgentPolicyModule.AgentPolicy memory stored = module.getPolicy(safe);
        assertEq(stored.maxValuePerTx,     2 ether);
        assertEq(stored.cooldownBetweenTx, 120);
        assertTrue(stored.active);
        assertEq(stored.policyExpiresAt,   1000);
    }

    function test_SetPolicy_EmitsEvent() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit AgentPolicyModule.PolicySet(safe, 1 ether, 60, 0);
        module.setPolicy(safe, defaultPolicy, 0);
    }

    function test_SetPolicy_CanBeUpdated() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        // Update to a stricter policy
        AgentPolicyModule.PolicyParams memory updated = _makeParams(
            0.1 ether, 300, true
        );
        vm.prank(operator);
        module.setPolicy(safe, updated, 0);

        AgentPolicyModule.AgentPolicy memory stored = module.getPolicy(safe);
        assertEq(stored.maxValuePerTx,     0.1 ether);
        assertEq(stored.cooldownBetweenTx, 300);
    }

    // =========================================================================
    // getPolicy / hasPolicy
    // =========================================================================

    function test_GetPolicy_WhenNoPolicyExists_Reverts() public {
        vm.expectRevert(AgentPolicyModule.PolicyNotFound.selector);
        module.getPolicy(safe);
    }

    function test_HasPolicy_ReturnsFalse_BeforeSet() public view {
        assertFalse(module.hasPolicy(safe));
    }

    function test_HasPolicy_ReturnsTrue_AfterSet() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        assertTrue(module.hasPolicy(safe));
    }

    // =========================================================================
    // Whitelists (O(1))
    // =========================================================================

    function test_UpdateContractWhitelist_Works() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        address[] memory targets = new address[](1);
        targets[0] = targetAddr;
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;

        vm.prank(operator);
        module.updateContractWhitelist(safe, targets, allowed);

        assertTrue(module.isContractAllowed(safe, targetAddr));
        assertEq(module.getPolicy(safe).numAllowedContracts, 1);
    }

    function test_UpdateTokenWhitelist_Works() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        address[] memory tokens = new address[](1);
        tokens[0] = tokenAddr;
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;

        vm.prank(operator);
        module.updateTokenWhitelist(safe, tokens, allowed);

        assertTrue(module.isTokenAllowed(safe, tokenAddr));
        assertEq(module.getPolicy(safe).numAllowedTokens, 1);
    }

    // =========================================================================
    // validateTransaction — no-policy pass-through
    // =========================================================================

    function test_ValidateTransaction_NoPolicy_AlwaysPasses() public {
        // No policy means no restrictions — any value, any target, any token
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 999 ether, tokenAddr);
        // Must not revert
    }

    // =========================================================================
    // validateTransaction — active flag (kill switch)
    // =========================================================================

    function test_ValidateTransaction_PolicyActive_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
        // Must not revert
    }

    function test_ValidateTransaction_PolicyInactive_Reverts() public {
        AgentPolicyModule.PolicyParams memory p = _makeParams(
            1 ether, 0, false
        );
        vm.prank(operator);
        module.setPolicy(safe, p, 0);

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // validateTransaction — value limit
    // =========================================================================

    function test_ValidateTransaction_ValueAtLimit_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 1 ether, address(0));
    }

    function test_ValidateTransaction_ValueExceedsLimit_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ValueExceedsLimit.selector,
                2 ether,
                1 ether
            )
        );
        module.validateTransaction(safe, targetAddr, 2 ether, address(0));
    }

    // =========================================================================
    // validateTransaction — contract whitelist
    // =========================================================================

    function test_ValidateTransaction_EmptyContractList_AllowsAnyTarget() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        vm.prank(safe);
        module.validateTransaction(safe, address(0xBEEF), 0, address(0));
    }

    function test_ValidateTransaction_TargetInWhitelist_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        address[] memory targets = new address[](1);
        targets[0] = targetAddr;
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;

        vm.prank(operator);
        module.updateContractWhitelist(safe, targets, allowed);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_TargetNotInWhitelist_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0);

        address[] memory targets = new address[](1);
        targets[0] = address(0x1111);
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;

        vm.prank(operator);
        module.updateContractWhitelist(safe, targets, allowed);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.ContractNotWhitelisted.selector, targetAddr)
        );
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // validateTransaction — cooldown
    // =========================================================================

    function test_ValidateTransaction_SecondTxTooEarly_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy, 0); // cooldown = 60 s

        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        vm.warp(1030); // only 30 s elapsed; 30 s remaining
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.CooldownActive.selector, 30)
        );
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // Fuzz tests
    // =========================================================================

    function testFuzz_SetPolicy_MaxValue(uint256 maxValue) public {
        vm.assume(maxValue > 0);

        AgentPolicyModule.PolicyParams memory p = _makeParams(
            maxValue, 0, true
        );
        vm.prank(operator);
        module.setPolicy(safe, p, 0);

        assertEq(module.getPolicy(safe).maxValuePerTx, maxValue);
    }
}
