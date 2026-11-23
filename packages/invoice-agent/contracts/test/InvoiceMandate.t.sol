// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceMandate, ITUSD8} from "../src/InvoiceMandate.sol";
import {EighteenDecimals, FalseTUSD8, MockTUSD8, ReentrantTUSD8} from "./mocks/MockTUSD8.sol";

/// @dev An agent that is a contract, so a malicious token can re-enter the vault AS the agent.
contract AgentProxy {
    function call(address target, bytes calldata data) external returns (bool ok, bytes memory ret) {
        return target.call(data);
    }
}

contract InvoiceMandateTest is Test {
    MockTUSD8 internal token;
    InvoiceMandate internal vault;

    address internal operator = makeAddr("operator");
    address internal agent = makeAddr("agent");
    address internal vendorPayTo = makeAddr("acme payee");
    address internal attacker = makeAddr("attacker");
    bytes32 internal constant VENDOR = bytes32("acme");

    uint48 internal constant CAP = 10e6; // 10 tUSD8 per invoice
    uint48 internal constant DAILY = 50e6; // 50 tUSD8 per UTC day
    uint40 internal expiry;

    event InvoiceSettled(
        bytes32 indexed invoiceKey,
        string invoiceId,
        bytes32 indexed vendor,
        address indexed payTo,
        uint256 amount,
        address agent
    );
    event MandateSet(
        address indexed agent,
        bytes32 indexed vendor,
        address indexed payTo,
        uint256 maxPerInvoice,
        uint256 maxPerDay,
        uint256 expiresAt
    );
    event Paused(bool paused);
    event AgentRevoked(address indexed agent);
    event Withdrawn(address indexed to, uint256 amount);

    function setUp() public {
        vm.warp(1_795_000_000); // 2026-11-17, mid-day UTC
        expiry = uint40(block.timestamp + 30 days);
        token = new MockTUSD8();
        vm.prank(operator);
        vault = new InvoiceMandate(ITUSD8(address(token)));
        token.mint(operator, 1_000e6);
        vm.prank(operator);
        token.transfer(address(vault), 100e6); // the deposit: a plain tUSD8 transfer to the vault
        vm.prank(operator);
        vault.setMandate(agent, VENDOR, vendorPayTo, CAP, DAILY, expiry);
    }

    function _pay(string memory id, uint256 amount) internal {
        vm.prank(agent);
        vault.payInvoice(id, amount);
    }

    // ---------------------------------------------------------------- deployment and mandate

    function test_constructor_operatorIsDeployer_tokenChecked() public {
        assertEq(vault.operator(), operator);
        assertEq(address(vault.token()), address(token));
        address notTusd8 = address(new EighteenDecimals());
        address eoa = makeAddr("eoa");
        vm.expectRevert(InvoiceMandate.InvalidToken.selector);
        new InvoiceMandate(ITUSD8(notTusd8));
        vm.expectRevert(InvoiceMandate.InvalidToken.selector); // no code at the address
        new InvoiceMandate(ITUSD8(eoa));
    }

    function test_setMandate_storesAndEmits() public {
        address agent2 = makeAddr("agent2");
        vm.expectEmit(address(vault));
        emit MandateSet(agent2, bytes32("beta"), vendorPayTo, 1e6, 2e6, expiry);
        vm.prank(operator);
        vault.setMandate(agent2, bytes32("beta"), vendorPayTo, 1e6, 2e6, expiry);
        (address a, uint40 exp, bool paused, address payTo, uint48 cap, uint48 daily, bytes32 vendor) = vault.mandate();
        assertEq(a, agent2);
        assertEq(exp, expiry);
        assertFalse(paused);
        assertEq(payTo, vendorPayTo);
        assertEq(cap, 1e6);
        assertEq(daily, 2e6);
        assertEq(vendor, bytes32("beta"));
    }

    function test_setMandate_onlyOperator_andValidated() public {
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.setMandate(agent, VENDOR, agent, CAP, DAILY, expiry); // the agent cannot redirect its own payee

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "agent"));
        vault.setMandate(address(0), VENDOR, vendorPayTo, CAP, DAILY, expiry);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "vendor"));
        vault.setMandate(agent, bytes32(0), vendorPayTo, CAP, DAILY, expiry);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "payTo"));
        vault.setMandate(agent, VENDOR, address(0), CAP, DAILY, expiry);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "payTo"));
        vault.setMandate(agent, VENDOR, address(vault), CAP, DAILY, expiry);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "limits"));
        vault.setMandate(agent, VENDOR, vendorPayTo, 0, DAILY, expiry);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "limits"));
        vault.setMandate(agent, VENDOR, vendorPayTo, DAILY + 1, DAILY, expiry);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.InvalidMandate.selector, "expiresAt"));
        vault.setMandate(agent, VENDOR, vendorPayTo, CAP, DAILY, uint40(block.timestamp));
        vm.stopPrank();
    }

    function test_noMandateYet_nobodyCanPay() public {
        vm.prank(operator);
        InvoiceMandate fresh = new InvoiceMandate(ITUSD8(address(token)));
        vm.prank(address(0)); // the zero "agent" of an unset mandate is not a caller
        vm.expectRevert(InvoiceMandate.NotAgent.selector);
        fresh.payInvoice("INV-001", 1);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotAgent.selector);
        fresh.payInvoice("INV-001", 1);
    }

    // ---------------------------------------------------------------- happy path and events

    function test_payInvoice_paysRegisteredPayee_recordsAndEmits() public {
        bytes32 key = vault.invoiceKey("INV-001", VENDOR);
        assertEq(key, keccak256(abi.encode("INV-001", VENDOR)));
        vm.roll(1234);
        // InvoiceSettled is emitted before the token's Transfer (effects before the external call).
        vm.expectEmit(address(vault));
        emit InvoiceSettled(key, "INV-001", VENDOR, vendorPayTo, 8e6, agent);
        vm.expectEmit(address(token));
        emit MockTUSD8.Transfer(address(vault), vendorPayTo, 8e6);
        _pay("INV-001", 8e6);

        assertEq(token.balanceOf(vendorPayTo), 8e6);
        assertEq(token.balanceOf(address(vault)), 92e6);
        (bool settled, uint256 amount, uint256 blockNumber, address by, bytes32 k) = vault.settlementOf("INV-001");
        assertTrue(settled);
        assertEq(amount, 8e6);
        assertEq(blockNumber, 1234);
        assertEq(by, agent);
        assertEq(k, key);
        assertEq(vault.spentToday(), 8e6);
    }

    function test_settlementOf_unknownInvoice_isNotSettled() public view {
        (bool settled, uint256 amount, uint256 blockNumber, address by,) = vault.settlementOf("INV-404");
        assertFalse(settled);
        assertEq(amount, 0);
        assertEq(blockNumber, 0);
        assertEq(by, address(0));
    }

    // ---------------------------------------------------------------- one settlement per invoice

    function test_secondSettlement_reverts_sameCallerSameAmount() public {
        vm.roll(77);
        _pay("INV-001", 8e6);
        bytes32 key = vault.invoiceKey("INV-001", VENDOR);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.AlreadySettled.selector, key, 77));
        vault.payInvoice("INV-001", 8e6);
        assertEq(token.balanceOf(vendorPayTo), 8e6, "paid once");
    }

    function test_secondSettlement_reverts_otherAmount_laterBlock_newAgentKey() public {
        _pay("INV-001", 8e6);
        vm.roll(block.number + 100); // another nonce, another process: the chain does not care
        vm.warp(block.timestamp + 2 days); // another day: the daily limit is fresh
        vm.prank(agent);
        vm.expectRevert();
        vault.payInvoice("INV-001", 1e6);
        // The operator rotates the agent key: the invoice is still settled.
        address agent2 = makeAddr("agent2");
        vm.prank(operator);
        vault.setMandate(agent2, VENDOR, vendorPayTo, CAP, DAILY, uint40(block.timestamp + 1 days));
        vm.prank(agent2);
        vm.expectRevert();
        vault.payInvoice("INV-001", 8e6);
        // A new payee for the same vendor (a legitimate bank change) does not reopen the invoice either.
        vm.prank(operator);
        vault.setMandate(agent2, VENDOR, makeAddr("acme new payee"), CAP, DAILY, uint40(block.timestamp + 1 days));
        vm.prank(agent2);
        vm.expectRevert();
        vault.payInvoice("INV-001", 8e6);
        assertEq(token.balanceOf(vendorPayTo), 8e6, "paid once");
    }

    function test_invoiceIdIsExact_andScopedByVendor() public {
        _pay("INV-001", 1e6);
        _pay("inv-001", 1e6); // case-sensitive, as in the agent's ledger
        vm.prank(operator);
        vault.setMandate(agent, bytes32("beta"), vendorPayTo, CAP, DAILY, expiry);
        _pay("INV-001", 1e6); // beta's INV-001 is another invoice
        assertEq(token.balanceOf(vendorPayTo), 3e6);
    }

    function test_invalidInvoiceId_andZeroAmount() public {
        vm.startPrank(agent);
        vm.expectRevert(InvoiceMandate.InvalidInvoiceId.selector);
        vault.payInvoice("", 1e6);
        vm.expectRevert(InvoiceMandate.InvalidInvoiceId.selector);
        vault.payInvoice(string(new bytes(65)), 1e6);
        vault.payInvoice(string(abi.encodePacked(bytes32("x"), bytes32("y"))), 1e6); // 64 bytes: accepted
        vm.expectRevert(InvoiceMandate.ZeroAmount.selector);
        vault.payInvoice("INV-001", 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- limits

    function test_perInvoiceCap() public {
        _pay("INV-AT-CAP", CAP);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.AboveInvoiceCap.selector, CAP + 1, CAP));
        vault.payInvoice("INV-OVER", CAP + 1);
    }

    function test_dailyLimit_andUtcDayRollover() public {
        for (uint256 i = 0; i < 5; i++) {
            _pay(string(abi.encodePacked("D1-", vm.toString(i))), CAP); // 5 × 10 = 50: exactly the limit
        }
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.AboveDailyLimit.selector, DAILY, 1, DAILY));
        vault.payInvoice("D1-5", 1);

        // Same UTC day, one second before midnight: still refused.
        uint256 nextMidnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(nextMidnight - 1);
        vm.prank(agent);
        vm.expectRevert();
        vault.payInvoice("D1-5", 1);

        // Midnight UTC: a new day, a new limit.
        vm.warp(nextMidnight);
        _pay("D2-0", CAP);
        assertEq(vault.spentToday(), CAP);
        assertEq(vault.day(), nextMidnight / 1 days);
    }

    function test_replacingTheMandate_doesNotResetTheDay() public {
        _pay("A", CAP);
        _pay("B", CAP);
        vm.prank(operator);
        vault.setMandate(agent, VENDOR, vendorPayTo, CAP, 25e6, expiry);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMandate.AboveDailyLimit.selector, 20e6, 6e6, 25e6));
        vault.payInvoice("C", 6e6);
        _pay("C", 5e6);
    }

    function test_expiry() public {
        vm.warp(expiry - 1);
        _pay("BEFORE", 1e6);
        vm.warp(expiry);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.MandateExpired.selector);
        vault.payInvoice("AT", 1e6);
    }

    function test_vaultBalanceTooLow_revertsWithoutRecording() public {
        vm.prank(operator);
        vault.setMandate(agent, VENDOR, vendorPayTo, 100e6, 200e6, expiry);
        vm.prank(agent);
        vm.expectRevert(); // the token reverts: the whole call reverts, nothing recorded
        vault.payInvoice("BIG", 101e6);
        (bool settled,,,,) = vault.settlementOf("BIG");
        assertFalse(settled);
        assertEq(vault.spentToday(), 0);
    }

    // ---------------------------------------------------------------- who may call what

    function test_wrongCaller() public {
        vm.prank(attacker);
        vm.expectRevert(InvoiceMandate.NotAgent.selector);
        vault.payInvoice("INV-001", 1e6);
        vm.prank(operator); // not even the operator pays invoices
        vm.expectRevert(InvoiceMandate.NotAgent.selector);
        vault.payInvoice("INV-001", 1e6);
    }

    function test_pause_unpause() public {
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.pause();
        vm.expectEmit(address(vault));
        emit Paused(true);
        vm.prank(operator);
        vault.pause();
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.MandatePaused.selector);
        vault.payInvoice("INV-001", 1e6);
        // setMandate keeps the pause: a new mandate is not a way around it.
        vm.prank(operator);
        vault.setMandate(agent, VENDOR, vendorPayTo, CAP, DAILY, expiry);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.MandatePaused.selector);
        vault.payInvoice("INV-001", 1e6);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.unpause();
        vm.prank(operator);
        vault.unpause();
        _pay("INV-001", 1e6);
    }

    function test_revokeAgent_isInstant() public {
        _pay("INV-001", 1e6);
        vm.expectEmit(address(vault));
        emit AgentRevoked(agent);
        vm.prank(operator);
        vault.revokeAgent();
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotAgent.selector);
        vault.payInvoice("INV-002", 1e6);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.revokeAgent();
    }

    function test_withdraw_onlyOperator_toOperator() public {
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.withdraw(1e6);
        vm.prank(attacker);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.withdraw(1e6);
        uint256 before = token.balanceOf(operator);
        vm.expectEmit(address(vault));
        emit Withdrawn(operator, 40e6);
        vm.prank(operator);
        vault.withdraw(40e6);
        assertEq(token.balanceOf(operator), before + 40e6);
        assertEq(token.balanceOf(address(vault)), 60e6);
        vm.prank(operator);
        vm.expectRevert();
        vault.withdraw(61e6);
    }

    // ---------------------------------------------------------------- a compromised agent key

    function test_compromisedAgentKey_cannotPayAnyoneElse_norExceedLimits() public {
        // The attacker holds the agent key. The only function it can call is payInvoice, whose payee is fixed.
        vm.startPrank(agent);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.setMandate(agent, VENDOR, attacker, CAP, DAILY, expiry);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.withdraw(1);
        vm.expectRevert(InvoiceMandate.NotOperator.selector);
        vault.unpause();
        // Draining by many fake invoices stops at the daily limit, and every coin goes to the vendor.
        uint256 paid;
        for (uint256 i = 0; i < 20; i++) {
            (bool ok,) = address(vault).call(abi.encodeCall(InvoiceMandate.payInvoice, (vm.toString(i), CAP)));
            if (ok) paid += CAP;
        }
        vm.stopPrank();
        assertEq(paid, DAILY);
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(vendorPayTo), DAILY);
        assertEq(token.balanceOf(address(vault)), 100e6 - DAILY);
        // The operator sees it and revokes; the rest is withdrawn.
        vm.startPrank(operator);
        vault.revokeAgent();
        vault.withdraw(token.balanceOf(address(vault)));
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // ---------------------------------------------------------------- token behaviour

    function test_tokenReturningFalse_reverts() public {
        FalseTUSD8 bad = new FalseTUSD8();
        vm.prank(operator);
        InvoiceMandate v = new InvoiceMandate(ITUSD8(address(bad)));
        vm.prank(operator);
        v.setMandate(agent, VENDOR, vendorPayTo, CAP, DAILY, expiry);
        vm.prank(agent);
        vm.expectRevert(InvoiceMandate.TransferFailed.selector);
        v.payInvoice("INV-001", 1e6);
        (bool settled,,,,) = v.settlementOf("INV-001");
        assertFalse(settled);
    }

    function test_reentrantToken_cannotSettleTwice_norPassTheLimit() public {
        ReentrantTUSD8 evil = new ReentrantTUSD8();
        AgentProxy proxy = new AgentProxy();
        vm.prank(operator);
        InvoiceMandate v = new InvoiceMandate(ITUSD8(address(evil)));
        evil.mint(address(v), 100e6);
        vm.prank(operator);
        v.setMandate(address(proxy), VENDOR, vendorPayTo, CAP, CAP, expiry);

        // During the payout the token re-enters AS the agent with the same invoice: AlreadySettled.
        bytes memory same = abi.encodeCall(InvoiceMandate.payInvoice, ("INV-001", 5e6));
        evil.arm(address(proxy), abi.encodeCall(AgentProxy.call, (address(v), same)));
        proxy.call(address(v), same);
        assertTrue(evil.reentered());
        assertEq(evil.balanceOf(vendorPayTo), 5e6, "paid once");

        // With another invoice: the day's spending was already counted, so 5 + 6 > 10 is refused.
        bytes memory other = abi.encodeCall(InvoiceMandate.payInvoice, ("INV-002", 6e6));
        evil.arm(address(proxy), abi.encodeCall(AgentProxy.call, (address(v), other)));
        proxy.call(address(v), abi.encodeCall(InvoiceMandate.payInvoice, ("INV-003", 1e6)));
        assertEq(evil.balanceOf(vendorPayTo), 6e6, "5 + 1, the re-entrant 6 refused");
        (bool settled,,,,) = v.settlementOf("INV-002");
        assertFalse(settled);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_payWithinLimits_onlyOnce(uint48 cap, uint48 daily, uint256 amount, string calldata id) public {
        vm.assume(bytes(id).length > 0 && bytes(id).length <= 64);
        cap = uint48(bound(cap, 1, 100e6));
        daily = uint48(bound(daily, cap, type(uint48).max));
        amount = bound(amount, 1, type(uint48).max);
        vm.prank(operator);
        vault.setMandate(agent, VENDOR, vendorPayTo, cap, daily, expiry);
        token.mint(address(vault), type(uint48).max);
        uint256 vendorBefore = token.balanceOf(vendorPayTo);

        vm.prank(agent);
        (bool ok,) = address(vault).call(abi.encodeCall(InvoiceMandate.payInvoice, (id, amount)));
        assertEq(ok, amount <= cap, "paid iff within the per-invoice cap");
        assertEq(token.balanceOf(vendorPayTo) - vendorBefore, ok ? amount : 0);

        vm.prank(agent);
        (bool again,) = address(vault).call(abi.encodeCall(InvoiceMandate.payInvoice, (id, amount)));
        if (ok) assertFalse(again, "never a second settlement");
        assertEq(token.balanceOf(vendorPayTo) - vendorBefore, ok ? amount : 0);
    }

    function testFuzz_dailyTotalNeverAboveLimit(uint48 daily, uint256[8] calldata amounts) public {
        daily = uint48(bound(daily, 1, 100e6));
        vm.prank(operator);
        vault.setMandate(agent, VENDOR, vendorPayTo, daily, daily, expiry);
        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 a = bound(amounts[i], 1, daily);
            bool expected = total + a <= daily && a <= token.balanceOf(address(vault));
            vm.prank(agent);
            (bool ok,) = address(vault).call(abi.encodeCall(InvoiceMandate.payInvoice, (vm.toString(i), a)));
            assertEq(ok, expected);
            if (ok) total += a;
        }
        assertLe(token.balanceOf(vendorPayTo), daily);
        assertEq(token.balanceOf(vendorPayTo), total);
    }

    // ---------------------------------------------------------------- gas (forge test --gas-report)

    function test_gas_payInvoice() public {
        // Warm-up payment so the day slot is non-zero, as in steady state.
        _pay("WARMUP", 1e6);
        vm.roll(block.number + 1);
        vm.prank(agent);
        uint256 g = gasleft();
        vault.payInvoice("INV-001", 8e6);
        emit log_named_uint("payInvoice execution gas (vendor already holds tUSD8, warm test context)", g - gasleft());
    }
}
