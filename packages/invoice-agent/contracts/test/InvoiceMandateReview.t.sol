// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceMandate, ITUSD8} from "../src/InvoiceMandate.sol";
import {BlacklistTUSD8, MockTUSD8} from "./mocks/MockTUSD8.sol";

/// @dev The independent security review's adversarial cases (2026-11-23), asserting the FIXED behaviour; the two that
///      are by design (calendar-day window, dust griefing by a stolen key) assert the documented behaviour.
contract InvoiceMandateReviewTest is Test {
    BlacklistTUSD8 internal token;
    InvoiceMandate internal vault;
    address internal operator = makeAddr("operator");
    address internal agent = makeAddr("agent");
    address internal payA = makeAddr("payA");
    address internal payB = makeAddr("payB");
    bytes32 internal constant A = bytes32("acme");
    bytes32 internal constant B = bytes32("beta");

    function setUp() public {
        vm.warp(1_795_000_000);
        token = new BlacklistTUSD8();
        vm.prank(operator);
        vault = new InvoiceMandate(ITUSD8(address(token)));
        token.mint(address(vault), 1_000e6);
        vm.prank(operator);
        vault.setMandate(agent, A, payA, 10e6, 50e6, uint40(block.timestamp + 30 days));
    }

    function _pay(string memory id, bytes32 vendor, address payTo, uint256 amt) internal {
        vm.prank(agent);
        vault.payInvoice(id, vendor, payTo, amt);
    }

    // P2-1. The agent signed acme's INV-1; the operator switches to beta before it lands: it must NOT pay beta, and
    // beta's own INV-1 stays payable.
    function test_vendorSwitchRace_oldSignedCallReverts_andTheNewVendorsIdStaysFree() public {
        vm.prank(operator);
        vault.setMandate(agent, B, payB, 10e6, 50e6, uint40(block.timestamp + 30 days));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.MandateChanged.selector, B, payB));
        vault.payInvoice("INV-1", A, payA, 7e6); // the bytes the agent signed for acme
        assertEq(token.balanceOf(payB), 0);
        assertEq(token.balanceOf(payA), 0);
        _pay("INV-1", B, payB, 3e6); // beta's genuine INV-1
        assertEq(token.balanceOf(payB), 3e6);
    }

    function test_samePayeeNewVendor_and_sameVendorNewPayee_bothRefuseTheOldCall() public {
        vm.prank(operator);
        vault.setMandate(agent, A, payB, 10e6, 50e6, uint40(block.timestamp + 30 days)); // acme changed its bank details
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.MandateChanged.selector, A, payB));
        vault.payInvoice("INV-1", A, payA, 1e6);
        vm.prank(operator);
        vault.setMandate(agent, B, payB, 10e6, 50e6, uint40(block.timestamp + 30 days));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.MandateChanged.selector, B, payB));
        vault.payInvoice("INV-1", A, payB, 1e6);
    }

    // P2-2. After a vendor change the old vendor's settlement is still found, by vendor or across all vendors.
    function test_settlement_isFound_afterVendorChange() public {
        vm.roll(42);
        _pay("INV-1", A, payA, 1e6);
        vm.prank(operator);
        vault.setMandate(agent, B, payB, 10e6, 50e6, uint40(block.timestamp + 30 days));
        (bool byVendor, uint256 amount, uint256 blockNumber, address by,) = vault.settlementOf("INV-1", A);
        assertTrue(byVendor);
        assertEq(amount, 1e6);
        assertEq(blockNumber, 42);
        assertEq(by, agent);
        (bool beta,,,,) = vault.settlementOf("INV-1", B);
        assertFalse(beta, "beta's INV-1 is another invoice");
        (bool found, bytes32 vendor, uint256 amt,,,) = vault.findSettlement("INV-1");
        assertTrue(found);
        assertEq(vendor, A);
        assertEq(amt, 1e6);
        (bool none,,,,,) = vault.findSettlement("INV-2");
        assertFalse(none);
        assertEq(vault.vendorCount(), 2);
        assertEq(vault.vendors(0), A);
        assertEq(vault.vendors(1), B);
        // Switching back to a known vendor does not duplicate it in the history.
        vm.prank(operator);
        vault.setMandate(agent, A, payA, 10e6, 50e6, uint40(block.timestamp + 30 days));
        assertEq(vault.vendorCount(), 2);
    }

    // P3-4, by design and documented: the daily limit is per CALENDAR UTC day, so up to 2× can go out around midnight.
    function test_dayBoundary_upToTwiceTheDailyLimitAroundMidnight_documented() public {
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        for (uint256 i; i < 5; i++) {
            _pay(string(abi.encodePacked("a", vm.toString(i))), A, payA, 10e6);
        }
        assertEq(vault.remainingToday(), 0);
        vm.warp(midnight);
        assertEq(vault.remainingToday(), 50e6);
        for (uint256 i; i < 5; i++) {
            _pay(string(abi.encodePacked("b", vm.toString(i))), A, payA, 10e6);
        }
        assertEq(token.balanceOf(payA), 100e6);
    }

    // P3-5, by design and documented: a stolen agent key can settle future ids with dust (to the real payee).
    function test_stolenKey_dustSettlesAFutureId_documented() public {
        _pay("INV-002", A, payA, 1);
        vm.prank(agent);
        vm.expectRevert();
        vault.payInvoice("INV-002", A, payA, 9e6);
        assertEq(token.balanceOf(payA), 1, "the dust went to the registered payee, nobody else");
    }

    function test_expiryEdge() public {
        uint40 e = uint40(block.timestamp + 100);
        vm.prank(operator);
        vault.setMandate(agent, A, payA, 10e6, 50e6, e);
        vm.warp(e - 1);
        _pay("x1", A, payA, 1);
        vm.warp(e);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.MandateExpired.selector);
        vault.payInvoice("x2", A, payA, 1);
    }

    function test_lowerDailyBelowSpent_blocksTheRestOfTheDay_remainingTodayIsZero() public {
        _pay("x1", A, payA, 10e6);
        _pay("x2", A, payA, 10e6);
        vm.prank(operator);
        vault.setMandate(agent, A, payA, 5e6, 5e6, uint40(block.timestamp + 2 days));
        assertEq(vault.remainingToday(), 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.AboveDailyLimit.selector, 20e6, 1, 5e6));
        vault.payInvoice("x3", A, payA, 1);
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.remainingToday(), 5e6);
        _pay("x3", A, payA, 5e6);
        assertEq(vault.remainingToday(), 0);
    }

    function test_uint48Max_noTruncation() public {
        uint48 m = type(uint48).max;
        token.mint(address(vault), uint256(m) * 2);
        vm.prank(operator);
        vault.setMandate(agent, A, payA, m, m, uint40(block.timestamp + 1 days));
        _pay("big", A, payA, m);
        vm.prank(agent);
        vm.expectRevert();
        vault.payInvoice("big2", A, payA, 1);
        vm.prank(agent);
        vm.expectRevert();
        vault.payInvoice("big3", A, payA, uint256(m) + 1);
        (, uint256 amt,,,) = vault.settlementOf("big", A);
        assertEq(amt, m);
    }

    // P3-6. A blacklisted operator can still get the funds out, to an address it chooses.
    function test_blacklistedOperator_withdrawTo_anotherAddress() public {
        token.ban(operator);
        vm.prank(operator);
        vm.expectRevert(InvoiceMandate.TransferFailed.selector);
        vault.withdraw(1);
        address safe = makeAddr("operator's other address");
        vm.prank(operator);
        vault.withdrawTo(safe, 100e6);
        assertEq(token.balanceOf(safe), 100e6);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.withdrawTo(agent, 1);
        vm.prank(operator);
        vm.expectRevert(InvoiceMandate.InvalidRecipient.selector);
        vault.withdrawTo(address(0), 1);
    }

    function test_sweep_foreignTokenOnly_operatorOnly() public {
        MockTUSD8 other = new MockTUSD8();
        other.mint(address(vault), 5e6);
        address to = makeAddr("sweep destination");
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.sweep(address(other), to);
        vm.prank(operator);
        vm.expectRevert(InvoiceMandate.InvalidToken.selector);
        vault.sweep(address(token), to); // tUSD8 leaves only through withdraw / withdrawTo
        vm.prank(operator);
        vault.sweep(address(other), to);
        assertEq(other.balanceOf(to), 5e6);
        assertEq(other.balanceOf(address(vault)), 0);
    }

    // P3-9.
    function test_revokeAgent_revertsWhenThereIsNoAgent() public {
        vm.startPrank(operator);
        vault.revokeAgent();
        vm.expectRevert(InvoiceMandate.NoAgent.selector);
        vault.revokeAgent();
        vm.stopPrank();
        vm.prank(operator);
        InvoiceMandate fresh = new InvoiceMandate(ITUSD8(address(token)));
        vm.prank(operator);
        vm.expectRevert(InvoiceMandate.NoAgent.selector);
        fresh.revokeAgent();
    }

    // P3-7.
    function test_mandateGuards_payToNotAgent_agentNotOperator_payToNotToken() public {
        uint40 exp = uint40(block.timestamp + 1 days);
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "payTo"));
        vault.setMandate(agent, A, agent, 10e6, 50e6, exp);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "agent"));
        vault.setMandate(operator, A, payA, 10e6, 50e6, exp);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "payTo"));
        vault.setMandate(agent, A, address(token), 10e6, 50e6, exp);
        vm.stopPrank();
    }
}
