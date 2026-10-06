// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployEscrowScript} from "../script/DeployEscrow.s.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev `vm.setEnv` is process-global and Foundry runs tests in parallel, so every env-dependent
///      scenario lives in the single sequential test below; the other tests never touch env.
contract DeployEscrowScriptTest is Test {
    DeployEscrowScript internal script;

    address internal operator = makeAddr("operator");
    address internal feeWallet = makeAddr("feeWallet");

    function setUp() public {
        script = new DeployEscrowScript();
    }

    function test_DefaultAddresses() public view {
        assertEq(script.defaultUsdc(8453), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(script.defaultReputationRegistry(8453), 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63);
        assertEq(script.defaultUsdc(84532), 0x036CbD53842c5426634e7929541eC2318f3dCF7e);
        assertEq(script.defaultReputationRegistry(84532), 0x8004B663056A597Dffe9eCcC1965A193B7388713);
        assertEq(script.defaultUsdc(1), address(0));
        assertEq(script.defaultReputationRegistry(1), address(0));
        assertEq(script.defaultUsdc(31337), address(0));
    }

    function test_ResolveAddress_MissingEnvAndZeroFallback_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowScript.MissingEnv.selector, "AGENTFI_TEST_UNSET_VAR"));
        script.resolveAddress("AGENTFI_TEST_UNSET_VAR", address(0));
    }

    function test_ResolveAddress_MissingEnv_UsesFallback() public view {
        assertEq(script.resolveAddress("AGENTFI_TEST_UNSET_VAR", operator), operator);
    }

    function test_Run_DefaultsThenOverrides() public {
        vm.setEnv("PRIVATE_KEY", vm.toString(uint256(0xA11CE)));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(operator));
        vm.setEnv("FEE_WALLET", vm.toString(feeWallet));
        vm.setEnv("FEE_BPS", "30");
        vm.setEnv("EVALUATOR_FEE_BPS", "0");

        // 1. Base Sepolia: token and registry resolve from the chain-id defaults.
        vm.chainId(84532);
        address usdc = script.defaultUsdc(84532);
        vm.etch(usdc, address(new MockERC20()).code);

        (AgentJobEscrow escrow, ReputationHook hook) = script.run();

        assertEq(escrow.token(), usdc);
        assertEq(escrow.feeWallet(), feeWallet);
        assertEq(escrow.operator(), operator);
        assertEq(escrow.platformFeeBP(), 30);
        assertEq(escrow.evaluatorFeeBP(), 0);
        assertEq(hook.acp(), address(escrow));
        assertEq(hook.reputationRegistry(), script.defaultReputationRegistry(84532));

        // 2. Explicit env vars override the defaults (and allow any chain).
        MockERC20 customUsdc = new MockERC20();
        address customRegistry = makeAddr("registry");
        vm.setEnv("USDC_ADDRESS", vm.toString(address(customUsdc)));
        vm.setEnv("REPUTATION_REGISTRY_ADDRESS", vm.toString(customRegistry));
        vm.setEnv("FEE_BPS", "15");
        vm.setEnv("EVALUATOR_FEE_BPS", "5");
        vm.chainId(31337);

        (escrow, hook) = script.run();

        assertEq(escrow.token(), address(customUsdc));
        assertEq(escrow.platformFeeBP(), 15);
        assertEq(escrow.evaluatorFeeBP(), 5);
        assertEq(hook.acp(), address(escrow));
        assertEq(hook.reputationRegistry(), customRegistry);
    }
}
