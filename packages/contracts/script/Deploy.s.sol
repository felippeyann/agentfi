// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console} from "forge-std/Script.sol";
import {DeployGuards} from "./DeployGuards.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {EscrowModule} from "../src/EscrowModule.sol";

/**
 * @title Deploy
 * @notice Deploys `AgentPolicyModule` and `AgentExecutor` (and, only on request, the legacy
 *         `EscrowModule`) to the target network. The ERC-8183 escrow and its ERC-8004 hook are
 *         deployed by `DeployEscrow.s.sol`.
 *
 * Usage (keystore signer, preferred — the key never touches the environment):
 *   cast wallet import agentfi-deployer --interactive
 *   EXPECTED_CHAIN_ID=84532 OPERATOR_ADDRESS=0x… FEE_WALLET=0x… EXECUTOR_FEE_BPS=30 \
 *   forge script script/Deploy.s.sol \
 *     --rpc-url base_sepolia \
 *     --account agentfi-deployer \
 *     --broadcast \
 *     --verify
 *
 * `--verify` uses Etherscan API V2 (one `ETHERSCAN_API_KEY` for every chain, see `foundry.toml`).
 * `--ledger`, `--trezor` and `--private-key` work the same way (`vm.startBroadcast()` without a
 * key uses the CLI signer). `PRIVATE_KEY` is still accepted but discouraged: the script warns, and
 * refuses a `PRIVATE_KEY` that differs from the CLI signer (`SignerConflict`), because forge
 * auto-loads `packages/contracts/.env` and a key there used to override `--account` silently.
 *
 * Required env vars:
 *   EXPECTED_CHAIN_ID           — chain id the deployment is meant for (84532 Base Sepolia, 8453 Base);
 *                                 must equal the RPC's chain id or nothing is broadcast (`WrongChain`)
 *   OPERATOR_ADDRESS            — may set/pause policies (and operate the legacy escrow module)
 *   FEE_WALLET                  — receives the executor's protocol fee (backend `OPERATOR_FEE_WALLET`)
 *   EXECUTOR_FEE_BPS            — `AgentExecutor.feeBps`, below 10 000. Its own variable since C2b:
 *                                 `FEE_BPS` is the escrow's platform fee (`DeployEscrow.s.sol`). The
 *                                 backend pre-estimates executor fees with 30 bps.
 *
 * Optional env vars (defaults in brackets):
 *   PRIVATE_KEY                 — deployer EOA private key [unset or 0: use the CLI signer above]
 *   DEPLOY_LEGACY_ESCROW_MODULE — `true` also deploys the legacy ETH `EscrowModule` [false]. New jobs
 *                                 use `AgentJobEscrow` (decision D8); the legacy module is only kept
 *                                 for ETH jobs until it is retired.
 */
contract DeployScript is DeployGuards {
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Everything the deployment needs, read from env and validated before broadcasting.
    struct Config {
        uint256 expectedChainId;
        uint256 deployerKey;
        address operator;
        address feeWallet;
        uint256 executorFeeBps;
        bool deployLegacyEscrowModule;
    }

    /// @notice `EXECUTOR_FEE_BPS` is not below 10 000.
    error InvalidExecutorFee(uint256 executorFeeBps);

    function run()
        external
        returns (AgentPolicyModule policyModule, AgentExecutor executor, EscrowModule escrowModule)
    {
        Config memory cfg = readConfig();

        _logChainAndSigner(cfg.expectedChainId, cfg.deployerKey);
        console.log("Operator:             ", cfg.operator);
        console.log("Fee wallet:           ", cfg.feeWallet);
        console.log("Executor fee bps:     ", cfg.executorFeeBps);
        console.log("Legacy EscrowModule:  ", cfg.deployLegacyEscrowModule ? "deploy" : "skip");

        _startBroadcast(cfg.deployerKey);

        // 1. Policy module — enforces per-agent constraints on-chain.
        policyModule = new AgentPolicyModule(cfg.operator);
        console.log("AgentPolicyModule:", address(policyModule));

        // 2. Executor — atomic batch runner with fee collection.
        executor = new AgentExecutor(address(policyModule), cfg.feeWallet, cfg.executorFeeBps);
        console.log("AgentExecutor:    ", address(executor));

        // 3. Legacy escrow module (ETH A2A payments) — opt-in only (D8).
        if (cfg.deployLegacyEscrowModule) {
            escrowModule = new EscrowModule(cfg.operator);
            console.log("EscrowModule:     ", address(escrowModule));
        }

        vm.stopBroadcast();

        // Output for the backend .env (names as in packages/backend/src/config/env.ts).
        string memory chainId = vm.toString(block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log(string.concat("POLICY_MODULE_ADDRESS_", chainId, "=", vm.toString(address(policyModule))));
        console.log(string.concat("EXECUTOR_ADDRESS_", chainId, "=", vm.toString(address(executor))));
        if (cfg.deployLegacyEscrowModule) {
            console.log(string.concat("ESCROW_MODULE_ADDRESS_", chainId, "=", vm.toString(address(escrowModule))));
        }
        console.log(string.concat("OPERATOR_FEE_WALLET=", vm.toString(cfg.feeWallet)));
        console.log("--------------------");
    }

    /// @notice Reads the configuration from env and validates it (the chain must be
    ///         `EXPECTED_CHAIN_ID`, `PRIVATE_KEY` must not contradict the CLI signer, the executor
    ///         fee must be below 10 000 bps).
    function readConfig() public view returns (Config memory cfg) {
        cfg.expectedChainId = requireExpectedChain();
        cfg.deployerKey = resolveDeployerKey();
        cfg.operator = vm.envAddress("OPERATOR_ADDRESS");
        cfg.feeWallet = vm.envAddress("FEE_WALLET");
        cfg.executorFeeBps = vm.envOr("EXECUTOR_FEE_BPS", type(uint256).max);
        if (cfg.executorFeeBps == type(uint256).max) revert MissingEnv("EXECUTOR_FEE_BPS");
        if (cfg.executorFeeBps >= BPS_DENOMINATOR) revert InvalidExecutorFee(cfg.executorFeeBps);
        cfg.deployLegacyEscrowModule = vm.envOr("DEPLOY_LEGACY_ESCROW_MODULE", false);
    }
}
