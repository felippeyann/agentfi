// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";

/**
 * @title DeployEscrow
 * @notice Deploys the ERC-8183 `AgentJobEscrow` and its ERC-8004 `ReputationHook`.
 *
 * Usage:
 *   forge script script/DeployEscrow.s.sol \
 *     --rpc-url base_sepolia \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY
 *
 * Required env vars:
 *   PRIVATE_KEY                 — deployer EOA private key (needs ETH for gas)
 *   OPERATOR_ADDRESS            — may pause/unpause job creation and funding (never moves funds)
 *   FEE_WALLET                  — receives the platform fee on completed jobs
 *
 * Optional env vars (defaults in brackets):
 *   FEE_BPS                     — platform fee in basis points [30]
 *   EVALUATOR_FEE_BPS           — evaluator fee in basis points [0]
 *   USDC_ADDRESS                — escrow token [Base: 0x8335…2913, Base Sepolia: 0x036C…CF7e]
 *   REPUTATION_REGISTRY_ADDRESS — ERC-8004 Reputation Registry [Base: 0x8004…9b63, Base Sepolia: 0x8004…8713]
 *
 * On any other chain `USDC_ADDRESS` and `REPUTATION_REGISTRY_ADDRESS` are required.
 */
contract DeployEscrowScript is Script {
    uint256 internal constant CHAIN_BASE = 8453;
    uint256 internal constant CHAIN_BASE_SEPOLIA = 84532;

    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant REPUTATION_REGISTRY_BASE = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address internal constant REPUTATION_REGISTRY_BASE_SEPOLIA = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    error MissingEnv(string name);

    function run() external returns (AgentJobEscrow escrow, ReputationHook hook) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address feeWallet = vm.envAddress("FEE_WALLET");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(30));
        uint256 evaluatorFeeBps = vm.envOr("EVALUATOR_FEE_BPS", uint256(0));
        address usdc = resolveAddress("USDC_ADDRESS", defaultUsdc(block.chainid));
        address registry = resolveAddress("REPUTATION_REGISTRY_ADDRESS", defaultReputationRegistry(block.chainid));

        console.log("Deploying to chain:   ", block.chainid);
        console.log("Token (USDC):         ", usdc);
        console.log("Fee wallet:           ", feeWallet);
        console.log("Operator:             ", operator);
        console.log("Platform fee bps:     ", feeBps);
        console.log("Evaluator fee bps:    ", evaluatorFeeBps);
        console.log("Reputation registry:  ", registry);

        vm.startBroadcast(deployerKey);

        // 1. Escrow — the hook needs its address, so it goes first.
        escrow = new AgentJobEscrow(usdc, feeWallet, operator, evaluatorFeeBps, feeBps);
        console.log("AgentJobEscrow:", address(escrow));

        // 2. Hook — attached per job by the backend via createJob(..., hook).
        hook = new ReputationHook(address(escrow), registry);
        console.log("ReputationHook:", address(hook));

        vm.stopBroadcast();

        // Output for .env
        string memory chainId = vm.toString(block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log(string.concat("AGENT_JOB_ESCROW_ADDRESS_", chainId, "=", vm.toString(address(escrow))));
        console.log(string.concat("REPUTATION_HOOK_ADDRESS_", chainId, "=", vm.toString(address(hook))));
        console.log("--------------------");
    }

    /// @notice Default USDC address for the chains AgentFi targets (zero elsewhere).
    function defaultUsdc(uint256 chainId) public pure returns (address) {
        if (chainId == CHAIN_BASE) return USDC_BASE;
        if (chainId == CHAIN_BASE_SEPOLIA) return USDC_BASE_SEPOLIA;
        return address(0);
    }

    /// @notice Default ERC-8004 Reputation Registry for the chains AgentFi targets (zero elsewhere).
    function defaultReputationRegistry(uint256 chainId) public pure returns (address) {
        if (chainId == CHAIN_BASE) return REPUTATION_REGISTRY_BASE;
        if (chainId == CHAIN_BASE_SEPOLIA) return REPUTATION_REGISTRY_BASE_SEPOLIA;
        return address(0);
    }

    /// @notice Reads an optional address env var, falling back to `fallbackValue`; reverts if both are zero.
    function resolveAddress(string memory name, address fallbackValue) public view returns (address value) {
        value = vm.envOr(name, fallbackValue);
        if (value == address(0)) revert MissingEnv(name);
    }
}
