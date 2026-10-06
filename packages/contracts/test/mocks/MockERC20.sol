// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal standard ERC-20 (returns `true`), 6 decimals like USDC.
contract MockERC20 {
    string public name = "Mock USD Coin";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        _spendAllowance(from, amount);
        _move(from, to, amount);
        return true;
    }

    function _spendAllowance(address from, uint256 amount) internal {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Burns 1% of every transfer: the receiver gets less than `amount`.
contract FeeOnTransferERC20 is MockERC20 {
    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "insufficient balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// @dev USDC-style token with an operator blacklist: any transfer from or to a blacklisted address reverts.
contract BlacklistERC20 is MockERC20 {
    mapping(address => bool) public blacklisted;

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function _move(address from, address to, uint256 amount) internal override {
        require(!blacklisted[from] && !blacklisted[to], "Blacklistable: account is blacklisted");
        super._move(from, to, amount);
    }
}

/// @dev USDT-style token: `transfer`/`transferFrom` return nothing.
contract NoReturnERC20 {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        require(balanceOf[from] >= amount, "insufficient balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Token that moves balances but returns `false` from `transfer`/`transferFrom`.
contract FalseReturnERC20 is MockERC20 {
    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        return false;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spendAllowance(from, amount);
        _move(from, to, amount);
        return false;
    }
}

/// @dev Malicious token: on every transfer it re-enters `target` with `attackData` once and records the result.
contract ReentrantERC20 is MockERC20 {
    address public target;
    bytes public attackData;
    bool public attacked;
    bool public lastReentryOk;
    bytes public lastReentryData;

    function setAttack(address target_, bytes calldata attackData_) external {
        target = target_;
        attackData = attackData_;
        attacked = false;
    }

    function _move(address from, address to, uint256 amount) internal override {
        super._move(from, to, amount);
        if (!attacked && target != address(0)) {
            attacked = true;
            (lastReentryOk, lastReentryData) = target.call(attackData);
        }
    }
}
