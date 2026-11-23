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
///   # 1. deploy: the signer becomes the operator; EXPECTED_OPERATOR must be that signer's address
///   EXPECTED_OPERATOR=0x… forge script script/InvoiceMandate.s.sol --sig "deploy()" --rpc-url aevum --account <name> [--broadcast]
///   # 2. deposit: a plain tUSD8 transfer from the operator to the vault (amount in base units, 6 decimals)
///   forge script script/InvoiceMandate.s.sol --sig "deposit(address,uint256)" <vault> 1000000 --rpc-url aevum --account <name> [--broadcast]
///   # 3. the mandate: agent, vendor id, payee, cap per invoice and per day (base units), days until expiry
///   forge script script/InvoiceMandate.s.sol --sig "setMandate(address,address,string,address,uint48,uint48,uint256)" \
///     <vault> <agent> vendor-1 <payTo> 1000000 1000000 7 --rpc-url aevum --account <name> [--broadcast]
///
/// Environment:
///   EXPECTED_CHAIN_ID     default 44005 (QDay Aevum Testnet); any other value is printed loudly (local tests only)
///   TUSD8                 the token on OTHER chains only: refused on 44005, where it is always the official tUSD8
///   EXPECTED_OPERATOR     deploy(): the address that must sign (the future operator); required
///   ALLOW_UNUSUAL_LIMITS  setMandate(): accept a cap below 0.01 or a cap / daily limit above 1000 tUSD8
///   ALLOW_VENDOR_CHANGE   setMandate(): accept a vendor id different from the current one on a vault that has paid
contract InvoiceMandateScript is Script {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint256 internal constant AEVUM = 44005;
    uint256 internal constant MIN_CAP = 10_000; // 0.01 tUSD8
    uint256 internal constant MAX_LIMIT = 1_000e6; // 1000 tUSD8

    error WrongChain(uint256 expected, uint256 actual);
    error NotTUSD8(address token);
    error TokenOverrideRefused(address token);
    error NotOperator(address signer, address operator);
    error UnusualLimits(uint256 maxPerInvoice, uint256 maxPerDay);
    error VendorChange(bytes32 current, bytes32 requested);
    error WrongVault(address vaultToken, address token);

    function _token() internal view returns (ITUSD8 token) {
        uint256 expected = vm.envOr("EXPECTED_CHAIN_ID", AEVUM);
        if (expected != AEVUM) {
            console.log(
                "!!! EXPECTED_CHAIN_ID OVERRIDDEN: running against chain", expected, "- NOT QDay Aevum Testnet (44005)"
            );
        }
        if (block.chainid != expected) revert WrongChain(expected, block.chainid);
        token = ITUSD8(checkTokenOverride(block.chainid, vm.envOr("TUSD8", AEVUM_TUSD8)));
        if (address(token).code.length == 0 || token.decimals() != 6) revert NotTUSD8(address(token));
    }

    /// @notice On Aevum the token is always the official tUSD8: a TUSD8 override is refused there.
    function checkTokenOverride(uint256 chainId, address t) public pure returns (address) {
        if (chainId == AEVUM && t != AEVUM_TUSD8) revert TokenOverrideRefused(t);
        return t;
    }

    /// @notice The signer must be the expected operator (deploy) or the vault's operator (setMandate).
    function checkSigner(address signer, address expected) public pure {
        if (signer != expected) revert NotOperator(signer, expected);
    }

    function _signer() internal returns (address signer) {
        (, signer,) = vm.readCallers();
    }

    /// @dev 1500000 → "1.5"
    function _human(uint256 units) internal pure returns (string memory) {
        uint256 frac = units % 1e6;
        if (frac == 0) return vm.toString(units / 1e6);
        bytes memory f = bytes(vm.toString(frac + 1e6)); // "1xxxxxx": keeps the leading zeros
        uint256 end = f.length;
        while (end > 1 && f[end - 1] == "0") end--;
        bytes memory digits = new bytes(end - 1);
        for (uint256 i = 1; i < end; i++) {
            digits[i - 1] = f[i];
        }
        return string.concat(vm.toString(units / 1e6), ".", string(digits));
    }

    function deploy() external returns (InvoiceMandate vault) {
        ITUSD8 token = _token();
        address expectedOperator = vm.envAddress("EXPECTED_OPERATOR");
        vm.startBroadcast();
        checkSigner(_signer(), expectedOperator);
        vault = new InvoiceMandate(token);
        vm.stopBroadcast();
        console.log("InvoiceMandate:", address(vault));
        console.log("operator:", vault.operator());
        console.log("token:", address(token));
    }

    function deposit(InvoiceMandate vault, uint256 amount) external {
        ITUSD8 token = _token();
        if (address(vault.token()) != address(token)) revert WrongVault(address(vault.token()), address(token));
        console.log("deposit (tUSD8):", _human(amount));
        vm.startBroadcast();
        require(token.transfer(address(vault), amount), "transfer returned false");
        vm.stopBroadcast();
        console.log("vault balance (tUSD8):", _human(token.balanceOf(address(vault))));
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
        ITUSD8 token = _token();
        if (address(vault.token()) != address(token)) revert WrongVault(address(vault.token()), address(token));
        require(bytes(vendorId).length > 0 && bytes(vendorId).length <= 32, "vendor id: 1-32 bytes");
        require(validDays > 0 && validDays <= 365, "validDays: 1-365");
        bytes32 vendor = bytes32(bytes(vendorId));
        uint40 expiresAt = uint40(block.timestamp + validDays * 1 days);

        console.log("== the mandate about to be signed ==");
        console.log("vault:", address(vault));
        console.log("agent:", agent);
        console.log("vendor id:", vendorId);
        console.log("payTo:", payTo);
        console.log("cap per invoice (tUSD8):", _human(maxPerInvoice));
        console.log("daily limit, calendar UTC day (tUSD8):", _human(maxPerDay));
        console.log("valid for (days):", validDays);
        console.log("expiresAt (unix):", uint256(expiresAt));

        bool unusual = maxPerInvoice < MIN_CAP || maxPerInvoice > MAX_LIMIT || maxPerDay > MAX_LIMIT;
        if (unusual && !vm.envOr("ALLOW_UNUSUAL_LIMITS", false)) revert UnusualLimits(maxPerInvoice, maxPerDay);
        (,,,,,, bytes32 current) = vault.mandate();
        if (current != bytes32(0) && current != vendor && vault.day() != 0 && !vm.envOr("ALLOW_VENDOR_CHANGE", false)) {
            // The vault has paid invoices: a new vendor id starts a new invoice namespace (old ids become payable again).
            revert VendorChange(current, vendor);
        }

        vm.startBroadcast();
        checkSigner(_signer(), vault.operator());
        vault.setMandate(agent, vendor, payTo, maxPerInvoice, maxPerDay, expiresAt);
        vm.stopBroadcast();
    }
}
