// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @dev Test stand-in for tUSD8 (FiatToken shape that matters here: 6 decimals, `transfer` returns bool and reverts
///      on insufficient balance). Open mint: tests only.
contract MockTUSD8 {
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @dev Moves nothing and returns false: the vault must revert (TransferFailed), not record a settlement.
contract FalseTUSD8 is MockTUSD8 {
    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @dev 18 decimals: not tUSD8, the constructor refuses it.
contract EighteenDecimals {
    uint8 public decimals = 18;
}

/// @dev On transfer, re-enters the vault once with `data` (as the token, i.e. not the agent) and records the result.
contract ReentrantTUSD8 is MockTUSD8 {
    address public target;
    bytes public data;
    bool public reentered;
    bool public reentryOk;

    function arm(address target_, bytes calldata data_) external {
        (target, data, reentered) = (target_, data_, false);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        if (!reentered && target != address(0)) {
            reentered = true;
            (reentryOk,) = target.call(data);
        }
        return true;
    }
}
