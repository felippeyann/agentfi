// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

/**
 * @title Deploy
 * @notice Deploys AgentPolicyModule and AgentExecutor to target network.
 *
 * Usage:
 *   forge script script/Deploy.s.sol \
 *     --rpc-url base \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY
 *
 * Required env vars:
 *   PRIVATE_KEY        — deployer EOA private key (needs ETH for gas)
 *   OPERATOR_ADDRESS   — address that can set/pause policies (use your MetaMask address)
 *   FEE_WALLET         — address that receives protocol fees (OPERATOR_FEE_WALLET)
 *   FEE_BPS            — protocol fee in basis points (30 = 0.30% FREE tier)
 */
contract DeployScript is Script {
    function run() external {
        address operator  = vm.envAddress("OPERATOR_ADDRESS");
        address feeWallet = vm.envAddress("FEE_WALLET");
        uint256 feeBps    = vm.envUint("FEE_BPS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        console.log("Deploying to chain:", block.chainid);
        console.log("Operator:  ", operator);
        console.log("Fee wallet:", feeWallet);
        console.log("Fee bps:   ", feeBps);

        vm.startBroadcast(deployerKey);

        // 1. Deploy policy module — enforces per-agent constraints on-chain
        AgentPolicyModule policyModule = new AgentPolicyModule(operator);
        console.log("AgentPolicyModule:", address(policyModule));

        // 2. Deploy executor — atomic batch runner with fee collection
        AgentExecutor executor = new AgentExecutor(
            address(policyModule),
            feeWallet,
            feeBps
        );
        console.log("AgentExecutor:    ", address(executor));

        vm.stopBroadcast();

        // Output for .env
        string memory chainId = vm.toString(block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log(string.concat("POLICY_MODULE_ADDRESS_", chainId, "=", vm.toString(address(policyModule))));
        console.log(string.concat("EXECUTOR_ADDRESS_", chainId, "=", vm.toString(address(executor))));
        console.log("--------------------");
    }
}
