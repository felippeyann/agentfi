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
    AgentPolicyModule.AgentPolicy internal defaultPolicy;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _makePolicy(
        uint256 maxValue,
        uint256 cooldown,
        address[] memory contracts,
        address[] memory tokens,
        bool active
    ) internal pure returns (AgentPolicyModule.AgentPolicy memory) {
        return AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     maxValue,
            cooldownBetweenTx: cooldown,
            allowedContracts:  contracts,
            allowedTokens:     tokens,
            active:            active,
            policyExpiresAt:   0
        });
    }

    function _emptyAddrs() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _single(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    // -------------------------------------------------------------------------
    // setUp
    // -------------------------------------------------------------------------

    function setUp() public {
        module = new AgentPolicyModule(operator);

        defaultPolicy = _makePolicy(
            1 ether,       // maxValuePerTx
            60,            // cooldownBetweenTx
            _emptyAddrs(), // no contract whitelist
            _emptyAddrs(), // no token whitelist
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
        module.setPolicy(safe, defaultPolicy);

        assertTrue(module.hasPolicy(safe));
    }

    function test_SetPolicy_BySafe_Succeeds() public {
        vm.prank(safe);
        module.setPolicy(safe, defaultPolicy);

        assertTrue(module.hasPolicy(safe));
    }

    function test_SetPolicy_ByUnauthorized_Reverts() public {
        vm.prank(unauthorized);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.setPolicy(safe, defaultPolicy);
    }

    /// @dev A different Safe cannot set policy for another Safe.
    function test_SetPolicy_BySafe2_ForSafe1_Reverts() public {
        vm.prank(safe2);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.setPolicy(safe, defaultPolicy);
    }

    // =========================================================================
    // setPolicy — validation
    // =========================================================================

    function test_SetPolicy_ZeroSafeAddress_Reverts() public {
        vm.prank(operator);
        vm.expectRevert(AgentPolicyModule.ZeroAddress.selector);
        module.setPolicy(address(0), defaultPolicy);
    }

    function test_SetPolicy_ZeroMaxValue_Reverts() public {
        AgentPolicyModule.AgentPolicy memory bad = _makePolicy(
            0,             // invalid
            60,
            _emptyAddrs(),
            _emptyAddrs(),
            true
        );
        vm.prank(operator);
        vm.expectRevert(AgentPolicyModule.InvalidPolicy.selector);
        module.setPolicy(safe, bad);
    }

    function test_SetPolicy_ZeroCooldown_IsAllowed() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        assertEq(module.getPolicy(safe).cooldownBetweenTx, 0);
    }

    function test_SetPolicy_InactivePolicy_IsAllowed() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _emptyAddrs(), false
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        assertFalse(module.getPolicy(safe).active);
    }

    // =========================================================================
    // setPolicy — stored values
    // =========================================================================

    function test_SetPolicy_StoresValuesCorrectly() public {
        address[] memory contracts = _single(targetAddr);
        address[] memory tokens    = _single(tokenAddr);

        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            2 ether, 120, contracts, tokens, true
        );

        vm.prank(operator);
        module.setPolicy(safe, p);

        AgentPolicyModule.AgentPolicy memory stored = module.getPolicy(safe);
        assertEq(stored.maxValuePerTx,     2 ether);
        assertEq(stored.cooldownBetweenTx, 120);
        assertTrue(stored.active);
        assertEq(stored.allowedContracts.length, 1);
        assertEq(stored.allowedContracts[0],     targetAddr);
        assertEq(stored.allowedTokens.length,    1);
        assertEq(stored.allowedTokens[0],        tokenAddr);
    }

    function test_SetPolicy_EmitsEvent() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, false);
        emit AgentPolicyModule.PolicySet(safe, defaultPolicy);
        module.setPolicy(safe, defaultPolicy);
    }

    function test_SetPolicy_CanBeUpdated() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        // Update to a stricter policy
        AgentPolicyModule.AgentPolicy memory updated = _makePolicy(
            0.1 ether, 300, _emptyAddrs(), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, updated);

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
        module.setPolicy(safe, defaultPolicy);

        assertTrue(module.hasPolicy(safe));
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

    function test_ValidateTransaction_NoPolicy_DoesNotCreatePolicy() public {
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 1, address(0));

        assertFalse(module.hasPolicy(safe));
    }

    // =========================================================================
    // validateTransaction — active flag (kill switch)
    // =========================================================================

    function test_ValidateTransaction_PolicyActive_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
        // Must not revert
    }

    function test_ValidateTransaction_PolicyInactive_Reverts() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _emptyAddrs(), false
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // validateTransaction — value limit
    // =========================================================================

    function test_ValidateTransaction_ValueAtLimit_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 1 ether, address(0));
    }

    function test_ValidateTransaction_ValueBelowLimit_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0.5 ether, address(0));
    }

    function test_ValidateTransaction_ZeroValue_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_ValueExceedsLimit_Reverts() public {
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
        module.validateTransaction(safe, targetAddr, 2 ether, address(0));
    }

    function test_ValidateTransaction_ValueByOne_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ValueExceedsLimit.selector,
                1 ether + 1,
                1 ether
            )
        );
        module.validateTransaction(safe, targetAddr, 1 ether + 1, address(0));
    }

    // =========================================================================
    // validateTransaction — contract whitelist
    // =========================================================================

    function test_ValidateTransaction_EmptyContractList_AllowsAnyTarget() public {
        // defaultPolicy has empty allowedContracts
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(safe, address(0xBEEF), 0, address(0));
    }

    function test_ValidateTransaction_TargetInWhitelist_Passes() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _single(targetAddr), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_TargetNotInWhitelist_Reverts() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _single(address(0x1111)), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.ContractNotWhitelisted.selector, targetAddr)
        );
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_MultipleContractWhitelist_MatchesCorrectly() public {
        address[] memory allowed = new address[](3);
        allowed[0] = address(0x1111);
        allowed[1] = targetAddr;      // second entry
        allowed[2] = address(0x3333);

        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, allowed, _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        // targetAddr is in the list — should pass
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // validateTransaction — token whitelist
    // =========================================================================

    function test_ValidateTransaction_ZeroTokenAddress_SkipsTokenCheck() public {
        // Even with a populated token whitelist, address(0) bypasses token check
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _single(address(0x9999)), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_EmptyTokenList_AllowsAnyToken() public {
        // defaultPolicy has empty allowedTokens
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, tokenAddr);
    }

    function test_ValidateTransaction_TokenInWhitelist_Passes() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _single(tokenAddr), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, tokenAddr);
    }

    function test_ValidateTransaction_TokenNotInWhitelist_Reverts() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _single(address(0x2222)), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.TokenNotWhitelisted.selector, tokenAddr)
        );
        module.validateTransaction(safe, targetAddr, 0, tokenAddr);
    }

    // =========================================================================
    // validateTransaction — cooldown
    // =========================================================================

    function test_ValidateTransaction_FirstTx_NoCooldownRequired() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        // Even with cooldown set, first tx has no prior timestamp
        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
        // Must not revert
    }

    function test_ValidateTransaction_SecondTxExactlyAtCooldown_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy); // cooldown = 60 s

        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        vm.warp(1060); // exactly 60 s later
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_SecondTxAfterCooldown_Passes() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        vm.warp(1061);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_SecondTxTooEarly_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy); // cooldown = 60 s

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

    function test_ValidateTransaction_ZeroCooldown_AlwaysPasses() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.warp(1000);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        // Immediately again — no cooldown
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    function test_ValidateTransaction_UpdatesLastTxTimestamp() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.warp(5000);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        assertEq(module.getLastTxTimestamp(safe), 5000);
    }

    function test_ValidateTransaction_EmitsEvent() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        vm.expectEmit(true, true, false, true);
        emit AgentPolicyModule.TransactionValidated(safe, targetAddr, 0);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // validateTransaction — multiple checks in one call (precedence)
    // =========================================================================

    /// @dev Pause check occurs before value check — PolicyPausedError wins.
    function test_ValidateTransaction_PausedBeforeValueCheck() public {
        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, 0, _emptyAddrs(), _emptyAddrs(), false // paused
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        module.validateTransaction(safe, targetAddr, 999 ether, address(0));
    }

    // =========================================================================
    // emergencyPause
    // =========================================================================

    function test_EmergencyPause_ByOperator_Succeeds() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        assertFalse(module.getPolicy(safe).active);
    }

    function test_EmergencyPause_BySafe_Succeeds() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(safe);
        module.emergencyPause(safe);

        assertFalse(module.getPolicy(safe).active);
    }

    function test_EmergencyPause_ByUnauthorized_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(unauthorized);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.emergencyPause(safe);
    }

    function test_EmergencyPause_EmitsEvent() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        vm.expectEmit(true, true, false, false);
        emit AgentPolicyModule.PolicyPaused(safe, operator);
        module.emergencyPause(safe);
    }

    function test_EmergencyPause_BlocksValidation() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(safe);
        vm.expectRevert(AgentPolicyModule.PolicyPausedError.selector);
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }

    // =========================================================================
    // resume
    // =========================================================================

    function test_Resume_ByOperator_Succeeds() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(operator);
        module.resume(safe);

        assertTrue(module.getPolicy(safe).active);
    }

    function test_Resume_BySafe_Succeeds() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(safe);
        module.resume(safe);

        assertTrue(module.getPolicy(safe).active);
    }

    function test_Resume_ByUnauthorized_Reverts() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(unauthorized);
        vm.expectRevert(AgentPolicyModule.Unauthorized.selector);
        module.resume(safe);
    }

    function test_Resume_EmitsEvent() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(operator);
        vm.expectEmit(true, true, false, false);
        emit AgentPolicyModule.PolicyResumed(safe, operator);
        module.resume(safe);
    }

    function test_Resume_AllowsValidationAgain() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.prank(operator);
        module.emergencyPause(safe);

        vm.prank(operator);
        module.resume(safe);

        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));
        // Must not revert
    }

    // =========================================================================
    // getLastTxTimestamp
    // =========================================================================

    function test_GetLastTxTimestamp_DefaultIsZero() public view {
        assertEq(module.getLastTxTimestamp(safe), 0);
    }

    function test_GetLastTxTimestamp_ReturnedAfterValidation() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);

        vm.warp(9999);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        assertEq(module.getLastTxTimestamp(safe), 9999);
    }

    /// @dev Policies are isolated per Safe — Safe2 timestamp is unaffected.
    function test_GetLastTxTimestamp_IsolatedPerSafe() public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy);
        vm.prank(operator);
        module.setPolicy(safe2, defaultPolicy);

        vm.warp(500);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        // safe2 has not yet transacted
        assertEq(module.getLastTxTimestamp(safe2), 0);
    }

    // =========================================================================
    // Isolation: policies are independent per Safe
    // =========================================================================

    function test_Policies_AreIsolated_BetweenSafes() public {
        AgentPolicyModule.AgentPolicy memory strictPolicy = _makePolicy(
            0.1 ether, 0, _emptyAddrs(), _emptyAddrs(), true
        );

        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy); // max 1 ETH

        vm.prank(operator);
        module.setPolicy(safe2, strictPolicy); // max 0.1 ETH

        // safe can send 0.5 ETH
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0.5 ether, address(0));

        // safe2 cannot send 0.5 ETH
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.ValueExceedsLimit.selector,
                0.5 ether,
                0.1 ether
            )
        );
        module.validateTransaction(safe2, targetAddr, 0.5 ether, address(0));
    }

    // =========================================================================
    // Fuzz tests
    // =========================================================================

    function testFuzz_SetPolicy_MaxValue(uint256 maxValue) public {
        vm.assume(maxValue > 0);

        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            maxValue, 0, _emptyAddrs(), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        assertEq(module.getPolicy(safe).maxValuePerTx, maxValue);
    }

    function testFuzz_ValidateTransaction_ValueLimit(uint256 value) public {
        vm.prank(operator);
        module.setPolicy(safe, defaultPolicy); // maxValuePerTx = 1 ether

        if (value <= 1 ether) {
            vm.prank(safe);
            module.validateTransaction(safe, targetAddr, value, address(0));
        } else {
            vm.prank(safe);
            vm.expectRevert(
                abi.encodeWithSelector(
                    AgentPolicyModule.ValueExceedsLimit.selector,
                    value,
                    1 ether
                )
            );
            module.validateTransaction(safe, targetAddr, value, address(0));
        }
    }

    function testFuzz_Cooldown_RemainingCalculation(
        uint256 elapsed,
        uint256 cooldown
    ) public {
        cooldown = bound(cooldown, 1, 10_000);
        elapsed  = bound(elapsed, 0, cooldown - 1); // elapsed < cooldown → reverts

        AgentPolicyModule.AgentPolicy memory p = _makePolicy(
            1 ether, cooldown, _emptyAddrs(), _emptyAddrs(), true
        );
        vm.prank(operator);
        module.setPolicy(safe, p);

        uint256 startTime = 100_000;
        vm.warp(startTime);
        vm.prank(safe);
        module.validateTransaction(safe, targetAddr, 0, address(0));

        vm.warp(startTime + elapsed);
        uint256 remaining = cooldown - elapsed;

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPolicyModule.CooldownActive.selector, remaining)
        );
        module.validateTransaction(safe, targetAddr, 0, address(0));
    }
}
