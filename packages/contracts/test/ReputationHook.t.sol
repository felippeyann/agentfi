// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {ReputationHook} from "../src/ReputationHook.sol";
import {IACPHook} from "../src/IACPHook.sol";
import {MockERC20, BlacklistERC20} from "./mocks/MockERC20.sol";
import {
    MockReputationRegistry,
    EmptyRevertRegistry,
    InvalidOpcodeRegistry,
    GasBurningRegistry,
    GasHungryRegistry,
    CountingRegistry,
    LongRevertRegistry
} from "./mocks/MockReputationRegistry.sol";
import {MockIdentityRegistry, RawIdentityRegistry, GasGriefingIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

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
    /// @dev Deploy-script defaults (`FEEDBACK_GAS_LIMIT`, `IDENTITY_CALL_GAS_LIMIT`).
    uint256 internal constant FEEDBACK_GAS = 500_000;
    uint256 internal constant IDENTITY_GAS = 50_000;

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
        return new ReputationHook(address(escrow), registry_, identity_, trusted, minBudget, FEEDBACK_GAS, IDENTITY_GAS);
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
        new ReputationHook(address(0), address(registry), address(identity), evaluator, MIN_BUDGET, FEEDBACK_GAS, IDENTITY_GAS);
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
        ReputationHook h = new ReputationHook(
            address(e), address(registry), address(identity), evaluator, MIN_BUDGET, FEEDBACK_GAS, IDENTITY_GAS
        );
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
        // INVALID burns every unit of gas forwarded to the registry, i.e. exactly `feedbackGasLimit`;
        // the rest of the transaction's gas is untouched, so the hook emits the failure and the escrow finishes.
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

    // =========================================================================
    // R3c — gas policy: capped registry calls, InsufficientGasForFeedback guard
    // =========================================================================
    //
    // Every settlement below is sent the way an RPC client would after `eth_estimateGas`: a low-level
    // call with an explicit gas limit, all touched accounts cold (`vm.cool`), state restored between
    // probes. `_minimalGas` binary-searches the lowest limit at which the settlement succeeds — what
    // an estimator returns — and the tests assert what happens AT that limit.

    /// @dev Gas limit for settlements whose cheap gates skip the write: far below `feedbackGasRequirement`.
    uint256 internal constant SKIP_PATH_GAS = 200_000;
    /// @dev Upper bound of the binary search (every settlement in this file succeeds with it).
    uint256 internal constant SEARCH_CEILING = 5_000_000;

    bytes32 internal constant WRITTEN = keccak256("FeedbackWritten(uint256,uint256,int128)");
    bytes32 internal constant SKIPPED = keccak256("FeedbackSkipped(uint256,bytes32)");
    bytes32 internal constant FAILED = keccak256("FeedbackFailed(uint256,bytes)");

    function _coolAll(ReputationHook h) internal {
        address rep = h.reputationRegistry();
        address id = h.identityRegistry();
        vm.cool(address(escrow));
        vm.cool(address(token));
        vm.cool(address(h));
        vm.cool(rep);
        vm.cool(id);
    }

    function _settleCall(uint256 jobId, bool completed, bytes32 reason, bytes memory params)
        internal
        pure
        returns (bytes memory)
    {
        return completed
            ? abi.encodeCall(AgentJobEscrow.complete, (jobId, reason, params))
            : abi.encodeCall(AgentJobEscrow.reject, (jobId, reason, params));
    }

    /// @dev `caller` sends `callData` to the escrow with exactly `gasLimit` gas, every account cold.
    function _sendWithGas(ReputationHook h, address caller, bytes memory callData, uint256 gasLimit)
        internal
        returns (bool ok, bytes memory ret)
    {
        _coolAll(h);
        vm.prank(caller);
        (ok, ret) = address(escrow).call{gas: gasLimit}(callData);
    }

    function _minimalGasFor(ReputationHook h, address caller, bytes memory callData) internal returns (uint256) {
        uint256 lo = 0;
        uint256 hi = SEARCH_CEILING;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = _sendWithGas(h, caller, callData, mid);
            vm.revertToStateAndDelete(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @dev What `eth_estimateGas` returns for the evaluator's `complete` / `reject` of `jobId`.
    function _minimalGas(ReputationHook h, uint256 jobId, bool completed, bytes memory params)
        internal
        returns (uint256)
    {
        return _minimalGasFor(h, evaluator, _settleCall(jobId, completed, REASON, params));
    }

    /// @dev Settles at `gasLimit` (must succeed) and returns the single event the hook emitted.
    function _settleAt(ReputationHook h, address caller, bytes memory callData, uint256 gasLimit)
        internal
        returns (bytes32 topic, bytes memory data)
    {
        vm.recordLogs();
        (bool ok,) = _sendWithGas(h, caller, callData, gasLimit);
        assertTrue(ok, "settlement reverted");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(h)) continue;
            (topic, data) = (logs[i].topics[0], logs[i].data);
            found++;
        }
        assertEq(found, 1, "hook must emit exactly one event");
    }

    function _settleEvaluatorAt(ReputationHook h, uint256 jobId, bool completed, bytes memory params, uint256 gasLimit)
        internal
        returns (bytes32 topic, bytes memory data)
    {
        return _settleAt(h, evaluator, _settleCall(jobId, completed, REASON, params), gasLimit);
    }

    /// @dev Settles at `gasLimit`, expects `InsufficientGasForFeedback` bubbled through the escrow.
    function _expectGuardRevert(ReputationHook h, uint256 jobId, bool completed, bytes memory params, uint256 gasLimit)
        internal
        returns (uint256 available, uint256 required)
    {
        (bool ok, bytes memory ret) = _sendWithGas(h, evaluator, _settleCall(jobId, completed, REASON, params), gasLimit);
        assertFalse(ok, "settlement should revert");
        assertEq(ret.length, 68, "revert data must be InsufficientGasForFeedback(uint256,uint256)");
        assertEq(bytes4(ret), ReputationHook.InsufficientGasForFeedback.selector);
        assembly {
            available := mload(add(ret, 0x24))
            required := mload(add(ret, 0x44))
        }
        assertLt(available, required);
    }

    function _feedbackCallRequirement(ReputationHook h) internal view returns (uint256) {
        uint256 cap = h.feedbackGasLimit();
        return cap + cap / 63 + 1 + h.FEEDBACK_CALL_RESERVE();
    }

    /// @dev Minimal gas of a plain feedback write through the default `hook` (reference for the
    ///      "registry behaviour does not change the gas a settlement needs" assertions).
    function _baselineMinimalGas() internal returns (uint256) {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        return _minimalGas(hook, jobId, true, _params());
    }

    function _uriOfLength(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = "a";
        }
        return string(b);
    }

    // ----- constructor parameters -------------------------------------------

    function test_GasPolicy_ImmutablesAndRequirement() public view {
        assertEq(hook.feedbackGasLimit(), FEEDBACK_GAS);
        assertEq(hook.identityCallGasLimit(), IDENTITY_GAS);
        assertEq(hook.MIN_FEEDBACK_GAS_LIMIT(), 250_000);
        assertEq(hook.MAX_FEEDBACK_GAS_LIMIT(), 2_000_000);
        assertEq(hook.MIN_IDENTITY_CALL_GAS_LIMIT(), 20_000);
        assertEq(hook.MAX_IDENTITY_CALL_GAS_LIMIT(), 200_000);
        assertEq(hook.MAX_REASON_LENGTH(), 256);
        // 2 * 50_000 + (500_000 + 7_936 + 1 + 10_000) + 50_000
        assertEq(
            hook.feedbackGasRequirement(),
            2 * IDENTITY_GAS + FEEDBACK_GAS + FEEDBACK_GAS / 63 + 1 + hook.FEEDBACK_CALL_RESERVE() + hook.GAS_RESERVE()
        );
        assertEq(hook.feedbackGasRequirement(), 667_937);
    }

    function test_Constructor_FeedbackGasLimitBounds() public {
        uint256 min = hook.MIN_FEEDBACK_GAS_LIMIT();
        uint256 max = hook.MAX_FEEDBACK_GAS_LIMIT();
        vm.expectRevert(abi.encodeWithSelector(ReputationHook.InvalidFeedbackGasLimit.selector, min - 1));
        new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, min - 1, IDENTITY_GAS);
        vm.expectRevert(abi.encodeWithSelector(ReputationHook.InvalidFeedbackGasLimit.selector, max + 1));
        new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, max + 1, IDENTITY_GAS);
        vm.expectRevert(abi.encodeWithSelector(ReputationHook.InvalidFeedbackGasLimit.selector, 0));
        new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, 0, IDENTITY_GAS);

        ReputationHook atMin =
            new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, min, IDENTITY_GAS);
        ReputationHook atMax =
            new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, max, IDENTITY_GAS);
        assertEq(atMin.feedbackGasLimit(), min);
        assertEq(atMax.feedbackGasLimit(), max);
    }

    function test_Constructor_IdentityCallGasLimitBounds() public {
        uint256 min = hook.MIN_IDENTITY_CALL_GAS_LIMIT();
        uint256 max = hook.MAX_IDENTITY_CALL_GAS_LIMIT();
        vm.expectRevert(abi.encodeWithSelector(ReputationHook.InvalidIdentityCallGasLimit.selector, min - 1));
        new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, FEEDBACK_GAS, min - 1);
        vm.expectRevert(abi.encodeWithSelector(ReputationHook.InvalidIdentityCallGasLimit.selector, max + 1));
        new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, FEEDBACK_GAS, max + 1);

        ReputationHook atMin =
            new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, FEEDBACK_GAS, min);
        ReputationHook atMax =
            new ReputationHook(address(escrow), address(registry), address(identity), evaluator, MIN_BUDGET, FEEDBACK_GAS, max);
        assertEq(atMin.identityCallGasLimit(), min);
        assertEq(atMax.identityCallGasLimit(), max);
        assertEq(atMax.feedbackGasRequirement(), 2 * max + _feedbackCallRequirement(atMax) + atMax.GAS_RESERVE());
    }

    // ----- the guard ---------------------------------------------------------

    function test_GasGuard_JustTooLittleGas_RevertsAndWritesNothing() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        uint256 minimal = _minimalGas(hook, jobId, true, _params());

        // One unit below what an estimator would return: the hook's up-front check is what fails.
        (uint256 available, uint256 required) = _expectGuardRevert(hook, jobId, true, _params(), minimal - 1);
        assertEq(required, hook.feedbackGasRequirement());
        assertEq(available, required - 1, "the guard is the binding constraint, to the unit");

        // Nothing happened: no feedback, no payment, the job is still Submitted.
        assertEq(registry.callCount(), 0);
        assertEq(token.balanceOf(provider), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Submitted));
    }

    function test_GasGuard_EnoughGas_WritesFeedback() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        (bytes32 topic, bytes memory data) = _settleEvaluatorAt(hook, jobId, true, _params(), 1_000_000);
        assertEq(topic, WRITTEN);
        assertEq(abi.decode(data, (int128)), 100);
        assertEq(registry.callCount(), 1);
        _assertFeedback(AGENT_ID, 100, "completed");
    }

    /// @notice THE property: the lowest gas at which `complete` succeeds also writes the feedback.
    function test_MinimalGas_Complete_WritesFeedback() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        uint256 minimal = _minimalGas(hook, jobId, true, _params());

        (bytes32 topic,) = _settleEvaluatorAt(hook, jobId, true, _params(), minimal);
        assertEq(topic, WRITTEN, "feedback lost at the estimated gas");
        assertEq(registry.callCount(), 1);
        _assertFeedback(AGENT_ID, 100, "completed");
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
        emit log_named_uint("minimal gas, complete + feedback (mock registry)", minimal);
    }

    function test_MinimalGas_Reject_WritesNegativeFeedback() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        uint256 minimal = _minimalGas(hook, jobId, false, _params());

        (bytes32 topic,) = _settleEvaluatorAt(hook, jobId, false, _params(), minimal);
        assertEq(topic, WRITTEN, "feedback lost at the estimated gas");
        _assertFeedback(AGENT_ID, 0, "rejected");
        assertEq(token.balanceOf(client), 1_000_000e6);

        uint256 other = _submitted(address(hook), AGENT_ID);
        (, uint256 required) = _expectGuardRevert(hook, other, false, _params(), minimal - 1);
        assertEq(required, hook.feedbackGasRequirement());
    }

    /// @dev Any feedback URI length, complete or reject: at the estimated gas the write happens, one
    ///      unit below the guard reverts. `CountingRegistry` keeps the registry's own cost flat.
    function testFuzz_MinimalGas_AlwaysWrites(uint256 uriLength, bool completed) public {
        uriLength = bound(uriLength, 0, 4_096);
        CountingRegistry counting = new CountingRegistry();
        ReputationHook h = _newHook(address(counting), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        bytes memory params = abi.encode(_uriOfLength(uriLength), FEEDBACK_HASH);

        uint256 minimal = _minimalGas(h, jobId, completed, params);
        _expectGuardRevert(h, jobId, completed, params, minimal - 1);
        (bytes32 topic,) = _settleEvaluatorAt(h, jobId, completed, params, minimal);
        assertEq(topic, WRITTEN);
        assertEq(counting.callCount(), 1);
    }

    // ----- gates that skip the write are not subject to the guard -----------

    function test_SkipGates_SettleBelowTheGuard() public {
        assertLt(SKIP_PATH_GAS, hook.feedbackGasRequirement());
        bytes32 topic;
        bytes memory data;

        // untrusted-evaluator
        uint256 jobId = _submittedWith(address(hook), AGENT_ID, BUDGET, stranger);
        (topic, data) = _settleAt(hook, stranger, _settleCall(jobId, true, REASON, _params()), SKIP_PATH_GAS);
        assertEq(topic, SKIPPED);
        assertEq(abi.decode(data, (bytes32)), "untrusted-evaluator");

        // no-params
        jobId = _submitted(address(hook), AGENT_ID);
        (topic, data) = _settleAt(hook, evaluator, _settleCall(jobId, true, REASON, ""), SKIP_PATH_GAS);
        assertEq(abi.decode(data, (bytes32)), "no-params");

        // no-agent-id
        jobId = _submitted(address(hook), 0);
        (topic, data) = _settleAt(hook, evaluator, _settleCall(jobId, true, REASON, _params()), SKIP_PATH_GAS);
        assertEq(abi.decode(data, (bytes32)), "no-agent-id");

        // budget-too-small
        jobId = _submittedWith(address(hook), AGENT_ID, MIN_BUDGET - 1, evaluator);
        (topic, data) = _settleAt(hook, evaluator, _settleCall(jobId, true, REASON, _params()), SKIP_PATH_GAS);
        assertEq(abi.decode(data, (bytes32)), "budget-too-small");

        // not-submitted (evaluator rejects a Funded job: cancellation)
        jobId = _funded(address(hook), AGENT_ID);
        (topic, data) = _settleAt(hook, evaluator, _settleCall(jobId, false, REASON, _params()), SKIP_PATH_GAS);
        assertEq(abi.decode(data, (bytes32)), "not-submitted");

        // payout-blocked
        jobId = _submitted(address(hook), AGENT_ID);
        (topic, data) = _settleAt(
            hook, evaluator, _settleCall(jobId, false, hook.REASON_PAYOUT_BLOCKED(), _params()), SKIP_PATH_GAS
        );
        assertEq(abi.decode(data, (bytes32)), "payout-blocked");

        assertEq(registry.callCount(), 0);
    }

    function test_ClaimRefund_NeverNeedsHookGas() public {
        uint256 jobId = _submitted(address(hook), AGENT_ID);
        vm.warp(escrow.getJob(jobId).expiredAt);
        uint256 minimal = _minimalGasFor(hook, stranger, abi.encodeCall(AgentJobEscrow.claimRefund, (jobId)));
        assertLt(minimal, SKIP_PATH_GAS);
        (bool ok,) = _sendWithGas(hook, stranger, abi.encodeCall(AgentJobEscrow.claimRefund, (jobId)), minimal);
        assertTrue(ok);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(token.balanceOf(client), 1_000_000e6);
    }

    // ----- registries that burn gas cannot block or starve settlement -------

    function test_GasBurningRegistry_FeedbackFailed_SettlementSucceeds() public {
        uint256 baseline = _baselineMinimalGas();
        GasBurningRegistry burner = new GasBurningRegistry();
        ReputationHook h = _newHook(address(burner), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);

        uint256 minimal = _minimalGas(h, jobId, true, _params());
        assertEq(minimal, baseline, "a gas-burning registry must not change the gas settlement needs");

        (bytes32 topic, bytes memory data) = _settleEvaluatorAt(h, jobId, true, _params(), minimal);
        assertEq(topic, FAILED);
        assertEq(abi.decode(data, (bytes)).length, 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
    }

    function test_GasBurningRegistry_Reject_RefundSucceeds() public {
        GasBurningRegistry burner = new GasBurningRegistry();
        ReputationHook h = _newHook(address(burner), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        uint256 minimal = _minimalGas(h, jobId, false, _params());
        (bytes32 topic,) = _settleEvaluatorAt(h, jobId, false, _params(), minimal);
        assertEq(topic, FAILED);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), 1_000_000e6);
    }

    function test_GasHungryRegistry_WrittenAtMinimalGas() public {
        // The registry uses almost its whole cap and still succeeds: the gas the hook keeps after
        // the call (1/64 + FEEDBACK_CALL_RESERVE) is enough for the event and the escrow's tail.
        GasHungryRegistry hungry = new GasHungryRegistry();
        ReputationHook h = _newHook(address(hungry), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        uint256 minimal = _minimalGas(h, jobId, true, _params());
        (bytes32 topic,) = _settleEvaluatorAt(h, jobId, true, _params(), minimal);
        assertEq(topic, WRITTEN);
        assertEq(hungry.callCount(), 1);
    }

    function test_RegistryRevertData_TruncatedAndBounded() public {
        uint256 baseline = _baselineMinimalGas();
        LongRevertRegistry bomb = new LongRevertRegistry(10_000);
        ReputationHook h = _newHook(address(bomb), address(identity), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);

        uint256 minimal = _minimalGas(h, jobId, true, _params());
        assertEq(minimal, baseline, "revert data must not raise the gas settlement needs");

        (bytes32 topic, bytes memory data) = _settleEvaluatorAt(h, jobId, true, _params(), minimal);
        assertEq(topic, FAILED);
        bytes memory full = bomb.revertData();
        bytes memory expected = new bytes(h.MAX_REASON_LENGTH());
        for (uint256 i = 0; i < expected.length; i++) {
            expected[i] = full[i];
        }
        assertEq(abi.decode(data, (bytes)), expected);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
    }

    function test_GasBurningIdentityRegistry_AgentNotProvider_SettlementSucceeds() public {
        uint256 baseline = _baselineMinimalGas();
        GasGriefingIdentityRegistry griefer = new GasGriefingIdentityRegistry();
        griefer.set(GasGriefingIdentityRegistry.Mode.Loop, provider, GasGriefingIdentityRegistry.Mode.Loop, provider);
        ReputationHook h = _newHook(address(registry), address(griefer), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);

        uint256 minimal = _minimalGas(h, jobId, true, _params());
        assertEq(minimal, baseline, "a gas-burning identity registry must not change the gas settlement needs");

        (bytes32 topic, bytes memory data) = _settleEvaluatorAt(h, jobId, true, _params(), minimal);
        assertEq(topic, SKIPPED);
        assertEq(abi.decode(data, (bytes32)), "agent-not-provider");
        assertEq(registry.callCount(), 0);
        assertEq(token.balanceOf(provider), BUDGET - (BUDGET * 30) / 10_000);
    }

    function test_OwnerOfBurnsGas_AgentWalletStillVerified_Written() public {
        // A burning `ownerOf` costs exactly its cap and cannot starve the `getAgentWallet` check.
        GasGriefingIdentityRegistry griefer = new GasGriefingIdentityRegistry();
        griefer.set(GasGriefingIdentityRegistry.Mode.Loop, address(0), GasGriefingIdentityRegistry.Mode.Answer, provider);
        ReputationHook h = _newHook(address(registry), address(griefer), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        uint256 minimal = _minimalGas(h, jobId, true, _params());
        (bytes32 topic,) = _settleEvaluatorAt(h, jobId, true, _params(), minimal);
        assertEq(topic, WRITTEN);
        assertEq(registry.callCount(), 1);
    }

    function test_IdentityHugeReturnData_RejectedAndBounded() public {
        uint256 baseline = _baselineMinimalGas();
        GasGriefingIdentityRegistry griefer = new GasGriefingIdentityRegistry();
        // First word is the provider, but 64 KiB of return data is not "exactly one word".
        griefer.set(
            GasGriefingIdentityRegistry.Mode.HugeReturn, provider, GasGriefingIdentityRegistry.Mode.HugeReturn, provider
        );
        ReputationHook h = _newHook(address(registry), address(griefer), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);

        uint256 minimal = _minimalGas(h, jobId, true, _params());
        assertEq(minimal, baseline, "return data must not raise the gas settlement needs");
        (bytes32 topic, bytes memory data) = _settleEvaluatorAt(h, jobId, true, _params(), minimal);
        assertEq(topic, SKIPPED);
        assertEq(abi.decode(data, (bytes32)), "agent-not-provider");
    }

    /// @dev Worst case for the up-front estimate: both identity calls consume (almost) their whole cap
    ///      and the trusted evaluator sends a very large feedback URI, so the hook's own work exceeds
    ///      `GAS_RESERVE`. The second check right before `giveFeedback` then becomes the binding one:
    ///      one unit below the estimated gas it reverts, and at the estimated gas the registry still
    ///      receives its full cap and the feedback is written.
    function test_WorstCase_FeedbackCallCheckIsBinding_StillWrites() public {
        GasGriefingIdentityRegistry griefer = new GasGriefingIdentityRegistry();
        griefer.set(
            GasGriefingIdentityRegistry.Mode.Loop, address(0), GasGriefingIdentityRegistry.Mode.BurnThenAnswer, provider
        );
        GasHungryRegistry hungry = new GasHungryRegistry();
        ReputationHook h = _newHook(address(hungry), address(griefer), evaluator, MIN_BUDGET);
        uint256 jobId = _submitted(address(h), AGENT_ID);
        bytes memory params = abi.encode(_uriOfLength(40_000), FEEDBACK_HASH);

        uint256 minimal = _minimalGas(h, jobId, true, params);
        (, uint256 required) = _expectGuardRevert(h, jobId, true, params, minimal - 1);
        assertEq(required, _feedbackCallRequirement(h), "the pre-call check binds in the worst case");

        (bytes32 topic,) = _settleEvaluatorAt(h, jobId, true, params, minimal);
        assertEq(topic, WRITTEN);
        assertEq(hungry.callCount(), 1);
    }
}
