// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {ODMarketHours} from "overdrive/oracle/ODMarketHours.sol";
import {IODMarketHours, SessionWindow} from "overdrive/interfaces/IODMarketHours.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";

/// Rescore 5, finding I4-5 (Low), regression. Before the fix the keeper key could move all free cash into the exit
/// reserve in one call (bounded only by free cash) and nothing could move it back; and it could push two windows up
/// to 30 days apart, so every stock read CLOSED for the whole horizon. Now the keeper is held to
/// Params.maxReserveMoveBps of free cash per 24 h window, the admin (timelock) can move the reserve back, and two
/// pushed windows are at most MAX_SESSION_GAP apart.
contract Rescore5ReserveMoveTest is BackerFixture {
    address internal keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        gov.grantRole(ODRoles.KEEPER_ROLE, keeper);
    }

    function test_I4_5_KeeperCannotMoveAllFreeCash() public {
        uint256 cash = gov.freeCash();
        assertEq(gov.getParams().maxReserveMoveBps, 1000, "default: 10% per 24 h");
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.ReserveMoveCap.selector, cash, cash / 10));
        gov.moveToExitReserve(cash);
        gov.moveToExitReserve(cash / 10); // the whole allowance, in one call
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.ReserveMoveCap.selector, 1, 0));
        gov.moveToExitReserve(1); // and no more in this window, however it is split
        vm.warp(vm.getBlockTimestamp() + 1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.ReserveMoveCap.selector, 1, 0));
        gov.moveToExitReserve(1);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 left = gov.freeCash();
        gov.moveToExitReserve(left / 10); // a new window: 10% of what is free now
        vm.stopPrank();
        assertEq(gov.freeCash(), left - left / 10);
        assertGe(gov.freeCash() * 100, cash * 80, "two windows moved under 20% of free cash");
    }

    function test_I4_5_AdminMovesTheReserveBack() public {
        uint256 cash = gov.freeCash();
        uint256 reserve = gov.exitReserve();
        vm.prank(admin);
        gov.moveToExitReserve(cash); // the admin (timelock) is not metered
        assertEq(gov.freeCash(), 0);
        vm.prank(keeper);
        vm.expectRevert();
        gov.moveFromExitReserve(1); // not the keeper
        vm.prank(guardian);
        vm.expectRevert();
        gov.moveFromExitReserve(1); // not the guardian
        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IODGovernor.InsufficientCash.selector, reserve + cash + 1, reserve + cash)
        );
        gov.moveFromExitReserve(reserve + cash + 1);
        vm.expectEmit(address(gov));
        emit IODGovernor.ExitReserveReleased(cash, reserve);
        gov.moveFromExitReserve(cash);
        vm.stopPrank();
        assertEq(gov.freeCash(), cash);
        assertEq(gov.exitReserve(), reserve);
    }

    function test_I4_5_MoveShareIsAdminBounded() public {
        IODGovernor.Params memory p = gov.getParams();
        p.maxReserveMoveBps = 5001;
        vm.prank(admin);
        vm.expectRevert(IODGovernor.InvalidParams.selector);
        gov.setParams(p);
        p.maxReserveMoveBps = 0; // zero: the keeper moves nothing
        vm.prank(keeper);
        vm.expectRevert();
        gov.setParams(p);
        vm.prank(admin);
        gov.setParams(p);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.ReserveMoveCap.selector, 1, 0));
        gov.moveToExitReserve(1);
    }

    /// Two pushed windows are at most MAX_SESSION_GAP (5 days) apart: the keeper cannot write a CLOSED horizon.
    function test_I4_5_PushedWindowsCannotLeaveALongClosedGap() public {
        vm.warp(1811347200); // Wed 2027-05-26 12:00 EDT; five days on is Monday noon, both inside a regular session
        ODMarketHours mh = new ODMarketHours(admin, keeper);
        uint64 t = uint64(vm.getBlockTimestamp());
        SessionWindow[] memory s = new SessionWindow[](2);
        Session[] memory k = new Session[](2);
        s[0] = SessionWindow({open: t, close: t + 60});
        s[1] = SessionWindow({open: t + 60 + 5 days + 1, close: t + 120 + 5 days + 1});
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionGapTooLong.selector, 1));
        mh.setSessionsWithKinds(s, k);
        s[1] = SessionWindow({open: t + 60 + 5 days, close: t + 120 + 5 days});
        mh.setSessionsWithKinds(s, k);
        vm.stopPrank();
        assertEq(mh.sessions().length, 2);
    }
}
