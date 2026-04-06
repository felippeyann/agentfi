// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutorHandler} from "./AgentExecutorHandler.sol";

contract AgentExecutorInvariants is StdInvariant, Test {
    AgentExecutor public executor;
    AgentPolicyModule public policyModule;
    AgentExecutorHandler public handler;
    
    address public feeWallet = address(0xFEED);
    address public operator = address(0xBA5E);
    uint256 public constant FEE_BPS = 30; // 0.3%

    function setUp() public {
        policyModule = new AgentPolicyModule(operator);
        executor = new AgentExecutor(address(policyModule), feeWallet, FEE_BPS);
        handler = new AgentExecutorHandler(executor, policyModule, FEE_BPS);
        
        // Target the handler for stateful fuzzing
        targetContract(address(handler));
    }

    /**
     * @notice INVARIANT: Fee Integrity
     * The fee wallet's balance must always equal the sum of all calculated fees 
     * from successfully executed transactions.
     */
    function invariant_FeeWalletBalanceMatchesExpectation() public {
        assertEq(feeWallet.balance, handler.totalFeesExpected());
    }

    /**
     * @notice INVARIANT: No Stuck Funds
     * The AgentExecutor contract must never hold a balance after a transaction sequence.
     * All ETH should be either at the target, in the fee wallet, or refunded.
     */
    function invariant_ExecutorBalanceIsZero() public {
        assertEq(address(executor).balance, 0);
    }
}
