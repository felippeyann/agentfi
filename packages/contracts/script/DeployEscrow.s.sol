// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console} from "forge-std/Script.sol";
import {DeployGuards} from "./DeployGuards.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";

/**
 * @title DeployEscrow
 * @notice Deploys the ERC-8183 `AgentJobEscrow` and its ERC-8004 `ReputationHook`.
 *
 * Usage (keystore signer, preferred — the key never touches the environment):
 *   cast wallet import agentfi-deployer --interactive
 *   EXPECTED_CHAIN_ID=84532 forge script script/DeployEscrow.s.sol \
 *     --rpc-url base_sepolia \
 *     --account agentfi-deployer \
 *     --broadcast \
 *     --verify
 *
 * `--verify` uses Etherscan API V2 (one `ETHERSCAN_API_KEY` for every chain, see `foundry.toml`).
 * `--ledger`, `--trezor` and `--private-key` work the same way (the script calls
 * `vm.startBroadcast()` without a key and Foundry uses the CLI signer). Setting `PRIVATE_KEY`
 * is still supported for backwards compatibility but discouraged: the script warns, and refuses
 * a `PRIVATE_KEY` that differs from the CLI signer (`SignerConflict`) — forge auto-loads
 * `packages/contracts/.env`, so a key left there used to override `--account` silently.
 *
 * Required env vars:
 *   EXPECTED_CHAIN_ID           — chain id the deployment is meant for (84532 Base Sepolia, 8453 Base);
 *                                 must equal the RPC's chain id or nothing is broadcast (`WrongChain`)
 *   OPERATOR_ADDRESS            — may pause/unpause job creation and funding, rotate the fee wallet
 *                                 and sweep accrued platform fees (never moves escrowed budgets)
 *   FEE_WALLET                  — initial receiver of accrued platform fees (`withdrawPlatformFees`)
 *   TRUSTED_EVALUATOR           — backend signer that settles jobs (decision D5): the only evaluator
 *                                 whose settlements write ERC-8004 feedback and the only
 *                                 `revokeFeedback` / `clearPenalties` caller
 *
 * Optional env vars (defaults in brackets):
 *   PRIVATE_KEY                 — deployer EOA private key [unset or 0: use the CLI signer above]
 *   FEE_BPS                     — escrow platform fee in basis points [30] (the executor's fee is
 *                                 `EXECUTOR_FEE_BPS` in `Deploy.s.sol`)
 *   EVALUATOR_FEE_BPS           — evaluator fee in basis points [0]
 *   MIN_FEEDBACK_BUDGET         — minimum job budget (token units) for feedback [1000000 = 1 USDC]
 *   FEEDBACK_GAS_LIMIT          — gas forwarded by the hook to `giveFeedback` [500000; allowed
 *                                 250000..2000000 — the v2.0.0 registry uses 179416]
 *   IDENTITY_CALL_GAS_LIMIT     — gas forwarded to each Identity Registry `ownerOf` /
 *                                 `getAgentWallet` call [50000; allowed 20000..200000 — v2.0.0 uses ~7800]
 *   USDC_ADDRESS               — escrow token [Base: 0x8335…2913, Base Sepolia: 0x036C…CF7e]
 *   REPUTATION_REGISTRY_ADDRESS — ERC-8004 Reputation Registry [Base: 0x8004BAa1…9b63, Base Sepolia: 0x8004B663…8713]
 *   IDENTITY_REGISTRY_ADDRESS   — ERC-8004 Identity Registry [Base: 0x8004A169…a432, Base Sepolia: 0x8004A818…BD9e]
 *
 * On any other chain `USDC_ADDRESS`, `REPUTATION_REGISTRY_ADDRESS` and `IDENTITY_REGISTRY_ADDRESS`
 * are required. The chain must be `EXPECTED_CHAIN_ID`, all three addresses must have code on it,
 * `FEE_BPS + EVALUATOR_FEE_BPS` must be below 10 000 and both gas limits must be within the hook's
 * bounds; everything is validated before the first transaction is broadcast.
 */
contract DeployEscrowScript is DeployGuards {
    uint256 internal constant CHAIN_BASE = 8453;
    uint256 internal constant CHAIN_BASE_SEPOLIA = 84532;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    /// @notice Default `ReputationHook.feedbackGasLimit`: 2.8x the 179 416 gas `giveFeedback` uses on
    ///         the ERC-8004 Reputation Registry v2.0.0 (first entry for an agent, C5a fork run).
    uint256 public constant DEFAULT_FEEDBACK_GAS_LIMIT = 500_000;
    /// @notice Default `ReputationHook.identityCallGasLimit`: 6x the ~7 800 gas of a cold
    ///         `ownerOf` / `getAgentWallet` through the ERC-8004 Identity Registry v2.0.0 proxy.
    uint256 public constant DEFAULT_IDENTITY_CALL_GAS_LIMIT = 50_000;
    /// @notice Mirrors of the `ReputationHook` constructor bounds (constants of another contract are
    ///         not reachable from here; `DeployEscrow.t.sol` pins them to the hook's getters).
    uint256 public constant MIN_FEEDBACK_GAS_LIMIT = 250_000;
    uint256 public constant MAX_FEEDBACK_GAS_LIMIT = 2_000_000;
    uint256 public constant MIN_IDENTITY_CALL_GAS_LIMIT = 20_000;
    uint256 public constant MAX_IDENTITY_CALL_GAS_LIMIT = 200_000;

    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant REPUTATION_REGISTRY_BASE = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address internal constant REPUTATION_REGISTRY_BASE_SEPOLIA = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address internal constant IDENTITY_REGISTRY_BASE = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant IDENTITY_REGISTRY_BASE_SEPOLIA = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    /// @notice Everything the deployment needs, read from env and validated before broadcasting.
    struct Config {
        uint256 expectedChainId;
        uint256 deployerKey;
        address operator;
        address feeWallet;
        address trustedEvaluator;
        uint256 feeBps;
        uint256 evaluatorFeeBps;
        uint256 minFeedbackBudget;
        uint256 feedbackGasLimit;
        uint256 identityCallGasLimit;
        address usdc;
        address reputationRegistry;
        address identityRegistry;
    }

    error NotAContract(string name, address value);
    error InvalidFees(uint256 platformFeeBP, uint256 evaluatorFeeBP);
    error InvalidGasLimit(string name, uint256 value, uint256 min, uint256 max);

    function run() external returns (AgentJobEscrow escrow, ReputationHook hook) {
        Config memory cfg = readConfig();

        _logChainAndSigner(cfg.expectedChainId, cfg.deployerKey);
        console.log("Token (USDC):         ", cfg.usdc);
        console.log("Fee wallet:           ", cfg.feeWallet);
        console.log("Operator:             ", cfg.operator);
        console.log("Trusted evaluator:    ", cfg.trustedEvaluator);
        console.log("Platform fee bps:     ", cfg.feeBps);
        console.log("Evaluator fee bps:    ", cfg.evaluatorFeeBps);
        console.log("Min feedback budget:  ", cfg.minFeedbackBudget);
        console.log("Feedback gas limit:   ", cfg.feedbackGasLimit);
        console.log("Identity call gas:    ", cfg.identityCallGasLimit);
        console.log("Reputation registry:  ", cfg.reputationRegistry);
        console.log("Identity registry:    ", cfg.identityRegistry);

        _startBroadcast(cfg.deployerKey);

        // 1. Escrow — the hook needs its address, so it goes first.
        escrow = new AgentJobEscrow(cfg.usdc, cfg.feeWallet, cfg.operator, cfg.evaluatorFeeBps, cfg.feeBps);
        console.log("AgentJobEscrow:", address(escrow));

        // 2. Hook — attached per job by the backend via createJob(..., hook).
        hook = new ReputationHook(
            address(escrow),
            cfg.reputationRegistry,
            cfg.identityRegistry,
            cfg.trustedEvaluator,
            cfg.minFeedbackBudget,
            cfg.feedbackGasLimit,
            cfg.identityCallGasLimit
        );
        console.log("ReputationHook:", address(hook));
        console.log("Hook gas requirement: ", hook.feedbackGasRequirement());
        console.log("Hook bind requirement:", hook.canonicalBindGasRequirement());

        vm.stopBroadcast();

        // Output for .env
        string memory chainId = vm.toString(block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log(string.concat("AGENT_JOB_ESCROW_ADDRESS_", chainId, "=", vm.toString(address(escrow))));
        console.log(string.concat("REPUTATION_HOOK_ADDRESS_", chainId, "=", vm.toString(address(hook))));
        console.log("--------------------");
    }

    /// @notice Reads the configuration from env and validates it (the chain must be `EXPECTED_CHAIN_ID`,
    ///         `PRIVATE_KEY` must not contradict the CLI signer, addresses must have code, fees must
    ///         sum below 10 000, gas limits must be within the hook's bounds).
    function readConfig() public view returns (Config memory cfg) {
        cfg.expectedChainId = requireExpectedChain();
        cfg.deployerKey = resolveDeployerKey();
        cfg.operator = vm.envAddress("OPERATOR_ADDRESS");
        cfg.feeWallet = vm.envAddress("FEE_WALLET");
        cfg.trustedEvaluator = vm.envAddress("TRUSTED_EVALUATOR");
        cfg.feeBps = vm.envOr("FEE_BPS", uint256(30));
        cfg.evaluatorFeeBps = vm.envOr("EVALUATOR_FEE_BPS", uint256(0));
        cfg.minFeedbackBudget = vm.envOr("MIN_FEEDBACK_BUDGET", uint256(1_000_000));
        cfg.feedbackGasLimit = boundedGasLimit(
            "FEEDBACK_GAS_LIMIT", DEFAULT_FEEDBACK_GAS_LIMIT, MIN_FEEDBACK_GAS_LIMIT, MAX_FEEDBACK_GAS_LIMIT
        );
        cfg.identityCallGasLimit = boundedGasLimit(
            "IDENTITY_CALL_GAS_LIMIT",
            DEFAULT_IDENTITY_CALL_GAS_LIMIT,
            MIN_IDENTITY_CALL_GAS_LIMIT,
            MAX_IDENTITY_CALL_GAS_LIMIT
        );
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

    /// @notice Reads an optional gas-limit env var, falling back to `fallbackValue`; reverts with
    ///         `InvalidGasLimit` when the result is outside [`min`, `max`] (the hook's constructor
    ///         bounds), so a typo is refused before anything is broadcast.
    function boundedGasLimit(string memory name, uint256 fallbackValue, uint256 min, uint256 max)
        public
        view
        returns (uint256 value)
    {
        value = vm.envOr(name, fallbackValue);
        if (value < min || value > max) revert InvalidGasLimit(name, value, min, max);
    }

    /// @notice Reads an optional address env var, falling back to `fallbackValue`; reverts if the
    ///         result is zero (`MissingEnv`) or has no code on this chain (`NotAContract`).
    function resolveContract(string memory name, address fallbackValue) public view returns (address value) {
        value = vm.envOr(name, fallbackValue);
        if (value == address(0)) revert MissingEnv(name);
        if (value.code.length == 0) revert NotAContract(name, value);
    }
}
