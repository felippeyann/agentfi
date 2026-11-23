// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InvoiceMandate, ITUSD8} from "../src/InvoiceMandate.sol";

/// @title The owner's three Aevum transactions for an InvoiceMandate vault, one `--sig` per transaction.
/// @notice Each run signs with the CLI signer (`--account <keystore>`, `--ledger` or `--interactive`): the script never
///         reads a private key. Without `--broadcast` forge only simulates (and prints the gas); with it, it sends.
///         Every run checks the chain id and the token first and refuses on any mismatch.
///
///   cd packages/invoice-agent/contracts
///   # 1. deploy (the signer becomes the operator)
///   forge script script/InvoiceMandate.s.sol --sig "deploy()" --rpc-url aevum --account <name> [--broadcast]
///   # 2. deposit: a plain tUSD8 transfer from the operator to the vault (amount in base units, 6 decimals)
///   forge script script/InvoiceMandate.s.sol --sig "deposit(address,uint256)" <vault> 1000000 --rpc-url aevum --account <name> [--broadcast]
///   # 3. the mandate: agent, vendor id, payee, cap per invoice and per day (base units), days until expiry
///   forge script script/InvoiceMandate.s.sol --sig "setMandate(address,address,string,address,uint48,uint48,uint256)" \
///     <vault> <agent> acme <payTo> 1000000 1000000 7 --rpc-url aevum --account <name> [--broadcast]
///
/// Environment: EXPECTED_CHAIN_ID (default 44005, QDay Aevum Testnet); TUSD8 (default the official tUSD8 on 44005).
contract InvoiceMandateScript is Script {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    error WrongChain(uint256 expected, uint256 actual);
    error NotTUSD8(address token);
    error NotOperator(address signer, address operator);

    function _token() internal view returns (ITUSD8 token) {
        uint256 expected = vm.envOr("EXPECTED_CHAIN_ID", uint256(44005));
        if (block.chainid != expected) revert WrongChain(expected, block.chainid);
        token = ITUSD8(vm.envOr("TUSD8", AEVUM_TUSD8));
        if (address(token).code.length == 0 || token.decimals() != 6) revert NotTUSD8(address(token));
    }

    function deploy() external returns (InvoiceMandate vault) {
        ITUSD8 token = _token();
        vm.startBroadcast();
        vault = new InvoiceMandate(token);
        vm.stopBroadcast();
        console.log("InvoiceMandate:", address(vault));
        console.log("operator:", vault.operator());
        console.log("token:", address(token));
    }

    function deposit(InvoiceMandate vault, uint256 amount) external {
        ITUSD8 token = _token();
        if (address(vault.token()) != address(token)) revert NotTUSD8(address(vault.token()));
        vm.startBroadcast();
        require(token.transfer(address(vault), amount), "transfer returned false");
        vm.stopBroadcast();
        console.log("vault balance (base units):", token.balanceOf(address(vault)));
    }

    function setMandate(
        InvoiceMandate vault,
        address agent,
        string calldata vendorId,
        address payTo,
        uint48 maxPerInvoice,
        uint48 maxPerDay,
        uint256 validDays
    ) external {
        _token();
        require(bytes(vendorId).length > 0 && bytes(vendorId).length <= 32, "vendor id: 1-32 bytes");
        require(validDays > 0 && validDays <= 365, "validDays: 1-365");
        bytes32 vendor = bytes32(bytes(vendorId));
        uint40 expiresAt = uint40(block.timestamp + validDays * 1 days);
        vm.startBroadcast();
        (, address signer,) = vm.readCallers();
        if (signer != vault.operator()) revert NotOperator(signer, vault.operator());
        vault.setMandate(agent, vendor, payTo, maxPerInvoice, maxPerDay, expiresAt);
        vm.stopBroadcast();
        console.log("agent:", agent);
        console.log("payTo:", payTo);
        console.log("expiresAt (unix):", uint256(expiresAt));
    }
}
