// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Deploy8004} from "../src/Deploy8004.sol";
import {SettledInvoiceFeedback, IERC8004Reputation} from "../src/SettledInvoiceFeedback.sol";

/// @title Deploy8004Registries: our own deployment of the vendored ERC-8004 reference registries + the adapter.
/// @notice NOT the official ERC-8004 deployment (that lives at 0x8004A818.../0x8004B663... on chains where the
///         ERC-8004 team deployed it; none exists on QDay Aevum 44005 as of 2026-11-26). The broadcaster becomes the
///         registries' UUPS owner (it can upgrade them: say so wherever these addresses are shown).
///         Local dry-run (Anvil fork of Aevum, no key):
///           forge script script/Deploy8004Registries.s.sol --rpc-url http://127.0.0.1:8745 --unlocked \
///             --sender 0x87ba9E8e20E9D4cFB64f65Da1b82160c3910Bdf7 --broadcast
///         A real Aevum run is an owner decision (signing checkpoint), never run by an agent.
contract Deploy8004Registries is Script {
    function run() external {
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        (address id, address rep, address val) = Deploy8004.deployProxies(sender);
        Deploy8004.upgrade(id, rep, val);
        SettledInvoiceFeedback adapter = new SettledInvoiceFeedback(IERC8004Reputation(rep));
        vm.stopBroadcast();
        console.log("OWNER", sender);
        console.log("IDENTITY", id);
        console.log("REPUTATION", rep);
        console.log("VALIDATION", val);
        console.log("ADAPTER", address(adapter));
    }
}
