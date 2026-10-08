// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityRegistry} from "../../src/IIdentityRegistry.sol";

/// @dev Minimal ERC-8004 Identity Registry: `ownerOf` / `getAgentWallet` per id, both reverting
///      for unknown ids like the ERC-721 reference implementation; can be told to revert on everything.
///      Also models the ERC-721 approvals the v2.0.0 Reputation Registry consults through
///      `isAuthorizedOrOwner` for its anti-self-feedback check (see `MockReputationRegistry.setSelfFeedbackGuard`).
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => address) internal _wallets;
    mapping(uint256 => address) internal _approved;
    mapping(address => mapping(address => bool)) internal _operators;
    bool public shouldRevert;

    error ERC721NonexistentToken(uint256 tokenId);

    function setOwner(uint256 agentId, address owner) external {
        _owners[agentId] = owner;
    }

    function setWallet(uint256 agentId, address wallet) external {
        _wallets[agentId] = wallet;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    /// @dev ERC-721 `transferFrom` as the v2.0.0 registry implements it for this purpose: the owner
    ///      changes, the single-token approval and the agent wallet are cleared.
    function transfer(uint256 agentId, address to) external {
        _owners[agentId] = to;
        delete _approved[agentId];
        delete _wallets[agentId];
    }

    /// @dev ERC-721 `approve`, callable by the owner (`msg.sender`).
    function approve(address to, uint256 agentId) external {
        require(msg.sender == _owners[agentId], "MockIdentityRegistry: not owner");
        _approved[agentId] = to;
    }

    /// @dev ERC-721 `setApprovalForAll` for `msg.sender`'s tokens.
    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
    }

    /// @dev ERC-8004 v2.0.0: owner, approved address or operator of the owner. Reverts for unknown ids.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
        return spender == owner || _approved[agentId] == spender || _operators[owner][spender];
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        if (shouldRevert) revert("MockIdentityRegistry: forced revert");
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function getAgentWallet(uint256 agentId) external view returns (address wallet) {
        if (shouldRevert) revert("MockIdentityRegistry: forced revert");
        if (_owners[agentId] == address(0)) revert ERC721NonexistentToken(agentId);
        wallet = _wallets[agentId];
    }
}

/// @dev Identity registry whose `ownerOf` / `getAgentWallet` can each be told to answer normally, loop
///      forever (burn the whole cap), burn the cap down to `LEAVE` and then answer, or answer with
///      `HUGE_RETURN` bytes of return data whose first word is the answer (R3c gas-griefing cases).
contract GasGriefingIdentityRegistry {
    enum Mode {
        Answer,
        Loop,
        BurnThenAnswer,
        HugeReturn
    }

    uint256 internal constant LEAVE = 2_000;
    uint256 public constant HUGE_RETURN = 64 * 1024;

    Mode public ownerMode;
    Mode public walletMode;
    address public ownerAnswer;
    address public walletAnswer;

    function set(Mode ownerMode_, address ownerAnswer_, Mode walletMode_, address walletAnswer_) external {
        ownerMode = ownerMode_;
        ownerAnswer = ownerAnswer_;
        walletMode = walletMode_;
        walletAnswer = walletAnswer_;
    }

    function ownerOf(uint256) external view returns (address) {
        return _respond(ownerMode, ownerAnswer);
    }

    function getAgentWallet(uint256) external view returns (address) {
        return _respond(walletMode, walletAnswer);
    }

    function _respond(Mode mode, address answer) internal view returns (address) {
        if (mode == Mode.Loop) {
            assembly {
                for {} 1 {} {}
            }
        }
        if (mode == Mode.BurnThenAnswer) {
            while (gasleft() > LEAVE) {}
        }
        if (mode == Mode.HugeReturn) {
            uint256 n = HUGE_RETURN;
            assembly {
                mstore(0, answer)
                return(0, n)
            }
        }
        return answer;
    }
}

/// @dev Worst case for the binding guard on `submit`: `ownerOf` burns the whole cap it is given, and
///      `getAgentWallet` answers `answer` only when it still has at least `threshold` gas on entry
///      (i.e. it received essentially the full `identityCallGasLimit`), otherwise the zero address.
///      Immutables only, so the probe itself reads no storage before measuring.
contract CapProbeIdentityRegistry {
    address public immutable answer;
    uint256 public immutable threshold;

    constructor(address answer_, uint256 threshold_) {
        answer = answer_;
        threshold = threshold_;
    }

    function ownerOf(uint256) external pure returns (address) {
        assembly {
            for {} 1 {} {}
        }
        return address(0);
    }

    function getAgentWallet(uint256) external view returns (address) {
        if (gasleft() < threshold) return address(0);
        return answer;
    }
}

/// @dev Identity registry that answers every call with a fixed raw byte string (malformed ERC-8004).
contract RawIdentityRegistry {
    bytes internal _response;

    function setResponse(bytes calldata response) external {
        _response = response;
    }

    fallback() external {
        bytes memory r = _response;
        assembly {
            return(add(r, 32), mload(r))
        }
    }
}
