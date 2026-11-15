// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleFixture} from "./OracleFixture.t.sol";
import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {ODMarketHours} from "../../src/oracle/ODMarketHours.sol";
import {SessionWindow, Holiday} from "../../src/interfaces/IODMarketHours.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";

/// A calendar from before I7-2: it answers kindAt and nothing else.
contract OldCalendar {
    function kindAt(uint256) external pure returns (Session) {
        return Session.OPEN;
    }
}

/// I7-2: a feed round printed before a close of 24 hours or more is not a live price in the session that follows,
/// however generous the market's in-session age. The guard reads HALTED until the feed prints again.
contract ReopenRoundTest is OracleFixture {
    uint256 internal printed;

    function setUp() public override {
        super.setUp();
        MarketConfig memory c = _cfg();
        c.maxAgeOpen = 3 days; // SPY on mainnet: 72 hours
        c.maxAgeExtended = 3 days;
        _set(M, c);
        _warp(1 hours);
        feed.push(ANSWER_250);
        guard.poke(M);
        printed = _now();
    }

    /// Calendar: in session until `closeAfter` past the print, out (`kind`) for `closedFor`, then EXTENDED.
    function _schedule(uint256 closeAfter, uint256 closedFor, Session kind) internal {
        cal.addStep(printed + closeAfter, kind);
        cal.addStep(printed + closeAfter + closedFor, Session.EXTENDED);
    }

    function _assertHalted() internal view {
        PriceReading memory r = _r();
        assertEq(uint256(r.session), uint256(Session.HALTED), "HALTED");
        assertFalse(r.fresh);
        assertTrue(r.buysPaused);
        assertEq(r.reason, bytes32("HALTED"));
        assertEq(r.p, 250e18, "the last good price, for display and the queue only");
        assertEq(guard.liquidationBlock(M), bytes32("NOT_LIVE"), "no liquidation on it either");
    }

    function test_WeekendRoundIsNotLiveAtTheReopen() public {
        _schedule(8 hours, 48 hours, Session.CLOSED); // Friday 12:00 print, 20:00 close, Sunday 20:00 reopen
        _warp(8 hours - 1);
        assertTrue(_r().fresh, "live up to the close");
        _warp(1);
        assertEq(uint256(_r().session), uint256(Session.CLOSED));
        assertTrue(_r().fresh, "closed: the last good price, still inside maxAgeClosed");
        _warp(48 hours);
        assertLt(_now() - printed, 3 days, "inside the in-session age");
        _assertHalted();
        _warp(6 hours);
        _assertHalted();

        // the first round of the week: live again
        feed.push(ANSWER_250);
        PriceReading memory r = guard.poke(M);
        assertEq(uint256(r.session), uint256(Session.EXTENDED));
        assertTrue(r.fresh);
        assertFalse(r.buysPaused);
    }

    /// The boundary: a close of 24 hours less one second is an ordinary gap; 24 hours is a long close.
    function test_BoundaryIs24Hours() public {
        uint256 snap = vm.snapshotState();
        _schedule(1 hours, 24 hours - 1, Session.CLOSED);
        _warp(25 hours);
        assertTrue(_r().fresh, "23:59:59 closed: the round is still live");
        vm.revertToState(snap);
        _schedule(1 hours, 24 hours, Session.CLOSED); // a mid-week holiday
        _warp(25 hours);
        _assertHalted();
    }

    /// Two short closes do not add up: only one unbroken stretch counts.
    function test_ShortClosesDoNotAddUp() public {
        cal.addStep(printed + 1 hours, Session.CLOSED);
        cal.addStep(printed + 13 hours, Session.OPEN);
        cal.addStep(printed + 20 hours, Session.CLOSED);
        cal.addStep(printed + 40 hours, Session.OPEN);
        _warp(41 hours);
        assertTrue(_r().fresh, "12 h and 20 h closed: live");
    }

    /// A round printed inside the close, less than 24 hours before the reopen, is news from the closed market: live.
    function test_RoundPrintedLateInTheCloseIsLive() public {
        _schedule(8 hours, 48 hours, Session.CLOSED);
        _warp(8 hours + 38 hours);
        feed.push(ANSWER_250); // 10 hours before the reopen
        _warp(10 hours);
        assertTrue(_r().fresh);
        assertEq(uint256(_r().session), uint256(Session.EXTENDED));
    }

    /// poke latches the halt at the reopen (it starts now, not on Friday) and the next round clears it.
    function test_PokeLatchesAndClears() public {
        _schedule(8 hours, 48 hours, Session.CLOSED);
        _warp(56 hours);
        guard.poke(M);
        assertEq(guard.marketState(M).haltedSince, _now(), "the halt starts at the reopen");
        assertEq(guard.marketState(M).lastGoodP, 250e18, "the last good price is untouched");
        _warp(1 hours);
        feed.push(ANSWER_250);
        guard.poke(M);
        assertEq(guard.marketState(M).haltedSince, 0);
        assertTrue(_r().fresh);
    }

    /// A 24/7 market has no calendar: its rounds are judged on age alone.
    function test_AlwaysOpenIgnoresTheCalendar() public {
        _pythAt(keccak256("pyth ETH"), 3000e8);
        guard.poke(ETH);
        cal.addStep(_now() + 1, Session.CLOSED);
        _warp(25 hours);
        assertEq(uint256(guard.read(ETH).session), uint256(Session.OPEN));
    }

    /// A calendar that cannot answer fails closed, and only for a round old enough to span a long close.
    function test_OldCalendarFailsClosed() public {
        ODOracleGuard g = new ODOracleGuard(admin, guardian, address(new OldCalendar()), address(pyth), address(0));
        MarketConfig memory c = _cfg();
        c.maxAgeOpen = 3 days;
        c.maxAgeExtended = 3 days;
        vm.prank(admin);
        g.setMarket(M, c);
        _warp(24 hours - 1);
        assertTrue(g.read(M).fresh, "under 24 hours old: no calendar call, live");
        _warp(1);
        assertEq(uint256(g.read(M).session), uint256(Session.HALTED), "24 hours old and no answer: not live");
    }
}

/// ODMarketHours.closedBetween on pushed windows and on the built-in calendar.
contract ClosedBetweenTest is Test {
    address private admin = makeAddr("admin");
    address private keeper = makeAddr("keeper");
    ODMarketHours private mh;

    uint256 private constant TUE_1200 = 1790092800; // Tue 2026-09-22 12:00 EDT
    uint256 private constant FRI_2000 = 1790380800; // Fri 2026-09-25 20:00 EDT
    uint256 private constant SUN_2000 = 1790553600; // Sun 2026-09-27 20:00 EDT
    uint256 private constant WED_BEFORE_TG_2000 = 1795654800; // Wed 2026-11-25 20:00 EST
    uint256 private constant TG_2000 = 1795741200; // Thanksgiving 20:00 EST
    uint32 private constant DAY_TG_2026 = 20783;

    function setUp() public {
        vm.warp(TUE_1200 - 3 days);
        mh = new ODMarketHours(admin, keeper);
    }

    function _twoWeeks() private {
        SessionWindow[] memory s = new SessionWindow[](2);
        s[0] = SessionWindow({open: uint64(FRI_2000 - 5 days), close: uint64(FRI_2000)});
        s[1] = SessionWindow({open: uint64(SUN_2000), close: uint64(SUN_2000 + 5 days)});
        Session[] memory k = new Session[](2);
        k[0] = Session.OPEN;
        k[1] = Session.EXTENDED;
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }

    function test_PushedWeekend() public {
        _twoWeeks();
        assertFalse(mh.closedBetween(TUE_1200, FRI_2000, 24 hours), "inside one window");
        assertFalse(mh.closedBetween(TUE_1200, FRI_2000 + 24 hours - 1, 24 hours), "closed for 23:59:59 so far");
        assertTrue(mh.closedBetween(TUE_1200, FRI_2000 + 24 hours, 24 hours), "closed for 24 hours");
        assertTrue(mh.closedBetween(FRI_2000 - 8 hours, SUN_2000 + 30, 24 hours), "Friday round at the reopen");
        assertTrue(mh.closedBetween(FRI_2000 - 8 hours, SUN_2000 + 3 days, 24 hours), "and for the rest of its age");
        assertFalse(mh.closedBetween(SUN_2000 - 10 hours, SUN_2000 + 30, 24 hours), "printed 10 h before the reopen");
        assertFalse(mh.closedBetween(SUN_2000, SUN_2000 + 3 days, 24 hours), "the new week");
        assertFalse(mh.closedBetween(SUN_2000, SUN_2000, 24 hours), "empty range");
        assertFalse(mh.closedBetween(SUN_2000, SUN_2000 - 1, 24 hours), "reversed range");
    }

    /// The keeper replaced the list with this week only (the crank drops past windows). Last week is UNKNOWN to
    /// kindAt with the fallback off, and closedBetween still sees the weekend through the built-in calendar.
    function test_DroppedPastWindows() public {
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(SUN_2000), close: uint64(SUN_2000 + 5 days)});
        Session[] memory k = new Session[](1);
        k[0] = Session.EXTENDED;
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
        assertFalse(mh.fallbackEnabled());
        assertEq(uint256(mh.kindAt(FRI_2000 - 8 hours)), uint256(Session.UNKNOWN));
        assertTrue(mh.closedBetween(FRI_2000 - 8 hours, SUN_2000 + 30, 24 hours), "Friday round at the reopen");
        assertFalse(mh.closedBetween(SUN_2000 + 1 hours, SUN_2000 + 2 days, 24 hours));
    }

    /// Mid-week the pushed list starts at the stretch that contains now. A round printed 30 hours earlier, before
    /// the first pushed window, has no long close behind it: no false halt for a quiet feed.
    function test_MidWeekPushDoesNotLookLikeAClose() public {
        uint256 wed1600 = TUE_1200 + 28 hours;
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(wed1600), close: uint64(wed1600 + 2 days)});
        Session[] memory k = new Session[](1);
        k[0] = Session.EXTENDED;
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
        assertEq(uint256(mh.kindAt(TUE_1200)), uint256(Session.UNKNOWN), "before the pushed range, fallback off");
        assertFalse(mh.closedBetween(TUE_1200 - 2 hours, wed1600 + 10 minutes, 24 hours));
        assertFalse(mh.closedBetween(TUE_1200 - 12 hours, wed1600 + 1 days, 24 hours));
    }

    /// No pushed windows and the fallback off: the built-in calendar still answers closedBetween.
    function test_NoPushedWindows() public view {
        assertFalse(mh.closedBetween(TUE_1200, TUE_1200 + 3 days, 24 hours), "Tuesday to Friday noon");
        assertTrue(mh.closedBetween(FRI_2000 - 8 hours, SUN_2000 + 30, 24 hours), "the weekend");
        assertFalse(mh.closedBetween(FRI_2000 - 8 hours, FRI_2000 + 24 hours - 1, 24 hours));
    }

    /// Past the years the built-in calendar knows and outside any pushed window, time is out of session.
    function test_BeyondTheCalendarFailsClosed() public view {
        uint256 far = TUE_1200 + 3650 days;
        assertTrue(mh.closedBetween(far, far + 24 hours, 24 hours));
        assertFalse(mh.closedBetween(far, far + 24 hours - 1, 24 hours));
    }

    /// The built-in calendar: nightly closes (8 hours) never count, the weekend and a full holiday do. The walk
    /// across three days of four boundaries each stays far inside the guard's 300,000 gas read.
    function test_FallbackCalendar() public {
        Holiday[] memory h = new Holiday[](1);
        h[0] = Holiday({day: DAY_TG_2026, closeMinute: 0});
        vm.startPrank(admin);
        mh.setHolidays(h);
        mh.setFallbackEnabled(true);
        vm.stopPrank();
        assertFalse(mh.closedBetween(TUE_1200, TUE_1200 + 3 days, 24 hours), "Tuesday to Friday noon");
        assertTrue(mh.closedBetween(FRI_2000 - 8 hours, SUN_2000 + 30, 24 hours), "the weekend");
        assertFalse(mh.closedBetween(SUN_2000 + 60, SUN_2000 + 3 days, 24 hours), "after the reopen");
        assertTrue(mh.closedBetween(WED_BEFORE_TG_2000 - 8 hours, TG_2000 + 30, 24 hours), "Thanksgiving");
        uint256 g = gasleft();
        mh.closedBetween(TUE_1200 - 12 hours, TUE_1200 + 60 hours, 24 hours);
        g -= gasleft();
        assertLt(g, 150_000, "gas of a three day walk");
        emit log_named_uint("gas, 3 day walk on the built-in calendar", g);
    }
}
