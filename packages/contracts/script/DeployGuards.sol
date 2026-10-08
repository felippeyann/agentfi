// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";

/**
 * @title DeployGuards
 * @notice Pre-broadcast checks shared by `Deploy.s.sol` and `DeployEscrow.s.sol` (C2b, second
 *         adversarial review 2026-10-08).
 *
 * @dev 1. Chain guard. `EXPECTED_CHAIN_ID` is mandatory and must equal `block.chainid`, otherwise the
 *         script reverts before anything is broadcast. Without it, `--rpc-url base` instead of
 *         `base_sepolia` deployed against real USDC with mainnet defaults.
 *      2. Signer. The keystore / hardware signer given on the command line (`--account`,
 *         `--keystore`, `--ledger`, `--trezor`, `--private-key`) is preferred: the scripts call
 *         `vm.startBroadcast()` without a key and Foundry uses it. `PRIVATE_KEY` is still accepted
 *         for backwards compatibility, with a loud warning, because forge auto-loads
 *         `packages/contracts/.env`: a key left there used to silently override `--account` (the
 *         reviewer deployed from the wrong key that way). When a CLI signer is given, Foundry runs
 *         the script with `tx.origin` (and `msg.sender`) = that signer, so a `PRIVATE_KEY` for a
 *         different address is refused (`SignerConflict`) instead of silently winning. Without a CLI
 *         signer `tx.origin` is Foundry's `DEFAULT_SENDER` and `PRIVATE_KEY` is used.
 */
abstract contract DeployGuards is Script {
    /// @notice A required environment variable is missing (or zero).
    error MissingEnv(string name);
    /// @notice `EXPECTED_CHAIN_ID` differs from the chain the RPC answers.
    error WrongChain(uint256 expected, uint256 actual);
    /// @notice `PRIVATE_KEY` (environment or `packages/contracts/.env`) belongs to a different address
    ///         than the signer given on the command line.
    error SignerConflict(address cliSigner, address privateKeySigner);

    /// @notice Reads the mandatory `EXPECTED_CHAIN_ID` and requires it to equal `block.chainid`.
    function requireExpectedChain() public view returns (uint256 expected) {
        expected = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        if (expected == 0) revert MissingEnv("EXPECTED_CHAIN_ID");
        if (expected != block.chainid) revert WrongChain(expected, block.chainid);
    }

    /// @notice `PRIVATE_KEY` when set and consistent with the CLI signer, else 0 (use the CLI signer).
    /// @dev Compares `tx.origin`, which `forge script` sets to the CLI signer when one is given (and
    ///      to `DEFAULT_SENDER` otherwise; verified with forge 1.7.1 for `--keystore` and
    ///      `--private-key`), with the key's address.
    function resolveDeployerKey() public view returns (uint256 key) {
        key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key == 0) return 0;
        address keySigner = vm.addr(key);
        // solhint-disable-next-line avoid-tx-origin
        if (tx.origin != DEFAULT_SENDER && tx.origin != keySigner) revert SignerConflict(tx.origin, keySigner);
    }

    /// @dev Starts the broadcast with `key`, or with the CLI signer when `key` is 0.
    function _startBroadcast(uint256 key) internal {
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
    }

    /// @dev Prints the chain and the signer, with the `PRIVATE_KEY` warning when it applies.
    function _logChainAndSigner(uint256 expectedChainId, uint256 key) internal view {
        console.log("Chain (EXPECTED_CHAIN_ID matches):", expectedChainId);
        if (key == 0) {
            // solhint-disable-next-line avoid-tx-origin
            console.log("Deployer (CLI signer):", tx.origin);
            return;
        }
        console.log("WARNING: PRIVATE_KEY is set (environment or packages/contracts/.env, which forge loads");
        console.log("WARNING: automatically) and is used as the deployer. Prefer --account <keystore>:");
        console.log("WARNING: unset PRIVATE_KEY and remove it from packages/contracts/.env.");
        console.log("Deployer (PRIVATE_KEY):", vm.addr(key));
    }
}
