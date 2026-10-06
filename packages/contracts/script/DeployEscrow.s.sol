// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";

/**
 * @title DeployEscrow
 * @notice Deploys the ERC-8183 `AgentJobEscrow` and its ERC-8004 `ReputationHook`.
 *
 * Usage (keystore signer, preferred — the key never touches the environment):
 *   cast wallet import agentfi-deployer --interactive
 *   forge script script/DeployEscrow.s.sol \
 *     --rpc-url base_sepolia \
 *     --account agentfi-deployer \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY
 *
 * `--ledger`, `--trezor` and `--private-key` work the same way (the script calls
 * `vm.startBroadcast()` without a key and Foundry uses the CLI signer). Setting `PRIVATE_KEY`
 * in the environment is still supported for backwards compatibility but discouraged.
 *
 * Required env vars:
 *   OPERATOR_ADDRESS            — may pause/unpause job creation and funding, rotate the fee wallet
 *                                 and sweep accrued platform fees (never moves escrowed budgets)
 *   FEE_WALLET                  — initial receiver of accrued platform fees (`withdrawPlatformFees`)
 *   TRUSTED_EVALUATOR           — backend signer that settles jobs (decision D5): the only evaluator
 *                                 whose settlements write ERC-8004 feedback and the only
 *                                 `revokeFeedback` caller
 *
 * Optional env vars (defaults in brackets):
 *   PRIVATE_KEY                 — deployer EOA private key [unset or 0: use the CLI signer above]
 *   FEE_BPS                     — platform fee in basis points [30]
 *   EVALUATOR_FEE_BPS           — evaluator fee in basis points [0]
 *   MIN_FEEDBACK_BUDGET         — minimum job budget (token units) for feedback [1000000 = 1 USDC]
 *   USDC_ADDRESS                — escrow token [Base: 0x8335…2913, Base Sepolia: 0x036C…CF7e]
 *   REPUTATION_REGISTRY_ADDRESS — ERC-8004 Reputation Registry [Base: 0x8004BAa1…9b63, Base Sepolia: 0x8004B663…8713]
 *   IDENTITY_REGISTRY_ADDRESS   — ERC-8004 Identity Registry [Base: 0x8004A169…a432, Base Sepolia: 0x8004A818…BD9e]
 *
 * On any other chain `USDC_ADDRESS`, `REPUTATION_REGISTRY_ADDRESS` and `IDENTITY_REGISTRY_ADDRESS`
 * are required. All three must have code on the target chain and `FEE_BPS + EVALUATOR_FEE_BPS`
 * must be below 10 000; everything is validated before the first transaction is broadcast.
 */
contract DeployEscrowScript is Script {
    uint256 internal constant CHAIN_BASE = 8453;
    uint256 internal constant CHAIN_BASE_SEPOLIA = 84532;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant REPUTATION_REGISTRY_BASE = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address internal constant REPUTATION_REGISTRY_BASE_SEPOLIA = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address internal constant IDENTITY_REGISTRY_BASE = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant IDENTITY_REGISTRY_BASE_SEPOLIA = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    /// @notice Everything the deployment needs, read from env and validated before broadcasting.
    struct Config {
        uint256 deployerKey;
        address operator;
        address feeWallet;
        address trustedEvaluator;
        uint256 feeBps;
        uint256 evaluatorFeeBps;
        uint256 minFeedbackBudget;
        address usdc;
        address reputationRegistry;
        address identityRegistry;
    }

    error MissingEnv(string name);
    error NotAContract(string name, address value);
    error InvalidFees(uint256 platformFeeBP, uint256 evaluatorFeeBP);

    function run() external returns (AgentJobEscrow escrow, ReputationHook hook) {
        Config memory cfg = readConfig();

        console.log("Deploying to chain:   ", block.chainid);
        console.log("Token (USDC):         ", cfg.usdc);
        console.log("Fee wallet:           ", cfg.feeWallet);
        console.log("Operator:             ", cfg.operator);
        console.log("Trusted evaluator:    ", cfg.trustedEvaluator);
        console.log("Platform fee bps:     ", cfg.feeBps);
        console.log("Evaluator fee bps:    ", cfg.evaluatorFeeBps);
        console.log("Min feedback budget:  ", cfg.minFeedbackBudget);
        console.log("Reputation registry:  ", cfg.reputationRegistry);
        console.log("Identity registry:    ", cfg.identityRegistry);

        if (cfg.deployerKey != 0) vm.startBroadcast(cfg.deployerKey);
        else vm.startBroadcast();

        // 1. Escrow — the hook needs its address, so it goes first.
        escrow = new AgentJobEscrow(cfg.usdc, cfg.feeWallet, cfg.operator, cfg.evaluatorFeeBps, cfg.feeBps);
        console.log("AgentJobEscrow:", address(escrow));

        // 2. Hook — attached per job by the backend via createJob(..., hook).
        hook = new ReputationHook(
            address(escrow), cfg.reputationRegistry, cfg.identityRegistry, cfg.trustedEvaluator, cfg.minFeedbackBudget
        );
        console.log("ReputationHook:", address(hook));

        vm.stopBroadcast();

        // Output for .env
        string memory chainId = vm.toString(block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log(string.concat("AGENT_JOB_ESCROW_ADDRESS_", chainId, "=", vm.toString(address(escrow))));
        console.log(string.concat("REPUTATION_HOOK_ADDRESS_", chainId, "=", vm.toString(address(hook))));
        console.log("--------------------");
    }

    /// @notice Reads the configuration from env and validates it (addresses must have code, fees must sum below 10 000).
    function readConfig() public view returns (Config memory cfg) {
        cfg.deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        cfg.operator = vm.envAddress("OPERATOR_ADDRESS");
        cfg.feeWallet = vm.envAddress("FEE_WALLET");
        cfg.trustedEvaluator = vm.envAddress("TRUSTED_EVALUATOR");
        cfg.feeBps = vm.envOr("FEE_BPS", uint256(30));
        cfg.evaluatorFeeBps = vm.envOr("EVALUATOR_FEE_BPS", uint256(0));
        cfg.minFeedbackBudget = vm.envOr("MIN_FEEDBACK_BUDGET", uint256(1_000_000));
        cfg.usdc = resolveContract("USDC_ADDRESS", defaultUsdc(block.chainid));
        cfg.reputationRegistry =
            resolveContract("REPUTATION_REGISTRY_ADDRESS", defaultReputationRegistry(block.chainid));
        cfg.identityRegistry = resolveContract("IDENTITY_REGISTRY_ADDRESS", defaultIdentityRegistry(block.chainid));
        if (cfg.feeBps + cfg.evaluatorFeeBps >= BPS_DENOMINATOR) revert InvalidFees(cfg.feeBps, cfg.evaluatorFeeBps);
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

    /// @notice Default ERC-8004 Identity Registry for the chains AgentFi targets (zero elsewhere).
    function defaultIdentityRegistry(uint256 chainId) public pure returns (address) {
        if (chainId == CHAIN_BASE) return IDENTITY_REGISTRY_BASE;
        if (chainId == CHAIN_BASE_SEPOLIA) return IDENTITY_REGISTRY_BASE_SEPOLIA;
        return address(0);
    }

    /// @notice Reads an optional address env var, falling back to `fallbackValue`; reverts if the
    ///         result is zero (`MissingEnv`) or has no code on this chain (`NotAContract`).
    function resolveContract(string memory name, address fallbackValue) public view returns (address value) {
        value = vm.envOr(name, fallbackValue);
        if (value == address(0)) revert MissingEnv(name);
        if (value.code.length == 0) revert NotAContract(name, value);
    }
}
