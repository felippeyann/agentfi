// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";

/**
 * @title AgentExecutorHandler
 * @notice Stateful handler for invariant testing of the AgentExecutor.
 *         Tracks "ghost state" to verify economic invariants.
 */
contract AgentExecutorHandler is Test {
    AgentExecutor public executor;
    AgentPolicyModule public policyModule;
    
    address public feeWallet = address(0xFEED);
    address public operator = address(0xBA5E);
    address public agentSafe = address(0x5AFE);
    
    uint256 public totalFeesExpected;
    uint256 public totalValueExecuted;
    uint256 public feeBps;

    constructor(AgentExecutor _executor, AgentPolicyModule _policyModule, uint256 _feeBps) {
        executor = _executor;
        policyModule = _policyModule;
        feeBps = _feeBps;
        
        // Initial setup for the fuzzed agent
        vm.deal(agentSafe, 1_000_000 ether);
    }

    /**
     * @notice Fuzzes executeSingle calls with random values.
     */
    function executeSingle(uint256 amount) public {
        amount = bound(amount, 0, 10 ether); // Stay within a reasonable range for the test
        
        AgentExecutor.Action memory action = AgentExecutor.Action({
            target: address(0x1337), // Mock target
            value: amount,
            token: address(0),
            data: ""
        });

        // Calculate expected fee
        uint256 fee = (amount * feeBps) / 10000;
        uint256 totalNeeded = amount + fee;

        vm.prank(agentSafe);
        try executor.executeSingle{value: totalNeeded}(action) {
            totalFeesExpected += fee;
            totalValueExecuted += amount;
        } catch {
            // If it reverts (e.g. policy violation), we don't increment ghost state
        }
    }

    // Helper to get contract balance
    function getExecutorBalance() public view returns (uint256) {
        return address(executor).balance;
    }
}
