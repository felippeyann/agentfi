// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityRegistry} from "../../src/IIdentityRegistry.sol";

/// @dev Minimal ERC-8004 Identity Registry: `ownerOf` / `getAgentWallet` per id, both reverting
///      for unknown ids like the ERC-721 reference implementation; can be told to revert on everything.
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => address) internal _wallets;
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
