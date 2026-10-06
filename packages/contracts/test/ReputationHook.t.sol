// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {IACPHook} from "../src/IACPHook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

contract ReputationHookTest is Test {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    AgentJobEscrow internal escrow;
    ReputationHook internal hook;
    MockERC20 internal token;
    MockReputationRegistry internal registry;

    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal feeWallet = makeAddr("feeWallet");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BUDGET = 250e6;
    uint256 internal constant AGENT_ID = 4242;
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant REASON = keccak256("reason");
    string internal constant FEEDBACK_URI = "https://backend.example/v1/jobs/1/feedback.json";
    bytes32 internal constant FEEDBACK_HASH = keccak256("feedback-file");

    // -------------------------------------------------------------------------
    // setUp
    // -------------------------------------------------------------------------

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockERC20();
        registry = new MockReputationRegistry();
        escrow = new AgentJobEscrow(address(token), feeWallet, operator, 0, 30);
        hook = new ReputationHook(address(escrow), address(registry));

        token.mint(client, 1_000_000e6);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _params() internal pure returns (bytes memory) {
        return abi.encode(FEEDBACK_URI, FEEDBACK_HASH);
    }

    function _open(address hook_, uint256 agentId) internal returns (uint256 jobId) {
        vm.startPrank(client);
        jobId = escrow.createJob(provider, evaluator, block.timestamp + 1 days, "task", hook_);
        escrow.setBudget(jobId, BUDGET, "");
        if (agentId != 0) escrow.setProviderAgentId(jobId, agentId);
        vm.stopPrank();
    }

    function _funded(address hook_, uint256 agentId) internal returns (uint256 jobId) {
        jobId = _open(hook_, agentId);
        vm.prank(client);
        escrow.fund(jobId, BUDGET, "");
    }

    function _submitted(address hook_, uint256 agentId) internal returns (uint256 jobId) {
        jobId = _funded(hook_, agentId);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function _assertFeedback(uint256 agentId, int128 value, string memory tag2) internal view {
        MockReputationRegistry.Feedback memory f = registry.last();
        assertEq(registry.lastCaller(), address(hook));
        assertEq(f.agentId, agentId);
        assertEq(f.value, value);
        assertEq(f.valueDecimals, 0);
        assertEq(f.tag1, "agentfi.job");
        assertEq(f.tag2, tag2);
        assertEq(f.endpoint, "");
        assertEq(f.feedbackURI, FEEDBACK_URI);
        assertEq(f.feedbackHash, FEEDBACK_HASH);
    }

    // =========================================================================
    // Constructor / ERC-165
    // =========================================================================

    function test_Constructor_SetsImmutables() public view {
        assertEq(hook.acp(), address(escrow));
        assertEq(hook.reputationRegistry(), address(registry));
        assertEq(hook.TAG1(), "agentfi.job");
        assertEq(hook.TAG_COMPLETED(), "completed");
        assertEq(hook.TAG_REJECTED(), "rejected");
        assertEq(hook.VALUE_COMPLETED(), 100);
        assertEq(hook.VALUE_REJECTED(), 0);
    }

    function test_Constructor_ZeroAcp_Reverts() public {
        vm.expectRevert(ReputationHook.ZeroAddress.selector);
        new ReputationHook(address(0), address(registry));
    }

    function test_Constructor_ZeroRegistry_Reverts() public {
        vm.expectRevert(ReputationHook.ZeroAddress.selector);
        new ReputationHook(address(escrow), address(0));
    }

    function test_SupportsInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertFalse(hook.supportsInterface(0xffffffff));
        assertFalse(hook.supportsInterface(0x12345678));
    }

    function test_EscrowAcceptsHookAtCreateJob() public {
        uint256 jobId = _open(address(hook), 0);
        assertEq(escrow.getJob(jobId).hook, address(hook));
    }

    // =========================================================================
    // onlyACP
    // =========================================================================

    function test_BeforeAction_NotAcp_Reverts() public {
        vm.prank(stranger);
        vm.expectRevert(ReputationHook.OnlyACP.selector);
        hook.beforeAction(1, AgentJobEscrow.complete.selector, "");
    }

    function test_AfterAction_NotAcp_Reverts() public {
        vm.prank(evaluator);
        vm.expectRevert(ReputationHook.OnlyACP.selector);
        hook.afterAction(1, AgentJobEscrow.complete.selector, abi.encode(REASON, _params()));
        assertEq(registry.callCount(), 0);
    }

    function test_BeforeAction_FromAcp_IsNoop() public {
        vm.prank(address(escrow));
        hook.beforeAction(1, AgentJobEscrow.complete.selector, abi.encode(REASON, _params()));
        assertEq(registry.callCount(), 0);
    }

    // =========================================================================
    // complete → positive feedback
    // =========================================================================

    function test_Complete_WritesPositiveFeedback() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackWritten(jobId, AGENT_ID, 100);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        assertEq(registry.callCount(), 1);
        _assertFeedback(AGENT_ID, 100, "completed");
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
    }

    function test_Complete_AgentIdSetWhileFunded_IsUsed() public {
        uint256 jobId = _funded(address(hook), 0);
        vm.prank(client);
        escrow.setProviderAgentId(jobId, 77);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        _assertFeedback(77, 100, "completed");
    }

    // =========================================================================
    // reject → negative feedback only after submission
    // =========================================================================

    function test_Reject_AfterSubmit_WritesNegativeFeedback() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackWritten(jobId, AGENT_ID, 0);
        vm.prank(evaluator);
        escrow.reject(jobId, REASON, _params());

        assertEq(registry.callCount(), 1);
        _assertFeedback(AGENT_ID, 0, "rejected");
        assertEq(token.balanceOf(client), 1_000_000e6); // full refund
    }

    function test_Reject_WhileFunded_Skipped() public {
        uint256 jobId = _funded(address(hook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackSkipped(jobId, "not-submitted");
        vm.prank(evaluator);
        escrow.reject(jobId, REASON, _params());

        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Rejected));
    }

    function test_Reject_WhileOpen_Skipped() public {
        uint256 jobId = _open(address(hook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackSkipped(jobId, "not-submitted");
        vm.prank(client);
        escrow.reject(jobId, REASON, _params());

        assertEq(registry.callCount(), 0);
    }

    // =========================================================================
    // Skips
    // =========================================================================

    function test_Complete_EmptyParams_Skipped() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackSkipped(jobId, "no-params");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");

        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_Complete_NoAgentId_Skipped() public {
        uint256 jobId = _submitted(address(hook), 0);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackSkipped(jobId, "no-agent-id");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        assertEq(registry.callCount(), 0);
    }

    function test_Complete_MalformedParams_Skipped() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackSkipped(jobId, "bad-params");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, hex"deadbeef");

        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_DecodeFeedbackParams_RoundTrip() public view {
        (string memory uri, bytes32 h) = hook.decodeFeedbackParams(_params());
        assertEq(uri, FEEDBACK_URI);
        assertEq(h, FEEDBACK_HASH);
    }

    function test_DecodeFeedbackParams_Malformed_Reverts() public {
        vm.expectRevert();
        hook.decodeFeedbackParams(hex"01");
    }

    // =========================================================================
    // Registry failures never revert settlement
    // =========================================================================

    function test_Complete_RegistryReverts_SettlementSucceeds() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        registry.setShouldRevert(true);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackFailed(
            jobId, abi.encodeWithSignature("Error(string)", "MockReputationRegistry: forced revert")
        );
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Reject_RegistryReverts_RefundSucceeds() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        registry.setShouldRevert(true);

        vm.prank(evaluator);
        escrow.reject(jobId, REASON, _params());

        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), 1_000_000e6);
    }

    function test_Complete_RegistryWithoutCode_SettlementSucceeds() public {
        ReputationHook deadHook = new ReputationHook(address(escrow), stranger);
        uint256 jobId = _submitted(address(deadHook), AGENT_ID);

        vm.expectEmit(true, true, true, true, address(deadHook));
        emit ReputationHook.FeedbackFailed(jobId, bytes("no-code"));
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    // =========================================================================
    // Non-settlement selectors are ignored
    // =========================================================================

    function test_OtherSelectors_Ignored() public {
        uint256 jobId = _open(address(hook), AGENT_ID);
        vm.startPrank(client);
        escrow.setProvider(jobId, provider);
        escrow.setBudget(jobId, BUDGET, _params());
        escrow.fund(jobId, BUDGET, _params());
        vm.stopPrank();
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_ClaimRefund_WritesNothing() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        vm.warp(escrow.getJob(jobId).expiredAt);
        escrow.claimRefund(jobId);
        assertEq(registry.callCount(), 0);
    }

    // =========================================================================
    // Fuzz: value/tag mapping is stable for any agent id and feedback payload
    // =========================================================================

    function testFuzz_Complete_AnyAgentIdAndPayload(uint256 agentId, string memory uri, bytes32 h) public {
        agentId = bound(agentId, 1, type(uint256).max);
        uint256 jobId = _submitted(address(hook), agentId);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, abi.encode(uri, h));

        MockReputationRegistry.Feedback memory f = registry.last();
        assertEq(f.agentId, agentId);
        assertEq(f.value, 100);
        assertEq(f.tag2, "completed");
        assertEq(f.feedbackURI, uri);
        assertEq(f.feedbackHash, h);
    }
}
