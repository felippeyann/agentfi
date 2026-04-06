// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

contract AgentExecutorReproTest is Test {
    AgentPolicyModule public policyModule;
    AgentExecutor     public executor;
    
    address internal operator  = address(0xABCD);
    address internal safe      = address(0x1234);
    address internal feeWallet = address(0xFEE1);
    address internal mockToken = address(0x706b656e);
    address internal target    = address(0x746172676574);

    function setUp() public {
        policyModule = new AgentPolicyModule(operator);
        executor     = new AgentExecutor(address(policyModule), feeWallet, 30);
        vm.deal(safe, 100 ether);
    }

    /**
     * @notice VERIFY FIX: Token Whitelist Enforcement
     * This test demonstrates that the Executor now correctly passes the token 
     * address to the policy module, causing a revert if the token is not whitelisted.
     */
    function test_VerifyFix_TokenWhitelistEnforcement() public {
        // 1. Set a basic policy
        AgentPolicyModule.PolicyParams memory p = AgentPolicyModule.PolicyParams({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 0,
            active:            true
        });
        
        vm.prank(operator);
        policyModule.setPolicy(safe, p, 0);

        // 2. Update token whitelist
        address[] memory tokens = new address[](1);
        tokens[0] = mockToken;
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;

        vm.prank(operator);
        policyModule.updateTokenWhitelist(safe, tokens, allowed);

        // 3. Prepare an action interacting with a non-whitelisted token (0xBAD)
        address badToken = address(0xBAD);
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: target,
            value:  0,
            token:  badToken, // Now explicitly passed!
            data:   ""
        });

        // 4. Execute. 
        // LOGICAL EXPECTATION: It should REVERT because 0xBAD is not whitelisted.
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPolicyModule.TokenNotWhitelisted.selector,
                badToken
            )
        );
        executor.executeBatch(actions);
        
        console.log("Fix verified: Transaction correctly reverted due to non-whitelisted token.");
    }
}
