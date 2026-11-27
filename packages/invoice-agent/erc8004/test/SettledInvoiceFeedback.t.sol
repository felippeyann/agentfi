// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceMandate, ITUSD8} from "invoice-mandate/InvoiceMandate.sol";
import {LocalTestUSD8} from "invoice-mandate/LocalTestUSD8.sol";
import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {ReputationRegistryUpgradeable} from "erc8004/ReputationRegistryUpgradeable.sol";
import {Deploy8004} from "../src/Deploy8004.sol";
import {SettledInvoiceFeedback, IInvoiceMandateView, IERC8004Reputation} from "../src/SettledInvoiceFeedback.sol";

/// @dev A contract that pretends to be a vault: says every invoice is settled by whoever it is told.
contract FakeVault {
    address public operator;
    address internal agent;

    constructor(address operator_, address agent_) {
        operator = operator_;
        agent = agent_;
    }

    function mandate() external view returns (address, uint40, bool, address, uint48, uint48, bytes32) {
        return (agent, type(uint40).max, false, address(1), 1, 1, bytes32("vendor-1"));
    }

    function settlementOf(string calldata invoiceId, bytes32 vendor)
        external
        view
        returns (bool, uint256, uint256, address, bytes32)
    {
        return (true, 1e6, 1, agent, keccak256(abi.encode(invoiceId, vendor)));
    }
}

contract SettledInvoiceFeedbackTest is Test {
    string internal constant INVOICE = "QDAY-2026-11-24-001";
    bytes32 internal constant VENDOR = bytes32("vendor-1");
    string internal constant KEY = "agentfi.invoiceMandateVault";
    string internal constant TAG1 = "agentfi.settledInvoice";

    LocalTestUSD8 internal token;
    InvoiceMandate internal vault;
    IdentityRegistryUpgradeable internal identity;
    ReputationRegistryUpgradeable internal reputation;
    SettledInvoiceFeedback internal adapter;

    address internal operator = makeAddr("operator");
    address internal payTo = makeAddr("vendor-1 payee");
    address internal stranger = makeAddr("stranger");
    address internal identityOwner = makeAddr("identity owner");
    uint256 internal agentPk;
    address internal agent;
    uint256 internal agentId;

    function setUp() public {
        vm.warp(1_795_000_000);
        (agent, agentPk) = makeAddrAndKey("agent");

        (address id, address rep, address val) = Deploy8004.deployProxies(address(this));
        Deploy8004.Registries memory r = Deploy8004.upgrade(id, rep, val);
        identity = r.identity;
        reputation = r.reputation;
        adapter = new SettledInvoiceFeedback(IERC8004Reputation(address(reputation)));

        vm.startPrank(operator);
        token = new LocalTestUSD8();
        vault = new InvoiceMandate(ITUSD8(address(token)));
        token.mint(operator, 100e6);
        token.transfer(address(vault), 10e6);
        vault.setMandate(agent, VENDOR, payTo, 1e6, 1e6, uint40(block.timestamp + 1 days));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ helpers

    function _settle(InvoiceMandate v, string memory invoiceId) internal {
        vm.prank(agent);
        v.payInvoice(invoiceId, VENDOR, payTo, 1e6);
    }

    /// @dev Registration by the operator-side owner key, agent wallet proven with the agent key's EIP-712 signature.
    function _registerWithProvenWallet(address vaultAddr) internal returns (uint256 newId) {
        vm.prank(identityOwner);
        newId = identity.register("https://example.invalid/agent-registration.json");
        vm.prank(identityOwner);
        identity.setMetadata(newId, KEY, abi.encode(vaultAddr));
        uint256 deadline = block.timestamp + 4 minutes;
        bytes memory sig = _walletSig(newId, agent, identityOwner, deadline, agentPk);
        vm.prank(identityOwner);
        identity.setAgentWallet(newId, agent, deadline, sig);
    }

    function _walletSig(uint256 id, address wallet, address owner, uint256 deadline, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash = keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                address(identity)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSep, keccak256(abi.encode(typeHash, id, wallet, owner, deadline)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _give(address rater, IInvoiceMandateView v, string memory invoiceId) internal returns (uint64) {
        vm.prank(rater);
        return adapter.giveSettledFeedback(agentId, v, invoiceId, VENDOR, 100, 0, "ipfs://feedback", bytes32(0));
    }

    // ------------------------------------------------------------ identity

    function test_register_setsOwnerAndDefaultWallet() public {
        vm.prank(agent);
        uint256 id = identity.register("https://example.invalid/agent.json");
        assertEq(identity.ownerOf(id), agent);
        assertEq(identity.getAgentWallet(id), agent, "agentWallet defaults to the registering owner");
        assertEq(identity.tokenURI(id), "https://example.invalid/agent.json");
    }

    function test_setAgentWallet_requiresTheWalletsSignature() public {
        vm.prank(identityOwner);
        uint256 id = identity.register("u");
        uint256 deadline = block.timestamp + 4 minutes;
        (, uint256 strangerPk) = makeAddrAndKey("stranger-key");
        bytes memory bad = _walletSig(id, agent, identityOwner, deadline, strangerPk);
        vm.prank(identityOwner);
        vm.expectRevert(bytes("invalid wallet sig"));
        identity.setAgentWallet(id, agent, deadline, bad);

        bytes memory good = _walletSig(id, agent, identityOwner, deadline, agentPk);
        vm.prank(identityOwner);
        identity.setAgentWallet(id, agent, deadline, good);
        assertEq(identity.getAgentWallet(id), agent);
    }

    function test_vaultDeclaration_onlyByOwner() public {
        vm.prank(identityOwner);
        uint256 id = identity.register("u");
        vm.prank(stranger);
        vm.expectRevert(bytes("Not authorized"));
        identity.setMetadata(id, KEY, abi.encode(address(vault)));
        vm.prank(identityOwner);
        identity.setMetadata(id, KEY, abi.encode(address(vault)));
        assertEq(adapter.declaredVault(id), address(vault));
    }

    // ------------------------------------------------------------ refusals

    function test_refuses_unsettledInvoice() public {
        agentId = _registerWithProvenWallet(address(vault));
        bytes32 key = vault.invoiceKey(INVOICE, VENDOR);
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.NotSettled.selector, key));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_refuses_settlementByAnotherAgent() public {
        address other = makeAddr("other agent");
        vm.prank(operator);
        vault.setMandate(other, VENDOR, payTo, 1e6, 1e6, uint40(block.timestamp + 1 days));
        vm.prank(other);
        vault.payInvoice(INVOICE, VENDOR, payTo, 1e6);

        agentId = _registerWithProvenWallet(address(vault)); // identity's wallet = `agent`, not `other`
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.AgentMismatch.selector, other, agent));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_refuses_differentVault() public {
        vm.prank(operator);
        InvoiceMandate vault2 = new InvoiceMandate(ITUSD8(address(token)));
        vm.startPrank(operator);
        token.transfer(address(vault2), 1e6);
        vault2.setMandate(agent, VENDOR, payTo, 1e6, 1e6, uint40(block.timestamp + 1 days));
        vm.stopPrank();
        _settle(vault2, INVOICE); // a real settlement by the right agent, but in a vault the owner did not declare

        agentId = _registerWithProvenWallet(address(vault));
        vm.expectRevert(
            abi.encodeWithSelector(SettledInvoiceFeedback.VaultNotBound.selector, address(vault), address(vault2))
        );
        _give(operator, IInvoiceMandateView(address(vault2)), INVOICE);
    }

    function test_refuses_fakeVaultNotDeclared() public {
        FakeVault fake = new FakeVault(stranger, agent);
        agentId = _registerWithProvenWallet(address(vault));
        vm.expectRevert(
            abi.encodeWithSelector(SettledInvoiceFeedback.VaultNotBound.selector, address(vault), address(fake))
        );
        _give(stranger, IInvoiceMandateView(address(fake)), INVOICE);
    }

    function test_refuses_noVaultDeclared() public {
        _settle(vault, INVOICE);
        vm.prank(identityOwner);
        agentId = identity.register("u");
        vm.expectRevert(
            abi.encodeWithSelector(SettledInvoiceFeedback.VaultNotBound.selector, address(0), address(vault))
        );
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_refuses_unprovenWallet() public {
        _settle(vault, INVOICE);
        vm.startPrank(identityOwner);
        agentId = identity.register("u"); // agentWallet = identityOwner, never proven for `agent`
        identity.setMetadata(agentId, KEY, abi.encode(address(vault)));
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.AgentMismatch.selector, agent, identityOwner));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_refuses_walletClearedByTransfer() public {
        _settle(vault, INVOICE);
        agentId = _registerWithProvenWallet(address(vault));
        vm.prank(identityOwner);
        identity.transferFrom(identityOwner, stranger, agentId);
        assertEq(identity.getAgentWallet(agentId), address(0));
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.AgentMismatch.selector, agent, address(0)));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_refuses_nonCounterparty() public {
        _settle(vault, INVOICE);
        agentId = _registerWithProvenWallet(address(vault));
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.NotACounterparty.selector, stranger));
        _give(stranger, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_refuses_selfFeedbackByIdentityOwner() public {
        // The operator owns the identity: it may not rate its own agent (ERC-8004's self-feedback rule).
        _settle(vault, INVOICE);
        vm.prank(operator);
        agentId = identity.register("u");
        vm.prank(operator);
        identity.setMetadata(agentId, KEY, abi.encode(address(vault)));
        uint256 deadline = block.timestamp + 4 minutes;
        bytes memory sig = _walletSig(agentId, agent, operator, deadline, agentPk);
        vm.prank(operator);
        identity.setAgentWallet(agentId, agent, deadline, sig);

        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.SelfFeedback.selector, operator));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
        // ... but the vendor's payee may.
        uint64 idx = _give(payTo, IInvoiceMandateView(address(vault)), INVOICE);
        assertEq(idx, 1);
    }

    function test_refuses_secondRatingOfSameSettlement() public {
        _settle(vault, INVOICE);
        agentId = _registerWithProvenWallet(address(vault));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
        bytes32 key = vault.invoiceKey(INVOICE, VENDOR);
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.AlreadyRated.selector, key, operator));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_registry_stillRefusesDirectSelfFeedback() public {
        agentId = _registerWithProvenWallet(address(vault));
        vm.prank(identityOwner);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        reputation.giveFeedback(agentId, 100, 0, TAG1, "", "", "", bytes32(0));
    }

    // ------------------------------------------------------------ acceptance and read path

    function test_accepts_settledInvoice_andReadsBack() public {
        _settle(vault, INVOICE);
        uint256 settledAt = block.number;
        agentId = _registerWithProvenWallet(address(vault));
        bytes32 key = vault.invoiceKey(INVOICE, VENDOR);

        uint64 idx = _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
        assertEq(idx, 1);

        (int128 value, uint8 dec, string memory tag1, string memory tag2, bool revoked) =
            reputation.readFeedback(agentId, address(adapter), idx);
        assertEq(value, 100);
        assertEq(dec, 0);
        assertEq(tag1, TAG1);
        assertEq(tag2, vm.toString(key));
        assertFalse(revoked);

        address[] memory clients = new address[](1);
        clients[0] = address(adapter);
        (uint64 count,,) = reputation.getSummary(agentId, clients, TAG1, "");
        assertEq(count, 1);

        SettledInvoiceFeedback.Anchor memory a = adapter.anchorOf(agentId, idx);
        assertEq(a.vault, address(vault));
        assertEq(a.invoiceKey, key);
        assertEq(a.agent, agent);
        assertEq(a.rater, operator);
        assertEq(uint8(a.role), uint8(SettledInvoiceFeedback.Role.Operator));
        assertEq(a.settlementBlock, settledAt);
        assertEq(a.amount, 1e6);
        assertEq(a.invoiceId, INVOICE);
        assertEq(adapter.anchorCount(agentId), 1);

        SettledInvoiceFeedback.Link memory l = adapter.linkOf(agentId, INVOICE, VENDOR);
        assertEq(l.owner, identityOwner);
        assertEq(l.agentWallet, agent);
        assertEq(l.vault, address(vault));
        (address mandateAgent,,,,,,) = vault.mandate();
        assertEq(l.mandateAgent, mandateAgent);
        assertTrue(l.settled);
        assertEq(l.settledBy, agent);
        assertEq(l.settlementBlock, settledAt);
        assertTrue(l.linked);

        // Operator and payee may each rate the settlement once.
        uint64 idx2 = _give(payTo, IInvoiceMandateView(address(vault)), INVOICE);
        assertEq(idx2, 2);
        assertEq(uint8(adapter.anchorOf(agentId, idx2).role), uint8(SettledInvoiceFeedback.Role.Payee));
    }

    function test_accepts_afterMandateExpiredOrRevoked() public {
        // The settlement is history: feedback stays possible after the mandate expired (the real vault's state).
        _settle(vault, INVOICE);
        agentId = _registerWithProvenWallet(address(vault));
        vm.warp(block.timestamp + 2 days);
        vm.prank(operator);
        vault.revokeAgent();
        uint64 idx = _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
        SettledInvoiceFeedback.Link memory l = adapter.linkOf(agentId, INVOICE, VENDOR);
        assertEq(l.mandateAgent, address(0));
        assertTrue(l.linked);
        assertEq(adapter.anchorOf(agentId, idx).agent, agent);
    }

    function test_revoke_onlyByRater() public {
        _settle(vault, INVOICE);
        agentId = _registerWithProvenWallet(address(vault));
        uint64 idx = _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
        vm.prank(payTo);
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.NotRater.selector, payTo));
        adapter.revokeSettledFeedback(agentId, idx);
        vm.prank(operator);
        adapter.revokeSettledFeedback(agentId, idx);
        (,,,, bool revoked) = reputation.readFeedback(agentId, address(adapter), idx);
        assertTrue(revoked);
        // A revoked rating does not reopen the settlement for a new one.
        bytes32 key = vault.invoiceKey(INVOICE, VENDOR);
        vm.expectRevert(abi.encodeWithSelector(SettledInvoiceFeedback.AlreadyRated.selector, key, operator));
        _give(operator, IInvoiceMandateView(address(vault)), INVOICE);
    }

    function test_vaultRef_isCaip10() public view {
        assertEq(
            adapter.vaultRef(address(vault)),
            string.concat("eip155:", vm.toString(block.chainid), ":", vm.toLowercase(vm.toString(address(vault))))
        );
    }
}
