// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @dev The part of QDay's tUSD8 (a Circle FiatToken clone, 6 decimals) this vault uses.
interface ITUSD8 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title InvoiceMandate: one operator's tUSD8 vault that an agent can use only to pay one vendor's invoices, once each.
/// @notice The operator funds the vault (a plain tUSD8 transfer to its address) and sets the mandate: the agent key,
///         the vendor and its registered payee, a cap per invoice, a daily limit (calendar UTC days) and an expiry. The
///         agent can only call `payInvoice`, naming the vendor and payee it judged: it pays only if they are still the
///         mandate's, within the limits, before the expiry, and at most ONCE per (invoice id, vendor): a second settlement
///         of the same invoice reverts, whatever the nonce, the process or the ledger that sends it. A stolen agent key can
///         pay nobody but the registered payee, and no more than the limits. The operator can pause, revoke the agent and
///         withdraw at any time. No upgradeability, no admin above the operator.
contract InvoiceMandate {
    struct Mandate {
        address agent; // the only key that may call payInvoice; address(0) = revoked
        uint40 expiresAt; // unix time; nothing is paid at or after it
        bool paused;
        address payTo; // the vendor's registered payee
        uint48 maxPerInvoice; // token base units (6 decimals)
        uint48 maxPerDay; // token base units, per calendar UTC day
        bytes32 vendor; // the vendor's id, e.g. bytes32("vendor-1")
    }

    struct Settlement {
        address agent; // who settled it
        uint48 amount; // token base units
        uint48 blockNumber; // 0 = not settled
    }

    ITUSD8 public immutable token;
    address public immutable operator;

    Mandate public mandate;
    uint48 public spentToday; // base units paid on `day`
    uint32 public day; // block.timestamp / 1 days of the last payment
    mapping(bytes32 invoiceKey => Settlement) public settlements;
    /// @notice Every vendor id this vault has ever been mandated for, in order: "was it paid?" checks all of them.
    bytes32[] public vendors;
    mapping(bytes32 vendor => bool) public knownVendor;

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
    event Swept(address indexed otherToken, address indexed to, uint256 amount);
    event InvoiceSettled(
        bytes32 indexed invoiceKey,
        string invoiceId,
        bytes32 indexed vendor,
        address indexed payTo,
        uint256 amount,
        address agent
    );

    error NotOperator();
    error NotAgent();
    error NoAgent();
    error MandatePaused();
    error MandateExpired();
    error MandateChanged(bytes32 vendor, address payTo);
    error InvalidInvoiceId();
    error ZeroAmount();
    error AboveInvoiceCap(uint256 amount, uint256 cap);
    error AboveDailyLimit(uint256 spentToday, uint256 amount, uint256 limit);
    error AlreadySettled(bytes32 invoiceKey, uint256 blockNumber);
    error InvalidMandate(string why);
    error InvalidToken();
    error InvalidRecipient();
    error TransferFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @param token_ tUSD8 (0x456569838f1d43009A91ebA4263147Afd7233483 on Aevum Testnet). The deployer is the operator.
    constructor(ITUSD8 token_) {
        if (address(token_).code.length == 0 || token_.decimals() != 6) revert InvalidToken();
        token = token_;
        operator = msg.sender;
    }

    /// @notice Sets (or replaces) the whole mandate. Today's spending carries over: replacing the mandate never resets the
    ///         daily limit, and never lifts a pause.
    function setMandate(
        address agent,
        bytes32 vendor,
        address payTo,
        uint48 maxPerInvoice,
        uint48 maxPerDay,
        uint40 expiresAt
    ) external onlyOperator {
        if (agent == address(0) || agent == operator) revert InvalidMandate("agent");
        if (vendor == bytes32(0)) revert InvalidMandate("vendor");
        if (payTo == address(0) || payTo == address(this) || payTo == agent || payTo == address(token)) {
            revert InvalidMandate("payTo");
        }
        if (maxPerInvoice == 0 || maxPerInvoice > maxPerDay) revert InvalidMandate("limits");
        if (expiresAt <= block.timestamp) revert InvalidMandate("expiresAt");
        if (!knownVendor[vendor]) {
            knownVendor[vendor] = true;
            vendors.push(vendor);
        }
        bool paused = mandate.paused;
        mandate = Mandate(agent, expiresAt, paused, payTo, maxPerInvoice, maxPerDay, vendor);
        emit MandateSet(agent, vendor, payTo, maxPerInvoice, maxPerDay, expiresAt);
    }

    function pause() external onlyOperator {
        mandate.paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOperator {
        mandate.paused = false;
        emit Paused(false);
    }

    /// @notice Instant revocation: the agent key can no longer pay anything; a new `setMandate` names a new one.
    function revokeAgent() external onlyOperator {
        address agent = mandate.agent;
        if (agent == address(0)) revert NoAgent();
        mandate.agent = address(0);
        emit AgentRevoked(agent);
    }

    /// @notice Returns tUSD8 from the vault to the operator.
    function withdraw(uint256 amount) external onlyOperator {
        _withdrawTo(operator, amount);
    }

    /// @notice Returns tUSD8 from the vault to an address the operator chooses (e.g. when the operator is blacklisted).
    function withdrawTo(address to, uint256 amount) external onlyOperator {
        _withdrawTo(to, amount);
    }

    /// @notice Sends the whole balance of a token other than tUSD8, sent here by mistake, to an address the operator chooses.
    function sweep(address otherToken, address to) external onlyOperator {
        if (otherToken == address(token)) revert InvalidToken();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        uint256 amount = ITUSD8(otherToken).balanceOf(address(this));
        _safeTransfer(otherToken, to, amount);
        emit Swept(otherToken, to, amount);
    }

    /// @notice Pays `amount` base units of `vendor`'s invoice `invoiceId` to `payTo`. Only the agent; once per invoice.
    ///         `vendor` and `payTo` are what the agent judged and signed: if the operator has changed the mandate since,
    ///         the call reverts (MandateChanged) instead of paying the new vendor with the old vendor's invoice.
    function payInvoice(string calldata invoiceId, bytes32 vendor, address payTo, uint256 amount) external {
        Mandate memory m = mandate;
        if (msg.sender != m.agent || m.agent == address(0)) revert NotAgent();
        if (m.paused) revert MandatePaused();
        if (block.timestamp >= m.expiresAt) revert MandateExpired();
        if (vendor != m.vendor || payTo != m.payTo) revert MandateChanged(m.vendor, m.payTo);
        if (bytes(invoiceId).length == 0 || bytes(invoiceId).length > 64) revert InvalidInvoiceId();
        if (amount == 0) revert ZeroAmount();
        if (amount > m.maxPerInvoice) revert AboveInvoiceCap(amount, m.maxPerInvoice);

        bytes32 key = invoiceKey(invoiceId, vendor);
        Settlement storage s = settlements[key];
        if (s.blockNumber != 0) revert AlreadySettled(key, s.blockNumber);

        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = today == day ? spentToday : 0;
        if (spent + amount > m.maxPerDay) revert AboveDailyLimit(spent, amount, m.maxPerDay);

        // Effects before the token call: a re-entrant call finds the invoice settled and the day's spending counted.
        // The casts cannot truncate: amount <= maxPerInvoice and spent + amount <= maxPerDay are uint48 values.
        // forge-lint: disable-next-line(unsafe-typecast)
        (s.agent, s.amount, s.blockNumber) = (msg.sender, uint48(amount), uint48(block.number));
        // forge-lint: disable-next-line(unsafe-typecast)
        (day, spentToday) = (today, uint48(spent + amount));
        emit InvoiceSettled(key, invoiceId, vendor, payTo, amount, msg.sender);
        _safeTransfer(address(token), payTo, amount);
    }

    /// @notice The settlement of `vendor`'s invoice `invoiceId` ("was it paid?", straight from the chain).
    function settlementOf(string calldata invoiceId, bytes32 vendor)
        public
        view
        returns (bool settled, uint256 amount, uint256 blockNumber, address agent, bytes32 key)
    {
        key = invoiceKey(invoiceId, vendor);
        Settlement memory s = settlements[key];
        return (s.blockNumber != 0, s.amount, s.blockNumber, s.agent, key);
    }

    /// @notice `invoiceId` looked up for EVERY vendor this vault has had, newest first: the first settlement found, or
    ///         settled = false when no vendor of this vault has a settlement under that id.
    function findSettlement(string calldata invoiceId)
        external
        view
        returns (bool settled, bytes32 vendor, uint256 amount, uint256 blockNumber, address agent, bytes32 key)
    {
        for (uint256 i = vendors.length; i > 0; i--) {
            vendor = vendors[i - 1];
            (settled, amount, blockNumber, agent, key) = settlementOf(invoiceId, vendor);
            if (settled) return (settled, vendor, amount, blockNumber, agent, key);
        }
        return (false, bytes32(0), 0, 0, address(0), bytes32(0));
    }

    /// @notice How many vendors this vault has been mandated for (`vendors(i)` lists them).
    function vendorCount() external view returns (uint256) {
        return vendors.length;
    }

    /// @notice What the agent may still pay today (calendar UTC day) under the current daily limit.
    function remainingToday() external view returns (uint256) {
        uint256 spent = uint32(block.timestamp / 1 days) == day ? spentToday : 0;
        return spent >= mandate.maxPerDay ? 0 : mandate.maxPerDay - spent;
    }

    /// @notice The idempotency key: one settlement per (invoice id, vendor).
    function invoiceKey(string calldata invoiceId, bytes32 vendor) public pure returns (bytes32) {
        return keccak256(abi.encode(invoiceId, vendor));
    }

    function _withdrawTo(address to, uint256 amount) private {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        _safeTransfer(address(token), to, amount);
        emit Withdrawn(to, amount);
    }

    /// @dev SafeERC20-style: the call must succeed and return nothing or `true` (FiatToken returns a bool).
    function _safeTransfer(address tkn, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = tkn.call(abi.encodeCall(ITUSD8.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
