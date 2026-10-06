// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployEscrowScript} from "../script/DeployEscrow.s.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @dev `vm.setEnv` is process-global and Foundry runs tests in parallel, so every env-dependent
///      scenario lives in the single sequential test below; the other tests never touch env.
contract DeployEscrowScriptTest is Test {
    DeployEscrowScript internal script;

    address internal operator = makeAddr("operator");
    address internal feeWallet = makeAddr("feeWallet");
    address internal trustedEvaluator = makeAddr("trustedEvaluator");

    function setUp() public {
        script = new DeployEscrowScript();
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

    function test_ResolveContract_MissingEnvAndZeroFallback_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowScript.MissingEnv.selector, "AGENTFI_TEST_UNSET_VAR"));
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

    function test_Run_DefaultsThenOverridesThenValidation() public {
        vm.setEnv("PRIVATE_KEY", vm.toString(uint256(0xA11CE)));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(operator));
        vm.setEnv("FEE_WALLET", vm.toString(feeWallet));
        vm.setEnv("TRUSTED_EVALUATOR", vm.toString(trustedEvaluator));
        vm.setEnv("FEE_BPS", "30");
        vm.setEnv("EVALUATOR_FEE_BPS", "0");

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
        vm.chainId(31337);

        (escrow, hook) = script.run();

        assertEq(escrow.token(), address(customUsdc));
        assertEq(escrow.platformFeeBP(), 15);
        assertEq(escrow.evaluatorFeeBP(), 5);
        assertEq(hook.acp(), address(escrow));
        assertEq(hook.reputationRegistry(), address(customReputation));
        assertEq(hook.identityRegistry(), address(customIdentity));
        assertEq(hook.trustedEvaluator(), trustedEvaluator);
        assertEq(hook.minFeedbackBudget(), 5_000_000);

        // 3. A registry address without code is refused before anything is broadcast.
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

        // 4. FEE_BPS > 9999 (and any sum reaching 10 000) is refused before anything is broadcast.
        vm.setEnv("FEE_BPS", "10000");
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowScript.InvalidFees.selector, 10_000, 5));
        script.run();

        vm.setEnv("FEE_BPS", "9995");
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowScript.InvalidFees.selector, 9_995, 5));
        script.readConfig();

        // 5. The largest valid sum still deploys.
        vm.setEnv("FEE_BPS", "9994");
        (escrow,) = script.run();
        assertEq(escrow.platformFeeBP() + escrow.evaluatorFeeBP(), 9_999);
    }
}
