// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {IACPHook} from "../src/IACPHook.sol";
import {MockERC20, BlacklistERC20} from "./mocks/MockERC20.sol";
import {MockReputationRegistry, EmptyRevertRegistry, InvalidOpcodeRegistry} from "./mocks/MockReputationRegistry.sol";
import {MockIdentityRegistry, RawIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract ReputationHookTest is Test {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    AgentJobEscrow internal escrow;
    ReputationHook internal hook;
    MockERC20 internal token;
    MockReputationRegistry internal registry;
    MockIdentityRegistry internal identity;

    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    /// @dev The trusted evaluator (operator / backend signer, decision D5).
    address internal evaluator = makeAddr("evaluator");
    address internal feeWallet = makeAddr("feeWallet");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    address internal victim = makeAddr("victim");
    address internal attacker = makeAddr("attacker");
    address internal accomplice = makeAddr("accomplice");

    uint256 internal constant BUDGET = 250e6;
    uint256 internal constant MIN_BUDGET = 1_000_000; // 1 USDC
    uint256 internal constant AGENT_ID = 4242;
    uint256 internal constant VICTIM_ID = 7;
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
        identity = new MockIdentityRegistry();
        escrow = new AgentJobEscrow(address(token), feeWallet, operator, 0, 30);
        hook = _newHook(address(registry), address(identity), evaluator, MIN_BUDGET);

        identity.setOwner(AGENT_ID, provider);
        identity.setOwner(VICTIM_ID, victim);

        token.mint(client, 1_000_000e6);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
        token.mint(attacker, 1_000e6);
        vm.prank(attacker);
        token.approve(address(escrow), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _newHook(address registry_, address identity_, address trusted, uint256 minBudget)
        internal
        returns (ReputationHook)
    {
        return new ReputationHook(address(escrow), registry_, identity_, trusted, minBudget);
    }

    function _params() internal pure returns (bytes memory) {
        return abi.encode(FEEDBACK_URI, FEEDBACK_HASH);
    }

    function _openWith(address hook_, uint256 agentId, uint256 budget, address evaluator_)
        internal
        returns (uint256 jobId)
    {
        vm.startPrank(client);
        jobId = escrow.createJob(provider, evaluator_, block.timestamp + 1 days, "task", hook_);
        escrow.setBudget(jobId, budget, "");
        if (agentId != 0) escrow.setProviderAgentId(jobId, agentId);
        vm.stopPrank();
    }

    function _open(address hook_, uint256 agentId) internal returns (uint256 jobId) {
        return _openWith(hook_, agentId, BUDGET, evaluator);
    }

    function _fund(uint256 jobId) internal {
        uint256 budget = escrow.getJob(jobId).budget; // read before pranking: the prank applies to the next call only
        vm.prank(client);
        escrow.fund(jobId, budget, "");
    }

    function _submit(uint256 jobId) internal {
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function _funded(address hook_, uint256 agentId) internal returns (uint256 jobId) {
        jobId = _open(hook_, agentId);
        _fund(jobId);
    }

    function _submitted(address hook_, uint256 agentId) internal returns (uint256 jobId) {
        jobId = _funded(hook_, agentId);
        _submit(jobId);
    }

    function _submittedWith(address hook_, uint256 agentId, uint256 budget, address evaluator_)
        internal
        returns (uint256 jobId)
    {
        jobId = _openWith(hook_, agentId, budget, evaluator_);
        _fund(jobId);
        _submit(jobId);
    }

    function _expectSkip(address hook_, uint256 jobId, bytes32 reason) internal {
        vm.expectEmit(true, true, true, true, hook_);
        emit ReputationHook.FeedbackSkipped(jobId, reason);
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
        assertEq(hook.identityRegistry(), address(identity));
        assertEq(hook.trustedEvaluator(), evaluator);
        assertEq(hook.minFeedbackBudget(), MIN_BUDGET);
        assertEq(hook.TAG1(), "agentfi.job");
        assertEq(hook.TAG_COMPLETED(), "completed");
        assertEq(hook.TAG_REJECTED(), "rejected");
        assertEq(hook.VALUE_COMPLETED(), 100);
        assertEq(hook.VALUE_REJECTED(), 0);
        assertEq(hook.REASON_PAYOUT_BLOCKED(), keccak256("agentfi.payout-blocked"));
    }

    function test_Constructor_ZeroAcp_Reverts() public {
        vm.expectRevert(ReputationHook.ZeroAddress.selector);
        new ReputationHook(address(0), address(registry), address(identity), evaluator, MIN_BUDGET);
    }

    function test_Constructor_ZeroRegistry_Reverts() public {
        vm.expectRevert(ReputationHook.ZeroAddress.selector);
        _newHook(address(0), address(identity), evaluator, MIN_BUDGET);
    }

    function test_Constructor_ZeroIdentityRegistry_Reverts() public {
        vm.expectRevert(ReputationHook.ZeroAddress.selector);
        _newHook(address(registry), address(0), evaluator, MIN_BUDGET);
    }

    function test_Constructor_ZeroTrustedEvaluator_Reverts() public {
        vm.expectRevert(ReputationHook.ZeroAddress.selector);
        _newHook(address(registry), address(identity), address(0), MIN_BUDGET);
    }

    function test_Constructor_ZeroMinBudget_Allowed() public {
        ReputationHook h = _newHook(address(registry), address(identity), evaluator, 0);
        assertEq(h.minFeedbackBudget(), 0);
    }

    function test_SupportsInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertFalse(hook.supportsInterface(0xffffffff));
        assertFalse(hook.supportsInterface(0x12345678));
    }

    function test_InterfaceId_Pinned() public pure {
        // `IACPHook is IERC165` must not change the id (inherited selectors are excluded).
        assertEq(type(IACPHook).interfaceId, bytes4(0x7ff6bc9e));
        assertEq(type(IACPHook).interfaceId, IACPHook.beforeAction.selector ^ IACPHook.afterAction.selector);
        assertEq(type(IERC165).interfaceId, bytes4(0x01ffc9a7));
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
    // complete → positive feedback (happy paths)
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
        identity.setOwner(77, provider);
        uint256 jobId = _funded(address(hook), 0);
        vm.prank(client);
        escrow.setProviderAgentId(jobId, 77);
        _submit(jobId);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        _assertFeedback(77, 100, "completed");
    }

    function test_Complete_AgentWalletMatchesProvider_Written() public {
        // The ERC-721 owner is a cold key / Safe; the agent wallet is the provider that delivered.
        identity.setOwner(99, makeAddr("coldOwner"));
        identity.setWallet(99, provider);
        uint256 jobId = _submitted(address(hook), 99);

        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackWritten(jobId, 99, 100);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 1);
    }

    function test_Complete_ProviderSetsOwnAgentId_Written() public {
        uint256 jobId = _funded(address(hook), 0);
        vm.prank(provider);
        escrow.setProviderAgentId(jobId, AGENT_ID);
        _submit(jobId);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        _assertFeedback(AGENT_ID, 100, "completed");
    }

    function test_Complete_BudgetExactlyMinimum_Written() public {
        uint256 jobId = _submittedWith(address(hook), AGENT_ID, MIN_BUDGET, evaluator);
        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackWritten(jobId, AGENT_ID, 100);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(escrow.pendingPlatformFees(), (MIN_BUDGET * 30) / 10_000); // a real fee was paid
    }

    function test_Complete_ZeroMinBudgetHook_DustWritten() public {
        ReputationHook h = _newHook(address(registry), address(identity), evaluator, 0);
        uint256 jobId = _submittedWith(address(h), AGENT_ID, 1, evaluator);
        vm.expectEmit(true, true, true, true, address(h));
        emit ReputationHook.FeedbackWritten(jobId, AGENT_ID, 100);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
    }

    // =========================================================================
    // F1 — forged feedback: the reviewer's PoC and the gates that stop it
    // =========================================================================

    function test_Attack_ClientNamesItselfEvaluator_Complete_Skipped() public {
        // PoC: attacker A (client AND evaluator) + accomplice B (provider), dust budget, victim's id.
        vm.startPrank(attacker);
        uint256 jobId = escrow.createJob(accomplice, attacker, block.timestamp + 1 days, "forge", address(hook));
        escrow.setBudget(jobId, 1, "");
        escrow.setProviderAgentId(jobId, VICTIM_ID);
        escrow.fund(jobId, 1, "");
        vm.stopPrank();
        vm.prank(accomplice);
        escrow.submit(jobId, DELIVERABLE, "");

        _expectSkip(address(hook), jobId, "untrusted-evaluator");
        vm.prank(attacker);
        escrow.complete(jobId, REASON, _params());

        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(escrow.pendingPlatformFees(), 0); // the attack was free (fee rounds to zero) and wrote nothing
    }

    function test_Attack_ClientNamesItselfEvaluator_Reject_Skipped() public {
        // Same setup, negative variant: 0/"rejected" against a competitor.
        vm.startPrank(attacker);
        uint256 jobId = escrow.createJob(accomplice, attacker, block.timestamp + 1 days, "smear", address(hook));
        escrow.setBudget(jobId, 1, "");
        escrow.setProviderAgentId(jobId, VICTIM_ID);
        escrow.fund(jobId, 1, "");
        vm.stopPrank();
        vm.prank(accomplice);
        escrow.submit(jobId, DELIVERABLE, "");

        _expectSkip(address(hook), jobId, "untrusted-evaluator");
        vm.prank(attacker);
        escrow.reject(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_Attack_ThirdPartyEvaluator_Skipped() public {
        // Any evaluator that is not the trusted signer is ignored, even with a big budget and a valid id.
        uint256 jobId = _submittedWith(address(hook), AGENT_ID, BUDGET, stranger);
        _expectSkip(address(hook), jobId, "untrusted-evaluator");
        vm.prank(stranger);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_UntrustedEvaluator_GateRunsBeforeParams() public {
        uint256 jobId = _submittedWith(address(hook), AGENT_ID, BUDGET, stranger);
        _expectSkip(address(hook), jobId, "untrusted-evaluator");
        vm.prank(stranger);
        escrow.complete(jobId, REASON, ""); // would otherwise be "no-params"
    }

    function test_TrustedEvaluator_ForeignAgentId_Skipped() public {
        // Even the trusted evaluator cannot attribute a job to an id the provider does not control.
        uint256 jobId = _submitted(address(hook), VICTIM_ID);
        _expectSkip(address(hook), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_TrustedEvaluator_ForeignAgentId_Reject_Skipped() public {
        uint256 jobId = _submitted(address(hook), VICTIM_ID);
        _expectSkip(address(hook), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.reject(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_TrustedEvaluator_UnknownAgentId_Skipped() public {
        // ownerOf / getAgentWallet revert for unregistered ids; the revert is swallowed.
        uint256 jobId = _submitted(address(hook), 123456);
        _expectSkip(address(hook), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_TrustedEvaluator_DustBudget_Skipped() public {
        uint256 jobId = _submittedWith(address(hook), AGENT_ID, MIN_BUDGET - 1, evaluator);
        _expectSkip(address(hook), jobId, "budget-too-small");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
        assertEq(escrow.pendingPlatformFees(), (MIN_BUDGET - 1) * 30 / 10_000);
    }

    function test_DustBudget_CheckedBeforeIdentity() public {
        // Ordering pin: the cheap budget gate fires before any identity-registry call.
        uint256 jobId = _submittedWith(address(hook), VICTIM_ID, 1, evaluator);
        _expectSkip(address(hook), jobId, "budget-too-small");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
    }

    function test_IdentityRegistryReverts_Skipped() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        identity.setShouldRevert(true);
        _expectSkip(address(hook), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_IdentityRegistryWithoutCode_Failed() public {
        ReputationHook h = _newHook(address(registry), stranger, evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        vm.expectEmit(true, true, true, true, address(h));
        emit ReputationHook.FeedbackFailed(jobId, bytes("no-identity-code"));
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_IdentityRegistryRawResponses_Skipped() public {
        RawIdentityRegistry raw = new RawIdentityRegistry();
        ReputationHook h = _newHook(address(registry), address(raw), evaluator, MIN_BUDGET);

        // empty return data
        uint256 jobId = _submitted(address(h), AGENT_ID);
        _expectSkip(address(h), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        // two words
        raw.setResponse(abi.encode(provider, provider));
        jobId = _submitted(address(h), AGENT_ID);
        _expectSkip(address(h), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        // one word with dirty upper bits (not a clean address)
        raw.setResponse(abi.encode(uint256(uint160(provider)) | (uint256(1) << 200)));
        jobId = _submitted(address(h), AGENT_ID);
        _expectSkip(address(h), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());

        // a clean word equal to the provider is accepted
        raw.setResponse(abi.encode(provider));
        jobId = _submitted(address(h), AGENT_ID);
        vm.expectEmit(true, true, true, true, address(h));
        emit ReputationHook.FeedbackWritten(jobId, AGENT_ID, 100);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 1);
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
        _expectSkip(address(hook), jobId, "not-submitted");
        vm.prank(evaluator);
        escrow.reject(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Rejected));
    }

    function test_Reject_WhileOpen_Skipped() public {
        uint256 jobId = _open(address(hook), AGENT_ID);
        _expectSkip(address(hook), jobId, "not-submitted");
        vm.prank(client);
        escrow.reject(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_Reject_PayoutBlockedReason_Skipped() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        bytes32 reason = hook.REASON_PAYOUT_BLOCKED();
        _expectSkip(address(hook), jobId, "payout-blocked");
        vm.prank(evaluator);
        escrow.reject(jobId, reason, _params());
        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), 1_000_000e6);
    }

    function test_Complete_PayoutBlockedReason_IgnoredOnComplete() public {
        // The reserved reason only suppresses negative feedback; a completion still writes 100.
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        bytes32 reason = hook.REASON_PAYOUT_BLOCKED();
        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackWritten(jobId, AGENT_ID, 100);
        vm.prank(evaluator);
        escrow.complete(jobId, reason, _params());
    }

    function test_Reject_PayoutBlocked_ProviderBlacklisted_EndToEnd() public {
        BlacklistERC20 bl = new BlacklistERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(bl), feeWallet, operator, 0, 30);
        ReputationHook h = new ReputationHook(address(e), address(registry), address(identity), evaluator, MIN_BUDGET);
        bl.mint(client, BUDGET);
        vm.startPrank(client);
        bl.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, block.timestamp + 1 days, "task", address(h));
        e.setBudget(jobId, BUDGET, "");
        e.setProviderAgentId(jobId, AGENT_ID);
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        bl.setBlacklisted(provider, true);

        // completion cannot pay the provider ...
        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.complete(jobId, REASON, _params());

        // ... so the evaluator unwinds with the reserved reason: refund, no negative feedback
        bytes32 reason = h.REASON_PAYOUT_BLOCKED();
        vm.expectEmit(true, true, true, true, address(h));
        emit ReputationHook.FeedbackSkipped(jobId, "payout-blocked");
        vm.prank(evaluator);
        e.reject(jobId, reason, _params());
        assertEq(registry.callCount(), 0);
        assertEq(bl.balanceOf(client), BUDGET);
    }

    // =========================================================================
    // Skips: params and agent id
    // =========================================================================

    function test_Complete_EmptyParams_Skipped() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        _expectSkip(address(hook), jobId, "no-params");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");
        assertEq(registry.callCount(), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_Complete_NoAgentId_Skipped() public {
        uint256 jobId = _submitted(address(hook), 0);
        _expectSkip(address(hook), jobId, "no-agent-id");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }

    function test_Complete_MalformedParams_Skipped() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        _expectSkip(address(hook), jobId, "bad-params");
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
        assertEq(token.balanceOf(address(escrow)), (BUDGET * 30) / 10_000); // accrued platform fee
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
        ReputationHook deadHook = _newHook(stranger, address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(deadHook), AGENT_ID);
        vm.expectEmit(true, true, true, true, address(deadHook));
        emit ReputationHook.FeedbackFailed(jobId, bytes("no-code"));
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_Complete_RegistryRevertsWithEmptyData_SettlementSucceeds() public {
        EmptyRevertRegistry empty = new EmptyRevertRegistry();
        ReputationHook h = _newHook(address(empty), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        vm.expectEmit(true, true, true, true, address(h));
        emit ReputationHook.FeedbackFailed(jobId, "");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
    }

    function test_Complete_RegistryOutOfGas_SettlementSucceeds() public {
        // INVALID burns every unit of gas forwarded to the registry; the 1/64 kept by the hook
        // (EIP-150) is enough to emit the failure and let the escrow finish.
        InvalidOpcodeRegistry oog = new InvalidOpcodeRegistry();
        ReputationHook h = _newHook(address(oog), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        vm.expectEmit(true, true, true, true, address(h));
        emit ReputationHook.FeedbackFailed(jobId, "");
        vm.prank(evaluator);
        escrow.complete{gas: 3_000_000}(jobId, REASON, _params());
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
    }

    // =========================================================================
    // Revocation (the only correction path)
    // =========================================================================

    function test_RevokeFeedback_ByTrustedEvaluator_ForwardsAndEmits() public {
        vm.expectEmit(true, true, true, true, address(hook));
        emit ReputationHook.FeedbackRevoked(AGENT_ID, 3);
        vm.prank(evaluator);
        hook.revokeFeedback(AGENT_ID, 3);

        assertEq(registry.revokeCount(), 1);
        assertEq(registry.lastRevoker(), address(hook)); // the registry only lets the writer revoke
        assertEq(registry.lastRevokedAgentId(), AGENT_ID);
        assertEq(registry.lastRevokedIndex(), 3);
    }

    function test_RevokeFeedback_NotTrustedEvaluator_Reverts() public {
        address[4] memory callers = [operator, client, stranger, address(escrow)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(ReputationHook.OnlyTrustedEvaluator.selector);
            hook.revokeFeedback(AGENT_ID, 1);
        }
        assertEq(registry.revokeCount(), 0);
    }

    function test_RevokeFeedback_RegistryReverts_Bubbles() public {
        registry.setShouldRevert(true);
        vm.prank(evaluator);
        vm.expectRevert("MockReputationRegistry: forced revert");
        hook.revokeFeedback(AGENT_ID, 1);
    }

    // =========================================================================
    // Non-settlement selectors are ignored
    // =========================================================================

    function test_OtherSelectors_Ignored() public {
        vm.startPrank(client);
        uint256 jobId = escrow.createJob(address(0), evaluator, block.timestamp + 1 days, "task", address(hook));
        escrow.setProviderAgentId(jobId, AGENT_ID);
        escrow.setProvider(jobId, provider);
        escrow.setProviderAgentId(jobId, AGENT_ID);
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
        identity.setOwner(agentId, provider);
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

    function testFuzz_Complete_ForeignOwner_NeverWritten(uint256 agentId, address owner) public {
        agentId = bound(agentId, 1, type(uint256).max);
        vm.assume(owner != provider && owner != address(0));
        identity.setOwner(agentId, owner);
        uint256 jobId = _submitted(address(hook), agentId);
        _expectSkip(address(hook), jobId, "agent-not-provider");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, _params());
        assertEq(registry.callCount(), 0);
    }
}
