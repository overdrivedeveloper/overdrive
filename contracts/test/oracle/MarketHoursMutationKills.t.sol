// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ODMarketHours} from "../../src/oracle/ODMarketHours.sol";
import {IODMarketHours, SessionWindow} from "../../src/interfaces/IODMarketHours.sol";
import {Session} from "../../src/interfaces/ODTypes.sol";

/// Tests added from mutation testing (docs/reviews/mutation-2026-11-15.md): each pins a behaviour that a surviving
/// mutant showed no test checked.
contract MarketHoursMutationKillsTest is Test {
    address private admin = makeAddr("admin");
    address private keeper = makeAddr("keeper");
    ODMarketHours private mh;

    uint256 private constant TUE_1200 = 1790092800; // Tue 2026-09-22 12:00 EDT
    uint256 private constant FRI_2000 = 1790380800; // Fri 2026-09-25 20:00 EDT

    function setUp() public {
        vm.warp(1_790_000_000);
        mh = new ODMarketHours(admin, keeper);
    }

    function _push(SessionWindow[] memory s) private {
        Session[] memory k = new Session[](s.length);
        for (uint256 i; i < s.length; ++i) {
            k[i] = Session.OPEN;
        }
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }

    /// Kills m5835 (_checkCalendar: the next calendar boundary dropped, so only the window's first instant was
    /// checked). A window that opens in session but runs into the weekend close is refused (L-9).
    function test_WindowRunningIntoTheWeekendIsRefused() public {
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(TUE_1200), close: uint64(FRI_2000 + 16 hours)});
        vm.prank(keeper);
        vm.expectPartialRevert(IODMarketHours.SessionCoversClosed.selector);
        mh.setSessionsWithKinds(s, _kinds(1));
        // the same window cut at the Friday close is accepted
        s[0].close = uint64(FRI_2000);
        _push(s);
        assertEq(uint256(mh.kindAt(TUE_1200)), uint256(Session.OPEN));
    }

    /// Kills m4976 (MAX_SESSION_GAP 5 days raised to 5 weeks). Two windows more than 5 days apart are refused;
    /// 5 days apart are accepted.
    function test_GapBetweenWindowsIsAtMostFiveDays() public {
        SessionWindow[] memory s = new SessionWindow[](2);
        s[0] = SessionWindow({open: uint64(TUE_1200), close: uint64(TUE_1200 + 1 hours)});
        s[1] = SessionWindow({open: uint64(TUE_1200 + 7 days), close: uint64(TUE_1200 + 7 days + 1 hours)});
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionGapTooLong.selector, 1));
        mh.setSessionsWithKinds(s, _kinds(2));
        assertEq(mh.MAX_SESSION_GAP(), 5 days);
    }

    /// Kills m5741 (_edgeAfter: inside a later pushed window the next edge read from window 0, `i % 1`, instead of
    /// window i - 1). A span inside the second or third of three pushed windows holds no close; the wrong edge sent
    /// the walk back in time until it failed closed.
    function test_ClosedBetweenInsideLaterPushedWindows() public {
        SessionWindow[] memory s = new SessionWindow[](3);
        for (uint256 i; i < 3; ++i) {
            uint256 o = TUE_1200 + i * 1 days;
            s[i] = SessionWindow({open: uint64(o), close: uint64(o + 3 hours)});
        }
        _push(s);
        for (uint256 i; i < 3; ++i) {
            uint256 from = TUE_1200 + i * 1 days + 30 minutes;
            assertFalse(mh.closedBetween(from, from + 2 hours, 1 hours), "in-session span inside window i");
        }
        // the gap between two windows is a close
        assertTrue(mh.closedBetween(TUE_1200 + 1 hours, TUE_1200 + 1 days + 1 hours, 1 hours), "gap is a close");
    }

    /// Kills m5545 (closedBetween: the early exit looked up time 0, `to == minClosedSeconds`, instead of
    /// `to - minClosedSeconds`). A one-hour span inside a weekend, checked against a close longer than any real one,
    /// whose look-back point is a Tuesday noon in session, is answered false by that one lookup; without it the walk
    /// over 200 days of calendar boundaries passes MAX_SCAN_STEPS and fails closed.
    function test_ShortSpanAgainstVeryLongCloseUsesEarlyExit() public view {
        uint256 from = TUE_1200 + 200 days; // a Saturday noon (EDT), out of session
        uint256 minClosed = 200 days + 1 hours;
        assertFalse(mh.closedBetween(from, from + 1 hours, minClosed), "no close that long");
    }

    function _kinds(uint256 n) private pure returns (Session[] memory k) {
        k = new Session[](n);
        for (uint256 i; i < n; ++i) {
            k[i] = Session.OPEN;
        }
    }
}
