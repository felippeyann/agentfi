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
///         the vendor and its registered payee, a cap per invoice, a daily limit (UTC days) and an expiry. The agent
///         can only call `payInvoice`, which pays the registered payee, within the limits, before the expiry, and at
///         most ONCE per (invoice id, vendor): a second settlement of the same invoice reverts, whatever the nonce,
///         the process or the ledger that sends it. A stolen agent key can therefore pay nobody else and no more
///         than the limits. The operator can pause, revoke the agent and withdraw at any time.
///         No upgradeability, no admin above the operator.
contract InvoiceMandate {
    struct Mandate {
        address agent; // the only key that may call payInvoice; address(0) = revoked
        uint40 expiresAt; // unix time; nothing is paid at or after it
        bool paused;
        address payTo; // the vendor's registered payee
        uint48 maxPerInvoice; // token base units (6 decimals)
        uint48 maxPerDay; // token base units, per UTC day
        bytes32 vendor; // the vendor's id, e.g. bytes32("acme")
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
    error MandatePaused();
    error MandateExpired();
    error InvalidInvoiceId();
    error ZeroAmount();
    error AboveInvoiceCap(uint256 amount, uint256 cap);
    error AboveDailyLimit(uint256 spentToday, uint256 amount, uint256 limit);
    error AlreadySettled(bytes32 invoiceKey, uint256 blockNumber);
    error InvalidMandate(string why);
    error InvalidToken();
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

    /// @notice Sets (or replaces) the whole mandate. Today's spending carries over: replacing the mandate never resets the daily limit.
    function setMandate(
        address agent,
        bytes32 vendor,
        address payTo,
        uint48 maxPerInvoice,
        uint48 maxPerDay,
        uint40 expiresAt
    ) external onlyOperator {
        if (agent == address(0)) revert InvalidMandate("agent");
        if (vendor == bytes32(0)) revert InvalidMandate("vendor");
        if (payTo == address(0) || payTo == address(this)) revert InvalidMandate("payTo");
        if (maxPerInvoice == 0 || maxPerInvoice > maxPerDay) revert InvalidMandate("limits");
        if (expiresAt <= block.timestamp) revert InvalidMandate("expiresAt");
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
        emit AgentRevoked(mandate.agent);
        mandate.agent = address(0);
    }

    /// @notice Returns tUSD8 from the vault to the operator.
    function withdraw(uint256 amount) external onlyOperator {
        _transfer(operator, amount);
        emit Withdrawn(operator, amount);
    }

    /// @notice Pays `amount` base units of invoice `invoiceId` to the vendor's registered payee. Only the agent; once per invoice.
    function payInvoice(string calldata invoiceId, uint256 amount) external {
        Mandate memory m = mandate;
        if (msg.sender != m.agent || m.agent == address(0)) revert NotAgent();
        if (m.paused) revert MandatePaused();
        if (block.timestamp >= m.expiresAt) revert MandateExpired();
        if (bytes(invoiceId).length == 0 || bytes(invoiceId).length > 64) revert InvalidInvoiceId();
        if (amount == 0) revert ZeroAmount();
        if (amount > m.maxPerInvoice) revert AboveInvoiceCap(amount, m.maxPerInvoice);

        bytes32 key = invoiceKey(invoiceId, m.vendor);
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
        emit InvoiceSettled(key, invoiceId, m.vendor, m.payTo, amount, msg.sender);
        _transfer(m.payTo, amount);
    }

    /// @notice The settlement of `invoiceId` for the CURRENT vendor ("was it paid?", straight from the chain).
    function settlementOf(string calldata invoiceId)
        external
        view
        returns (bool settled, uint256 amount, uint256 blockNumber, address agent, bytes32 key)
    {
        key = invoiceKey(invoiceId, mandate.vendor);
        Settlement memory s = settlements[key];
        return (s.blockNumber != 0, s.amount, s.blockNumber, s.agent, key);
    }

    /// @notice The idempotency key: one settlement per (invoice id, vendor).
    function invoiceKey(string calldata invoiceId, bytes32 vendor) public pure returns (bytes32) {
        return keccak256(abi.encode(invoiceId, vendor));
    }

    /// @dev SafeERC20-style: the call must succeed and return nothing or `true` (FiatToken returns a bool).
    function _transfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(ITUSD8.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
