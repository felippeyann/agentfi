// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IReputationRegistry} from "../../src/IReputationRegistry.sol";

/// @dev Records the last `giveFeedback` and `revokeFeedback` calls; can be told to revert.
///
///      `giveFeedback` is received through `fallback` and decoded into a single struct instead of a
///      declared 8-parameter function: four `calldata` strings make the generated ABI decoder
///      exceed the 16-slot stack limit when the optimizer is off (as in `forge coverage`).
contract MockReputationRegistry {
    struct Feedback {
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    uint256 public callCount;
    address public lastCaller;
    bool public shouldRevert;
    Feedback internal _last;

    uint256 public revokeCount;
    address public lastRevoker;
    uint256 public lastRevokedAgentId;
    uint64 public lastRevokedIndex;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function last() external view returns (Feedback memory) {
        return _last;
    }

    /// @dev Mirrors the registry's rule that only the original writer may revoke (`msg.sender` is recorded).
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        if (shouldRevert) revert("MockReputationRegistry: forced revert");
        revokeCount++;
        lastRevoker = msg.sender;
        lastRevokedAgentId = agentId;
        lastRevokedIndex = feedbackIndex;
    }

    fallback() external {
        require(msg.sig == IReputationRegistry.giveFeedback.selector, "MockReputationRegistry: unknown selector");
        if (shouldRevert) revert("MockReputationRegistry: forced revert");
        // Function arguments are encoded as a bare tuple; prefix the 0x20 offset word so the bytes
        // decode as a single dynamic struct with the same layout.
        Feedback memory f = abi.decode(abi.encodePacked(uint256(0x20), msg.data[4:]), (Feedback));
        callCount++;
        lastCaller = msg.sender;
        _last = f;
    }
}

/// @dev Registry that reverts with empty revert data on every call.
contract EmptyRevertRegistry {
    fallback() external {
        revert();
    }
}

/// @dev Registry that burns all forwarded gas (INVALID opcode), i.e. behaves like an out-of-gas callee.
contract InvalidOpcodeRegistry {
    fallback() external {
        assembly {
            invalid()
        }
    }
}

/// @dev Registry whose `giveFeedback` loops forever: it consumes whatever gas it is given (R3c: a
///      third-party registry upgraded to burn gas).
contract GasBurningRegistry {
    fallback() external {
        assembly {
            for {} 1 {} {}
        }
    }
}

/// @dev Registry that needs almost all of the forwarded gas and then succeeds: it burns gas down to
///      `LEAVE` and records the call (one SSTORE). Exercises the hook's accounting after the call.
contract GasHungryRegistry {
    uint256 internal constant LEAVE = 30_000;
    uint256 public callCount;

    fallback() external {
        while (gasleft() > LEAVE) {}
        callCount++;
    }
}

/// @dev Registry that accepts any payload for almost no gas (counts calls only), so huge feedback
///      URIs can be tested without the storage cost of `MockReputationRegistry`.
contract CountingRegistry {
    uint256 public callCount;

    fallback() external {
        callCount++;
    }
}

/// @dev Registry whose `giveFeedback` reverts with `size` bytes of data (word i = i + 1): a revert-data
///      bomb the hook must truncate instead of copying and emitting in full.
contract LongRevertRegistry {
    uint256 public immutable size;

    constructor(uint256 size_) {
        size = size_;
    }

    /// @dev The revert data this registry produces (what a copy-everything caller would see).
    function revertData() public view returns (bytes memory data) {
        data = new bytes(size);
        for (uint256 i = 0; i < size; i += 32) {
            assembly {
                mstore(add(add(data, 0x20), i), add(i, 1))
            }
        }
    }

    fallback() external {
        uint256 n = size;
        assembly {
            for { let i := 0 } lt(i, n) { i := add(i, 0x20) } { mstore(i, add(i, 1)) }
            revert(0, n)
        }
    }
}
