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

    function _kinds(uint256 n) private pure returns (Session[] memory k) {
        k = new Session[](n);
        for (uint256 i; i < n; ++i) {
            k[i] = Session.OPEN;
        }
    }
}
