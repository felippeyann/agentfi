// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {EscrowModule} from "../src/EscrowModule.sol";

// =============================================================================
// Helper contracts
// =============================================================================

contract MockERC20 {
    string public name = "Mock Token";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RejectETH {
    receive() external payable { revert("RejectETH"); }
    fallback() external payable { revert("RejectETH"); }
}

// =============================================================================
// Tests
// =============================================================================

contract EscrowModuleTest is Test {
    EscrowModule public escrow;
    MockERC20 public token;

    address public operator = makeAddr("operator");
    address public requester = makeAddr("requester");
    address public provider = makeAddr("provider");

    bytes32 public constant JOB_ID = keccak256("test-job-1");
    bytes32 public constant JOB_ID_2 = keccak256("test-job-2");

    function setUp() public {
        escrow = new EscrowModule(operator);
        token = new MockERC20();

        vm.deal(requester, 100 ether);
        token.mint(requester, 1000 ether);
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    function test_constructor_setsOperator() public view {
        assertEq(escrow.operator(), operator);
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(EscrowModule.ZeroAddress.selector);
        new EscrowModule(address(0));
    }

    // -------------------------------------------------------------------------
    // Lock — ETH
    // -------------------------------------------------------------------------

    function test_lockEth_success() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        EscrowModule.Escrow memory e = escrow.getEscrow(JOB_ID);
        assertEq(e.requester, requester);
        assertEq(e.provider, provider);
        assertEq(e.token, address(0));
        assertEq(e.amount, 1 ether);
        assertEq(uint8(e.status), uint8(EscrowModule.EscrowStatus.LOCKED));
        assertEq(address(escrow).balance, 1 ether);
    }

    function test_lockEth_refundsExcess() public {
        uint256 balanceBefore = requester.balance;
        vm.prank(requester);
        escrow.lock{value: 2 ether}(JOB_ID, provider, address(0), 1 ether);

        assertEq(address(escrow).balance, 1 ether);
        assertEq(requester.balance, balanceBefore - 1 ether);
    }

    function test_lockEth_revertsInsufficientValue() public {
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(EscrowModule.InsufficientValue.selector, 0.5 ether, 1 ether));
        escrow.lock{value: 0.5 ether}(JOB_ID, provider, address(0), 1 ether);
    }

    function test_lockEth_revertsDuplicateJobId() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(EscrowModule.EscrowAlreadyExists.selector, JOB_ID));
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);
    }

    function test_lock_revertsZeroProvider() public {
        vm.prank(requester);
        vm.expectRevert(EscrowModule.ZeroAddress.selector);
        escrow.lock{value: 1 ether}(JOB_ID, address(0), address(0), 1 ether);
    }

    function test_lock_revertsZeroAmount() public {
        vm.prank(requester);
        vm.expectRevert(EscrowModule.ZeroAmount.selector);
        escrow.lock(JOB_ID, provider, address(0), 0);
    }

    // -------------------------------------------------------------------------
    // Lock — ERC-20
    // -------------------------------------------------------------------------

    function test_lockToken_success() public {
        vm.startPrank(requester);
        token.approve(address(escrow), 100 ether);
        escrow.lock(JOB_ID, provider, address(token), 100 ether);
        vm.stopPrank();

        EscrowModule.Escrow memory e = escrow.getEscrow(JOB_ID);
        assertEq(e.token, address(token));
        assertEq(e.amount, 100 ether);
        assertEq(token.balanceOf(address(escrow)), 100 ether);
    }

    // -------------------------------------------------------------------------
    // Release
    // -------------------------------------------------------------------------

    function test_release_eth() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        uint256 providerBefore = provider.balance;

        vm.prank(operator);
        escrow.release(JOB_ID);

        assertEq(provider.balance, providerBefore + 1 ether);
        assertEq(uint8(escrow.getEscrowStatus(JOB_ID)), uint8(EscrowModule.EscrowStatus.RELEASED));
    }

    function test_release_token() public {
        vm.startPrank(requester);
        token.approve(address(escrow), 100 ether);
        escrow.lock(JOB_ID, provider, address(token), 100 ether);
        vm.stopPrank();

        vm.prank(operator);
        escrow.release(JOB_ID);

        assertEq(token.balanceOf(provider), 100 ether);
        assertEq(uint8(escrow.getEscrowStatus(JOB_ID)), uint8(EscrowModule.EscrowStatus.RELEASED));
    }

    function test_release_revertsUnauthorized() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        vm.prank(requester);
        vm.expectRevert(EscrowModule.Unauthorized.selector);
        escrow.release(JOB_ID);
    }

    function test_release_revertsNotFound() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(EscrowModule.EscrowNotFound.selector, JOB_ID));
        escrow.release(JOB_ID);
    }

    function test_release_revertsAlreadyReleased() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        vm.prank(operator);
        escrow.release(JOB_ID);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(EscrowModule.EscrowNotLocked.selector, JOB_ID));
        escrow.release(JOB_ID);
    }

    // -------------------------------------------------------------------------
    // Refund
    // -------------------------------------------------------------------------

    function test_refund_eth() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        uint256 requesterBefore = requester.balance;

        vm.prank(operator);
        escrow.refund(JOB_ID);

        assertEq(requester.balance, requesterBefore + 1 ether);
        assertEq(uint8(escrow.getEscrowStatus(JOB_ID)), uint8(EscrowModule.EscrowStatus.REFUNDED));
    }

    function test_refund_token() public {
        vm.startPrank(requester);
        token.approve(address(escrow), 100 ether);
        escrow.lock(JOB_ID, provider, address(token), 100 ether);
        vm.stopPrank();

        vm.prank(operator);
        escrow.refund(JOB_ID);

        assertEq(token.balanceOf(requester), 1000 ether); // full balance restored
        assertEq(uint8(escrow.getEscrowStatus(JOB_ID)), uint8(EscrowModule.EscrowStatus.REFUNDED));
    }

    function test_refund_revertsUnauthorized() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        vm.prank(provider);
        vm.expectRevert(EscrowModule.Unauthorized.selector);
        escrow.refund(JOB_ID);
    }

    function test_refund_revertsAfterRelease() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        vm.prank(operator);
        escrow.release(JOB_ID);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(EscrowModule.EscrowNotLocked.selector, JOB_ID));
        escrow.refund(JOB_ID);
    }

    // -------------------------------------------------------------------------
    // Multiple escrows
    // -------------------------------------------------------------------------

    function test_multipleEscrows_independent() public {
        vm.prank(requester);
        escrow.lock{value: 1 ether}(JOB_ID, provider, address(0), 1 ether);

        vm.startPrank(requester);
        token.approve(address(escrow), 50 ether);
        escrow.lock(JOB_ID_2, provider, address(token), 50 ether);
        vm.stopPrank();

        // Release first, refund second
        vm.prank(operator);
        escrow.release(JOB_ID);

        vm.prank(operator);
        escrow.refund(JOB_ID_2);

        assertEq(uint8(escrow.getEscrowStatus(JOB_ID)), uint8(EscrowModule.EscrowStatus.RELEASED));
        assertEq(uint8(escrow.getEscrowStatus(JOB_ID_2)), uint8(EscrowModule.EscrowStatus.REFUNDED));
    }

    // -------------------------------------------------------------------------
    // Fuzz tests
    // -------------------------------------------------------------------------

    function testFuzz_lockAndRelease_eth(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 50 ether);
        bytes32 fuzzJobId = keccak256(abi.encodePacked("fuzz", amount));

        vm.prank(requester);
        escrow.lock{value: amount}(fuzzJobId, provider, address(0), amount);

        uint256 providerBefore = provider.balance;

        vm.prank(operator);
        escrow.release(fuzzJobId);

        assertEq(provider.balance, providerBefore + amount);
    }

    function testFuzz_lockAndRefund_eth(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 50 ether);
        bytes32 fuzzJobId = keccak256(abi.encodePacked("fuzz-refund", amount));

        vm.prank(requester);
        escrow.lock{value: amount}(fuzzJobId, provider, address(0), amount);

        uint256 requesterBefore = requester.balance;

        vm.prank(operator);
        escrow.refund(fuzzJobId);

        assertEq(requester.balance, requesterBefore + amount);
    }

    function testFuzz_lockAndRelease_token(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 500 ether);
        bytes32 fuzzJobId = keccak256(abi.encodePacked("fuzz-token", amount));

        vm.startPrank(requester);
        token.approve(address(escrow), amount);
        escrow.lock(fuzzJobId, provider, address(token), amount);
        vm.stopPrank();

        vm.prank(operator);
        escrow.release(fuzzJobId);

        assertEq(token.balanceOf(provider), amount);
    }
}
