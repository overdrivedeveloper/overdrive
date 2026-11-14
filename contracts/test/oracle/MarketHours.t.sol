// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ODMarketHours} from "../../src/oracle/ODMarketHours.sol";
import {IODMarketHours, SessionWindow, Holiday} from "../../src/interfaces/IODMarketHours.sol";
import {Session} from "../../src/interfaces/ODTypes.sol";
import {ODRoles} from "../../src/interfaces/ODRoles.sol";

contract MarketHoursTest is Test {
    address private admin = makeAddr("admin");
    address private keeper = makeAddr("keeper");
    address private stranger = makeAddr("stranger");
    ODMarketHours private mh;
    uint256 private t0;

    // Eastern wall-clock instants (Python zoneinfo, America/New_York).
    uint256 private constant TUE_1200 = 1790092800; // Tue 2026-09-22 12:00 EDT
    uint256 private constant FRI_2000 = 1790380800; // Fri 2026-09-25 20:00 EDT
    uint256 private constant SUN_2000 = 1790553600; // Sun 2026-09-27 20:00 EDT
    uint256 private constant WED_BEFORE_TG_2000 = 1795654800; // Wed 2026-11-25 20:00 EST
    uint256 private constant TG_2000 = 1795741200; // Thanksgiving 20:00 EST
    uint256 private constant MON_BEFORE_TG_1000 = 1795446000; // Mon 2026-11-23 10:00 EST
    uint32 private constant DAY_TG_2026 = 20783;
    uint32 private constant DAY_BF_2026 = 20784;
    uint32 private constant DAY_MEMORIAL_2027 = 20969; // Mon 2027-05-31
    uint256 private constant WED_0526_1200 = 1811347200; // Wed 2027-05-26 12:00 EDT
    uint256 private constant FRI_0528_2000 = 1811548800;
    uint256 private constant MON_0531_2000 = 1811808000;

    function setUp() public {
        vm.warp(1_790_000_000);
        t0 = 1_790_000_000;
        mh = new ODMarketHours(admin, keeper);
    }

    function _one(uint256 open, uint256 close) private pure returns (SessionWindow[] memory s, Session[] memory k) {
        s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(open), close: uint64(close)});
        k = new Session[](1);
        k[0] = Session.OPEN;
    }

    function _push(SessionWindow[] memory s, Session[] memory k) private {
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }

    function test_ConstructorRejectsZero() public {
        vm.expectRevert(IODMarketHours.ZeroAddress.selector);
        new ODMarketHours(address(0), keeper);
        vm.expectRevert(IODMarketHours.ZeroAddress.selector);
        new ODMarketHours(admin, address(0));
    }

    function test_KindUsesInclusiveOpenAndExclusiveClose() public {
        (SessionWindow[] memory s, Session[] memory k) = _one(t0 + 10, t0 + 20);
        _push(s, k);
        assertEq(uint256(mh.kindAt(t0 + 9)), uint256(Session.UNKNOWN), "before coverage, no fallback");
        assertEq(uint256(mh.kindAt(t0 + 10)), uint256(Session.OPEN));
        assertEq(uint256(mh.kindAt(t0 + 19)), uint256(Session.OPEN));
        assertEq(uint256(mh.kindAt(t0 + 20)), uint256(Session.UNKNOWN), "after coverage, no fallback");
    }

    function test_GapInsideCoverageIsClosed() public {
        SessionWindow[] memory s = new SessionWindow[](2);
        s[0] = SessionWindow({open: uint64(t0), close: uint64(t0 + 100)});
        s[1] = SessionWindow({open: uint64(t0 + 200), close: uint64(t0 + 300)});
        Session[] memory k = new Session[](2);
        k[0] = Session.OPEN;
        k[1] = Session.EXTENDED;
        _push(s, k);
        assertEq(uint256(mh.kindAt(t0 + 150)), uint256(Session.CLOSED));
        assertEq(uint256(mh.kindAt(t0 + 250)), uint256(Session.EXTENDED));
        assertEq(mh.sessions().length, 2);
    }

    function test_OnlyKeeperCanReplaceSessions() public {
        SessionWindow[] memory s = new SessionWindow[](0);
        Session[] memory k = new Session[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ODRoles.KEEPER_ROLE
            )
        );
        vm.prank(stranger);
        mh.setSessionsWithKinds(s, k);
    }

    function test_RejectsInvalidAndUnsortedSessions() public {
        (SessionWindow[] memory s, Session[] memory k) = _one(t0 + 10, t0 + 10);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.InvalidSession.selector, 0));
        _push(s, k);

        s = new SessionWindow[](2);
        s[0] = SessionWindow({open: uint64(t0 + 30), close: uint64(t0 + 40)});
        s[1] = SessionWindow({open: uint64(t0 + 10), close: uint64(t0 + 20)});
        k = new Session[](2);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionsUnsorted.selector, 1));
        _push(s, k);
    }

    function test_RejectsOverlappingSessions() public {
        SessionWindow[] memory s = new SessionWindow[](2);
        s[0] = SessionWindow({open: uint64(t0 + 10), close: uint64(t0 + 40)});
        s[1] = SessionWindow({open: uint64(t0 + 30), close: uint64(t0 + 50)});
        Session[] memory k = new Session[](2);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionsOverlap.selector, 1));
        _push(s, k);
    }

    function test_SessionsUnderSevenDays() public {
        (SessionWindow[] memory s, Session[] memory k) = _one(t0 + 10, t0 + 10 + 7 days);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionTooLong.selector, 0));
        _push(s, k);
        // A whole 24/5 trading week (Sunday 20:00 to Friday 20:00 ET) is one session.
        (s, k) = _one(SUN_2000 - 7 days, FRI_2000);
        _push(s, k);
        assertEq(uint256(mh.kindAt(TUE_1200)), uint256(Session.OPEN));
    }

    function test_RejectsMoreThanSixtyFourSessions() public {
        SessionWindow[] memory s = new SessionWindow[](65);
        for (uint256 i; i < s.length; ++i) {
            uint64 open = uint64(t0 + 10 + i * 2);
            s[i] = SessionWindow({open: open, close: open + 1});
        }
        Session[] memory k = new Session[](65);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.TooManySessions.selector, 65));
        _push(s, k);
    }

    function test_RejectsSessionsMoreThanThirtyDaysAhead() public {
        (SessionWindow[] memory s, Session[] memory k) = _one(t0 + 31 days, t0 + 31 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IODMarketHours.SessionTooFar.selector, 0));
        _push(s, k);
    }

    function test_FallbackOffByDefault() public view {
        assertFalse(mh.fallbackEnabled());
        assertEq(uint256(mh.kindAt(TUE_1200)), uint256(Session.UNKNOWN));
    }

    // ------------------------------------------------------------------ nextLongClose

    function _enableFallback() private {
        Holiday[] memory h = new Holiday[](3);
        h[0] = Holiday({day: DAY_TG_2026, closeMinute: 0});
        h[1] = Holiday({day: DAY_BF_2026, closeMinute: 780});
        h[2] = Holiday({day: DAY_MEMORIAL_2027, closeMinute: 0});
        vm.startPrank(admin);
        mh.setHolidays(h);
        mh.setFallbackEnabled(true);
        vm.stopPrank();
    }

    function test_NextLongCloseFriday() public {
        _enableFallback();
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(TUE_1200, 24 hours);
        assertEq(closeAt, FRI_2000, "Friday 20:00 ET");
        assertEq(reopenAt, SUN_2000, "Sunday 20:00 ET");
        // Asked from inside the closure: it starts now.
        (closeAt, reopenAt) = mh.nextLongClose(FRI_2000 + 1 hours, 24 hours);
        assertEq(closeAt, FRI_2000 + 1 hours);
        assertEq(reopenAt, SUN_2000);
    }

    function test_NextLongCloseHolidayWeekend() public {
        _enableFallback();
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(WED_0526_1200, 24 hours);
        assertEq(closeAt, FRI_0528_2000, "Friday 20:00 before Memorial Day");
        assertEq(reopenAt, MON_0531_2000, "Monday 20:00 overnight into Tuesday");
        assertEq(reopenAt - closeAt, 72 hours);
    }

    function test_NextLongCloseSkipsShortClosure() public {
        _enableFallback();
        // Thanksgiving: Wed 20:00 to Thu 20:00 is exactly 24 h, shorter than 25 h; the next long one is the weekend.
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(MON_BEFORE_TG_1000, 24 hours);
        assertEq(closeAt, WED_BEFORE_TG_2000);
        assertEq(reopenAt, TG_2000);
        (closeAt, reopenAt) = mh.nextLongClose(MON_BEFORE_TG_1000, 25 hours);
        assertGt(closeAt, TG_2000);
        assertEq(reopenAt - closeAt, 48 hours, "the weekend after the half day");
    }

    function test_NextLongCloseUsesPushedSessions() public {
        _enableFallback();
        // Push one session ending 1 h after now, then 3 days of nothing, then a session.
        SessionWindow[] memory s = new SessionWindow[](2);
        s[0] = SessionWindow({open: uint64(t0), close: uint64(t0 + 1 hours)});
        s[1] = SessionWindow({open: uint64(t0 + 3 days), close: uint64(t0 + 4 days)});
        Session[] memory k = new Session[](2);
        _push(s, k);
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(t0, 24 hours);
        assertEq(closeAt, t0 + 1 hours);
        assertEq(reopenAt, t0 + 3 days);
    }

    function test_NextLongCloseNoneWithoutCalendar() public view {
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(TUE_1200, 24 hours);
        assertEq(closeAt, 0);
        assertEq(reopenAt, 0);
    }

    function testFuzz_NextLongCloseIsClosedThroughout(uint256 ts) public {
        _enableFallback();
        ts = bound(ts, 1_767_225_600, 1_861_920_000 - 60 days);
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(ts, 24 hours);
        assertGt(closeAt, 0, "a weekend always comes within 45 days");
        assertGe(closeAt, ts);
        assertGe(reopenAt - closeAt, 24 hours);
        assertLe(closeAt - ts, 7 days + 1 hours);
        for (uint256 t = closeAt; t < reopenAt; t += 1 hours) {
            assertEq(uint256(mh.kindAt(t)), uint256(Session.CLOSED));
        }
        assertTrue(mh.kindAt(reopenAt) != Session.CLOSED);
    }
}
