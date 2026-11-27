// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev The read-only part of the deployed InvoiceMandate vault this adapter uses (packages/invoice-agent/contracts).
interface IInvoiceMandateView {
    function operator() external view returns (address);
    function mandate()
        external
        view
        returns (
            address agent,
            uint40 expiresAt,
            bool paused,
            address payTo,
            uint48 maxPerInvoice,
            uint48 maxPerDay,
            bytes32 vendor
        );
    function settlementOf(string calldata invoiceId, bytes32 vendor)
        external
        view
        returns (bool settled, uint256 amount, uint256 blockNumber, address agent, bytes32 key);
}

/// @dev The ERC-8004 Identity Registry calls this adapter needs (reference implementation, v2.0.0).
interface IERC8004Identity {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

/// @dev The ERC-8004 Reputation Registry calls this adapter needs (reference implementation, v2.0.0).
interface IERC8004Reputation {
    function getIdentityRegistry() external view returns (address);
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
}

/// @title SettledInvoiceFeedback: ERC-8004 feedback about an agent that cannot be written without a settled invoice.
/// @notice Each adapter instance is bound, at deployment and for good, to ONE InvoiceMandate vault (`vault()`, an
///         immutable; there is no owner and no setter). A counterparty of that vault (its operator, or the vendor's
///         registered payee) rates the agent that settled one of the vault's invoices. The adapter is the ERC-8004
///         `clientAddress`, so every entry it writes is anchored: the only write path, `giveSettledFeedback`, checks
///         on-chain, before calling `giveFeedback`, that
///           1. the agent's owner declared this same vault in the Identity Registry (metadata key VAULT_KEY): a
///              declaration that points anywhere else is refused, so an owner cannot substitute a contract of its
///              choosing for the bound vault;
///           2. the bound vault records the invoice as settled (`settlementOf`);
///           3. the settling key is the agent's verified `agentWallet` (ERC-8004: the owner's address, or a wallet the
///              owner proved control of with an EIP-712 / ERC-1271 signature);
///           4. the rater is the vault's operator or the mandate's payee for that vendor, and is NOT the agent's owner,
///              an approved operator of it, or the agent wallet (the spec's self-feedback rule, applied to the real
///              rater, since the registry only sees this adapter);
///           5. this ROLE has not already rated this settlement: at most one rating from the operator and one from
///              a payee per settlement. The payee is whoever the operator set as the current mandate's payee (the vault
///              does not expose the settlement's own payee, and the operator is trusted to name it); capping by role
///              means re-pointing the payee cannot turn one payment into more ratings.
///         Reading `getSummary(agentId, [adapter], TAG1, "")` therefore aggregates only feedback anchored in a
///         settlement of `vault()`. The trust root is the adapter's address: anyone can deploy another instance bound
///         to a contract of their choosing (even a fake vault), and its entries carry that other instance as
///         `clientAddress`. A reader must therefore (a) take the adapter address from a source it trusts, (b) check
///         that its code is this contract (verified source) and (c) check that `vault()` is the expected
///         InvoiceMandate (verified source; on Aevum, the vault of the public proof).
///         What it does NOT prove: the quality of the work, that operator / vendor / agent owner are independent
///         parties, or that any of them is a real business. Those stay declarations.
contract SettledInvoiceFeedback {
    /// @notice Identity Registry metadata key under which the agent's owner declares its vault: abi.encode(address).
    string public constant VAULT_KEY = "agentfi.invoiceMandateVault";
    /// @notice tag1 of every entry this adapter writes; tag2 is the invoiceKey as a 0x-prefixed hex string.
    string public constant TAG1 = "agentfi.settledInvoice";

    enum Role {
        None,
        Operator,
        Payee
    }

    struct Anchor {
        address vault;
        bytes32 invoiceKey;
        bytes32 vendor;
        address agent; // settlement.agent == agentWallet at feedback time
        address rater; // the real client behind this adapter's clientAddress
        Role role;
        uint48 settlementBlock;
        uint48 amount;
        string invoiceId;
    }

    IERC8004Identity public immutable identity;
    IERC8004Reputation public immutable reputation;
    /// @notice The one InvoiceMandate vault whose settlements this instance accepts, fixed at deployment.
    IInvoiceMandateView public immutable vault;

    /// @notice agentId => feedbackIndex (the Reputation Registry's, for clientAddress = this adapter) => anchor.
    mapping(uint256 agentId => mapping(uint64 feedbackIndex => Anchor)) internal _anchors;
    /// @notice keccak256(vault, invoiceKey, role) => already rated (one rating per role and settlement).
    mapping(bytes32 => bool) public rated;

    event AnchoredFeedback(
        uint256 indexed agentId,
        uint64 indexed feedbackIndex,
        address indexed vault,
        bytes32 invoiceKey,
        string invoiceId,
        bytes32 vendor,
        address agent,
        address rater,
        Role role,
        uint256 settlementBlock,
        uint256 amount
    );
    event AnchoredFeedbackRevoked(uint256 indexed agentId, uint64 indexed feedbackIndex, address indexed rater);

    error VaultNotBound(address declared, address bound);
    error NotSettled(bytes32 invoiceKey);
    error AgentMismatch(address settledBy, address agentWallet);
    error NotACounterparty(address rater);
    error SelfFeedback(address rater);
    error AlreadyRated(bytes32 invoiceKey, Role role);
    error NotRater(address caller);
    error UnknownFeedback(uint256 agentId, uint64 feedbackIndex);
    error BadRegistry();
    error BadVault(address vault);

    constructor(IERC8004Reputation reputation_, IInvoiceMandateView vault_) {
        address id = reputation_.getIdentityRegistry();
        if (id == address(0)) revert BadRegistry();
        // A sanity check, not an authentication: it refuses an EOA or an empty address, not a look-alike contract.
        // Which vault is genuine is for the reader to check (see the contract notice).
        if (address(vault_).code.length == 0) revert BadVault(address(vault_));
        reputation = reputation_;
        identity = IERC8004Identity(id);
        vault = vault_;
    }

    /// @notice Rate `agentId` for the settlement of `vendor`'s invoice `invoiceId` in the bound `vault()`. Reverts
    ///         unless every check in the contract notice holds. `feedbackURI`/`feedbackHash` are the optional ERC-8004
    ///         off-chain file (e.g. JSON naming the settlement tx hash) and its keccak256; neither is checked here.
    ///         This is the only function that writes a rating.
    /// @return feedbackIndex The Reputation Registry index of the entry (clientAddress = this adapter).
    function giveSettledFeedback(
        uint256 agentId,
        string calldata invoiceId,
        bytes32 vendor,
        int128 value,
        uint8 valueDecimals,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external returns (uint64 feedbackIndex) {
        address declared = declaredVault(agentId);
        if (declared != address(vault)) revert VaultNotBound(declared, address(vault));

        (bool settled, uint256 amount, uint256 blockNumber, address settledBy, bytes32 key) =
            vault.settlementOf(invoiceId, vendor);
        if (!settled) revert NotSettled(key);

        address wallet = identity.getAgentWallet(agentId);
        if (wallet == address(0) || settledBy != wallet) revert AgentMismatch(settledBy, wallet);

        Role role = roleOf(vendor, msg.sender);
        if (role == Role.None) revert NotACounterparty(msg.sender);
        if (msg.sender == wallet || identity.isAuthorizedOrOwner(msg.sender, agentId)) revert SelfFeedback(msg.sender);

        bytes32 once = keccak256(abi.encode(address(vault), key, role));
        if (rated[once]) revert AlreadyRated(key, role);
        rated[once] = true;

        reputation.giveFeedback(
            agentId,
            value,
            valueDecimals,
            TAG1,
            Strings.toHexString(uint256(key), 32),
            vaultRef(),
            feedbackURI,
            feedbackHash
        );
        feedbackIndex = reputation.getLastIndex(agentId, address(this));

        // The casts cannot truncate: the vault stores amount and blockNumber as uint48.
        _anchors[agentId][feedbackIndex] = Anchor({
            vault: address(vault),
            invoiceKey: key,
            vendor: vendor,
            agent: settledBy,
            rater: msg.sender,
            role: role,
            // forge-lint: disable-next-line(unsafe-typecast)
            settlementBlock: uint48(blockNumber),
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint48(amount),
            invoiceId: invoiceId
        });
        emit AnchoredFeedback(
            agentId,
            feedbackIndex,
            address(vault),
            key,
            invoiceId,
            vendor,
            settledBy,
            msg.sender,
            role,
            blockNumber,
            amount
        );
    }

    /// @notice The original rater withdraws its entry (ERC-8004 `revokeFeedback`, which only the clientAddress -
    ///         this adapter - may call). The settlement stays rated for that role: it cannot be rated again.
    function revokeSettledFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Anchor storage a = _anchors[agentId][feedbackIndex];
        if (a.vault == address(0)) revert UnknownFeedback(agentId, feedbackIndex);
        if (a.rater != msg.sender) revert NotRater(msg.sender);
        reputation.revokeFeedback(agentId, feedbackIndex);
        emit AnchoredFeedbackRevoked(agentId, feedbackIndex, msg.sender);
    }

    // ---------------------------------------------------------------- read path

    /// @notice The vault the agent's owner declared (address(0) if none or malformed).
    function declaredVault(uint256 agentId) public view returns (address) {
        bytes memory v = identity.getMetadata(agentId, VAULT_KEY);
        if (v.length != 32) return address(0);
        return abi.decode(v, (address));
    }

    /// @notice How a would-be rater relates to the bound vault: its operator, the current mandate's payee for
    ///         `vendor`, or neither.
    function roleOf(bytes32 vendor, address who) public view returns (Role) {
        if (who == vault.operator()) return Role.Operator;
        (,,, address payTo,,, bytes32 mVendor) = vault.mandate();
        if (mVendor == vendor && who == payTo) return Role.Payee;
        return Role.None;
    }

    /// @notice Number of entries this adapter has written for `agentId` (indexes 1..n).
    function anchorCount(uint256 agentId) external view returns (uint64) {
        return reputation.getLastIndex(agentId, address(this));
    }

    function anchorOf(uint256 agentId, uint64 feedbackIndex) external view returns (Anchor memory) {
        Anchor memory a = _anchors[agentId][feedbackIndex];
        if (a.vault == address(0)) revert UnknownFeedback(agentId, feedbackIndex);
        return a;
    }

    struct Link {
        address owner; // ERC-721 owner of agentId
        address agentWallet; // ERC-8004 verified agent wallet
        address vault; // the bound vault, vault() (the only one this instance reads)
        address declaredVault; // declared by the owner (VAULT_KEY); must equal `vault` for a link
        address mandateAgent; // vault.mandate().agent now (address(0) if revoked)
        bool settled;
        address settledBy; // settlement.agent
        uint256 amount;
        uint256 settlementBlock;
        bytes32 invoiceKey;
        bool linked; // declaredVault == vault && settled && settledBy == agentWallet != 0
    }

    /// @notice Live check, no feedback needed: agentId -> owner, agentWallet, the declared vault, and, in the BOUND
    ///         vault, the mandate agent and the settlement of (`invoiceId`, `vendor`). The settlement tx is found with
    ///         eth_getLogs for InvoiceSettled(invoiceKey) at `settlementBlock` on the vault.
    function linkOf(uint256 agentId, string calldata invoiceId, bytes32 vendor) external view returns (Link memory l) {
        l.owner = identity.ownerOf(agentId);
        l.agentWallet = identity.getAgentWallet(agentId);
        l.vault = address(vault);
        l.declaredVault = declaredVault(agentId);
        (l.mandateAgent,,,,,,) = vault.mandate();
        (l.settled, l.amount, l.settlementBlock, l.settledBy, l.invoiceKey) = vault.settlementOf(invoiceId, vendor);
        l.linked =
            l.declaredVault == l.vault && l.settled && l.agentWallet != address(0) && l.settledBy == l.agentWallet;
    }

    /// @notice The ERC-8004 `endpoint` written with each entry: "eip155:<chainId>:<bound vault>".
    function vaultRef() public view returns (string memory) {
        return string.concat("eip155:", Strings.toString(block.chainid), ":", Strings.toHexString(address(vault)));
    }
}
