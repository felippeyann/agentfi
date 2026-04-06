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
        // 1. Set a policy that ONLY allows 'mockToken'
        address[] memory allowedTokens = new address[](1);
        allowedTokens[0] = mockToken;

        AgentPolicyModule.AgentPolicy memory p = AgentPolicyModule.AgentPolicy({
            maxValuePerTx:     10 ether,
            cooldownBetweenTx: 0,
            allowedContracts:  new address[](0),
            allowedTokens:     allowedTokens,
            active:            true,
            policyExpiresAt:   0
        });
        
        vm.prank(operator);
        policyModule.setPolicy(safe, p);

        // 2. Prepare an action interacting with a non-whitelisted token (0xBAD)
        address badToken = address(0xBAD);
        AgentExecutor.Action[] memory actions = new AgentExecutor.Action[](1);
        actions[0] = AgentExecutor.Action({
            target: target,
            value:  0,
            token:  badToken, // Now explicitly passed!
            data:   ""
        });

        // 3. Execute. 
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
