// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {IIdentityRegistry} from "../src/IIdentityRegistry.sol";
import {IReputationRegistry} from "../src/IReputationRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev The parts of the ERC-8004 v2.0.0 registries this test needs beyond the hook's interfaces.
interface IIdentityRegistryV2 {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

interface IReputationRegistryV2 {
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/**
 * @title ReputationHookForkTest
 * @notice R3c against the REAL ERC-8004 registries (UUPS proxies, implementation v2.0.0) on a Base
 *         Sepolia fork: the lowest gas at which `complete` / `reject` succeeds writes the feedback,
 *         one unit below reverts with `InsufficientGasForFeedback`, and the per-call gas of
 *         `ownerOf` / `getAgentWallet` / `giveFeedback` that justifies the deploy defaults.
 *
 * @dev Skipped unless `BASE_SEPOLIA_FORK_URL` is set (CI has no RPC):
 *        BASE_SEPOLIA_FORK_URL=https://sepolia.base.org forge test --match-contract ReputationHookForkTest -vv
 *      `BASE_SEPOLIA_FORK_BLOCK` overrides the pinned block (default: the C5a rehearsal block). The
 *      escrow token is a mock: USDC plays no part in the hook's gas.
 */
contract ReputationHookForkTest is Test {
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    uint256 internal constant DEFAULT_FORK_BLOCK = 47_822_000;
    /// @dev ERC-1967 implementation slot (both registries are UUPS proxies).
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint256 internal constant BUDGET = 2_500_000; // 2.5 USDC, as in the C5a happy path
    bytes32 internal constant REASON = keccak256("reason");
    bytes32 internal constant FEEDBACK_HASH = keccak256("feedback-file");
    /// @dev Same shape and length as the backend's `feedbackURI` (`<BACKEND_PUBLIC_URL>/v1/jobs/<cuid>/feedback.json`).
    string internal constant FEEDBACK_URI =
        "https://api.agentfi.example/v1/jobs/cmg8f0q1x0000abcd12345678/feedback.json";

    AgentJobEscrow internal escrow;
    ReputationHook internal hook;
    MockERC20 internal token;
    uint256 internal agentId;

    address internal client = makeAddr("fork-client");
    address internal provider = makeAddr("fork-provider");
    address internal evaluator = makeAddr("fork-evaluator");

    function setUp() public {
        string memory url = vm.envOr("BASE_SEPOLIA_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url, vm.envOr("BASE_SEPOLIA_FORK_BLOCK", DEFAULT_FORK_BLOCK));

        token = new MockERC20();
        escrow = new AgentJobEscrow(address(token), makeAddr("fork-fees"), makeAddr("fork-operator"), 0, 30);
        hook = new ReputationHook(address(escrow), REPUTATION, IDENTITY, evaluator, 1_000_000, 500_000, 50_000);

        // R2: the provider mints its own ERC-8004 identity (ownerOf = getAgentWallet = provider).
        vm.prank(provider);
        agentId = IIdentityRegistryV2(IDENTITY).register("https://api.agentfi.example/v1/agents/fork/erc8004.json");

        token.mint(client, 100 * BUDGET);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _submittedJob() internal returns (uint256 jobId) {
        vm.startPrank(client);
        jobId = escrow.createJob(provider, evaluator, block.timestamp + 1 days, "fork", address(hook));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.setProviderAgentId(jobId, agentId);
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        escrow.submit(jobId, keccak256("deliverable"), "");
    }

    /// @dev Everything a settlement touches starts cold, as in a fresh transaction.
    function _coolAll() internal {
        // Read the implementation slots first: `vm.load` warms the slot it reads.
        address identityImpl = address(uint160(uint256(vm.load(IDENTITY, IMPLEMENTATION_SLOT))));
        address reputationImpl = address(uint160(uint256(vm.load(REPUTATION, IMPLEMENTATION_SLOT))));
        vm.cool(address(escrow));
        vm.cool(address(token));
        vm.cool(address(hook));
        vm.cool(IDENTITY);
        vm.cool(REPUTATION);
        vm.cool(identityImpl);
        vm.cool(reputationImpl);
    }

    function _settleCall(uint256 jobId, bool completed) internal pure returns (bytes memory) {
        bytes memory params = abi.encode(FEEDBACK_URI, FEEDBACK_HASH);
        return completed
            ? abi.encodeCall(AgentJobEscrow.complete, (jobId, REASON, params))
            : abi.encodeCall(AgentJobEscrow.reject, (jobId, REASON, params));
    }

    function _send(bytes memory callData, uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        _coolAll();
        vm.prank(evaluator);
        (ok, ret) = address(escrow).call{gas: gasLimit}(callData);
    }

    function _minimalGas(bytes memory callData) internal returns (uint256) {
        uint256 lo = 0;
        uint256 hi = 3_000_000;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = _send(callData, mid);
            vm.revertToStateAndDelete(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    function _assertProperty(bool completed) internal returns (uint256 minimal) {
        uint256 jobId = _submittedJob();
        bytes memory callData = _settleCall(jobId, completed);
        minimal = _minimalGas(callData);

        // One unit below the estimate: the guard, not a silently failed write.
        (bool ok, bytes memory ret) = _send(callData, minimal - 1);
        assertFalse(ok);
        assertEq(bytes4(ret), ReputationHook.InsufficientGasForFeedback.selector);

        // At the estimate: the real registry records the entry.
        vm.recordLogs();
        (ok,) = _send(callData, minimal);
        assertTrue(ok);
        emit log_named_uint("gas used by that call (escrow + hook + registries)", vm.lastCallGas().gasTotalUsed);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool written;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(hook)) continue;
            assertEq(logs[i].topics[0], ReputationHook.FeedbackWritten.selector, "feedback lost at the estimated gas");
            written = true;
        }
        assertTrue(written);

        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        (uint64 count, int128 value,) = IReputationRegistryV2(REPUTATION)
            .getSummary(agentId, clients, "agentfi.job", completed ? "completed" : "rejected");
        assertEq(count, 1);
        assertEq(value, completed ? int128(100) : int128(0));
    }

    // ---------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------

    function test_Fork_MinimalGas_Complete_WritesFeedback() public {
        uint256 minimal = _assertProperty(true);
        emit log_named_uint("minimal gas for complete (escrow call, real registries)", minimal);
        emit log_named_uint("hook feedbackGasRequirement", hook.feedbackGasRequirement());
    }

    function test_Fork_MinimalGas_Reject_WritesFeedback() public {
        uint256 minimal = _assertProperty(false);
        emit log_named_uint("minimal gas for reject (escrow call, real registries)", minimal);
    }

    /// @dev Cold per-call gas of the three registry calls the hook makes (callee frame, as forwarded).
    function test_Fork_RegistryCallGas_WithinCaps() public {
        _coolAll();
        IIdentityRegistry(IDENTITY).ownerOf(agentId);
        uint256 ownerOfGas = vm.lastCallGas().gasTotalUsed;

        _coolAll();
        IIdentityRegistry(IDENTITY).getAgentWallet(agentId);
        uint256 walletGas = vm.lastCallGas().gasTotalUsed;

        // First entry for a fresh agent from a fresh client: the most expensive case.
        _coolAll();
        vm.prank(address(hook));
        IReputationRegistry(REPUTATION)
            .giveFeedback(agentId, 100, 0, "agentfi.job", "completed", "", FEEDBACK_URI, FEEDBACK_HASH);
        uint256 feedbackGas = vm.lastCallGas().gasTotalUsed;

        emit log_named_uint("ownerOf (cold)", ownerOfGas);
        emit log_named_uint("getAgentWallet (cold)", walletGas);
        emit log_named_uint("giveFeedback (cold, first entry)", feedbackGas);

        assertLt(ownerOfGas, hook.MIN_IDENTITY_CALL_GAS_LIMIT());
        assertLt(walletGas, hook.MIN_IDENTITY_CALL_GAS_LIMIT());
        assertLt(feedbackGas, hook.MIN_FEEDBACK_GAS_LIMIT());
    }
}
