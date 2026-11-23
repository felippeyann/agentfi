// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceMandate, ITUSD8} from "../src/InvoiceMandate.sol";
import {InvoiceMandateScript} from "../script/InvoiceMandate.s.sol";
import {MockTUSD8} from "./mocks/MockTUSD8.sol";

/// @dev The owner's three transactions, simulated on "Aevum" (chain id 44005, a mock token at the official tUSD8 address).
///      Tests that set an environment flag assert both sides of it in ONE function (the process env is shared).
contract InvoiceMandateScriptTest is Test {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    InvoiceMandateScript internal script;
    MockTUSD8 internal token;
    address internal agent = makeAddr("agent");
    address internal payTo = makeAddr("payTo");

    function setUp() public {
        vm.chainId(44005);
        vm.etch(AEVUM_TUSD8, address(new MockTUSD8()).code);
        vm.store(AEVUM_TUSD8, bytes32(uint256(0)), bytes32(uint256(6))); // decimals = 6 (slot 0)
        token = MockTUSD8(AEVUM_TUSD8);
        token.mint(DEFAULT_SENDER, 10e6);
        vm.setEnv("EXPECTED_OPERATOR", vm.toString(DEFAULT_SENDER));
        script = new InvoiceMandateScript();
    }

    function test_threeTransactions_deployDepositSetMandate() public {
        InvoiceMandate vault = script.deploy();
        assertEq(vault.operator(), DEFAULT_SENDER, "the signer is the operator");
        assertEq(address(vault.token()), AEVUM_TUSD8);

        script.deposit(vault, 1e6);
        assertEq(token.balanceOf(address(vault)), 1e6);

        script.setMandate(vault, agent, "vendor-1", payTo, 1e6, 1e6, 7);
        (address a, uint40 exp,, address p, uint48 cap, uint48 daily, bytes32 vendor) = vault.mandate();
        assertEq(a, agent);
        assertEq(p, payTo);
        assertEq(cap, 1e6);
        assertEq(daily, 1e6);
        assertEq(vendor, bytes32("vendor-1"));
        assertEq(exp, block.timestamp + 7 days);
    }

    function test_refusesAnotherChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.WrongChain.selector, 44005, 1));
        script.deploy();
    }

    function test_refusesATokenThatIsNotTUSD8() public {
        vm.store(AEVUM_TUSD8, bytes32(uint256(0)), bytes32(uint256(18)));
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.NotTUSD8.selector, AEVUM_TUSD8));
        script.deploy();
    }

    function test_refusesASignerOtherThanTheOperator() public {
        address other = makeAddr("someone else");
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.NotOperator.selector, other, DEFAULT_SENDER));
        script.checkSigner(other, DEFAULT_SENDER);
        script.checkSigner(DEFAULT_SENDER, DEFAULT_SENDER);
    }

    function test_tusd8Override_refusedOn44005() public {
        address fake = makeAddr("fake tUSD8");
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.TokenOverrideRefused.selector, fake));
        script.checkTokenOverride(44005, fake);
        assertEq(script.checkTokenOverride(44005, AEVUM_TUSD8), AEVUM_TUSD8);
        assertEq(script.checkTokenOverride(31337, fake), fake, "other chains may name their token");
    }

    function test_setMandate_refusesAVaultOfAnotherToken() public {
        MockTUSD8 other = new MockTUSD8();
        vm.store(address(other), bytes32(uint256(0)), bytes32(uint256(6)));
        vm.prank(DEFAULT_SENDER);
        InvoiceMandate foreign = new InvoiceMandate(ITUSD8(address(other)));
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.WrongVault.selector, address(other), AEVUM_TUSD8));
        script.setMandate(foreign, agent, "vendor-1", payTo, 1e6, 1e6, 7);
    }

    function test_unusualLimits_refusedUnlessFlagged() public {
        InvoiceMandate vault = script.deploy();
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.UnusualLimits.selector, 9_999, 1e6));
        script.setMandate(vault, agent, "vendor-1", payTo, 9_999, 1e6, 7); // cap below 0.01
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandateScript.UnusualLimits.selector, 1e6, 1_001e6));
        script.setMandate(vault, agent, "vendor-1", payTo, 1e6, 1_001e6, 7); // daily above 1000
        vm.setEnv("ALLOW_UNUSUAL_LIMITS", "true");
        script.setMandate(vault, agent, "vendor-1", payTo, 1e6, 1_001e6, 7);
        vm.setEnv("ALLOW_UNUSUAL_LIMITS", "false");
        (,,,,, uint48 daily,) = vault.mandate();
        assertEq(daily, 1_001e6);
    }

    function test_vendorChange_afterAPayment_refusedUnlessFlagged() public {
        vm.warp(1_795_000_000); // a real date: day() is the UTC day of the last payment
        InvoiceMandate vault = script.deploy();
        script.deposit(vault, 2e6);
        script.setMandate(vault, agent, "vendor-1", payTo, 1e6, 1e6, 7);
        script.setMandate(vault, agent, "vendor-2", payTo, 1e6, 1e6, 7); // nothing paid yet: a free change
        script.setMandate(vault, agent, "vendor-1", payTo, 1e6, 1e6, 7);
        vm.prank(agent);
        vault.payInvoice("INV-1", bytes32("vendor-1"), payTo, 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(InvoiceMandateScript.VendorChange.selector, bytes32("vendor-1"), bytes32("vendor-2"))
        );
        script.setMandate(vault, agent, "vendor-2", payTo, 1e6, 1e6, 7);
        script.setMandate(vault, agent, "vendor-1", makeAddr("new payee"), 1e6, 1e6, 7); // same vendor, new payee: fine
        vm.setEnv("ALLOW_VENDOR_CHANGE", "true");
        script.setMandate(vault, agent, "vendor-2", payTo, 1e6, 1e6, 7);
        vm.setEnv("ALLOW_VENDOR_CHANGE", "false");
        (,,,,,, bytes32 vendor) = vault.mandate();
        assertEq(vendor, bytes32("vendor-2"));
    }
}
