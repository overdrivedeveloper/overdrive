// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {IODFees} from "overdrive/interfaces/IODFees.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockOvrd, MockFeesGovernor} from "../mocks/MockOvrd.sol";

contract FeesTest is ODTest {
    MockUSDG internal usdg;
    MockOvrd internal ovrd;
    MockFeesGovernor internal gov;
    ODFees internal fees;
    ODStake internal stk;

    address internal admin = makeAddr("timelock");
    address internal minter = makeAddr("minter");
    address internal backer = makeAddr("backer");
    address internal keepers = makeAddr("keepersPot");
    address internal hedgers = makeAddr("hedgersPot");
    address internal treasury = makeAddr("treasury");
    address internal burner = makeAddr("buyBurn");
    address internal alice = makeAddr("alice");

    bytes32 internal constant GEAR = keccak256("AAPL-SPORT");

    function setUp() public {
        usdg = new MockUSDG();
        ovrd = new MockOvrd();
        gov = new MockFeesGovernor(IERC20(address(usdg)));
        fees = new ODFees(IERC20(address(usdg)), admin, address(gov));
        stk = new ODStake(IERC20(address(ovrd)), IERC20(address(usdg)), admin, address(gov), backer);
        vm.startPrank(admin);
        fees.setNotifier(minter, true);
        fees.setNotifier(address(gov), true);
        fees.setNotifier(backer, true);
        fees.setRecipient(fees.B_KEEPERS(), keepers);
        fees.setRecipient(fees.B_HEDGERS(), hedgers);
        fees.setRecipient(fees.B_TREASURY(), treasury);
        fees.setRecipient(fees.B_STAKERS(), address(stk));
        fees.setRecipient(fees.B_BURN(), burner);
        stk.grantRole(stk.FEES_ROLE(), address(fees));
        vm.stopPrank();
        // someone staked so the stakers share streams to an active stake
        ovrd.mint(alice, 1_000e18);
        vm.startPrank(alice);
        ovrd.approve(address(stk), type(uint256).max);
        stk.stake(1_000e18);
        vm.stopPrank();
    }

    function _feed(address from, bytes32 kind, uint256 amount) internal {
        usdg.mint(from, amount);
        vm.prank(from);
        usdg.transfer(address(fees), amount);
        vm.prank(from);
        fees.notify(kind, GEAR, amount);
    }

    // ---- R1

    function test_NotifyOnlyAllowed() public {
        usdg.mint(address(fees), 100e6);
        vm.prank(alice);
        vm.expectRevert(ODFees.NotNotifier.selector);
        fees.notify("SPREAD", GEAR, 100e6);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(ODFees.UnknownKind.selector, bytes32("OTHER")));
        fees.notify("OTHER", GEAR, 100e6);
        vm.prank(admin);
        fees.setNotifier(minter, false);
        vm.prank(minter);
        vm.expectRevert(ODFees.NotNotifier.selector);
        fees.notify("SPREAD", GEAR, 100e6);
        vm.prank(backer);
        vm.expectEmit(address(fees));
        emit IODFees.Notified("BACKER_TOLL", GEAR, 100e6);
        fees.notify("BACKER_TOLL", GEAR, 100e6);
        assertEq(fees.distributable(), 100e6);
    }

    function test_NotifyChecksArrival() public {
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(ODFees.NotArrived.selector, 0, 50e6));
        fees.notify("SPREAD", GEAR, 50e6);
        _feed(minter, "SPREAD", 50e6);
        // the same 50 cannot be announced twice
        vm.prank(address(gov));
        vm.expectRevert(abi.encodeWithSelector(ODFees.NotArrived.selector, 50e6, 100e6));
        fees.notify("TOLL", GEAR, 50e6);
    }

    function test_DonationNotCounted() public {
        usdg.mint(address(fees), 1_000e6); // donation
        assertEq(fees.distributable(), 0);
        _feed(minter, "SPREAD", 100e6);
        assertEq(fees.distributable(), 100e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(fees.distribute(), 100e6);
        assertEq(usdg.balanceOf(treasury), 10e6);
    }

    // ---- R2

    function test_SplitDefault() public {
        _feed(minter, "SPREAD", 6_000e6);
        _feed(address(gov), "TOLL", 3_000e6);
        _feed(backer, "BACKER_TOLL", 1_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 amount = fees.distribute();
        assertEq(amount, 10_000e6);
        assertEq(gov.cash(), 3_200e6, "governor 40% of 80%");
        assertEq(gov.exitReserve(), 2_400e6, "exit reserve 30% of 80%");
        assertEq(usdg.balanceOf(keepers), 1_200e6);
        assertEq(usdg.balanceOf(hedgers), 1_200e6);
        assertEq(usdg.balanceOf(treasury), 1_000e6);
        assertEq(usdg.balanceOf(address(stk)), 500e6, "stakers through notifyRewards");
        assertEq(usdg.balanceOf(burner), 500e6);
        assertEq(usdg.balanceOf(address(fees)), 0);
        assertEq(stk.periodFinish(), vm.getBlockTimestamp() + 7 days);
    }

    function test_OpsSplit() public {
        vm.prank(admin);
        fees.setOpsSplit(1_000, 5_000, 2_000, 2_000);
        _feed(minter, "SPREAD", 10_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        fees.distribute();
        assertEq(gov.cash(), 800e6);
        assertEq(gov.exitReserve(), 4_000e6);
        assertEq(usdg.balanceOf(keepers), 1_600e6);
        assertEq(usdg.balanceOf(hedgers), 1_600e6);
    }

    function test_HeldUntilRecipientSet() public {
        bytes32 b = fees.B_BURN();
        vm.prank(admin);
        fees.setRecipient(b, address(0));
        _feed(minter, "SPREAD", 10_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        fees.distribute();
        assertEq(fees.held(b), 500e6);
        assertEq(fees.distributable(), 0);
        // a new notify still sees the held amount as accounted
        usdg.mint(address(fees), 10e6);
        vm.prank(minter);
        fees.notify("SPREAD", GEAR, 10e6);
        assertEq(fees.distributable(), 10e6);
        vm.prank(admin);
        fees.setRecipient(b, burner);
        assertEq(fees.release(b), 500e6);
        assertEq(usdg.balanceOf(burner), 500e6);
        assertEq(fees.held(b), 0);
        assertEq(fees.totalHeld(), 0);
    }

    function testFuzz_DistributeConserves(uint96 a, uint96 b, uint16 ops, uint16 tr, uint16 st, bool holdKeepers)
        public
    {
        ops = uint16(bound(ops, 0, 10_000));
        tr = uint16(bound(tr, 0, 10_000 - ops));
        st = uint16(bound(st, 0, 10_000 - ops - tr));
        vm.startPrank(admin);
        fees.setSplit(ops, tr, st, 10_000 - ops - tr - st);
        if (holdKeepers) fees.setRecipient(fees.B_KEEPERS(), address(0));
        vm.stopPrank();
        uint256 x = bound(a, 0, 1e15);
        uint256 y = bound(b, 0, 1e15);
        if (x != 0) _feed(minter, "SPREAD", x);
        if (y != 0) _feed(backer, "BACKER_TOLL", y);
        uint256 before = usdg.balanceOf(address(fees));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 amount = fees.distribute();
        assertEq(amount, x + y);
        uint256 paid = before - usdg.balanceOf(address(fees));
        assertEq(paid + fees.totalHeld() + fees.distributable(), amount, "paid + held + dust == amount");
        assertLe(fees.distributable(), 7, "dust is rounding only");
    }

    function test_TooEarly() public {
        uint256 next = fees.nextDistributionAt();
        vm.expectRevert(abi.encodeWithSelector(IODFees.TooEarly.selector, next));
        fees.distribute();
        vm.warp(next);
        fees.distribute();
        vm.expectRevert(abi.encodeWithSelector(IODFees.TooEarly.selector, next + 7 days));
        fees.distribute();
    }

    // ---- R3

    function test_SplitMustSum() public {
        vm.startPrank(admin);
        vm.expectRevert(IODFees.InvalidParams.selector);
        fees.setSplit(8_000, 1_000, 500, 501);
        vm.expectRevert(IODFees.InvalidParams.selector);
        fees.setOpsSplit(4_000, 3_000, 1_500, 1_499);
        vm.expectRevert(IODFees.InvalidParams.selector);
        fees.setFeeParams(3_001, 1_000);
        vm.expectRevert(IODFees.InvalidParams.selector);
        fees.setFeeParams(1_000, 3_001);
        vm.expectRevert(IODFees.InvalidParams.selector);
        fees.setRecipient("NOPE", alice);
        fees.setFeeParams(3_000, 3_000);
        vm.stopPrank();
        assertEq(fees.protocolSpreadShareBps(), 3_000);
        assertEq(fees.tollFeeBps(), 3_000);
    }

    function test_OnlyAdmin() public {
        bytes memory err = abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, alice, fees.DEFAULT_ADMIN_ROLE()
        );
        vm.startPrank(alice);
        vm.expectRevert(err);
        fees.setSplit(8_000, 1_000, 500, 500);
        vm.expectRevert(err);
        fees.setOpsSplit(4_000, 3_000, 1_500, 1_500);
        vm.expectRevert(err);
        fees.setRecipient("TREASURY", alice);
        vm.expectRevert(err);
        fees.setFeeParams(1_000, 1_000);
        vm.expectRevert(err);
        fees.setNotifier(alice, true);
        vm.stopPrank();
    }

    // ---- R4

    function test_RevertingRecipientHeld() public {
        gov.setMode(1); // Governor reverts on both entries
        usdg.setBlocked(keepers, true); // USDG refuses transfers to the keepers pot
        _feed(minter, "SPREAD", 10_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        fees.distribute();
        assertEq(fees.held(fees.B_GOVERNOR()), 3_200e6);
        assertEq(fees.held(fees.B_EXIT_RESERVE()), 2_400e6);
        assertEq(fees.held(fees.B_KEEPERS()), 1_200e6);
        assertEq(usdg.balanceOf(hedgers), 1_200e6);
        assertEq(usdg.balanceOf(treasury), 1_000e6);
        assertEq(usdg.balanceOf(burner), 500e6);
        // recovered recipients are paid on the next distribution
        gov.setMode(0);
        usdg.setBlocked(keepers, false);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        fees.distribute();
        assertEq(gov.cash(), 3_200e6);
        assertEq(gov.exitReserve(), 2_400e6);
        assertEq(usdg.balanceOf(keepers), 1_200e6);
        assertEq(fees.totalHeld(), 0);
    }

    function test_GovernorEoaHeld() public {
        bytes32 g = fees.B_GOVERNOR();
        vm.prank(admin);
        fees.setRecipient(g, alice); // no code: nothing is pulled, so the share is held
        _feed(minter, "SPREAD", 10_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        fees.distribute();
        assertEq(fees.held(fees.B_GOVERNOR()), 3_200e6);
        assertEq(usdg.balanceOf(alice), 0);
    }
}
