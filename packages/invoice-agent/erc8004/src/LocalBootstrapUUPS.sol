// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title LocalBootstrapUUPS: the reference repo's MinimalUUPS placeholder with the owner as a parameter.
/// @notice The reference registries' `initialize` is `reinitializer(2) onlyOwner`: a proxy must first be initialized
///         (version 1) by a placeholder that sets the Ownable owner, then upgraded to the real implementation. The
///         reference MinimalUUPS (erc-8004/erc-8004-contracts commit b9e466c, contracts/MinimalUUPS.sol) hard-codes the
///         ERC-8004 team's owner 0x547289319C3e6aedB179C0b8e8aF0B5ACd062603, so a deployment by anyone else (local
///         Anvil, or our own registries on Aevum) needs this copy. Same storage: identityRegistry at slot 0.
///         NOT an official ERC-8004 deployment artefact.
contract LocalBootstrapUUPS is OwnableUpgradeable, UUPSUpgradeable {
    /// @dev Identity registry address stored at slot 0 (matches the real implementations).
    address private _identityRegistry;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address identityRegistry_) public initializer {
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        _identityRegistry = identityRegistry_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function getVersion() external pure returns (string memory) {
        return "0.0.1-local";
    }
}
