// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OracleFixture} from "./OracleFixture.t.sol";
import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {ODMarketHours} from "../../src/oracle/ODMarketHours.sol";
import {SessionWindow, Holiday} from "../../src/interfaces/IODMarketHours.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";

/// Fix round 11 (R8-1, R8-2, I8-1) on the real ODMarketHours and the real ODOracleGuard, with the holiday list the
/// deploy writes (script/config/mainnet.json).
/// R8-1: the list is on chain from the deploy, so a holiday is a close even after the keeper dropped its windows.
/// R8-2: the calendar walk costs the same with 0 or 64 listed holidays (binary search), far inside the guard's cap.
/// I8-1: a round printed inside a long close (seconds after the 20:00 boundary) is not live at the reopen.
contract HolidayReopenTest is OracleFixture {
    address internal keeper = makeAddr("keeper");
    ODMarketHours internal mh;
    ODOracleGuard internal g2;

    uint256 internal constant SUN_2000 = 1_794_790_800; // Sun 2026-11-15 20:00 EST (the week opens)
    uint256 internal constant TUE_1200 = 1_794_934_800; // Tue 2026-11-17 12:00 EST
    uint256 internal constant FRI_2000 = 1_795_222_800; // Fri 2026-11-20 20:00 EST (the week closes)
    uint256 internal constant WED_2000 = 1_795_654_800; // Wed 2026-11-25 20:00 EST (holiday eve close)
    uint256 internal constant TG_2000 = 1_795_741_200; // Thu 2026-11-26 (Thanksgiving) 20:00 EST (reopen)
    uint256 internal constant GF_CLOSE = 1_775_174_400; // Thu 2026-04-02 20:00 EDT (Good Friday eve close)
    uint256 internal constant GF_REOPEN = 1_775_433_600; // Sun 2026-04-05 20:00 EDT
    uint256 internal constant Y2029 = 1_867_492_800; // 2029-03-06 12:00 UTC, past the built-in calendar
    uint256 internal constant GUARD_GAS = 300_000;

    function setUp() public override {
        super.setUp();
        mh = new ODMarketHours(admin, keeper);
        g2 = new ODOracleGuard(admin, guardian, address(mh), address(pyth), address(0));
        vm.prank(admin);
        mh.setHolidays(_configHolidays("mainnet"));
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _configHolidays(string memory network) internal view returns (Holiday[] memory hs) {
        string memory j = vm.readFile(string.concat("script/config/", network, ".json"));
        uint256 n;
        while (vm.keyExistsJson(j, string.concat(".holidays[", vm.toString(n), "]"))) ++n;
        hs = new Holiday[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".holidays[", vm.toString(i), "]");
            hs[i] = Holiday({
                day: uint32(vm.parseJsonUint(j, string.concat(k, ".day"))),
                closeMinute: uint16(vm.parseJsonUint(j, string.concat(k, ".closeMinute")))
            });
        }
    }

    /// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm), independent of the config's `day`.
    function _day(uint256 y, uint256 m, uint256 d) internal pure returns (uint32) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return uint32(era * 146_097 + doe - 719_468);
    }

    function _market(uint32 maxAge) internal {
        MarketConfig memory c = _cfg();
        c.maxAgeOpen = maxAge;
        c.maxAgeExtended = maxAge;
        vm.prank(admin);
        g2.setMarket(M, c);
    }

    function _push(uint256 open, uint256 close) internal {
        SessionWindow[] memory s = new SessionWindow[](1);
        s[0] = SessionWindow({open: uint64(open), close: uint64(close)});
        Session[] memory k = new Session[](1);
        k[0] = Session.EXTENDED;
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }

    function _fallback() internal {
        vm.prank(admin);
        mh.setFallbackEnabled(true);
    }

    function _roundAt(uint256 ts) internal {
        vm.warp(ts);
        feed.push(ANSWER_250);
    }

    function _assertHalted(string memory what) internal view {
        PriceReading memory r = g2.read(M);
        assertEq(uint256(r.session), uint256(Session.HALTED), what);
        assertFalse(r.fresh, what);
        assertTrue(r.buysPaused, what);
        assertEq(g2.liquidationBlock(M), bytes32("NOT_LIVE"), what);
    }

    function _assertLive(string memory what) internal view {
        PriceReading memory r = g2.read(M);
        assertTrue(r.fresh, what);
        assertTrue(r.session == Session.OPEN || r.session == Session.EXTENDED, what);
    }

    // ------------------------------------------------------------------------------------------------ the list

    /// The deploy config lists every NYSE full close and 13:00 early close of 2026 and 2027, on the right day.
    function test_MainnetConfigListsNyse2026And2027() public view {
        uint16[4][23] memory want = [
            [uint16(2026), 1, 1, 0],
            [uint16(2026), 1, 19, 0],
            [uint16(2026), 2, 16, 0],
            [uint16(2026), 4, 3, 0],
            [uint16(2026), 5, 25, 0],
            [uint16(2026), 6, 19, 0],
            [uint16(2026), 7, 3, 0],
            [uint16(2026), 9, 7, 0],
            [uint16(2026), 11, 26, 0],
            [uint16(2026), 11, 27, 780],
            [uint16(2026), 12, 24, 780],
            [uint16(2026), 12, 25, 0],
            [uint16(2027), 1, 1, 0],
            [uint16(2027), 1, 18, 0],
            [uint16(2027), 2, 15, 0],
            [uint16(2027), 3, 26, 0],
            [uint16(2027), 5, 31, 0],
            [uint16(2027), 6, 18, 0],
            [uint16(2027), 7, 5, 0],
            [uint16(2027), 9, 6, 0],
            [uint16(2027), 11, 25, 0],
            [uint16(2027), 11, 26, 780],
            [uint16(2027), 12, 24, 0]
        ];
        Holiday[] memory h = mh.holidays();
        assertLe(h.length, 64);
        assertEq(_day(2026, 11, 26), 20_783, "the day arithmetic of this test");
        for (uint256 i; i < want.length; ++i) {
            assertEq(h[i].day, _day(want[i][0], want[i][1], want[i][2]), "day");
            assertEq(h[i].closeMinute, want[i][3], "close minute");
            uint256 dow = (uint256(h[i].day) + 4) % 7;
            assertTrue(dow != 0 && dow != 6, "a weekday");
        }
        assertGt(h[h.length - 1].day, _day(2027, 12, 24) - 1, "reaches the end of 2027");
        // every network's config carries the same list (the fork and anvil deploys test what mainnet runs)
        bytes32 hash = keccak256(abi.encode(h));
        assertEq(keccak256(abi.encode(_configHolidays("fork"))), hash);
        assertEq(keccak256(abi.encode(_configHolidays("anvil"))), hash);
        assertEq(keccak256(abi.encode(_configHolidays("testnet"))), hash);
    }

    // ------------------------------------------------------------------------------------------------ R8-1

    /// The rescore 8 steps with the list the deploy writes: Wednesday 19:00 round, the keeper drops the past
    /// windows during the holiday, and at the Thanksgiving reopen the round is HALTED until the feed prints.
    function test_R8_1_PreHolidayRoundIsHaltedAtTheReopen_KeeperDroppedThePast() public {
        _market(26 hours);
        vm.warp(WED_2000 - 1 hours);
        _push(WED_2000 - 4 hours, WED_2000);
        feed.push(ANSWER_250);
        assertTrue(g2.poke(M).fresh, "live on Wednesday evening");
        vm.warp(TG_2000);
        _push(TG_2000, TG_2000 + 13 hours); // only windows with close > now
        vm.warp(TG_2000 + 30);
        assertTrue(mh.closedBetween(WED_2000 - 1 hours, TG_2000 + 30, 24 hours), "the holiday is a close");
        _assertHalted("Wednesday's round at the Thanksgiving reopen");
        vm.warp(TG_2000 + 10 hours);
        _assertHalted("and while the keeper's window lasts");
        feed.push(ANSWER_250);
        _assertLive("the first round after the reopen");
    }

    /// The same steps on the built-in calendar alone (no pushed windows, fallback on).
    function test_R8_1_FallbackCalendarAlone() public {
        _market(72 hours);
        _fallback();
        _roundAt(WED_2000 - 1 hours);
        assertTrue(g2.poke(M).fresh);
        vm.warp(TG_2000 + 30);
        _assertHalted("Thanksgiving reopen");
    }

    // ------------------------------------------------------------------------------------------------ R8-2

    function _fill(uint256 n) internal {
        Holiday[] memory h = new Holiday[](n);
        for (uint256 i; i < n; ++i) {
            h[i] = Holiday({day: uint32(20_300 + 7 * i), closeMinute: 0}); // Mondays up to 2026-10-19, ascending
        }
        vm.prank(admin);
        mh.setHolidays(h);
    }

    function _gas(uint256 n, uint256 age) internal returns (bool ok, bool closed, uint256 used) {
        _fill(n);
        uint256 nowTs = TUE_1200 + 76 hours; // Fri 16:00, the round is from earlier in the same week
        vm.warp(nowTs);
        _push(nowTs - 2 hours, nowTs + 4 hours); // the keeper's current window only
        vm.cool(address(mh));
        bytes memory out;
        uint256 g0 = gasleft();
        (ok, out) = address(mh).staticcall{gas: GUARD_GAS}(
            abi.encodeWithSignature("closedBetween(uint256,uint256,uint256)", nowTs - age, nowTs, 24 hours)
        );
        used = g0 - gasleft();
        closed = ok && abi.decode(out, (bool));
    }

    /// No holiday count up to the cap of 64 makes the guard's call fail or cost more: a quiet feed mid-week is never
    /// HALTED by the list's length. Cold storage, the keeper's usual single window.
    function test_R8_2_ListLength_GasBound() public {
        uint256[4] memory ages = [uint256(1 hours), 25 hours, 47 hours, 71 hours];
        uint256 worst;
        for (uint256 j; j < ages.length; ++j) {
            for (uint256 n; n <= 64; ++n) {
                uint256 snap = vm.snapshotState();
                (bool ok, bool closed, uint256 used) = _gas(n, ages[j]);
                vm.revertToState(snap);
                assertTrue(ok, "the call fits the guard's gas cap");
                assertFalse(closed, "mid-week: no close behind the round");
                if (used > worst) worst = used;
            }
        }
        emit log_named_uint("worst gas, 0 to 64 holidays, ages 1 h to 71 h (cold)", worst);
        assertLt(worst, GUARD_GAS * 2 / 3, "at most two thirds of the cap");
    }

    /// 50 and 64 listed holidays through the guard: a 47 hour old round on a Thursday is live.
    function test_R8_2_GuardMidWeek_FullList_GasBound() public {
        uint256[2] memory ns = [uint256(50), 64];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            _market(72 hours);
            _fill(ns[i]);
            vm.warp(TUE_1200);
            _push(TUE_1200 - 2 hours, TUE_1200 + 4 hours);
            feed.push(ANSWER_250);
            assertTrue(g2.poke(M).fresh);
            vm.warp(TUE_1200 + 47 hours);
            _push(TUE_1200 + 45 hours, TUE_1200 + 51 hours);
            vm.cool(address(mh));
            _assertLive("47 h old round, mid-week, full list");
            vm.revertToState(snap);
        }
    }

    /// The deployed list, every hour of a trading week, round ages 1 h to 71 h: a round printed in this week's
    /// session is never behind a close (no false halt), and one printed before Sunday 20:00 always is.
    function test_MidWeekNeverReadsAClose() public {
        _fallback();
        for (uint256 t = SUN_2000 + 1 hours; t < FRI_2000; t += 5 hours) {
            for (uint256 age = 1 hours; age <= 71 hours; age += 7 hours) {
                bool want = t - age < SUN_2000;
                assertEq(mh.closedBetween(t - age, t, 24 hours), want, "week");
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ I8-1

    /// The independent 8 PoC on the real calendar, flipped: a round 13 s into the 24 hour holiday close is behind
    /// that close at the reopen and for the rest of its age; a round at the reopen instant is not.
    function test_I8_1_LateRoundIsBehindTheClose() public {
        _fallback();
        assertEq(uint256(mh.kindAt(WED_2000 + 13)), uint256(Session.CLOSED), "the late round is stamped CLOSED");
        assertTrue(mh.closedBetween(WED_2000 - 13, TG_2000, 24 hours), "13 s before the close");
        assertTrue(mh.closedBetween(WED_2000 + 13, TG_2000, 24 hours), "13 s after the close");
        assertTrue(mh.closedBetween(WED_2000 + 13, TG_2000 + 8 hours, 24 hours), "hours later");
        assertTrue(mh.closedBetween(TG_2000 - 1, TG_2000 + 1, 24 hours), "one second before the reopen");
        assertFalse(mh.closedBetween(TG_2000, TG_2000 + 8 hours, 24 hours), "printed at the reopen");

        _market(26 hours);
        _roundAt(WED_2000 + 13);
        vm.warp(TG_2000);
        assertLt(vm.getBlockTimestamp() - (WED_2000 + 13), 24 hours, "under 24 hours old");
        _assertHalted("the late round at the reopen");
        vm.warp(TG_2000 + 2 hours);
        _assertHalted("and until the feed prints");
        feed.push(ANSWER_250);
        _assertLive("the first post-reopen round");
    }

    /// Wherever the session's last round lands from one hour before the holiday close to the last second of the
    /// close, it is not live at the reopen. A round at or after the reopen is.
    function testFuzz_I8_1_RoundAroundTheClose(uint256 offset, uint256 after_) public {
        offset = bound(offset, 0, 25 hours - 1); // WED 19:00 .. THU 19:59:59
        after_ = bound(after_, 0, 90 minutes);
        _market(26 hours);
        _fallback();
        _roundAt(WED_2000 - 1 hours + offset);
        vm.warp(TG_2000 + after_);
        if (vm.getBlockTimestamp() - (WED_2000 - 1 hours + offset) <= 26 hours) _assertHalted("around the close");
        else assertFalse(g2.read(M).fresh, "too old either way");
        feed.push(ANSWER_250);
        _assertLive("a round at or after the reopen");
    }

    /// The weekend: the SPY feed's recorded Friday 20:00:13 print, and a Saturday print, are not live on Sunday
    /// evening or Monday; a Sunday 20:00:05 print is.
    function test_Weekend_LateFridayAndSaturdayRounds() public {
        _market(72 hours);
        _fallback();
        _roundAt(FRI_2000 + 13);
        vm.warp(FRI_2000 + 48 hours + 30);
        _assertHalted("Friday 20:00:13 at the Sunday reopen");
        vm.warp(FRI_2000 + 71 hours);
        _assertHalted("and on Monday");
        _roundAt(FRI_2000 + 86 hours); // Monday 10:00
        _assertLive("Monday's round");

        uint256 nextFri = FRI_2000 + 7 days; // Fri 2026-11-27, the 13:00 early close day: 20:00 is still the close
        _roundAt(nextFri + 30 hours); // Sunday 02:00, inside the weekend
        vm.warp(nextFri + 48 hours + 1);
        _assertHalted("a Saturday night round at the reopen");
        feed.push(ANSWER_250);
        _assertLive("Sunday 20:00:01");
    }

    /// A quiet feed: Sunday evening's round is still live 70 hours later through the guard, with the deployed list
    /// and no pushed window (the longest walk an in-session round can need, inside the guard's gas read).
    function test_QuietFeed70Hours_GasBound() public {
        _market(72 hours);
        _fallback();
        _roundAt(SUN_2000 + 1);
        vm.warp(SUN_2000 + 70 hours);
        vm.cool(address(mh));
        _assertLive("70 hours later, same week, quiet feed");
    }

    /// Good Friday 2026: closed from Thursday 20:00 to Sunday 20:00 Eastern (72 hours, across no DST switch).
    function test_GoodFriday() public {
        _market(72 hours);
        _fallback();
        assertEq(uint256(mh.kindAt(GF_CLOSE - 1)), uint256(Session.EXTENDED));
        assertEq(uint256(mh.kindAt(GF_CLOSE)), uint256(Session.CLOSED));
        assertEq(uint256(mh.kindAt(GF_REOPEN - 1)), uint256(Session.CLOSED));
        assertEq(uint256(mh.kindAt(GF_REOPEN)), uint256(Session.EXTENDED));
        _roundAt(GF_CLOSE - 5 hours);
        vm.warp(GF_REOPEN - 6 hours);
        assertEq(uint256(g2.read(M).session), uint256(Session.CLOSED), "closed on the long weekend");
        vm.warp(GF_REOPEN + 30);
        _assertHalted("Thursday's round on Sunday evening");
        feed.push(ANSWER_250);
        _assertLive("Sunday evening's round");
    }

    /// The 13:00 early close (Friday after Thanksgiving) is post-market until 20:00, not a close: a morning round
    /// stays live through the afternoon, and Thursday evening's post-reopen round is live on Friday.
    function test_EarlyCloseIsNotAClose() public {
        _market(26 hours);
        _fallback();
        _roundAt(TG_2000 + 30); // the first round after the Thanksgiving reopen
        vm.warp(TG_2000 + 16 hours); // Friday 12:00
        assertEq(uint256(g2.read(M).session), uint256(Session.OPEN));
        _assertLive("Thursday evening's round on Friday morning");
        feed.push(ANSWER_250);
        vm.warp(TG_2000 + 17 hours + 1); // Friday 13:00:01, after the early close
        assertEq(uint256(g2.read(M).session), uint256(Session.EXTENDED), "post-market after 13:00");
        vm.warp(TG_2000 + 23 hours);
        _assertLive("the morning round late on the early close day");
        vm.warp(TG_2000 + 3 days + 30); // Sunday 20:00:30
        _assertHalted("Friday's round after the weekend");
    }

    /// Two holidays in a row (Thursday and Friday) join the weekend into one close of 96 hours.
    function test_BackToBackHolidays() public {
        Holiday[] memory h = new Holiday[](2);
        h[0] = Holiday({day: 20_783, closeMinute: 0});
        h[1] = Holiday({day: 20_784, closeMinute: 0});
        vm.prank(admin);
        mh.setHolidays(h);
        _market(72 hours);
        _fallback();
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(WED_2000 - 1 hours, 24 hours);
        assertEq(closeAt, WED_2000);
        assertEq(reopenAt, WED_2000 + 96 hours);
        _roundAt(WED_2000 + 50 hours); // a print in the middle of the close
        vm.warp(WED_2000 + 96 hours + 30);
        _assertHalted("a mid-close round at the reopen, 46 hours old");
        feed.push(ANSWER_250);
        _assertLive("post-reopen round");
    }

    /// Past the years the built-in calendar knows: with no pushed window the market is UNKNOWN (never live). With
    /// the keeper's window, a round printed inside it is live and one printed before it is not.
    function test_UnknownTime() public {
        _market(72 hours);
        _fallback();
        _roundAt(Y2029);
        assertEq(uint256(g2.read(M).session), uint256(Session.UNKNOWN));
        assertTrue(mh.closedBetween(Y2029 - 1 hours, Y2029, 24 hours), "unknown time is out of session");
        _push(Y2029 + 1 hours, Y2029 + 4 days);
        vm.warp(Y2029 + 2 hours);
        _assertHalted("a round from before the keeper's window");
        feed.push(ANSWER_250);
        vm.warp(Y2029 + 2 hours + 60 hours);
        _assertLive("a round inside the keeper's window, 60 hours old");
    }

    /// HALTED by the feed's age wins as before, and a 24/7 market never asks the calendar.
    function test_HaltedByAgeAndAlwaysOpen() public {
        _market(26 hours);
        _fallback();
        _roundAt(TUE_1200);
        vm.warp(TUE_1200 + 26 hours + 1);
        _assertHalted("older than the in-session age, mid-week");
        MarketConfig memory c = _ethCfg();
        vm.prank(admin);
        g2.setMarket(ETH, c);
        ethFeed.push(3000e8);
        vm.warp(TG_2000 - 1 hours); // a holiday for stocks
        ethFeed.push(3000e8);
        vm.warp(TG_2000 + 30);
        assertTrue(g2.read(ETH).fresh, "ETH ignores the stock calendar");
    }
}
