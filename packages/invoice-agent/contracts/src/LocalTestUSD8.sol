// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title LocalTestUSD8: a LOCAL TEST stand-in for QDay's tUSD8, for the Anvil demo only.
/// @notice NOT the tUSD8 contract (0x456569838f1d43009A91ebA4263147Afd7233483 on Aevum Testnet).
///         Same shape that matters to the demo: a plain ERC-20 with 6 decimals whose `transfer`
///         returns true and emits `Transfer`. Anyone can mint: never deploy it anywhere that matters.
contract LocalTestUSD8 {
    string public constant name = "tUSD8 (LOCAL TEST, not the QDay token)";
    string public constant symbol = "tUSD8-LOCAL";
    uint8 public constant decimals = 6;
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

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
