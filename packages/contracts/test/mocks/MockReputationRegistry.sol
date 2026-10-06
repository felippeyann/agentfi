// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IReputationRegistry} from "../../src/IReputationRegistry.sol";

/// @dev Records the last `giveFeedback` call; can be told to revert.
///
///      The call is received through `fallback` and decoded into a single struct instead of a
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

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function last() external view returns (Feedback memory) {
        return _last;
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
