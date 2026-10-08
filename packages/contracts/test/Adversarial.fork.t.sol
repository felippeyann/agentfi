// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

interface IIdentityV2 {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setApprovalForAll(address operator, bool approved) external;
    function approve(address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256) external view returns (address);
    function getAgentWallet(uint256) external view returns (address);
}

interface IReputationV2 {
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/**
 * @title AdversarialForkTest
 * @notice The second adversarial review's proofs (2026-10-08) against the REAL ERC-8004 registries
 *         v2.0.0 on a Base Sepolia fork, turned into C2b regressions: each attack that succeeded
 *         before C2b must now fail to achieve its goal.
 *
 * @dev Skipped unless `BASE_SEPOLIA_FORK_URL` is set (CI has no RPC):
 *        BASE_SEPOLIA_FORK_URL=https://sepolia.base.org forge test --match-contract AdversarialForkTest -vv
 *      `BASE_SEPOLIA_FORK_BLOCK` overrides the pinned block (default: the C5a rehearsal block).
 */
contract AdversarialForkTest is Test {
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 internal constant DEFAULT_FORK_BLOCK = 47_822_000;
    uint256 internal constant BUDGET = 2_500_000;
    bytes32 internal constant CONTESTED = keccak256("agentfi.contested");
    /// @dev `ReputationHook.REASON_QUALITY_REJECTED` (D9).
    bytes32 internal constant VERDICT = keccak256("agentfi.quality-rejected");
    /// @dev Revert data of the registry's anti-self-feedback check.
    bytes internal constant SELF_FEEDBACK = abi.encodeWithSignature("Error(string)", "Self-feedback not allowed");

    AgentJobEscrow internal escrow;
    ReputationHook internal hook;
    MockERC20 internal token;
    uint256 internal agentId;

    address internal client = makeAddr("adv-client");
    address internal provider = makeAddr("adv-provider");
    address internal provider2 = makeAddr("adv-provider-alt");
    address internal evaluator = makeAddr("adv-evaluator");

    function setUp() public {
        string memory url = vm.envOr("BASE_SEPOLIA_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url, vm.envOr("BASE_SEPOLIA_FORK_BLOCK", DEFAULT_FORK_BLOCK));
        token = new MockERC20();
        escrow = new AgentJobEscrow(address(token), makeAddr("fees"), makeAddr("op"), 0, 30);
        hook = new ReputationHook(address(escrow), REPUTATION, IDENTITY, evaluator, 1_000_000, 500_000, 50_000);
        vm.prank(provider);
        agentId = IIdentityV2(IDENTITY).register("https://x/agent.json");
        token.mint(client, 100 * BUDGET);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _funded(uint256 boundId) internal returns (uint256 jobId) {
        vm.startPrank(client);
        jobId = escrow.createJob(provider, evaluator, block.timestamp + 1 days, "j", address(hook));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
        if (boundId != 0) {
            vm.prank(provider);
            escrow.setProviderAgentId(jobId, boundId);
        }
    }

    function _submitted(uint256 boundId) internal returns (uint256 jobId) {
        jobId = _funded(boundId);
        vm.prank(provider);
        escrow.submit(jobId, keccak256("d"), "");
    }

    function _params() internal pure returns (bytes memory) {
        return abi.encode("https://x/v1/jobs/1/feedback.json", keccak256("f"));
    }

    /// @dev Every event the hook emitted in `logs`, in order.
    function _hookEvents(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(hook)) n++;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(hook)) out[n++] = logs[i];
        }
    }

    function _settle(uint256 jobId, bool completed, bytes32 reason) internal returns (Vm.Log[] memory events) {
        vm.recordLogs();
        vm.prank(evaluator);
        if (completed) escrow.complete{gas: 2_000_000}(jobId, reason, _params());
        else escrow.reject{gas: 2_000_000}(jobId, reason, _params());
        events = _hookEvents(vm.getRecordedLogs());
    }

    function _count(uint256 id, string memory tag2) internal view returns (uint64 count) {
        address[] memory c = new address[](1);
        c[0] = address(hook);
        (count,,) = IReputationV2(REPUTATION).getSummary(id, c, "agentfi.job", tag2);
    }

    function _assertSkipped(Vm.Log[] memory events, bytes32 reason) internal pure {
        assertEq(events.length, 1);
        assertEq(events[0].topics[0], ReputationHook.FeedbackSkipped.selector);
        assertEq(abi.decode(events[0].data, (bytes32)), reason);
    }

    function _assertWritten(Vm.Log[] memory events, uint256 id, int128 value) internal pure {
        assertEq(events.length, 1);
        assertEq(events[0].topics[0], ReputationHook.FeedbackWritten.selector);
        assertEq(uint256(events[0].topics[2]), id);
        assertEq(abi.decode(events[0].data, (int128)), value);
    }

    // ---------------------------------------------------------------------
    // Finding 1 (D9): a contest no longer smears the provider for free
    // ---------------------------------------------------------------------

    /// @notice Before C2b: the contest became a hook-signed value-0 entry while the client was
    ///         refunded in full and no fee was accrued. Now the client is still refunded, nothing is written.
    function test_ContestSmear_NowWritesNothing() public {
        uint256 before = token.balanceOf(client);
        uint256 jobId = _submitted(agentId);
        _assertSkipped(_settle(jobId, false, CONTESTED), "not-verdict");
        assertEq(token.balanceOf(client), before, "client fully refunded");
        assertEq(escrow.pendingPlatformFees(), 0, "no fee on reject");
        assertEq(_count(agentId, "rejected"), 0, "no negative entry for a contest");
    }

    /// @notice Control: the evaluator's explicit quality verdict is still recorded as value 0.
    function test_QualityVerdict_WritesZero() public {
        uint256 jobId = _submitted(agentId);
        _assertWritten(_settle(jobId, false, VERDICT), agentId, 0);
        assertEq(_count(agentId, "rejected"), 1);
    }

    // ---------------------------------------------------------------------
    // Finding 2: a self-custodied provider cannot dodge the verdict
    // ---------------------------------------------------------------------

    /// @dev Vector (a). Before C2b: the registry's anti-self-feedback check refused the hook, the
    ///      negative entry was lost and positives resumed after revoking. Now the hook records the
    ///      unrecorded verdict and refuses further positive entries for the identity.
    function _approveHookAttack(bool forAll) internal {
        _assertWritten(_settle(_submitted(agentId), true, keccak256("ok")), agentId, 100);
        assertEq(_count(agentId, "completed"), 1);

        uint256 poor = _submitted(agentId);
        vm.prank(provider);
        if (forAll) IIdentityV2(IDENTITY).setApprovalForAll(address(hook), true);
        else IIdentityV2(IDENTITY).approve(address(hook), agentId);

        Vm.Log[] memory events = _settle(poor, false, VERDICT);
        assertEq(events.length, 2);
        assertEq(events[0].topics[0], ReputationHook.FeedbackFailed.selector);
        assertEq(abi.decode(events[0].data, (bytes)), SELF_FEEDBACK, "refused by the anti-self-feedback check");
        assertEq(events[1].topics[0], ReputationHook.AgentPenalized.selector);
        assertEq(uint256(events[1].topics[1]), agentId);
        assertEq(_count(agentId, "rejected"), 0, "the registry recorded nothing ...");
        assertEq(hook.penalties(agentId), 1, "... but the hook did");

        // Revoke and try to keep collecting positive entries for the same identity: refused.
        vm.prank(provider);
        if (forAll) IIdentityV2(IDENTITY).setApprovalForAll(address(hook), false);
        else IIdentityV2(IDENTITY).approve(address(0), agentId);
        _assertSkipped(_settle(_submitted(agentId), true, keccak256("ok")), "penalized");
        assertEq(_count(agentId, "completed"), 1, "no positive entry after the dodge");
    }

    function test_ProviderApprovesHookForAll_VerdictPenalized_NoMorePositives() public {
        _approveHookAttack(true);
    }

    function test_ProviderApprovesHookToken_VerdictPenalized_NoMorePositives() public {
        _approveHookAttack(false);
    }

    /// @dev Vector (b). Before C2b: parking the NFT on another address right before the verdict made
    ///      settlement skip with "agent-not-provider"; the provider transferred it back afterwards.
    function test_ProviderParksIdentity_VerdictStillRecorded() public {
        uint256 jobId = _submitted(agentId);
        vm.prank(provider);
        IIdentityV2(IDENTITY).transferFrom(provider, provider2, agentId);

        _assertWritten(_settle(jobId, false, VERDICT), agentId, 0);

        vm.prank(provider2);
        IIdentityV2(IDENTITY).transferFrom(provider2, provider, agentId);
        assertEq(IIdentityV2(IDENTITY).ownerOf(agentId), provider);
        assertEq(_count(agentId, "rejected"), 1, "the verdict stays on the identity");
    }

    /// @dev Vector (b'): parked before a later job's submit; the binding is not re-read.
    function test_ProviderParksIdentityBeforeSubmit_VerdictStillRecorded() public {
        _submitted(agentId); // first verified binding
        vm.prank(provider);
        IIdentityV2(IDENTITY).transferFrom(provider, provider2, agentId);
        uint256 poor = _submitted(agentId);
        _assertWritten(_settle(poor, false, VERDICT), agentId, 0);
    }

    /// @dev Vector (c). A throwaway identity bound to a poor job: the verdict lands on the canonical id.
    function test_ProviderBindsThrowawayIdentity_VerdictLandsOnCanonical() public {
        _assertWritten(_settle(_submitted(agentId), true, keccak256("ok")), agentId, 100);

        vm.prank(provider);
        uint256 throwaway = IIdentityV2(IDENTITY).register("https://x/throwaway.json");
        assertEq(IIdentityV2(IDENTITY).ownerOf(throwaway), provider);

        uint256 poor = _submitted(throwaway);
        _assertWritten(_settle(poor, false, VERDICT), agentId, 0);
        assertEq(_count(agentId, "rejected"), 1);
        assertEq(_count(throwaway, ""), 0, "nothing for the throwaway id");
        assertEq(hook.canonicalAgentId(provider), agentId);
    }

    // ---------------------------------------------------------------------
    // Finding 3: the client cannot wipe the provider's binding
    // ---------------------------------------------------------------------

    /// @notice Before C2b: the client set 0 after the provider bound its id, `complete` skipped "no-agent-id".
    function test_ClientCannotClearProviderAgentId() public {
        uint256 jobId = _funded(agentId);
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(jobId, 0);
        assertEq(escrow.providerAgentId(jobId), agentId);

        vm.prank(provider);
        escrow.submit(jobId, keccak256("d"), "");
        _assertWritten(_settle(jobId, true, keccak256("ok")), agentId, 100);
    }

    // ---------------------------------------------------------------------
    // Sanity on the real token and registry (unchanged behaviour)
    // ---------------------------------------------------------------------

    /// @notice Real Base Sepolia USDC (FiatToken proxy): full lifecycle + fee sweep + expiry refund.
    function test_RealUsdc_Lifecycle() public {
        address fees = makeAddr("usdc-fees");
        address op = makeAddr("usdc-op");
        AgentJobEscrow e = new AgentJobEscrow(USDC, fees, op, 0, 30);
        ReputationHook h = new ReputationHook(address(e), REPUTATION, IDENTITY, evaluator, 1_000_000, 500_000, 50_000);
        deal(USDC, client, 10 * BUDGET);
        vm.prank(client);
        MockERC20(USDC).approve(address(e), type(uint256).max);

        vm.startPrank(client);
        uint256 j1 = e.createJob(provider, evaluator, block.timestamp + 1 days, "j", address(h));
        e.setBudget(j1, BUDGET, "");
        e.fund(j1, BUDGET, "");
        uint256 j2 = e.createJob(provider, evaluator, block.timestamp + 1 days, "j", address(h));
        e.setBudget(j2, BUDGET, "");
        e.fund(j2, BUDGET, "");
        vm.stopPrank();
        vm.startPrank(provider);
        e.setProviderAgentId(j1, agentId);
        e.submit(j1, keccak256("d"), "");
        vm.stopPrank();
        vm.recordLogs();
        vm.prank(evaluator);
        e.complete{gas: 2_000_000}(j1, keccak256("ok"), _params());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool written;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(h) && logs[i].topics[0] == ReputationHook.FeedbackWritten.selector) {
                written = true;
            }
        }
        assertTrue(written);
        uint256 fee = BUDGET * 30 / 10_000;
        assertEq(MockERC20(USDC).balanceOf(provider), BUDGET - fee);
        assertEq(e.pendingPlatformFees(), fee);
        vm.prank(op);
        e.withdrawPlatformFees();
        assertEq(MockERC20(USDC).balanceOf(fees), fee);

        vm.warp(block.timestamp + 1 days);
        e.claimRefund(j2);
        assertEq(MockERC20(USDC).balanceOf(client), 10 * BUDGET - BUDGET);
        assertEq(MockERC20(USDC).balanceOf(address(e)), 0);
    }

    /// @notice revokeFeedback through the hook against the real registry; second revoke bubbles; outsiders refused.
    function test_RevokeFeedback_RealRegistry() public {
        uint256 jobId = _submitted(agentId);
        _settle(jobId, true, keccak256("ok"));
        vm.expectRevert(ReputationHook.OnlyTrustedEvaluator.selector);
        hook.revokeFeedback(agentId, 1);
        vm.prank(evaluator);
        hook.revokeFeedback(agentId, 1);
        assertEq(_count(agentId, ""), 0);
        vm.prank(evaluator);
        vm.expectRevert(bytes("Already revoked"));
        hook.revokeFeedback(agentId, 1);
    }
}
