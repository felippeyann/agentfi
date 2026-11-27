// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SettledInvoiceFeedback, IInvoiceMandateView} from "../src/SettledInvoiceFeedback.sol";

/// @title ReadAgentLink: read-only. Given the adapter and an agentId, prints every anchored feedback entry and, for
///        each, the live chain links: identity owner, agentWallet, the adapter's bound vault and the vault the owner
///        declared, vault.mandate().agent, and the bound vault's settlement (agent, amount, block). No broadcast;
///        works against any RPC. `linked now true` needs: declared vault == bound vault, the invoice settled there,
///        and the settling key == the identity's agentWallet.
/// @dev ADAPTER=0x.. AGENT_ID=0 forge script script/ReadAgentLink.s.sol --rpc-url <rpc>
contract ReadAgentLink is Script {
    function run() external view {
        SettledInvoiceFeedback adapter = SettledInvoiceFeedback(vm.envAddress("ADAPTER"));
        uint256 agentId = vm.envUint("AGENT_ID");
        uint64 n = adapter.anchorCount(agentId);
        console.log("agentId", agentId);
        console.log("identity registry", address(adapter.identity()));
        console.log("reputation registry", address(adapter.reputation()));
        console.log("vault (bound to the adapter)", address(adapter.vault()));
        console.log("vault (declared by the owner)", adapter.declaredVault(agentId));
        console.log("anchored entries", uint256(n));
        for (uint64 i = 1; i <= n; i++) {
            SettledInvoiceFeedback.Anchor memory a = adapter.anchorOf(agentId, i);
            SettledInvoiceFeedback.Link memory l = adapter.linkOf(agentId, a.invoiceId, a.vendor);
            (int128 value, uint8 dec,, string memory tag2, bool revoked) =
                adapter.reputation().readFeedback(agentId, address(adapter), i);
            console.log("--- feedbackIndex", uint256(i));
            console.log("invoiceId", a.invoiceId);
            console.log("tag2 (invoiceKey)", tag2);
            console.log("vault (anchored)", a.vault);
            console.log("vault (declared now)", l.declaredVault);
            console.log("identity owner", l.owner);
            console.log("agentWallet", l.agentWallet);
            console.log("vault.mandate().agent", l.mandateAgent);
            console.log("settlement.agent", l.settledBy);
            console.log("settlement amount", l.amount);
            console.log("settlement block", l.settlementBlock);
            console.log("rater", a.rater);
            console.log("role (1 operator, 2 payee)", uint256(uint8(a.role)));
            console.log(string.concat("value ", vm.toString(int256(value))));
            console.log("valueDecimals", uint256(dec));
            console.log("revoked", revoked);
            console.log("linked now", l.linked);
        }
    }
}
