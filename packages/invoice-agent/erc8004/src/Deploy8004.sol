// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {IdentityRegistryUpgradeable} from "erc8004/IdentityRegistryUpgradeable.sol";
import {ReputationRegistryUpgradeable} from "erc8004/ReputationRegistryUpgradeable.sol";
import {ValidationRegistryUpgradeable} from "erc8004/ValidationRegistryUpgradeable.sol";
import {ERC1967Proxy} from "erc8004/ERC1967Proxy.sol";
import {LocalBootstrapUUPS} from "./LocalBootstrapUUPS.sol";

/// @title Deploy8004: deploys the vendored reference registries behind ERC-1967 proxies owned by `owner`.
/// @notice Same shape as the reference vanity flow (placeholder -> proxy -> upgradeToAndCall(real, initialize)), but at
///         ordinary addresses and with our own owner. Used by the tests and by script/E2E8004.s.sol. The caller must
///         be `owner` (the upgrade is onlyOwner), so call it from a script broadcast or a prank.
library Deploy8004 {
    struct Registries {
        IdentityRegistryUpgradeable identity;
        ReputationRegistryUpgradeable reputation;
        ValidationRegistryUpgradeable validation;
    }

    /// @dev Step 1 (any sender): the placeholder and three proxies initialized with `owner`.
    function deployProxies(address owner) internal returns (address identity, address reputation, address validation) {
        LocalBootstrapUUPS boot = new LocalBootstrapUUPS();
        identity = address(
            new ERC1967Proxy(address(boot), abi.encodeCall(LocalBootstrapUUPS.initialize, (owner, address(0))))
        );
        reputation =
            address(new ERC1967Proxy(address(boot), abi.encodeCall(LocalBootstrapUUPS.initialize, (owner, identity))));
        validation =
            address(new ERC1967Proxy(address(boot), abi.encodeCall(LocalBootstrapUUPS.initialize, (owner, identity))));
    }

    /// @dev Step 2 (sender must be `owner`): the real implementations, then upgradeToAndCall(impl, initialize).
    function upgrade(address identity, address reputation, address validation) internal returns (Registries memory r) {
        IdentityRegistryUpgradeable idImpl = new IdentityRegistryUpgradeable();
        ReputationRegistryUpgradeable repImpl = new ReputationRegistryUpgradeable();
        ValidationRegistryUpgradeable valImpl = new ValidationRegistryUpgradeable();
        LocalBootstrapUUPS(identity)
            .upgradeToAndCall(address(idImpl), abi.encodeCall(IdentityRegistryUpgradeable.initialize, ()));
        LocalBootstrapUUPS(reputation)
            .upgradeToAndCall(address(repImpl), abi.encodeCall(ReputationRegistryUpgradeable.initialize, (identity)));
        LocalBootstrapUUPS(validation)
            .upgradeToAndCall(address(valImpl), abi.encodeCall(ValidationRegistryUpgradeable.initialize, (identity)));
        r.identity = IdentityRegistryUpgradeable(identity);
        r.reputation = ReputationRegistryUpgradeable(reputation);
        r.validation = ValidationRegistryUpgradeable(validation);
    }
}
