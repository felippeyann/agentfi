// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceMandate} from "../src/InvoiceMandate.sol";
import {InvoiceMandateScript} from "../script/InvoiceMandate.s.sol";
import {MockTUSD8} from "./mocks/MockTUSD8.sol";

/// @dev The owner's three transactions, simulated on "Aevum" (chain id 44005, a mock token at the official tUSD8 address).
contract InvoiceMandateScriptTest is Test {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    InvoiceMandateScript internal script;
    MockTUSD8 internal token;

    function setUp() public {
        vm.chainId(44005);
        vm.etch(AEVUM_TUSD8, address(new MockTUSD8()).code);
        vm.store(AEVUM_TUSD8, bytes32(uint256(0)), bytes32(uint256(6))); // decimals = 6 (slot 0)
        token = MockTUSD8(AEVUM_TUSD8);
        token.mint(DEFAULT_SENDER, 10e6);
        script = new InvoiceMandateScript();
    }

    function test_threeTransactions_deployDepositSetMandate() public {
        InvoiceMandate vault = script.deploy();
        assertEq(vault.operator(), DEFAULT_SENDER, "the signer is the operator");
        assertEq(address(vault.token()), AEVUM_TUSD8);

        script.deposit(vault, 1e6);
        assertEq(token.balanceOf(address(vault)), 1e6);

        address agent = makeAddr("agent");
        address payTo = makeAddr("payTo");
        script.setMandate(vault, agent, "acme", payTo, 1e6, 1e6, 7);
        (address a, uint40 exp,, address p, uint48 cap, uint48 daily, bytes32 vendor) = vault.mandate();
        assertEq(a, agent);
        assertEq(p, payTo);
        assertEq(cap, 1e6);
        assertEq(daily, 1e6);
        assertEq(vendor, bytes32("acme"));
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
}
