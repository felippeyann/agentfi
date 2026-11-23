// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceMandate, ITUSD8} from "../src/InvoiceMandate.sol";

interface IFiat {
    function configureMinter(address, uint256) external returns (bool);
    function mint(address, uint256) external returns (bool);
    function masterMinter() external view returns (address);
    function blacklister() external view returns (address);
    function pauser() external view returns (address);
    function blacklist(address) external;
    function pause() external;
    function balanceOf(address) external view returns (uint256);
}

/// @dev Against the REAL tUSD8 on a LOCAL fork of Aevum Testnet (reads the public RPC; sends nothing anywhere).
///      Opt-in: `AEVUM_FORK=1 forge test --match-contract AevumForkTest`; skipped otherwise (and in CI).
contract AevumForkTest is Test {
    IFiat internal constant T = IFiat(0x456569838f1d43009A91ebA4263147Afd7233483);

    function test_fork_realFiatToken() public {
        if (!vm.envOr("AEVUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("aevum");
        address operator = makeAddr("operator");
        address agent = makeAddr("agent");
        address payTo = makeAddr("payTo");
        bytes32 vendor = bytes32("vendor-1");
        vm.prank(operator);
        InvoiceMandate vault = new InvoiceMandate(ITUSD8(address(T)));
        address minter = makeAddr("minter");
        vm.prank(T.masterMinter());
        T.configureMinter(minter, 100e6);
        vm.prank(minter);
        T.mint(address(vault), 100e6);
        vm.prank(operator);
        vault.setMandate(agent, vendor, payTo, 10e6, 50e6, uint40(block.timestamp + 1 days));
        vm.prank(agent);
        vault.payInvoice("INV-1", vendor, payTo, 1e6);
        assertEq(T.balanceOf(payTo), 1e6);
        vm.prank(agent);
        vault.payInvoice("INV-2", vendor, payTo, 1e6);

        // A blacklisted payee: the payment reverts and nothing is recorded.
        vm.prank(T.blacklister());
        T.blacklist(payTo);
        vm.prank(agent);
        vm.expectRevert();
        vault.payInvoice("INV-3", vendor, payTo, 1e6);
        (bool s,,,,) = vault.settlementOf("INV-3", vendor);
        assertFalse(s);

        // A paused token: withdraw reverts (the funds wait in the vault).
        vm.prank(T.pauser());
        T.pause();
        vm.prank(operator);
        vm.expectRevert();
        vault.withdraw(1);
    }
}
