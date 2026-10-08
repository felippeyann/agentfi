// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC165} from "forge-std/interfaces/IERC165.sol";
import {AgentJobEscrow} from "../src/AgentJobEscrow.sol";
import {IACPHook} from "../src/IACPHook.sol";
import {
    MockERC20,
    FeeOnTransferERC20,
    NoReturnERC20,
    FalseReturnERC20,
    ReentrantERC20,
    BlacklistERC20
} from "./mocks/MockERC20.sol";
import {
    MockHook,
    NoERC165Hook,
    NoSupportsInterfaceHook,
    GarbageERC165Hook,
    YesManHook,
    WideReturnERC165Hook,
    RevertsOnInvalidIdHook,
    ReentrantHook
} from "./mocks/MockHook.sol";

contract AgentJobEscrowTest is Test {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    AgentJobEscrow internal escrow;
    MockERC20 internal token;
    MockHook internal hook;

    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal feeWallet = makeAddr("feeWallet");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant PLATFORM_BPS = 30;
    uint256 internal constant EVAL_BPS = 0;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant BUDGET = 1_000e6; // 1,000 USDC
    uint256 internal constant TTL = 1 days;

    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant REASON = keccak256("reason");

    enum Action {
        SetProvider,
        SetBudget,
        Fund,
        Submit,
        Complete,
        Reject,
        ClaimRefund,
        SetProviderAgentId
    }

    // -------------------------------------------------------------------------
    // setUp
    // -------------------------------------------------------------------------

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockERC20();
        escrow = new AgentJobEscrow(address(token), feeWallet, operator, EVAL_BPS, PLATFORM_BPS);
        hook = new MockHook(escrow, address(token));
        hook.setWatched(provider);

        token.mint(client, 1_000_000e6);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _expiry() internal view returns (uint256) {
        return block.timestamp + TTL;
    }

    function _create(address hook_) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(provider, evaluator, _expiry(), "task", hook_);
    }

    /// @dev Job created without a provider (the only state in which `setProvider` is valid).
    function _createNoProvider(address hook_) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.createJob(address(0), evaluator, _expiry(), "task", hook_);
    }

    function _open(address hook_) internal returns (uint256 jobId) {
        jobId = _create(hook_);
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
    }

    function _openNoProvider() internal returns (uint256 jobId) {
        jobId = _createNoProvider(address(0));
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
    }

    /// @dev Escrow on a blacklist-capable token with one submitted job, ready for settlement.
    function _blacklistSetup() internal returns (AgentJobEscrow e, BlacklistERC20 bl, uint256 jobId) {
        bl = new BlacklistERC20();
        e = new AgentJobEscrow(address(bl), feeWallet, operator, 0, PLATFORM_BPS);
        bl.mint(client, BUDGET);
        vm.startPrank(client);
        bl.approve(address(e), BUDGET);
        jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
    }

    function _funded(address hook_) internal returns (uint256 jobId) {
        jobId = _open(hook_);
        vm.prank(client);
        escrow.fund(jobId, BUDGET, "");
    }

    function _submitted(address hook_) internal returns (uint256 jobId) {
        jobId = _funded(hook_);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function _completed(address hook_) internal returns (uint256 jobId) {
        jobId = _submitted(hook_);
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");
    }

    function _rejected(address hook_) internal returns (uint256 jobId) {
        jobId = _submitted(hook_);
        vm.prank(evaluator);
        escrow.reject(jobId, REASON, "");
    }

    function _expired(address hook_) internal returns (uint256 jobId) {
        jobId = _funded(hook_);
        vm.warp(block.timestamp + TTL);
        escrow.claimRefund(jobId);
    }

    function _jobInStatus(AgentJobEscrow.JobStatus s, address hook_) internal returns (uint256) {
        if (s == AgentJobEscrow.JobStatus.Open) return _open(hook_);
        if (s == AgentJobEscrow.JobStatus.Funded) return _funded(hook_);
        if (s == AgentJobEscrow.JobStatus.Submitted) return _submitted(hook_);
        if (s == AgentJobEscrow.JobStatus.Completed) return _completed(hook_);
        if (s == AgentJobEscrow.JobStatus.Rejected) return _rejected(hook_);
        return _expired(hook_);
    }

    function _status(uint256 jobId) internal view returns (AgentJobEscrow.JobStatus) {
        return escrow.getJob(jobId).status;
    }

    function _invalidStatus(uint256 jobId, AgentJobEscrow.JobStatus s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AgentJobEscrow.InvalidStatus.selector, jobId, s);
    }

    function _platformFee(uint256 budget) internal pure returns (uint256) {
        return (budget * PLATFORM_BPS) / BPS;
    }

    // =========================================================================
    // Constructor and getters
    // =========================================================================

    function test_Constructor_SetsImmutables() public view {
        assertEq(escrow.token(), address(token));
        assertEq(escrow.feeWallet(), feeWallet);
        assertEq(escrow.operator(), operator);
        assertEq(escrow.platformFeeBP(), PLATFORM_BPS);
        assertEq(escrow.evaluatorFeeBP(), EVAL_BPS);
        assertEq(escrow.jobCount(), 0);
        assertEq(escrow.pendingPlatformFees(), 0);
        assertFalse(escrow.paused());
    }

    function test_Constructor_ZeroToken_Reverts() public {
        vm.expectRevert(AgentJobEscrow.ZeroAddress.selector);
        new AgentJobEscrow(address(0), feeWallet, operator, 0, 30);
    }

    function test_Constructor_ZeroFeeWallet_Reverts() public {
        vm.expectRevert(AgentJobEscrow.ZeroAddress.selector);
        new AgentJobEscrow(address(token), address(0), operator, 0, 30);
    }

    function test_Constructor_ZeroOperator_Reverts() public {
        vm.expectRevert(AgentJobEscrow.ZeroAddress.selector);
        new AgentJobEscrow(address(token), feeWallet, address(0), 0, 30);
    }

    function test_Constructor_TokenWithoutCode_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.NotAContract.selector, stranger));
        new AgentJobEscrow(stranger, feeWallet, operator, 0, 30);
    }

    function test_Constructor_FeesSumTo10000_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidFees.selector, 5_000, 5_000));
        new AgentJobEscrow(address(token), feeWallet, operator, 5_000, 5_000);
    }

    function test_Constructor_FeesJustBelow10000_Allowed() public {
        AgentJobEscrow e = new AgentJobEscrow(address(token), feeWallet, operator, 4_999, 5_000);
        assertEq(e.platformFeeBP() + e.evaluatorFeeBP(), 9_999);
    }

    function test_GetJob_UnknownId_ReturnsEmpty() public view {
        AgentJobEscrow.Job memory j = escrow.getJob(42);
        assertEq(j.id, 0);
        assertEq(j.client, address(0));
    }

    // =========================================================================
    // createJob
    // =========================================================================

    function test_CreateJob_Succeeds_EmitsAndStores() public {
        uint256 expiry = _expiry();
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobCreated(1, client, provider, evaluator, expiry, address(hook));

        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, evaluator, expiry, "task", address(hook));

        assertEq(jobId, 1);
        assertEq(escrow.jobCount(), 1);
        AgentJobEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(j.id, 1);
        assertEq(j.client, client);
        assertEq(j.provider, provider);
        assertEq(j.evaluator, evaluator);
        assertEq(j.description, "task");
        assertEq(j.budget, 0);
        assertEq(j.expiredAt, expiry);
        assertEq(uint8(j.status), uint8(AgentJobEscrow.JobStatus.Open));
        assertEq(j.hook, address(hook));
        // createJob is not hookable
        assertEq(hook.callCount(), 0);
    }

    function test_CreateJob_IdsAreSequential() public {
        assertEq(_create(address(0)), 1);
        assertEq(_create(address(0)), 2);
        assertEq(_create(address(0)), 3);
        assertEq(escrow.jobCount(), 3);
    }

    function test_CreateJob_ZeroProvider_Allowed() public {
        vm.prank(client);
        uint256 jobId = escrow.createJob(address(0), evaluator, _expiry(), "task", address(0));
        assertEq(escrow.getJob(jobId).provider, address(0));
    }

    function test_CreateJob_EvaluatorEqualsClient_Allowed() public {
        vm.prank(client);
        uint256 jobId = escrow.createJob(provider, client, _expiry(), "task", address(0));
        assertEq(escrow.getJob(jobId).evaluator, client);
    }

    function test_CreateJob_ZeroEvaluator_Reverts() public {
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.InvalidEvaluator.selector);
        escrow.createJob(provider, address(0), _expiry(), "task", address(0));
    }

    function test_CreateJob_ProviderEqualsClient_Reverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidProvider.selector, client));
        escrow.createJob(client, evaluator, _expiry(), "task", address(0));
    }

    function test_CreateJob_ProviderEqualsEvaluator_Reverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidProvider.selector, evaluator));
        escrow.createJob(evaluator, evaluator, _expiry(), "task", address(0));
    }

    function test_CreateJob_ExpiryNotInFuture_Reverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidExpiry.selector, block.timestamp));
        escrow.createJob(provider, evaluator, block.timestamp, "task", address(0));
    }

    function test_CreateJob_HookDenyingInterface_Reverts() public {
        NoERC165Hook bad = new NoERC165Hook();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, address(bad)));
        escrow.createJob(provider, evaluator, _expiry(), "task", address(bad));
    }

    function test_CreateJob_HookWithoutSupportsInterface_Reverts() public {
        NoSupportsInterfaceHook bad = new NoSupportsInterfaceHook();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, address(bad)));
        escrow.createJob(provider, evaluator, _expiry(), "task", address(bad));
    }

    function test_CreateJob_EoaHook_Reverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, stranger));
        escrow.createJob(provider, evaluator, _expiry(), "task", stranger);
    }

    function test_CreateJob_GarbageERC165Hook_RevertsUnsupportedHook() public {
        // A non-boolean word must be rejected with the typed error, not with an abi-decoding panic.
        GarbageERC165Hook bad = new GarbageERC165Hook();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, address(bad)));
        escrow.createJob(provider, evaluator, _expiry(), "task", address(bad));
    }

    function test_CreateJob_YesManHook_Reverts() public {
        // Claims every interface including 0xffffffff: invalid ERC-165, must be rejected.
        YesManHook bad = new YesManHook();
        assertTrue(bad.supportsInterface(0xffffffff));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, address(bad)));
        escrow.createJob(provider, evaluator, _expiry(), "task", address(bad));
    }

    function test_CreateJob_WideReturnHook_Reverts() public {
        WideReturnERC165Hook bad = new WideReturnERC165Hook();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, address(bad)));
        escrow.createJob(provider, evaluator, _expiry(), "task", address(bad));
    }

    function test_CreateJob_HookRevertingOnInvalidIdProbe_Reverts() public {
        // Strict: the 0xffffffff probe must answer `false`, a revert is not accepted.
        RevertsOnInvalidIdHook bad = new RevertsOnInvalidIdHook();
        assertTrue(bad.supportsInterface(type(IACPHook).interfaceId));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.UnsupportedHook.selector, address(bad)));
        escrow.createJob(provider, evaluator, _expiry(), "task", address(bad));
    }

    function test_CreateJob_WhenPaused_Reverts() public {
        vm.prank(operator);
        escrow.pause();
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.EnforcedPause.selector);
        escrow.createJob(provider, evaluator, _expiry(), "task", address(0));
    }

    // =========================================================================
    // setProvider
    // =========================================================================

    function test_SetProvider_Succeeds_EmitsAndHooks() public {
        vm.prank(client);
        uint256 jobId = escrow.createJob(address(0), evaluator, _expiry(), "task", address(hook));

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.ProviderSet(jobId, provider);
        vm.prank(client);
        escrow.setProvider(jobId, provider);

        assertEq(escrow.getJob(jobId).provider, provider);
        assertEq(hook.callCount(), 2);
        MockHook.Call memory before = hook.getCall(0);
        MockHook.Call memory after_ = hook.getCall(1);
        assertTrue(before.isBefore);
        assertFalse(after_.isBefore);
        assertEq(before.selector, AgentJobEscrow.setProvider.selector);
        assertEq(before.data, abi.encode(provider, bytes("")));
        assertEq(after_.data, before.data);
    }

    function test_SetProvider_AlreadySetAtCreation_Reverts() public {
        // ERC-8183: "SHALL revert if ... current job.provider != address(0)".
        uint256 jobId = _create(address(0));
        address other = makeAddr("otherProvider");
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.ProviderAlreadySet.selector, jobId));
        escrow.setProvider(jobId, other);
        assertEq(escrow.getJob(jobId).provider, provider);
    }

    function test_SetProvider_Twice_Reverts() public {
        uint256 jobId = _createNoProvider(address(0));
        vm.startPrank(client);
        escrow.setProvider(jobId, provider);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.ProviderAlreadySet.selector, jobId));
        escrow.setProvider(jobId, makeAddr("otherProvider"));
        vm.stopPrank();
        assertEq(escrow.getJob(jobId).provider, provider);
    }

    function test_SetProvider_NoAgentIdToClear_ThenProviderBinds() public {
        // C2b: nobody can bind an id while the provider is unset, so setProvider emits only ProviderSet.
        uint256 jobId = _createNoProvider(address(0));
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(jobId, 4242);

        vm.recordLogs();
        vm.prank(client);
        escrow.setProvider(jobId, provider);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], AgentJobEscrow.ProviderSet.selector);
        assertEq(escrow.providerAgentId(jobId), 0);

        vm.prank(provider);
        escrow.setProviderAgentId(jobId, 4242);
        assertEq(escrow.providerAgentId(jobId), 4242);
    }

    function test_SetProvider_NotClient_Reverts() public {
        uint256 jobId = _createNoProvider(address(0));
        vm.prank(provider);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProvider(jobId, provider);
    }

    function test_SetProvider_Zero_Reverts() public {
        uint256 jobId = _createNoProvider(address(0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidProvider.selector, address(0)));
        escrow.setProvider(jobId, address(0));
    }

    function test_SetProvider_Client_Reverts() public {
        uint256 jobId = _createNoProvider(address(0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidProvider.selector, client));
        escrow.setProvider(jobId, client);
    }

    function test_SetProvider_Evaluator_Reverts() public {
        uint256 jobId = _createNoProvider(address(0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.InvalidProvider.selector, evaluator));
        escrow.setProvider(jobId, evaluator);
    }

    function test_SetProvider_UnknownJob_Reverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.JobNotFound.selector, 99));
        escrow.setProvider(99, provider);
    }

    // =========================================================================
    // setBudget
    // =========================================================================

    function test_SetBudget_ByClient_Succeeds() public {
        uint256 jobId = _create(address(hook));
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.BudgetSet(jobId, BUDGET);
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, hex"abcd");

        assertEq(escrow.getJob(jobId).budget, BUDGET);
        assertEq(hook.callCount(), 2);
        assertEq(hook.getCall(0).selector, AgentJobEscrow.setBudget.selector);
        assertEq(hook.getCall(0).data, abi.encode(BUDGET, bytes(hex"abcd")));
    }

    function test_SetBudget_ByProvider_Succeeds() public {
        uint256 jobId = _create(address(0));
        vm.prank(provider);
        escrow.setBudget(jobId, 5e6, "");
        assertEq(escrow.getJob(jobId).budget, 5e6);
    }

    function test_SetBudget_ByStranger_Reverts() public {
        uint256 jobId = _create(address(0));
        vm.prank(stranger);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setBudget(jobId, 5e6, "");
    }

    function test_SetBudget_ByEvaluator_Reverts() public {
        uint256 jobId = _create(address(0));
        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setBudget(jobId, 5e6, "");
    }

    function test_SetBudget_CanBeOverwrittenWhileOpen() public {
        uint256 jobId = _open(address(0));
        vm.prank(provider);
        escrow.setBudget(jobId, 2 * BUDGET, "");
        assertEq(escrow.getJob(jobId).budget, 2 * BUDGET);
    }

    // =========================================================================
    // fund
    // =========================================================================

    function test_Fund_Succeeds_MovesTokensEmitsAndHooks() public {
        uint256 jobId = _open(address(hook));
        uint256 clientBefore = token.balanceOf(client);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobFunded(jobId, client, BUDGET);
        vm.prank(client);
        escrow.fund(jobId, BUDGET, hex"01");

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Funded));
        assertEq(token.balanceOf(address(escrow)), BUDGET);
        assertEq(token.balanceOf(client), clientBefore - BUDGET);

        // setBudget produced calls 0/1; fund produced 2/3
        MockHook.Call memory before = hook.getCall(2);
        MockHook.Call memory after_ = hook.getCall(3);
        assertEq(before.selector, AgentJobEscrow.fund.selector);
        assertEq(before.data, hex"01"); // optParams passed raw
        assertEq(uint8(before.status), uint8(AgentJobEscrow.JobStatus.Open));
        assertEq(before.escrowBalance, 0);
        assertEq(uint8(after_.status), uint8(AgentJobEscrow.JobStatus.Funded));
        assertEq(after_.escrowBalance, BUDGET);
    }

    function test_Fund_ExpectedBudgetMismatch_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.BudgetMismatch.selector, BUDGET - 1, BUDGET));
        escrow.fund(jobId, BUDGET - 1, "");
    }

    function test_Fund_FrontRunBudgetChange_Reverts() public {
        uint256 jobId = _open(address(0));
        // provider bumps the budget right before the client's fund lands
        vm.prank(provider);
        escrow.setBudget(jobId, BUDGET * 10, "");
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.BudgetMismatch.selector, BUDGET, BUDGET * 10));
        escrow.fund(jobId, BUDGET, "");
    }

    function test_Fund_ProviderNotSet_Reverts() public {
        vm.prank(client);
        uint256 jobId = escrow.createJob(address(0), evaluator, _expiry(), "task", address(0));
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.ProviderNotSet.selector, jobId));
        escrow.fund(jobId, BUDGET, "");
    }

    function test_Fund_AfterSetProvider_Succeeds() public {
        vm.prank(client);
        uint256 jobId = escrow.createJob(address(0), evaluator, _expiry(), "task", address(0));
        vm.startPrank(client);
        escrow.setBudget(jobId, BUDGET, "");
        escrow.setProvider(jobId, provider);
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Funded));
    }

    function test_Fund_ZeroBudget_Reverts() public {
        uint256 jobId = _create(address(0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.ZeroBudget.selector, jobId));
        escrow.fund(jobId, 0, "");
    }

    function test_Fund_NotClient_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.prank(provider);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.fund(jobId, BUDGET, "");
    }

    function test_Fund_AfterExpiry_Reverts() public {
        uint256 jobId = _open(address(0));
        uint256 expiry = escrow.getJob(jobId).expiredAt;
        vm.warp(expiry);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.FundingWindowClosed.selector, jobId, expiry));
        escrow.fund(jobId, BUDGET, "");
    }

    function test_Fund_WhenPaused_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.prank(operator);
        escrow.pause();
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.EnforcedPause.selector);
        escrow.fund(jobId, BUDGET, "");
    }

    function test_Fund_InsufficientAllowance_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.startPrank(client);
        token.approve(address(escrow), 0);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
    }

    function test_Fund_FeeOnTransferToken_Reverts() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(fot), feeWallet, operator, 0, PLATFORM_BPS);
        fot.mint(client, BUDGET);
        vm.startPrank(client);
        fot.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        vm.expectRevert(
            abi.encodeWithSelector(AgentJobEscrow.FeeOnTransferNotSupported.selector, BUDGET, BUDGET - BUDGET / 100)
        );
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
    }

    function test_Fund_FalseReturnToken_Reverts() public {
        FalseReturnERC20 bad = new FalseReturnERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(bad), feeWallet, operator, 0, PLATFORM_BPS);
        bad.mint(client, BUDGET);
        vm.startPrank(client);
        bad.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
    }

    function test_NoReturnToken_FullLifecycle_Succeeds() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(usdt), feeWallet, operator, 0, PLATFORM_BPS);
        usdt.mint(client, BUDGET);
        vm.startPrank(client);
        usdt.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        uint256 fee = _platformFee(BUDGET);
        assertEq(usdt.balanceOf(provider), BUDGET - fee);
        assertEq(usdt.balanceOf(address(e)), fee);
        assertEq(e.pendingPlatformFees(), fee);

        vm.prank(feeWallet);
        e.withdrawPlatformFees();
        assertEq(usdt.balanceOf(feeWallet), fee);
        assertEq(usdt.balanceOf(address(e)), 0);
    }

    // =========================================================================
    // submit
    // =========================================================================

    function test_Submit_Succeeds_EmitsRecordsAndHooks() public {
        uint256 jobId = _funded(address(hook));
        uint256 n = hook.callCount();

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobSubmitted(jobId, provider, DELIVERABLE);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, hex"beef");

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Submitted));
        assertEq(escrow.submittedAt(jobId), block.timestamp);
        assertEq(hook.callCount(), n + 2);
        assertEq(hook.getCall(n).selector, AgentJobEscrow.submit.selector);
        assertEq(hook.getCall(n).data, abi.encode(DELIVERABLE, bytes(hex"beef")));
        assertEq(uint8(hook.getCall(n).status), uint8(AgentJobEscrow.JobStatus.Funded));
        assertEq(uint8(hook.getCall(n + 1).status), uint8(AgentJobEscrow.JobStatus.Submitted));
    }

    function test_Submit_NotProvider_Reverts() public {
        uint256 jobId = _funded(address(0));
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.submit(jobId, DELIVERABLE, "");
    }

    function test_Submit_AfterExpiry_StillAllowed_ButRefundable() public {
        // The published text only gates expiry through claimRefund; a late submit races the refund.
        uint256 jobId = _funded(address(0));
        vm.warp(block.timestamp + TTL);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Submitted));
        escrow.claimRefund(jobId);
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
    }

    // =========================================================================
    // complete
    // =========================================================================

    function test_Complete_Succeeds_PaysProviderAndFee() public {
        uint256 jobId = _submitted(address(hook));
        uint256 fee = _platformFee(BUDGET);
        uint256 n = hook.callCount();

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobCompleted(jobId, evaluator, REASON);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.PaymentReleased(jobId, provider, BUDGET - fee);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.PlatformFeeAccrued(jobId, fee);

        vm.prank(evaluator);
        escrow.complete(jobId, REASON, hex"cafe");

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - fee);
        // pull-based: the fee stays in the escrow until withdrawn
        assertEq(token.balanceOf(feeWallet), 0);
        assertEq(token.balanceOf(evaluator), 0);
        assertEq(token.balanceOf(address(escrow)), fee);
        assertEq(escrow.pendingPlatformFees(), fee);

        // hook ordering: before = Submitted and provider unpaid; after = Completed and provider paid
        MockHook.Call memory before = hook.getCall(n);
        MockHook.Call memory after_ = hook.getCall(n + 1);
        assertEq(before.selector, AgentJobEscrow.complete.selector);
        assertEq(before.data, abi.encode(REASON, bytes(hex"cafe")));
        assertEq(uint8(before.status), uint8(AgentJobEscrow.JobStatus.Submitted));
        assertEq(before.watchedBalance, 0);
        assertEq(before.pendingFees, 0);
        assertEq(uint8(after_.status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(after_.watchedBalance, BUDGET - fee);
        assertEq(after_.pendingFees, fee);
    }

    function test_Complete_AfterActionRunsAfterPayoutsAndFeeAccrual() public {
        uint256 evalBps = 100;
        AgentJobEscrow e = new AgentJobEscrow(address(token), feeWallet, operator, evalBps, PLATFORM_BPS);
        MockHook h = new MockHook(e, address(token));
        h.setWatched(evaluator);
        vm.startPrank(client);
        token.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(h));
        e.setBudget(jobId, BUDGET, "");
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        uint256 n = h.callCount();

        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        uint256 platformFee = _platformFee(BUDGET);
        uint256 evaluatorFee = (BUDGET * evalBps) / BPS;
        MockHook.Call memory before = h.getCall(n);
        MockHook.Call memory after_ = h.getCall(n + 1);
        // before: nothing moved yet
        assertEq(before.escrowBalance, BUDGET);
        assertEq(before.watchedBalance, 0);
        assertEq(before.pendingFees, 0);
        // after: provider and evaluator already paid, platform fee already accrued and still held
        assertEq(after_.escrowBalance, platformFee);
        assertEq(after_.watchedBalance, evaluatorFee);
        assertEq(after_.pendingFees, platformFee);
        assertEq(token.balanceOf(provider), BUDGET - platformFee - evaluatorFee);
    }

    function test_Complete_DustBudget_FeeRoundsToZero_NoAccrual() public {
        // 333 * 30 / 10_000 == 0: no fee, no accrual event, provider receives everything.
        uint256 dust = 333;
        uint256 jobId = _create(address(0));
        vm.startPrank(client);
        escrow.setBudget(jobId, dust, "");
        escrow.fund(jobId, dust, "");
        vm.stopPrank();
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");

        vm.recordLogs();
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != AgentJobEscrow.PlatformFeeAccrued.selector, "fee accrued on dust");
        }
        assertEq(token.balanceOf(provider), dust);
        assertEq(escrow.pendingPlatformFees(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        vm.prank(feeWallet);
        vm.expectRevert(AgentJobEscrow.NothingToWithdraw.selector);
        escrow.withdrawPlatformFees();
    }

    function test_Complete_MinimumFeeBudget_Accrues() public {
        // 334 * 30 / 10_000 == 1: the smallest budget that pays a fee.
        uint256 jobId = _create(address(0));
        vm.startPrank(client);
        escrow.setBudget(jobId, 334, "");
        escrow.fund(jobId, 334, "");
        vm.stopPrank();
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");
        assertEq(escrow.pendingPlatformFees(), 1);
        assertEq(token.balanceOf(provider), 333);
    }

    function test_Complete_MaxUint256Budget_NoOverflow() public {
        MockERC20 big = new MockERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(big), feeWallet, operator, 100, PLATFORM_BPS);
        uint256 budget = type(uint256).max;
        big.mint(client, budget);
        vm.startPrank(client);
        big.approve(address(e), budget);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, budget, "");
        e.fund(jobId, budget, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");

        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        uint256 platformFee = (budget / BPS) * PLATFORM_BPS + ((budget % BPS) * PLATFORM_BPS) / BPS;
        uint256 evaluatorFee = (budget / BPS) * 100 + ((budget % BPS) * 100) / BPS;
        assertEq(e.pendingPlatformFees(), platformFee);
        assertEq(big.balanceOf(evaluator), evaluatorFee);
        assertEq(big.balanceOf(provider), budget - platformFee - evaluatorFee);
        assertEq(big.balanceOf(provider) + big.balanceOf(evaluator) + e.pendingPlatformFees(), budget);
    }

    function test_EvaluatorIsClient_CompletePaysProvider() public {
        vm.startPrank(client);
        uint256 jobId = escrow.createJob(provider, client, _expiry(), "task", address(hook));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");

        // the evaluator role is exercised by the client's address
        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.complete(jobId, REASON, "");

        uint256 fee = _platformFee(BUDGET);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobCompleted(jobId, client, REASON);
        vm.prank(client);
        escrow.complete(jobId, REASON, "");
        assertEq(token.balanceOf(provider), BUDGET - fee);
        assertEq(escrow.pendingPlatformFees(), fee);
        assertEq(hook.lastCall().selector, AgentJobEscrow.complete.selector);
    }

    function test_EvaluatorIsClient_RejectAfterSubmitRefundsClient() public {
        vm.startPrank(client);
        uint256 jobId = escrow.createJob(provider, client, _expiry(), "task", address(0));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
        uint256 clientBefore = token.balanceOf(client);
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");

        vm.prank(client);
        escrow.reject(jobId, REASON, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
        assertEq(token.balanceOf(provider), 0);
    }

    function test_EvaluatorIsClient_RejectWhileFundedRefundsClient() public {
        vm.startPrank(client);
        uint256 jobId = escrow.createJob(provider, client, _expiry(), "task", address(0));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.fund(jobId, BUDGET, "");
        uint256 clientBefore = token.balanceOf(client);
        escrow.reject(jobId, REASON, "");
        vm.stopPrank();
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_EvaluatorIsClient_ProviderStillCannotSettle() public {
        vm.startPrank(client);
        uint256 jobId = escrow.createJob(provider, client, _expiry(), "task", address(0));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.startPrank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.complete(jobId, REASON, "");
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.reject(jobId, REASON, "");
        vm.stopPrank();
    }

    function test_Complete_WithEvaluatorFee_PaysEvaluator() public {
        uint256 evalBps = 100; // 1%
        AgentJobEscrow e = new AgentJobEscrow(address(token), feeWallet, operator, evalBps, PLATFORM_BPS);
        vm.startPrank(client);
        token.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");

        uint256 platformFee = _platformFee(BUDGET);
        uint256 evaluatorFee = (BUDGET * evalBps) / BPS;

        vm.expectEmit(true, true, true, true, address(e));
        emit AgentJobEscrow.EvaluatorFeePaid(jobId, evaluator, evaluatorFee);
        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        assertEq(token.balanceOf(provider), BUDGET - platformFee - evaluatorFee);
        assertEq(token.balanceOf(feeWallet), 0);
        assertEq(token.balanceOf(evaluator), evaluatorFee);
        assertEq(token.balanceOf(address(e)), platformFee);
        assertEq(e.pendingPlatformFees(), platformFee);
    }

    function test_Complete_ZeroFees_NoFeeTransfers() public {
        AgentJobEscrow e = new AgentJobEscrow(address(token), feeWallet, operator, 0, 0);
        vm.startPrank(client);
        token.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        assertEq(token.balanceOf(provider), BUDGET);
        assertEq(token.balanceOf(feeWallet), 0);
        assertEq(token.balanceOf(evaluator), 0);
        assertEq(e.pendingPlatformFees(), 0);
    }

    function test_Complete_NotEvaluator_Reverts() public {
        uint256 jobId = _submitted(address(0));
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.complete(jobId, REASON, "");
        vm.prank(provider);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.complete(jobId, REASON, "");
    }

    // =========================================================================
    // reject
    // =========================================================================

    function test_Reject_Open_ByClient_NoRefund() public {
        uint256 jobId = _open(address(hook));
        uint256 clientBefore = token.balanceOf(client);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobRejected(jobId, client, REASON);
        vm.prank(client);
        escrow.reject(jobId, REASON, "");

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore);
        assertEq(hook.lastCall().selector, AgentJobEscrow.reject.selector);
        assertEq(hook.lastCall().data, abi.encode(REASON, bytes("")));
    }

    function test_Reject_Open_ByEvaluator_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.reject(jobId, REASON, "");
    }

    function test_Reject_Open_ByProvider_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.prank(provider);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.reject(jobId, REASON, "");
    }

    function test_Reject_Funded_ByEvaluator_RefundsClient() public {
        uint256 jobId = _funded(address(0));
        uint256 clientBefore = token.balanceOf(client);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobRejected(jobId, evaluator, REASON);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.Refunded(jobId, client, BUDGET);
        vm.prank(evaluator);
        escrow.reject(jobId, REASON, "");

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(feeWallet), 0);
    }

    function test_Reject_Funded_ByClient_Reverts() public {
        uint256 jobId = _funded(address(0));
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.reject(jobId, REASON, "");
    }

    function test_Reject_Submitted_ByEvaluator_RefundsClient() public {
        uint256 jobId = _submitted(address(hook));
        uint256 clientBefore = token.balanceOf(client);
        uint256 n = hook.callCount();

        vm.prank(evaluator);
        escrow.reject(jobId, REASON, "");

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
        assertEq(token.balanceOf(provider), 0);
        assertEq(hook.getCall(n).escrowBalance, BUDGET);
        assertEq(hook.getCall(n + 1).escrowBalance, 0);
    }

    function test_Reject_Submitted_ByProvider_Reverts() public {
        uint256 jobId = _submitted(address(0));
        vm.prank(provider);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.reject(jobId, REASON, "");
    }

    function test_Reject_HookRevertInBefore_BlocksRejectAndRefund() public {
        uint256 jobId = _submitted(address(hook));
        uint256 clientBefore = token.balanceOf(client);
        hook.setRevertBefore(true);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(MockHook.HookRevert.selector, "before"));
        escrow.reject(jobId, REASON, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Submitted));
        assertEq(token.balanceOf(client), clientBefore);
        assertEq(token.balanceOf(address(escrow)), BUDGET);
    }

    function test_Reject_HookRevertInAfter_RevertsWholeReject() public {
        uint256 jobId = _funded(address(hook));
        uint256 clientBefore = token.balanceOf(client);
        hook.setRevertAfter(true);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(MockHook.HookRevert.selector, "after"));
        escrow.reject(jobId, REASON, "");
        // the refund transfer happened inside the reverted frame: nothing moved
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Funded));
        assertEq(token.balanceOf(client), clientBefore);
        assertEq(token.balanceOf(address(escrow)), BUDGET);
    }

    // =========================================================================
    // claimRefund
    // =========================================================================

    function test_ClaimRefund_BeforeExpiry_Reverts() public {
        uint256 jobId = _funded(address(0));
        uint256 expiry = escrow.getJob(jobId).expiredAt;
        vm.warp(expiry - 1);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.NotExpired.selector, jobId, expiry));
        escrow.claimRefund(jobId);
    }

    function test_ClaimRefund_Funded_ByAnyone_RefundsClient() public {
        uint256 jobId = _funded(address(0));
        uint256 clientBefore = token.balanceOf(client);
        vm.warp(escrow.getJob(jobId).expiredAt);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.JobExpired(jobId);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.Refunded(jobId, client, BUDGET);
        vm.prank(stranger);
        escrow.claimRefund(jobId);

        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_ClaimRefund_Submitted_RefundsClient() public {
        uint256 jobId = _submitted(address(0));
        uint256 clientBefore = token.balanceOf(client);
        vm.warp(escrow.getJob(jobId).expiredAt + 1 weeks);
        escrow.claimRefund(jobId);
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_ClaimRefund_IsNeverHooked() public {
        uint256 jobId = _submitted(address(hook));
        uint256 n = hook.callCount();
        hook.setRevertBefore(true);
        hook.setRevertAfter(true);
        vm.warp(escrow.getJob(jobId).expiredAt);
        escrow.claimRefund(jobId);
        assertEq(hook.callCount(), n);
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
    }

    function test_ClaimRefund_WorksWhilePaused() public {
        uint256 jobId = _funded(address(0));
        vm.prank(operator);
        escrow.pause();
        vm.warp(escrow.getJob(jobId).expiredAt);
        escrow.claimRefund(jobId);
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
    }

    // =========================================================================
    // Expiry race on Submitted jobs (spec-permitted: first tx wins)
    // =========================================================================

    function test_ExpiryRace_CompleteFirst_ThenClaimRefundReverts() public {
        uint256 jobId = _submitted(address(0));
        vm.warp(escrow.getJob(jobId).expiredAt);

        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - _platformFee(BUDGET));

        vm.prank(stranger);
        vm.expectRevert(_invalidStatus(jobId, AgentJobEscrow.JobStatus.Completed));
        escrow.claimRefund(jobId);
    }

    function test_ExpiryRace_ClaimRefundFirst_ThenCompleteReverts() public {
        uint256 jobId = _submitted(address(0));
        uint256 clientBefore = token.balanceOf(client);
        vm.warp(escrow.getJob(jobId).expiredAt);

        vm.prank(stranger);
        escrow.claimRefund(jobId);
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);

        vm.prank(evaluator);
        vm.expectRevert(_invalidStatus(jobId, AgentJobEscrow.JobStatus.Expired));
        escrow.complete(jobId, REASON, "");
        vm.prank(evaluator);
        vm.expectRevert(_invalidStatus(jobId, AgentJobEscrow.JobStatus.Expired));
        escrow.reject(jobId, REASON, "");
        assertEq(token.balanceOf(provider), 0);
    }

    // =========================================================================
    // Transition table (conformance): every (status, action) pair
    // =========================================================================

    function _isValid(AgentJobEscrow.JobStatus s, Action a) internal pure returns (bool) {
        if (a == Action.SetProvider || a == Action.SetBudget || a == Action.Fund) {
            return s == AgentJobEscrow.JobStatus.Open;
        }
        if (a == Action.Submit) return s == AgentJobEscrow.JobStatus.Funded;
        if (a == Action.Complete) return s == AgentJobEscrow.JobStatus.Submitted;
        if (a == Action.Reject) {
            return s == AgentJobEscrow.JobStatus.Open || s == AgentJobEscrow.JobStatus.Funded
                || s == AgentJobEscrow.JobStatus.Submitted;
        }
        if (a == Action.ClaimRefund) {
            return s == AgentJobEscrow.JobStatus.Funded || s == AgentJobEscrow.JobStatus.Submitted;
        }
        // SetProviderAgentId
        return s == AgentJobEscrow.JobStatus.Open || s == AgentJobEscrow.JobStatus.Funded;
    }

    function _expectedAfter(AgentJobEscrow.JobStatus s, Action a) internal pure returns (AgentJobEscrow.JobStatus) {
        if (a == Action.Fund) return AgentJobEscrow.JobStatus.Funded;
        if (a == Action.Submit) return AgentJobEscrow.JobStatus.Submitted;
        if (a == Action.Complete) return AgentJobEscrow.JobStatus.Completed;
        if (a == Action.Reject) return AgentJobEscrow.JobStatus.Rejected;
        if (a == Action.ClaimRefund) return AgentJobEscrow.JobStatus.Expired;
        return s;
    }

    /// @dev Performs `a` on `jobId` using the role that would be authorised if the status allowed it.
    function _perform(uint256 jobId, AgentJobEscrow.JobStatus s, Action a) internal {
        if (a == Action.SetProvider) {
            vm.prank(client);
            escrow.setProvider(jobId, makeAddr("replacement"));
        } else if (a == Action.SetBudget) {
            vm.prank(client);
            escrow.setBudget(jobId, BUDGET, "");
        } else if (a == Action.Fund) {
            vm.prank(client);
            escrow.fund(jobId, BUDGET, "");
        } else if (a == Action.Submit) {
            vm.prank(provider);
            escrow.submit(jobId, DELIVERABLE, "");
        } else if (a == Action.Complete) {
            vm.prank(evaluator);
            escrow.complete(jobId, REASON, "");
        } else if (a == Action.Reject) {
            vm.prank(s == AgentJobEscrow.JobStatus.Open ? client : evaluator);
            escrow.reject(jobId, REASON, "");
        } else if (a == Action.ClaimRefund) {
            vm.prank(stranger);
            escrow.claimRefund(jobId);
        } else {
            vm.prank(provider);
            escrow.setProviderAgentId(jobId, 7);
        }
    }

    function test_TransitionTable_OnlyValidPairsSucceed() public {
        for (uint8 si = 0; si <= uint8(AgentJobEscrow.JobStatus.Expired); si++) {
            for (uint8 ai = 0; ai <= uint8(Action.SetProviderAgentId); ai++) {
                AgentJobEscrow.JobStatus s = AgentJobEscrow.JobStatus(si);
                Action a = Action(ai);
                // setProvider is only valid while Open AND unset (ERC-8183); every other status
                // rejects it with InvalidStatus regardless of the provider.
                uint256 jobId = (s == AgentJobEscrow.JobStatus.Open && a == Action.SetProvider)
                    ? _openNoProvider()
                    : _jobInStatus(s, address(0));
                assertEq(uint8(_status(jobId)), si, "setup status");

                if (a == Action.ClaimRefund) vm.warp(escrow.getJob(jobId).expiredAt);

                if (_isValid(s, a)) {
                    _perform(jobId, s, a);
                    assertEq(uint8(_status(jobId)), uint8(_expectedAfter(s, a)), "post status");
                } else {
                    vm.expectRevert(_invalidStatus(jobId, s));
                    _perform(jobId, s, a);
                    assertEq(uint8(_status(jobId)), si, "status unchanged");
                }
            }
        }
    }

    function test_TransitionTable_FundsAlwaysSettle() public {
        // Funds never get stuck: after every terminal transition the escrow holds nothing for that
        // job except the accrued platform fee, which the fee wallet can always pull.
        uint256 completed = _completed(address(0));
        uint256 rejected = _rejected(address(0));
        uint256 expired = _expired(address(0));
        assertEq(uint8(_status(completed)), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(uint8(_status(rejected)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(uint8(_status(expired)), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(token.balanceOf(address(escrow)), _platformFee(BUDGET));
        assertEq(token.balanceOf(address(escrow)), escrow.pendingPlatformFees());
        vm.prank(feeWallet);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    // =========================================================================
    // Hooks
    // =========================================================================

    function test_Hook_FullLifecycle_OrderAndSelectors() public {
        uint256 jobId = _create(address(hook));
        vm.prank(client);
        escrow.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        escrow.fund(jobId, BUDGET, "");
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");

        bytes4[4] memory expected = [
            AgentJobEscrow.setBudget.selector,
            AgentJobEscrow.fund.selector,
            AgentJobEscrow.submit.selector,
            AgentJobEscrow.complete.selector
        ];
        assertEq(hook.callCount(), 8);
        for (uint256 i = 0; i < 4; i++) {
            MockHook.Call memory before = hook.getCall(2 * i);
            MockHook.Call memory after_ = hook.getCall(2 * i + 1);
            assertTrue(before.isBefore);
            assertFalse(after_.isBefore);
            assertEq(before.jobId, jobId);
            assertEq(before.selector, expected[i]);
            assertEq(after_.selector, expected[i]);
        }
    }

    function test_Hook_RevertInBefore_BlocksAction() public {
        uint256 jobId = _open(address(hook));
        hook.setRevertBefore(true);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(MockHook.HookRevert.selector, "before"));
        escrow.fund(jobId, BUDGET, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Open));
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Hook_RevertInAfter_RevertsWholeAction() public {
        uint256 jobId = _submitted(address(hook));
        hook.setRevertAfter(true);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(MockHook.HookRevert.selector, "after"));
        escrow.complete(jobId, REASON, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Submitted));
        assertEq(token.balanceOf(provider), 0);
        assertEq(token.balanceOf(address(escrow)), BUDGET);
    }

    function test_Hook_ZeroHook_NoCalls() public {
        _completed(address(0));
        assertEq(hook.callCount(), 0);
    }

    function test_Hook_FlipsAfterFund_SettlementBlocked_ClaimRefundStillWorks() public {
        // A hook that starts behaving after funding can block submit/complete/reject but never the refund.
        uint256 jobId = _funded(address(hook));
        uint256 clientBefore = token.balanceOf(client);
        hook.setRevertBefore(true);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(MockHook.HookRevert.selector, "before"));
        escrow.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(MockHook.HookRevert.selector, "before"));
        escrow.reject(jobId, REASON, "");
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Funded));

        vm.warp(escrow.getJob(jobId).expiredAt);
        vm.prank(stranger);
        escrow.claimRefund(jobId);
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(token.balanceOf(client), clientBefore + BUDGET);
    }

    function test_Hook_InterfaceId_MatchesSpec() public pure {
        bytes4 expected = IACPHook.beforeAction.selector ^ IACPHook.afterAction.selector;
        assertEq(type(IACPHook).interfaceId, expected);
        // Pinned so a signature drift in IACPHook.sol (which would break third-party hooks) is caught.
        assertEq(type(IACPHook).interfaceId, bytes4(0x7ff6bc9e));
        // `is IERC165` does not change the id: inherited functions are excluded by definition.
        assertTrue(type(IACPHook).interfaceId != (expected ^ IERC165.supportsInterface.selector));
    }

    // =========================================================================
    // Reentrancy
    // =========================================================================

    function _escrowWithReentrantToken() internal returns (AgentJobEscrow e, ReentrantERC20 evil, uint256 jobId) {
        evil = new ReentrantERC20();
        e = new AgentJobEscrow(address(evil), feeWallet, operator, 0, PLATFORM_BPS);
        evil.mint(client, BUDGET);
        vm.startPrank(client);
        evil.approve(address(e), BUDGET);
        jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        vm.stopPrank();
    }

    function test_Reentrancy_TokenDuringFund_Blocked() public {
        (AgentJobEscrow e, ReentrantERC20 evil, uint256 jobId) = _escrowWithReentrantToken();
        evil.setAttack(address(e), abi.encodeCall(AgentJobEscrow.fund, (jobId, BUDGET, "")));

        vm.prank(client);
        e.fund(jobId, BUDGET, "");

        assertTrue(evil.attacked());
        assertFalse(evil.lastReentryOk());
        assertEq(evil.lastReentryData(), abi.encodeWithSelector(AgentJobEscrow.ReentrantCall.selector));
        assertEq(evil.balanceOf(address(e)), BUDGET);
    }

    function test_Reentrancy_TokenDuringComplete_Blocked() public {
        (AgentJobEscrow e, ReentrantERC20 evil, uint256 jobId) = _escrowWithReentrantToken();
        vm.prank(client);
        e.fund(jobId, BUDGET, "");
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        // try to double-settle from inside the payout transfer
        evil.setAttack(address(e), abi.encodeCall(AgentJobEscrow.complete, (jobId, REASON, "")));

        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        assertFalse(evil.lastReentryOk());
        assertEq(evil.lastReentryData(), abi.encodeWithSelector(AgentJobEscrow.ReentrantCall.selector));
        assertEq(evil.balanceOf(provider), BUDGET - _platformFee(BUDGET));
        assertEq(evil.balanceOf(address(e)), _platformFee(BUDGET));
        assertEq(e.pendingPlatformFees(), _platformFee(BUDGET));
    }

    function test_Reentrancy_TokenDuringWithdrawPlatformFees_Blocked() public {
        (AgentJobEscrow e, ReentrantERC20 evil, uint256 jobId) = _escrowWithReentrantToken();
        vm.prank(client);
        e.fund(jobId, BUDGET, "");
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        evil.setAttack(address(0), "");
        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        // from inside the fee transfer try to withdraw again
        evil.setAttack(address(e), abi.encodeCall(AgentJobEscrow.withdrawPlatformFees, ()));
        vm.prank(feeWallet);
        e.withdrawPlatformFees();

        assertTrue(evil.attacked());
        assertFalse(evil.lastReentryOk());
        assertEq(evil.lastReentryData(), abi.encodeWithSelector(AgentJobEscrow.ReentrantCall.selector));
        assertEq(evil.balanceOf(feeWallet), _platformFee(BUDGET));
        assertEq(e.pendingPlatformFees(), 0);
    }

    function test_Reentrancy_TokenDuringClaimRefund_Blocked() public {
        (AgentJobEscrow e, ReentrantERC20 evil, uint256 jobId) = _escrowWithReentrantToken();
        vm.prank(client);
        e.fund(jobId, BUDGET, "");
        evil.setAttack(address(e), abi.encodeCall(AgentJobEscrow.claimRefund, (jobId)));
        vm.warp(e.getJob(jobId).expiredAt);

        e.claimRefund(jobId);

        assertFalse(evil.lastReentryOk());
        assertEq(evil.lastReentryData(), abi.encodeWithSelector(AgentJobEscrow.ReentrantCall.selector));
        assertEq(evil.balanceOf(client), BUDGET);
    }

    function test_Reentrancy_HookInAfterAction_Blocked() public {
        ReentrantHook evil = new ReentrantHook();
        uint256 jobId = _open(address(evil));
        // from afterAction(fund) try to submit on behalf of nobody
        evil.setAttack(address(escrow), abi.encodeCall(AgentJobEscrow.submit, (jobId, DELIVERABLE, "")), false);

        vm.prank(client);
        escrow.fund(jobId, BUDGET, "");

        assertTrue(evil.attacked());
        assertFalse(evil.lastReentryOk());
        assertEq(evil.lastReentryData(), abi.encodeWithSelector(AgentJobEscrow.ReentrantCall.selector));
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Funded));
    }

    function test_Reentrancy_HookInBeforeAction_Blocked() public {
        ReentrantHook evil = new ReentrantHook();
        uint256 jobId = _open(address(evil));
        vm.prank(client);
        escrow.fund(jobId, BUDGET, "");
        vm.prank(provider);
        escrow.submit(jobId, DELIVERABLE, "");
        // from beforeAction(complete) try to reject (would refund the client)
        evil.setAttack(address(escrow), abi.encodeCall(AgentJobEscrow.reject, (jobId, REASON, "")), true);

        vm.prank(evaluator);
        escrow.complete(jobId, REASON, "");

        assertFalse(evil.lastReentryOk());
        assertEq(evil.lastReentryData(), abi.encodeWithSelector(AgentJobEscrow.ReentrantCall.selector));
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(token.balanceOf(provider), BUDGET - _platformFee(BUDGET));
    }

    function test_Reentrancy_HookMayReadJobDuringAction() public {
        // Views are not guarded: the MockHook reads getJob() in both phases and that must work.
        uint256 jobId = _funded(address(hook));
        assertEq(hook.getCall(hook.callCount() - 1).jobId, jobId);
    }

    // =========================================================================
    // Pause (AgentFi extension)
    // =========================================================================

    function test_Pause_OnlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.pause();
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.unpause();
    }

    function test_Pause_EmitsAndToggles() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.Paused(operator);
        vm.prank(operator);
        escrow.pause();
        assertTrue(escrow.paused());

        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.Unpaused(operator);
        vm.prank(operator);
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_Pause_DoublePause_Reverts() public {
        vm.startPrank(operator);
        escrow.pause();
        vm.expectRevert(AgentJobEscrow.EnforcedPause.selector);
        escrow.pause();
        vm.stopPrank();
    }

    function test_Unpause_WhenNotPaused_Reverts() public {
        vm.prank(operator);
        vm.expectRevert(AgentJobEscrow.ExpectedPause.selector);
        escrow.unpause();
    }

    function test_Pause_DoesNotBlockSettlement() public {
        uint256 submitted = _submitted(address(0));
        uint256 funded = _funded(address(0));
        uint256 open = _open(address(0));
        vm.prank(operator);
        escrow.pause();

        vm.prank(evaluator);
        escrow.complete(submitted, REASON, "");
        vm.prank(evaluator);
        escrow.reject(funded, REASON, "");
        vm.prank(client);
        escrow.setBudget(open, 1, "");
        vm.prank(provider);
        escrow.setProviderAgentId(open, 9);
        vm.prank(client);
        escrow.reject(open, REASON, "");

        assertEq(uint8(_status(submitted)), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(uint8(_status(funded)), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(uint8(_status(open)), uint8(AgentJobEscrow.JobStatus.Rejected));
    }

    function test_Pause_SubmitStillWorks() public {
        uint256 funded = _funded(address(0));
        vm.prank(operator);
        escrow.pause();
        vm.prank(provider);
        escrow.submit(funded, DELIVERABLE, "");
        assertEq(uint8(_status(funded)), uint8(AgentJobEscrow.JobStatus.Submitted));
    }

    function test_Pause_UnpauseRestoresCreateAndFund() public {
        vm.prank(operator);
        escrow.pause();
        vm.prank(operator);
        escrow.unpause();
        uint256 jobId = _funded(address(0));
        assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Funded));
    }

    // =========================================================================
    // providerAgentId (AgentFi extension)
    // =========================================================================

    function test_SetProviderAgentId_WhileOpen_Succeeds() public {
        uint256 jobId = _open(address(hook));
        uint256 n = hook.callCount();
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.ProviderAgentIdSet(jobId, 1234);
        vm.prank(provider);
        escrow.setProviderAgentId(jobId, 1234);
        assertEq(escrow.providerAgentId(jobId), 1234);
        assertEq(hook.callCount(), n); // extension, not hooked
    }

    function test_SetProviderAgentId_WhileFunded_Succeeds() public {
        uint256 jobId = _funded(address(0));
        vm.prank(provider);
        escrow.setProviderAgentId(jobId, 55);
        assertEq(escrow.providerAgentId(jobId), 55);
    }

    function test_SetProviderAgentId_ProviderCanClearItsOwn() public {
        uint256 jobId = _open(address(0));
        vm.startPrank(provider);
        escrow.setProviderAgentId(jobId, 55);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.ProviderAgentIdSet(jobId, 0);
        escrow.setProviderAgentId(jobId, 0);
        vm.stopPrank();
        assertEq(escrow.providerAgentId(jobId), 0);
    }

    function test_SetProviderAgentId_AfterSubmit_Reverts() public {
        uint256 jobId = _submitted(address(0));
        vm.prank(provider);
        vm.expectRevert(_invalidStatus(jobId, AgentJobEscrow.JobStatus.Submitted));
        escrow.setProviderAgentId(jobId, 1);
    }

    /// @dev C2b finding 3 (second adversarial review): the client used to be able to set 0 after the
    ///      provider had bound its id and before `submit`, so `complete` skipped with "no-agent-id".
    function test_SetProviderAgentId_ClientCannotWipeProviderBinding() public {
        uint256 jobId = _funded(address(0));
        vm.prank(provider);
        escrow.setProviderAgentId(jobId, 4242);

        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(jobId, 0);
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(jobId, 7);
        assertEq(escrow.providerAgentId(jobId), 4242);

        // ... and while Open as well.
        uint256 open = _open(address(0));
        vm.prank(client);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(open, 1);
    }

    function test_SetProviderAgentId_ByProvider_Succeeds() public {
        uint256 jobId = _funded(address(0));
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.ProviderAgentIdSet(jobId, 1);
        vm.prank(provider);
        escrow.setProviderAgentId(jobId, 1);
        assertEq(escrow.providerAgentId(jobId), 1);
    }

    function test_SetProviderAgentId_ByStrangerOrEvaluator_Reverts() public {
        uint256 jobId = _open(address(0));
        vm.prank(stranger);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(jobId, 1);
        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setProviderAgentId(jobId, 1);
    }

    function test_SetProviderAgentId_NoProviderYet_NobodyCanSet() public {
        // With provider == address(0) nobody may set it (no "anyone" hole, and not the client either;
        // `msg.sender` can never be the zero address).
        uint256 jobId = _createNoProvider(address(0));
        address[3] memory callers = [stranger, client, evaluator];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
            escrow.setProviderAgentId(jobId, 1);
        }
        assertEq(escrow.providerAgentId(jobId), 0);
    }

    function test_SetProviderAgentId_UnknownJob_Reverts() public {
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.JobNotFound.selector, 7));
        escrow.setProviderAgentId(7, 1);
    }

    // =========================================================================
    // Platform fees: pull-based accrual, withdrawal and fee wallet rotation
    // =========================================================================

    function test_WithdrawPlatformFees_ByFeeWallet() public {
        _completed(address(0));
        uint256 fee = _platformFee(BUDGET);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.PlatformFeesWithdrawn(feeWallet, fee);
        vm.prank(feeWallet);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(feeWallet), fee);
        assertEq(escrow.pendingPlatformFees(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_WithdrawPlatformFees_ByOperator_PaysFeeWallet() public {
        _completed(address(0));
        uint256 fee = _platformFee(BUDGET);
        vm.prank(operator);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(feeWallet), fee);
        assertEq(token.balanceOf(operator), 0);
    }

    function test_WithdrawPlatformFees_AccumulatesAcrossJobs() public {
        _completed(address(0));
        _completed(address(0));
        _rejected(address(0));
        assertEq(escrow.pendingPlatformFees(), 2 * _platformFee(BUDGET));
        vm.prank(feeWallet);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(feeWallet), 2 * _platformFee(BUDGET));
    }

    function test_WithdrawPlatformFees_ByStranger_Reverts() public {
        _completed(address(0));
        vm.prank(stranger);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.withdrawPlatformFees();
        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.withdrawPlatformFees();
    }

    function test_WithdrawPlatformFees_NothingAccrued_Reverts() public {
        vm.prank(feeWallet);
        vm.expectRevert(AgentJobEscrow.NothingToWithdraw.selector);
        escrow.withdrawPlatformFees();
    }

    function test_WithdrawPlatformFees_WorksWhilePaused() public {
        _completed(address(0));
        vm.prank(operator);
        escrow.pause();
        vm.prank(feeWallet);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(feeWallet), _platformFee(BUDGET));
    }

    function test_WithdrawPlatformFees_NeverTouchesEscrowedBudgets() public {
        _completed(address(0));
        uint256 live = _submitted(address(0));
        vm.prank(feeWallet);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(address(escrow)), BUDGET);
        assertEq(uint8(_status(live)), uint8(AgentJobEscrow.JobStatus.Submitted));
    }

    function test_SetFeeWallet_OnlyOperator() public {
        address next = makeAddr("nextFeeWallet");
        vm.prank(feeWallet);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setFeeWallet(next);
        vm.prank(stranger);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.setFeeWallet(next);
    }

    function test_SetFeeWallet_Zero_Reverts() public {
        vm.prank(operator);
        vm.expectRevert(AgentJobEscrow.ZeroAddress.selector);
        escrow.setFeeWallet(address(0));
    }

    function test_SetFeeWallet_RotatesAndEmits() public {
        address next = makeAddr("nextFeeWallet");
        vm.expectEmit(true, true, true, true, address(escrow));
        emit AgentJobEscrow.FeeWalletUpdated(feeWallet, next);
        vm.prank(operator);
        escrow.setFeeWallet(next);
        assertEq(escrow.feeWallet(), next);

        _completed(address(0));
        // the old wallet lost its withdrawal right, the new one withdraws to itself
        vm.prank(feeWallet);
        vm.expectRevert(AgentJobEscrow.Unauthorized.selector);
        escrow.withdrawPlatformFees();
        vm.prank(next);
        escrow.withdrawPlatformFees();
        assertEq(token.balanceOf(next), _platformFee(BUDGET));
        assertEq(token.balanceOf(feeWallet), 0);
    }

    function test_FeeWalletBlacklisted_CompleteStillPaysProvider_RotateThenWithdraw() public {
        (AgentJobEscrow e, BlacklistERC20 bl, uint256 jobId) = _blacklistSetup();
        bl.setBlacklisted(feeWallet, true);
        uint256 fee = _platformFee(BUDGET);

        // settlement is unaffected by the frozen fee wallet
        vm.prank(evaluator);
        e.complete(jobId, REASON, "");
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(bl.balanceOf(provider), BUDGET - fee);
        assertEq(e.pendingPlatformFees(), fee);

        // the frozen wallet cannot pull, the accrual is kept
        vm.prank(feeWallet);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.withdrawPlatformFees();
        assertEq(e.pendingPlatformFees(), fee);

        // rotate and pull
        address next = makeAddr("nextFeeWallet");
        vm.prank(operator);
        e.setFeeWallet(next);
        vm.prank(operator);
        e.withdrawPlatformFees();
        assertEq(bl.balanceOf(next), fee);
        assertEq(e.pendingPlatformFees(), 0);
        assertEq(bl.balanceOf(address(e)), 0);
    }

    // =========================================================================
    // Blacklisted client / provider (documented: no escape hatch on purpose)
    // =========================================================================

    function test_ClientBlacklisted_RejectAndClaimRefundRevert_CompleteIsTheOnlyExit() public {
        (AgentJobEscrow e, BlacklistERC20 bl, uint256 jobId) = _blacklistSetup();
        bl.setBlacklisted(client, true);

        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.reject(jobId, REASON, "");
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Submitted));

        vm.warp(e.getJob(jobId).expiredAt);
        vm.prank(stranger);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.claimRefund(jobId);
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Submitted));

        vm.prank(evaluator);
        e.complete(jobId, REASON, "");
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Completed));
        assertEq(bl.balanceOf(provider), BUDGET - _platformFee(BUDGET));
    }

    function test_ClientBlacklisted_FundedJob_RefundResumesOnceUnblacklisted() public {
        BlacklistERC20 bl = new BlacklistERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(bl), feeWallet, operator, 0, PLATFORM_BPS);
        bl.mint(client, BUDGET);
        vm.startPrank(client);
        bl.approve(address(e), BUDGET);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, BUDGET, "");
        e.fund(jobId, BUDGET, "");
        vm.stopPrank();
        bl.setBlacklisted(client, true);

        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.reject(jobId, REASON, "");
        vm.warp(e.getJob(jobId).expiredAt);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.claimRefund(jobId);

        // funds are held, not lost: the refund works again once the client is cleared
        bl.setBlacklisted(client, false);
        e.claimRefund(jobId);
        assertEq(bl.balanceOf(client), BUDGET);
    }

    function test_ProviderBlacklisted_CompleteReverts_RejectRefundsClient() public {
        (AgentJobEscrow e, BlacklistERC20 bl, uint256 jobId) = _blacklistSetup();
        bl.setBlacklisted(provider, true);

        vm.prank(evaluator);
        vm.expectRevert(AgentJobEscrow.TransferFailed.selector);
        e.complete(jobId, REASON, "");
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Submitted));
        assertEq(e.pendingPlatformFees(), 0);

        vm.prank(evaluator);
        e.reject(jobId, keccak256("agentfi.payout-blocked"), "");
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Rejected));
        assertEq(bl.balanceOf(client), BUDGET);
        assertEq(bl.balanceOf(address(e)), 0);
    }

    function test_ProviderBlacklisted_ClaimRefundWorks() public {
        (AgentJobEscrow e, BlacklistERC20 bl, uint256 jobId) = _blacklistSetup();
        bl.setBlacklisted(provider, true);
        vm.warp(e.getJob(jobId).expiredAt);
        vm.prank(stranger);
        e.claimRefund(jobId);
        assertEq(uint8(e.getJob(jobId).status), uint8(AgentJobEscrow.JobStatus.Expired));
        assertEq(bl.balanceOf(client), BUDGET);
    }

    // =========================================================================
    // Fuzz
    // =========================================================================

    function testFuzz_Complete_FeeMath(uint256 budget, uint16 platformBps, uint16 evalBps) public {
        budget = bound(budget, 1, type(uint256).max);
        platformBps = uint16(bound(platformBps, 0, 9_999));
        evalBps = uint16(bound(evalBps, 0, 9_999 - platformBps));

        // fresh token so any uint256 budget can be minted without overflowing a prior balance
        MockERC20 t = new MockERC20();
        AgentJobEscrow e = new AgentJobEscrow(address(t), feeWallet, operator, evalBps, platformBps);
        t.mint(client, budget);
        vm.startPrank(client);
        t.approve(address(e), budget);
        uint256 jobId = e.createJob(provider, evaluator, _expiry(), "task", address(0));
        e.setBudget(jobId, budget, "");
        e.fund(jobId, budget, "");
        vm.stopPrank();
        vm.prank(provider);
        e.submit(jobId, DELIVERABLE, "");
        vm.prank(evaluator);
        e.complete(jobId, REASON, "");

        uint256 platformFee = e.pendingPlatformFees();
        uint256 evaluatorFee = t.balanceOf(evaluator);
        if (budget <= type(uint256).max / BPS) {
            // where the naive formula cannot overflow, the split formula must agree with it exactly
            assertEq(platformFee, (budget * platformBps) / BPS, "platform fee");
            assertEq(evaluatorFee, (budget * evalBps) / BPS, "evaluator fee");
        } else {
            assertEq(platformFee, (budget / BPS) * platformBps + ((budget % BPS) * platformBps) / BPS);
            assertEq(evaluatorFee, (budget / BPS) * evalBps + ((budget % BPS) * evalBps) / BPS);
        }
        assertEq(t.balanceOf(provider), budget - platformFee - evaluatorFee);
        assertEq(t.balanceOf(feeWallet), 0);
        assertEq(t.balanceOf(address(e)), platformFee);
        assertEq(t.balanceOf(provider) + evaluatorFee + platformFee, budget, "conservation");
    }

    function testFuzz_PlatformFeeAccrual_Conservation(uint96[5] memory budgets, uint8 outcomes) public {
        uint256 expectedFees;
        uint256 expectedHeld;
        for (uint256 i = 0; i < budgets.length; i++) {
            uint256 budget = bound(budgets[i], 1, type(uint96).max);
            token.mint(client, budget);
            vm.startPrank(client);
            uint256 jobId = escrow.createJob(provider, evaluator, _expiry(), "task", address(0));
            escrow.setBudget(jobId, budget, "");
            escrow.fund(jobId, budget, "");
            vm.stopPrank();
            vm.prank(provider);
            escrow.submit(jobId, DELIVERABLE, "");

            uint256 outcome = (outcomes >> (2 * i)) & 3; // 0: complete, 1: reject, 2/3: leave open
            if (outcome == 0) {
                vm.prank(evaluator);
                escrow.complete(jobId, REASON, "");
                expectedFees += _platformFee(budget);
            } else if (outcome == 1) {
                vm.prank(evaluator);
                escrow.reject(jobId, REASON, "");
            } else {
                expectedHeld += budget;
            }
            assertEq(escrow.pendingPlatformFees(), expectedFees, "accrual");
            assertEq(token.balanceOf(address(escrow)), expectedFees + expectedHeld, "balance");
        }

        if (expectedFees == 0) {
            vm.prank(feeWallet);
            vm.expectRevert(AgentJobEscrow.NothingToWithdraw.selector);
            escrow.withdrawPlatformFees();
        } else {
            vm.prank(operator);
            escrow.withdrawPlatformFees();
        }
        assertEq(token.balanceOf(feeWallet), expectedFees);
        assertEq(escrow.pendingPlatformFees(), 0);
        assertEq(token.balanceOf(address(escrow)), expectedHeld);
    }

    function testFuzz_FundAndRefund_RoundTrip(uint96 budget, uint32 ttl, bool viaReject) public {
        budget = uint96(bound(budget, 1, type(uint96).max));
        ttl = uint32(bound(ttl, 1, 365 days));
        token.mint(client, budget);
        uint256 clientBefore = token.balanceOf(client);

        vm.startPrank(client);
        uint256 jobId = escrow.createJob(provider, evaluator, block.timestamp + ttl, "task", address(0));
        escrow.setBudget(jobId, budget, "");
        escrow.fund(jobId, budget, "");
        vm.stopPrank();
        assertEq(token.balanceOf(client), clientBefore - budget);

        if (viaReject) {
            vm.prank(evaluator);
            escrow.reject(jobId, REASON, "");
        } else {
            vm.warp(block.timestamp + ttl);
            escrow.claimRefund(jobId);
        }
        assertEq(token.balanceOf(client), clientBefore);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzz_Fund_ExpectedBudgetMismatch_Reverts(uint96 budget, uint96 expected) public {
        budget = uint96(bound(budget, 1, type(uint96).max));
        vm.assume(expected != budget);
        uint256 jobId = _create(address(0));
        vm.startPrank(client);
        escrow.setBudget(jobId, budget, "");
        vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.BudgetMismatch.selector, expected, budget));
        escrow.fund(jobId, expected, "");
        vm.stopPrank();
    }

    function testFuzz_ClaimRefund_TimeGate(uint32 ttl, uint32 elapsed) public {
        ttl = uint32(bound(ttl, 1, 365 days));
        vm.startPrank(client);
        uint256 jobId = escrow.createJob(provider, evaluator, block.timestamp + ttl, "task", address(0));
        escrow.setBudget(jobId, BUDGET, "");
        escrow.fund(jobId, BUDGET, "");
        vm.stopPrank();

        uint256 expiry = block.timestamp + ttl;
        vm.warp(block.timestamp + elapsed);
        if (elapsed < ttl) {
            vm.expectRevert(abi.encodeWithSelector(AgentJobEscrow.NotExpired.selector, jobId, expiry));
            escrow.claimRefund(jobId);
        } else {
            escrow.claimRefund(jobId);
            assertEq(uint8(_status(jobId)), uint8(AgentJobEscrow.JobStatus.Expired));
        }
    }

    // =========================================================================
    // ERC-165 sanity for the forge-std interface we probe with
    // =========================================================================

    function test_HookProbe_UsesStandardSelector() public pure {
        assertEq(IERC165.supportsInterface.selector, bytes4(0x01ffc9a7));
    }
}
