// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {InvoiceMandate, ITUSD8} from "invoice-mandate/InvoiceMandate.sol";
import {LocalTestUSD8} from "invoice-mandate/LocalTestUSD8.sol";
import {Deploy8004} from "../src/Deploy8004.sol";
import {SettledInvoiceFeedback, IInvoiceMandateView, IERC8004Reputation} from "../src/SettledInvoiceFeedback.sol";

/// @title E2E8004: LOCAL ANVIL ONLY. Token + vault + ERC-8004 registries + adapter, one settled invoice, a registered
///        agent with a proven agentWallet, one anchored feedback. Uses Anvil's well-known dev keys; refuses any chain
///        other than 31337.
/// @dev forge script script/E2E8004.s.sol --rpc-url http://127.0.0.1:8745 --broadcast
contract E2E8004 is Script {
    // Anvil default mnemonic accounts 0..3 (public dev keys, never funded anywhere real).
    uint256 internal constant OPERATOR_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant AGENT_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant PAYEE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant ID_OWNER_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    string internal constant INVOICE = "QDAY-2026-11-24-001";
    bytes32 internal constant VENDOR = bytes32("vendor-1");

    function run() external {
        require(block.chainid == 31337, "E2E8004: local Anvil only");
        address operator = vm.addr(OPERATOR_PK);
        address agent = vm.addr(AGENT_PK);
        address payTo = vm.addr(PAYEE_PK);
        address idOwner = vm.addr(ID_OWNER_PK);

        // 1. Operator: registries (owned by the operator here), adapter, token, vault, mandate, deposit.
        vm.startBroadcast(OPERATOR_PK);
        (address id, address rep, address val) = Deploy8004.deployProxies(operator);
        Deploy8004.Registries memory r = Deploy8004.upgrade(id, rep, val);
        SettledInvoiceFeedback adapter = new SettledInvoiceFeedback(IERC8004Reputation(rep));
        LocalTestUSD8 token = new LocalTestUSD8();
        InvoiceMandate vault = new InvoiceMandate(ITUSD8(address(token)));
        token.mint(operator, 10e6);
        token.transfer(address(vault), 5e6);
        vault.setMandate(agent, VENDOR, payTo, 1e6, 1e6, uint40(block.timestamp + 1 days));
        vm.stopBroadcast();

        // 2. Agent: settles the invoice through the vault.
        vm.startBroadcast(AGENT_PK);
        vault.payInvoice(INVOICE, VENDOR, payTo, 1e6);
        vm.stopBroadcast();

        // 3. Identity owner: registers, declares the vault, binds the agent key as agentWallet (agent's EIP-712 sig).
        uint256 deadline = block.timestamp + 4 minutes;
        vm.startBroadcast(ID_OWNER_PK);
        uint256 agentId = r.identity.register("https://example.invalid/agentfi-invoice-agent.json");
        r.identity.setMetadata(agentId, adapter.VAULT_KEY(), abi.encode(address(vault)));
        r.identity.setAgentWallet(agentId, agent, deadline, _walletSig(id, agentId, agent, idOwner, deadline));
        vm.stopBroadcast();

        // 4. Operator (a counterparty, not the identity owner): the anchored feedback.
        vm.startBroadcast(OPERATOR_PK);
        uint64 idx = adapter.giveSettledFeedback(
            agentId, IInvoiceMandateView(address(vault)), INVOICE, VENDOR, 100, 0, "", bytes32(0)
        );
        vm.stopBroadcast();

        console.log("IDENTITY", id);
        console.log("REPUTATION", rep);
        console.log("VALIDATION", val);
        console.log("ADAPTER", address(adapter));
        console.log("TOKEN", address(token));
        console.log("VAULT", address(vault));
        console.log("AGENT_ID", agentId);
        console.log("FEEDBACK_INDEX", uint256(idx));
    }

    function _walletSig(address identity, uint256 agentId, address wallet, address owner, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                identity
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                agentId,
                wallet,
                owner,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", domainSep, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
