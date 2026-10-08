// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployEscrowScript} from "../script/DeployEscrow.s.sol";
import {DeployScript} from "../script/Deploy.s.sol";
import {DeployGuards} from "../script/DeployGuards.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {AgentPolicyModule} from "../src/AgentPolicyModule.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {EscrowModule} from "../src/EscrowModule.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @dev `vm.setEnv` is process-global and Foundry runs tests in parallel, so every env-dependent
///      scenario (both deploy scripts) lives in the single sequential test below; the other tests
///      never touch env.
contract DeployEscrowScriptTest is Test {
    DeployEscrowScript internal script;
    DeployScript internal coreScript;

    address internal operator = makeAddr("operator");
    address internal feeWallet = makeAddr("feeWallet");
    address internal trustedEvaluator = makeAddr("trustedEvaluator");

    function setUp() public {
        script = new DeployEscrowScript();
        coreScript = new DeployScript();
    }

    function test_DefaultAddresses() public view {
        assertEq(script.defaultUsdc(8453), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(script.defaultReputationRegistry(8453), 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63);
        assertEq(script.defaultIdentityRegistry(8453), 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
        assertEq(script.defaultUsdc(84532), 0x036CbD53842c5426634e7929541eC2318f3dCF7e);
        assertEq(script.defaultReputationRegistry(84532), 0x8004B663056A597Dffe9eCcC1965A193B7388713);
        assertEq(script.defaultIdentityRegistry(84532), 0x8004A818BFB912233c491871b3d84c89A494BD9e);
        assertEq(script.defaultUsdc(1), address(0));
        assertEq(script.defaultReputationRegistry(1), address(0));
        assertEq(script.defaultIdentityRegistry(1), address(0));
        assertEq(script.defaultUsdc(31337), address(0));
    }

    function test_GasLimitDefaultsAndBounds_MatchTheHook() public {
        assertEq(script.DEFAULT_FEEDBACK_GAS_LIMIT(), 500_000);
        assertEq(script.DEFAULT_IDENTITY_CALL_GAS_LIMIT(), 50_000);
        ReputationHook hook = new ReputationHook(
            address(this),
            address(this),
            address(this),
            trustedEvaluator,
            0,
            script.DEFAULT_FEEDBACK_GAS_LIMIT(),
            script.DEFAULT_IDENTITY_CALL_GAS_LIMIT()
        );
        // The script mirrors the constructor bounds so it can refuse a typo before broadcasting.
        assertEq(script.MIN_FEEDBACK_GAS_LIMIT(), hook.MIN_FEEDBACK_GAS_LIMIT());
        assertEq(script.MAX_FEEDBACK_GAS_LIMIT(), hook.MAX_FEEDBACK_GAS_LIMIT());
        assertEq(script.MIN_IDENTITY_CALL_GAS_LIMIT(), hook.MIN_IDENTITY_CALL_GAS_LIMIT());
        assertEq(script.MAX_IDENTITY_CALL_GAS_LIMIT(), hook.MAX_IDENTITY_CALL_GAS_LIMIT());
    }

    function test_BoundedGasLimit_UnsetUsesFallback() public view {
        assertEq(script.boundedGasLimit("AGENTFI_TEST_UNSET_VAR", 42, 1, 100), 42);
    }

    function test_BoundedGasLimit_FallbackOutOfBounds_Reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(DeployEscrowScript.InvalidGasLimit.selector, "AGENTFI_TEST_UNSET_VAR", 0, 1, 100)
        );
        script.boundedGasLimit("AGENTFI_TEST_UNSET_VAR", 0, 1, 100);
    }

    function test_ResolveContract_MissingEnvAndZeroFallback_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DeployGuards.MissingEnv.selector, "AGENTFI_TEST_UNSET_VAR"));
        script.resolveContract("AGENTFI_TEST_UNSET_VAR", address(0));
    }

    function test_ResolveContract_FallbackWithoutCode_Reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(DeployEscrowScript.NotAContract.selector, "AGENTFI_TEST_UNSET_VAR", operator)
        );
        script.resolveContract("AGENTFI_TEST_UNSET_VAR", operator);
    }

    function test_ResolveContract_MissingEnv_UsesFallbackWithCode() public {
        address withCode = address(new MockERC20());
        assertEq(script.resolveContract("AGENTFI_TEST_UNSET_VAR", withCode), withCode);
    }

    function test_Run_EnvScenarios_Sequential() public {
        // `Deploy.s.sol`: EXECUTOR_FEE_BPS has no default (it used to share FEE_BPS with the escrow).
        // Checked first, while no scenario has set it (skipped if the shell exports it).
        if (vm.envOr("EXECUTOR_FEE_BPS", type(uint256).max) == type(uint256).max) {
            vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
            vm.setEnv("PRIVATE_KEY", "0");
            vm.setEnv("OPERATOR_ADDRESS", vm.toString(operator));
            vm.setEnv("FEE_WALLET", vm.toString(feeWallet));
            vm.expectRevert(abi.encodeWithSelector(DeployGuards.MissingEnv.selector, "EXECUTOR_FEE_BPS"));
            coreScript.readConfig();
        }
        _deployEscrowScenarios();
        _chainGuardScenarios();
        _signerScenarios();
        _coreDeployScenarios();
    }

    function _deployEscrowScenarios() internal {
        vm.setEnv("PRIVATE_KEY", vm.toString(uint256(0xA11CE)));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(operator));
        vm.setEnv("FEE_WALLET", vm.toString(feeWallet));
        vm.setEnv("TRUSTED_EVALUATOR", vm.toString(trustedEvaluator));
        vm.setEnv("FEE_BPS", "30");
        vm.setEnv("EVALUATOR_FEE_BPS", "0");
        vm.setEnv("EXPECTED_CHAIN_ID", "84532");

        // 1. Base Sepolia: token and both registries resolve from the chain-id defaults, which must have code.
        vm.chainId(84532);
        address usdc = script.defaultUsdc(84532);
        address reputation = script.defaultReputationRegistry(84532);
        address identity = script.defaultIdentityRegistry(84532);
        vm.etch(usdc, address(new MockERC20()).code);
        vm.etch(reputation, address(new MockReputationRegistry()).code);
        vm.etch(identity, address(new MockIdentityRegistry()).code);

        (AgentJobEscrow escrow, ReputationHook hook) = script.run();

        assertEq(escrow.token(), usdc);
        assertEq(escrow.feeWallet(), feeWallet);
        assertEq(escrow.operator(), operator);
        assertEq(escrow.platformFeeBP(), 30);
        assertEq(escrow.evaluatorFeeBP(), 0);
        assertEq(hook.acp(), address(escrow));
        assertEq(hook.reputationRegistry(), reputation);
        assertEq(hook.identityRegistry(), identity);
        assertEq(hook.trustedEvaluator(), trustedEvaluator);
        assertEq(hook.minFeedbackBudget(), 1_000_000);
        assertEq(hook.feedbackGasLimit(), 500_000);
        assertEq(hook.identityCallGasLimit(), 50_000);
        assertEq(hook.feedbackGasRequirement(), 597_937);
        assertEq(hook.canonicalBindGasRequirement(), 140_794);

        // 2. Explicit env vars override the defaults (and allow any chain); PRIVATE_KEY=0 selects the
        //    CLI signer path (`--account` / `--ledger`), i.e. `vm.startBroadcast()` without a key.
        MockERC20 customUsdc = new MockERC20();
        MockReputationRegistry customReputation = new MockReputationRegistry();
        MockIdentityRegistry customIdentity = new MockIdentityRegistry();
        vm.setEnv("PRIVATE_KEY", "0");
        vm.setEnv("USDC_ADDRESS", vm.toString(address(customUsdc)));
        vm.setEnv("REPUTATION_REGISTRY_ADDRESS", vm.toString(address(customReputation)));
        vm.setEnv("IDENTITY_REGISTRY_ADDRESS", vm.toString(address(customIdentity)));
        vm.setEnv("FEE_BPS", "15");
        vm.setEnv("EVALUATOR_FEE_BPS", "5");
        vm.setEnv("MIN_FEEDBACK_BUDGET", "5000000");
        vm.setEnv("FEEDBACK_GAS_LIMIT", "600000");
        vm.setEnv("IDENTITY_CALL_GAS_LIMIT", "60000");
        vm.chainId(31337);
        vm.setEnv("EXPECTED_CHAIN_ID", "31337");

        (escrow, hook) = script.run();

        assertEq(escrow.token(), address(customUsdc));
        assertEq(escrow.platformFeeBP(), 15);
        assertEq(escrow.evaluatorFeeBP(), 5);
        assertEq(hook.acp(), address(escrow));
        assertEq(hook.reputationRegistry(), address(customReputation));
        assertEq(hook.identityRegistry(), address(customIdentity));
        assertEq(hook.trustedEvaluator(), trustedEvaluator);
        assertEq(hook.minFeedbackBudget(), 5_000_000);
        assertEq(hook.feedbackGasLimit(), 600_000);
        assertEq(hook.identityCallGasLimit(), 60_000);

        // 3. Gas limits outside the hook's bounds are refused before anything is broadcast; the
        //    bounds themselves deploy.
        _expectGasLimitRevert("FEEDBACK_GAS_LIMIT", 249_999, 250_000, 2_000_000);
        _expectGasLimitRevert("FEEDBACK_GAS_LIMIT", 2_000_001, 250_000, 2_000_000);
        vm.setEnv("FEEDBACK_GAS_LIMIT", "2000000");
        (, hook) = script.run();
        assertEq(hook.feedbackGasLimit(), 2_000_000);
        vm.setEnv("FEEDBACK_GAS_LIMIT", "500000");

        _expectGasLimitRevert("IDENTITY_CALL_GAS_LIMIT", 19_999, 20_000, 200_000);
        _expectGasLimitRevert("IDENTITY_CALL_GAS_LIMIT", 200_001, 20_000, 200_000);
        vm.setEnv("IDENTITY_CALL_GAS_LIMIT", "20000");
        (, hook) = script.run();
        assertEq(hook.identityCallGasLimit(), 20_000);
        vm.setEnv("IDENTITY_CALL_GAS_LIMIT", "50000");

        // 4. A registry address without code is refused before anything is broadcast.
        address eoa = makeAddr("eoa");
        vm.setEnv("REPUTATION_REGISTRY_ADDRESS", vm.toString(eoa));
        vm.expectRevert(
            abi.encodeWithSelector(DeployEscrowScript.NotAContract.selector, "REPUTATION_REGISTRY_ADDRESS", eoa)
        );
        script.run();
        vm.setEnv("REPUTATION_REGISTRY_ADDRESS", vm.toString(address(customReputation)));

        vm.setEnv("IDENTITY_REGISTRY_ADDRESS", vm.toString(eoa));
        vm.expectRevert(
            abi.encodeWithSelector(DeployEscrowScript.NotAContract.selector, "IDENTITY_REGISTRY_ADDRESS", eoa)
        );
        script.run();
        vm.setEnv("IDENTITY_REGISTRY_ADDRESS", vm.toString(address(customIdentity)));

        // 5. FEE_BPS > 9999 (and any sum reaching 10 000) is refused before anything is broadcast.
        vm.setEnv("FEE_BPS", "10000");
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowScript.InvalidFees.selector, 10_000, 5));
        script.run();

        vm.setEnv("FEE_BPS", "9995");
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowScript.InvalidFees.selector, 9_995, 5));
        script.readConfig();

        // 6. The largest valid sum still deploys.
        vm.setEnv("FEE_BPS", "9994");
        (escrow,) = script.run();
        assertEq(escrow.platformFeeBP() + escrow.evaluatorFeeBP(), 9_999);
        vm.setEnv("FEE_BPS", "30");
    }

    /// @dev C2b: `EXPECTED_CHAIN_ID` is mandatory and must match the RPC, for both scripts, before
    ///      anything is broadcast (`--rpc-url base` instead of `base_sepolia` used to deploy against
    ///      real USDC with mainnet defaults).
    function _chainGuardScenarios() internal {
        vm.setEnv("EXECUTOR_FEE_BPS", "30");
        vm.chainId(8453); // the RPC answers Base mainnet ...
        vm.setEnv("EXPECTED_CHAIN_ID", "84532"); // ... but the operator meant Base Sepolia
        bytes memory wrong = abi.encodeWithSelector(DeployGuards.WrongChain.selector, 84532, 8453);
        vm.expectRevert(wrong);
        script.readConfig();
        vm.expectRevert(wrong);
        script.run();
        vm.expectRevert(wrong);
        coreScript.readConfig();
        vm.expectRevert(wrong);
        coreScript.run();

        // Unset (0 is treated as unset: forge cannot unset an env var once a test set it).
        vm.setEnv("EXPECTED_CHAIN_ID", "0");
        bytes memory missing = abi.encodeWithSelector(DeployGuards.MissingEnv.selector, "EXPECTED_CHAIN_ID");
        vm.expectRevert(missing);
        script.run();
        vm.expectRevert(missing);
        coreScript.run();

        vm.setEnv("EXPECTED_CHAIN_ID", "8453");
        assertEq(script.requireExpectedChain(), 8453);
        vm.chainId(31337);
        vm.setEnv("EXPECTED_CHAIN_ID", "31337");
    }

    /// @dev C2b: a `PRIVATE_KEY` (environment or the auto-loaded `packages/contracts/.env`) that differs
    ///      from the CLI signer is refused; `PRIVATE_KEY` unset (or 0) uses the CLI signer (keystore path).
    function _signerScenarios() internal {
        uint256 key = 0xA11CE;
        address keySigner = vm.addr(key);
        address keystoreSigner = makeAddr("keystore-signer");
        vm.setEnv("PRIVATE_KEY", vm.toString(key));

        // `forge script --account <keystore>` runs the script with tx.origin = the keystore address.
        bytes memory conflict =
            abi.encodeWithSelector(DeployGuards.SignerConflict.selector, keystoreSigner, keySigner);
        vm.prank(keystoreSigner, keystoreSigner);
        vm.expectRevert(conflict);
        script.readConfig();
        vm.prank(keystoreSigner, keystoreSigner);
        vm.expectRevert(conflict);
        coreScript.readConfig();

        // The same address on both sides is not a conflict, and no CLI signer (DEFAULT_SENDER) uses the key.
        vm.prank(keySigner, keySigner);
        assertEq(script.readConfig().deployerKey, key);
        assertEq(script.resolveDeployerKey(), key);

        // Keystore path: PRIVATE_KEY unset -> no key, `vm.startBroadcast()` with the CLI signer.
        vm.setEnv("PRIVATE_KEY", "0");
        vm.prank(keystoreSigner, keystoreSigner);
        assertEq(script.readConfig().deployerKey, 0);
        (AgentJobEscrow escrow,) = script.run();
        assertEq(escrow.operator(), operator);
    }

    /// @dev C2b: `Deploy.s.sol` — own `EXECUTOR_FEE_BPS`, keystore signer, legacy `EscrowModule` opt-in.
    function _coreDeployScenarios() internal {
        // EXECUTOR_FEE_BPS is independent of the escrow's FEE_BPS.
        vm.setEnv("FEE_BPS", "15");
        vm.setEnv("EXECUTOR_FEE_BPS", "25");
        vm.setEnv("DEPLOY_LEGACY_ESCROW_MODULE", "false");
        (AgentPolicyModule policy, AgentExecutor executor, EscrowModule legacy) = coreScript.run();
        assertEq(policy.operator(), operator);
        assertEq(address(executor.policyModule()), address(policy));
        assertEq(executor.feeWallet(), feeWallet);
        assertEq(executor.feeBps(), 25);
        assertEq(address(legacy), address(0), "the legacy EscrowModule is not deployed by default");

        vm.setEnv("DEPLOY_LEGACY_ESCROW_MODULE", "true");
        (,, legacy) = coreScript.run();
        assertTrue(address(legacy) != address(0));
        assertEq(legacy.operator(), operator);
        vm.setEnv("DEPLOY_LEGACY_ESCROW_MODULE", "false");

        // PRIVATE_KEY set: broadcasts with the key (no CLI signer in a test).
        vm.setEnv("PRIVATE_KEY", vm.toString(uint256(0xB0B)));
        (, executor,) = coreScript.run();
        assertEq(executor.feeBps(), 25);
        vm.setEnv("PRIVATE_KEY", "0");

        // Fee bounds: 9 999 deploys, 10 000 is refused before broadcasting.
        vm.setEnv("EXECUTOR_FEE_BPS", "9999");
        (, executor,) = coreScript.run();
        assertEq(executor.feeBps(), 9_999);
        vm.setEnv("EXECUTOR_FEE_BPS", "10000");
        vm.expectRevert(abi.encodeWithSelector(DeployScript.InvalidExecutorFee.selector, 10_000));
        coreScript.run();
        vm.setEnv("EXECUTOR_FEE_BPS", "0");
        (, executor,) = coreScript.run();
        assertEq(executor.feeBps(), 0);
    }

    /// @dev Sets `name` to `value` and expects both `readConfig` and `run` to refuse it.
    function _expectGasLimitRevert(string memory name, uint256 value, uint256 min, uint256 max) internal {
        vm.setEnv(name, vm.toString(value));
        bytes memory err = abi.encodeWithSelector(DeployEscrowScript.InvalidGasLimit.selector, name, value, min, max);
        vm.expectRevert(err);
        script.readConfig();
        vm.expectRevert(err);
        script.run();
    }
}
