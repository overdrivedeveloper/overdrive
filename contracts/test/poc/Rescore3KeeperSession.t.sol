// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";
import {ODMarketHours} from "overdrive/oracle/ODMarketHours.sol";
import {IODMarketHours, SessionWindow, Holiday} from "overdrive/interfaces/IODMarketHours.sol";

/// Regression for L-9 (rescore 3, 2026-11-14). A pushed window wins over the built-in calendar, and on the old code
/// the keeper key alone could push an OPEN window over a Saturday (measured: +907 USDG per 10,000 on SPORT for a 5%
/// weekend move bought at Friday's price). setSessionsWithKinds now rejects any window covering calendar-CLOSED time.
contract Rescore3KeeperSessionTest is Test {
    uint256 internal constant SATURDAY = 1794666000; // 2026-11-14 14:20 UTC, a Saturday
    uint256 internal constant FRI_CLOSE = 1794618000; // 2026-11-13 20:00 EST: the weekend starts
    uint256 internal constant SUN_OPEN = 1794790800; // 2026-11-15 20:00 EST: the trading week starts
    address internal admin = address(0xA11CE);
    address internal keeper = address(0xBEEF);
    ODMarketHours internal mh;

    function setUp() public {
        vm.warp(SATURDAY);
        mh = new ODMarketHours(admin, keeper);
        vm.prank(admin);
        mh.setFallbackEnabled(true);
    }

    function _push(uint256 open, uint256 close) internal {
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(open), close: uint64(close)});
        Session[] memory k = new Session[](1);
        k[0] = Session.OPEN;
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }

    /// Control: the contract's own calendar calls the Saturday CLOSED.
    function test_Control_CalendarSaysSaturdayClosed() public view {
        assertEq(uint256(mh.kindAt(SATURDAY)), uint256(Session.CLOSED), "calendar: Saturday is closed");
    }

    /// The PoC, flipped: the keeper's OPEN window over the Saturday is refused and the calendar still answers CLOSED.
    function test_L9_KeeperWindowOverWeekendRefused() public {
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(SATURDAY - 1 hours), close: uint64(SATURDAY + 6 days)});
        Session[] memory k = new Session[](1);
        k[0] = Session.OPEN;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionCoversClosed.selector, 0, SATURDAY - 1 hours));
        mh.setSessionsWithKinds(s, k);
        assertEq(uint256(mh.kindAt(SATURDAY)), uint256(Session.CLOSED), "the calendar still answers");
    }

    /// The honest weekly push (Sunday 20:00 to Friday 20:00 Eastern) is accepted; one second either side is not.
    function test_L9_TradingWeekAcceptedEdgesRefused() public {
        _push(SUN_OPEN, SUN_OPEN + 5 days);
        assertEq(uint256(mh.kindAt(SUN_OPEN)), uint256(Session.OPEN));
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionCoversClosed.selector, 0, SUN_OPEN - 1));
        this.pushExternal(SUN_OPEN - 1, SUN_OPEN + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionCoversClosed.selector, 0, SUN_OPEN + 5 days));
        this.pushExternal(SUN_OPEN, SUN_OPEN + 5 days + 1);
        // the Friday session that ends at the weekend's start is fine
        vm.warp(FRI_CLOSE - 1 days);
        _push(FRI_CLOSE - 10 hours, FRI_CLOSE);
    }

    /// A listed full holiday (and the evening before it) is closed too.
    function test_L9_HolidayRefused() public {
        Holiday[] memory h = new Holiday[](1);
        h[0] = Holiday({day: uint32((SUN_OPEN - 5 hours) / 1 days + 4), closeMinute: 0}); // Thursday 2026-11-19
        vm.prank(admin);
        mh.setHolidays(h);
        vm.expectRevert();
        this.pushExternal(SUN_OPEN, SUN_OPEN + 5 days);
        _push(SUN_OPEN, SUN_OPEN + 3 days); // Sunday 20:00 to Wednesday 20:00 is still a trading stretch
    }

    /// The general property: whatever window the keeper gets accepted, the calendar calls no instant in it CLOSED.
    function testFuzz_L9_AcceptedWindowHasNoClosedTime(uint256 open, uint256 len, uint256 probe) public {
        open = bound(open, SATURDAY - 20 days, SATURDAY + 20 days);
        len = bound(len, 1, 7 days - 1);
        uint256 close = open + len;
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(open), close: uint64(close)});
        Session[] memory k = new Session[](1);
        k[0] = Session.EXTENDED;
        vm.prank(keeper);
        try mh.setSessionsWithKinds(s, k) {
            // a fresh contract with no pushed windows answers with the calendar alone
            ODMarketHours ref = new ODMarketHours(admin, keeper);
            vm.prank(admin);
            ref.setFallbackEnabled(true);
            uint256 t = open + probe % len;
            assertTrue(ref.kindAt(t) != Session.CLOSED, "an accepted window covers calendar-closed time");
            assertTrue(ref.kindAt(open) != Session.CLOSED);
            assertTrue(ref.kindAt(close - 1) != Session.CLOSED);
        } catch {}
    }

    function pushExternal(uint256 open, uint256 close) external {
        _push(open, close);
    }
}
