// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Vm} from "forge-std/Vm.sol";
import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {IODOracleGuard} from "../../src/interfaces/IODOracleGuard.sol";
import {ODRoles} from "../../src/interfaces/ODRoles.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {BrokenSource} from "../mocks/OracleMocks.sol";
import {OracleFixture} from "./OracleFixture.t.sol";

contract OracleGuardTest is OracleFixture {
    // ================================================================== R1 read never reverts

    /// Breaks one source (feed, token, Pyth, pool, calendar) in one of six ways; read must still answer.
    function test_ReadNeverRevertsOnBrokenSources(uint8 which, uint8 mode) public {
        which = which % 5;
        mode = mode % 6;
        MarketConfig memory c = _cfg();
        c.pythId = PYTH_ID;
        if (which == 3) c.pythId = bytes32(0); // pool case: no Pyth, so the TWAP is the only reference
        _set(M, c);
        _pythAt(PYTH_ID, 250e8);
        _warp(30 minutes);
        feed.push(ANSWER_250);
        _pythAt(PYTH_ID, 250e8);

        address target = which == 0
            ? address(feed)
            : which == 1 ? address(token) : which == 2 ? address(pyth) : which == 3 ? address(pool) : address(cal);
        vm.etch(target, address(new BrokenSource(mode)).code);

        PriceReading memory r = _r();
        (uint256 refP, bool fromPyth) = guard.refPrice(M);
        guard.buysPausedReason(M);
        guard.haltedSince(M);
        guard.poke(M);
        if (which == 0 || which == 1) {
            _assertSession(r, Session.HALTED);
            assertFalse(r.fresh);
            assertTrue(r.buysPaused);
        } else if (which == 2) {
            assertFalse(fromPyth, "broken Pyth is not a reference");
            assertGt(refP, 0, "falls back to the TWAP");
            _assertSession(r, Session.OPEN);
        } else if (which == 3) {
            assertEq(refP, 0);
            assertEq(r.reason, guard.REASON_REF_UNAVAILABLE());
            _assertSession(r, Session.OPEN);
        } else {
            _assertSession(r, Session.UNKNOWN);
        }
    }

    function test_UnknownMarketReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IODOracleGuard.MarketUnknown.selector, bytes32("NOPE")));
        guard.read("NOPE");
        vm.expectRevert(abi.encodeWithSelector(IODOracleGuard.MarketUnknown.selector, bytes32("NOPE")));
        guard.poke("NOPE");
    }

    function test_GasBurningFeedIsHaltedNotRevert() public {
        vm.etch(address(feed), address(new BrokenSource(3)).code);
        uint256 g = gasleft();
        PriceReading memory r = _r();
        _assertSession(r, Session.HALTED);
        assertLt(g - gasleft(), 1_000_000, "every read is gas-capped");
    }

    function test_ReadWritesNothing() public {
        vm.record();
        guard.read(M);
        guard.readRatio(M, ETH);
        guard.refPrice(M);
        (, bytes32[] memory writes) = vm.accesses(address(guard));
        assertEq(writes.length, 0);
    }

    // ================================================================== R2 multiplier exactly once

    function test_MultiplierAppliedOnce_Embedded() public {
        token.setMultipliers(1.5e18, 1.5e18, 0);
        feed.push(375e8); // feed already includes the multiplier
        assertEq(_r().p, 375e18);
    }

    function test_MultiplierAppliedOnce_NotEmbedded() public {
        MarketConfig memory c = _cfg();
        c.multiplierEmbedded = false;
        _set(M, c);
        token.setMultipliers(1.5e18, 1.5e18, 0);
        assertEq(_r().p, 375e18, "share price 250 x 1.5");
        PriceReading memory r = _r();
        _assertSession(r, Session.OPEN);
        assertTrue(r.fresh);
    }

    function testFuzz_MultiplierAppliedOnce(uint256 mult, int256 answer, bool embedded) public {
        mult = bound(mult, 1e15, 1e21);
        answer = bound(answer, 1, 1e14);
        MarketConfig memory c = _cfg();
        c.multiplierEmbedded = embedded;
        _set(M, c);
        token.setMultipliers(mult, mult, 0);
        feed.push(answer);
        uint256 raw = uint256(answer) * 1e10;
        uint256 want = embedded ? raw : raw * mult / 1e18;
        PriceReading memory r = _r();
        if (want == 0) _assertSession(r, Session.HALTED);
        else assertEq(r.p, want);
    }

    function test_PythMultiplierFlagIndependent() public {
        MarketConfig memory c = _cfg();
        c.pythId = PYTH_ID;
        c.multiplierEmbedded = true;
        c.pythMultiplierEmbedded = false;
        _set(M, c);
        token.setMultipliers(1.5e18, 1.5e18, 0);
        feed.push(375e8);
        _pythAt(PYTH_ID, 250e8); // Pyth prices one share
        (uint256 refP, bool fromPyth) = guard.refPrice(M);
        assertTrue(fromPyth);
        assertEq(refP, 375e18, "Pyth x multiplier, once");
        assertEq(_r().p, 375e18, "feed not multiplied again");

        c.pythMultiplierEmbedded = true;
        _set(M, c);
        (refP,) = guard.refPrice(M);
        assertEq(refP, 250e18, "flag read per source");
    }

    function test_FeedDecimalsAboveEighteen() public {
        MockAggregator f = _newFeed(20, 250e20);
        MarketConfig memory c = _cfg();
        c.feed = address(f);
        _set(M, c);
        assertEq(_r().p, 250e18);
    }

    // ================================================================== R3 live checks

    function test_FutureDatedRejected() public {
        feed.setRound(ANSWER_250, _now() + 1);
        _assertSession(_r(), Session.HALTED);
    }

    function test_StaleInSessionHalts() public {
        guard.poke(M);
        _warp(26 hours);
        _assertSession(_r(), Session.OPEN);
        _warp(1);
        PriceReading memory r = _r();
        _assertSession(r, Session.HALTED);
        assertEq(r.p, 250e18, "last good");
        assertFalse(r.fresh);
        assertEq(r.reason, guard.REASON_HALTED());
    }

    function test_ExtendedUsesItsOwnMaxAge() public {
        MarketConfig memory c = _cfg();
        c.maxAgeExtended = 1 hours;
        _set(M, c);
        _warp(1 hours + 1);
        feed.setRound(ANSWER_250, _now() - 1 hours - 1);
        _assertSession(_r(), Session.OPEN);
        cal.setKind(Session.EXTENDED);
        _assertSession(_r(), Session.HALTED);
        feed.push(ANSWER_250);
        _assertSession(_r(), Session.EXTENDED);
    }

    function test_OraclePausedHalts() public {
        token.setOraclePaused(true);
        _assertSession(_r(), Session.HALTED);
        cal.setKind(Session.CLOSED);
        _assertSession(_r(), Session.HALTED);
        token.setOraclePaused(false);
        cal.setKind(Session.OPEN);
        _assertSession(_r(), Session.OPEN);
    }

    function test_ZeroAnswerHalts() public {
        feed.push(0);
        _assertSession(_r(), Session.HALTED);
        feed.push(-1);
        _assertSession(_r(), Session.HALTED);
        feed.push(ANSWER_250);
        _assertSession(_r(), Session.OPEN);
    }

    function test_AnswerAboveMaxPHalts() public {
        MockAggregator f = _newFeed(18, int256(guard.MAX_P()) + 1);
        MarketConfig memory c = _cfg();
        c.feed = address(f);
        _set(M, c);
        _assertSession(_r(), Session.HALTED);
        f.push(int256(guard.MAX_P()));
        _assertSession(_r(), Session.OPEN);
    }

    function test_DisabledPausesBuysButStillPrices() public {
        MarketConfig memory c = _cfg();
        c.enabled = false;
        _set(M, c);
        PriceReading memory r = _r();
        assertEq(r.p, 250e18);
        assertTrue(r.fresh);
        assertEq(r.reason, guard.REASON_DISABLED());
    }

    // ================================================================== R4 24/7 crypto

    function test_CryptoAlwaysOpen() public {
        cal.setKind(Session.CLOSED);
        PriceReading memory r = guard.read(ETH);
        _assertSession(r, Session.OPEN);
        assertTrue(r.fresh);
        assertEq(r.p, 3000e18);
        vm.etch(address(cal), address(new BrokenSource(0)).code);
        _assertSession(guard.read(ETH), Session.OPEN);
    }

    function test_CryptoStaleHalts() public {
        guard.poke(ETH);
        uint256 updated = _now();
        _warp(26 hours + 1);
        PriceReading memory r = guard.read(ETH);
        _assertSession(r, Session.HALTED);
        assertEq(r.p, 3000e18);
        assertEq(guard.haltedSince(ETH), updated + 26 hours + 1, "derived without a poke");
        ethFeed.push(3010e8);
        _assertSession(guard.read(ETH), Session.OPEN);
    }

    // ================================================================== R5 closed sessions and the halt latch

    function test_ClosedUsesLastGood() public {
        guard.poke(M);
        cal.setKind(Session.CLOSED);
        feed.push(260e8);
        PriceReading memory r = _r();
        _assertSession(r, Session.CLOSED);
        assertEq(r.p, 250e18);
        assertTrue(r.fresh);
        assertEq(r.updatedAt, T0);
        guard.poke(M);
        (uint256 p,) = guard.lastGood(M);
        assertEq(p, 250e18, "closed poke stores nothing");
    }

    function test_ClosedWithoutLastGoodIsNotFresh() public {
        cal.setKind(Session.UNKNOWN);
        PriceReading memory r = _r();
        _assertSession(r, Session.UNKNOWN);
        assertEq(r.p, 0);
        assertFalse(r.fresh);
    }

    function test_ClosedTooOldHalts() public {
        guard.poke(M);
        cal.setKind(Session.CLOSED);
        _warp(5 days);
        _assertSession(_r(), Session.CLOSED);
        _warp(1);
        PriceReading memory r = _r();
        _assertSession(r, Session.HALTED);
        assertFalse(r.fresh);
    }

    function test_ClosedBoundIsPerMarket() public {
        // A quiet feed (about 3.8 days between weekend rounds) gets a longer closed bound than the 5-day default.
        MarketConfig memory c = _cfg();
        c.maxAgeClosed = 7 days;
        _set(M, c);
        guard.poke(M);
        cal.setKind(Session.CLOSED);
        _warp(6 days);
        _assertSession(_r(), Session.CLOSED);
    }

    function test_HaltLatchSurvivesClose() public {
        guard.poke(M);
        _warp(1 hours);
        token.setOraclePaused(true);
        guard.poke(M);
        assertEq(guard.haltedSince(M), _now());
        cal.setKind(Session.CLOSED);
        token.setOraclePaused(false);
        _assertSession(_r(), Session.HALTED); // ORC-1: no CLOSED price after an in-session halt
        cal.setKind(Session.OPEN);
        feed.push(251e8);
        guard.poke(M);
        assertEq(guard.haltedSince(M), 0, "live good reading clears");
        cal.setKind(Session.CLOSED);
        _assertSession(_r(), Session.CLOSED);
    }

    function test_HaltStartNeverMovesLater() public {
        guard.poke(M); // feed updatedAt = T0
        _warp(20 hours);
        token.setOraclePaused(true);
        guard.poke(M);
        uint256 first = _now();
        assertEq(guard.marketState(M).haltedSince, first);
        _warp(10 hours); // feed now stale from T0 + 26 h + 1, earlier than the first latch
        guard.poke(M);
        uint256 derivedStart = T0 + 26 hours + 1;
        assertEq(guard.marketState(M).haltedSince, first, "derived start is later than the latch: kept");
        // ORC-2: a calendar change (now CLOSED everywhere) cannot move it later or erase it.
        cal.setKind(Session.CLOSED);
        _warp(1 days);
        guard.poke(M);
        assertEq(guard.marketState(M).haltedSince, first);
        assertEq(guard.haltedSince(M), first);
        assertLt(first, derivedStart);
    }

    function test_HaltStartMovesEarlierToDerived() public {
        guard.poke(M);
        _warp(30 hours); // stale since T0 + 26 h + 1, nobody poked
        token.setOraclePaused(true);
        guard.poke(M);
        assertEq(guard.marketState(M).haltedSince, T0 + 26 hours + 1);
    }

    function testFuzz_HaltStartNeverMovesLater(uint32[4] memory gaps, uint8 kinds) public {
        guard.poke(M);
        uint64 prev;
        for (uint256 i; i < 4; ++i) {
            _warp(bound(gaps[i], 1, 3 days));
            cal.setKind(((kinds >> i) & 1) == 0 ? Session.OPEN : Session.CLOSED);
            guard.poke(M);
            uint64 cur = guard.marketState(M).haltedSince;
            if (prev != 0) assertLe(cur, prev);
            if (cur != 0) prev = cur;
        }
    }

    function test_DerivedHaltWithoutAnyPoke() public {
        guard.poke(M);
        _warp(27 hours);
        assertEq(guard.haltedSince(M), T0 + 26 hours + 1);
        cal.setKind(Session.CLOSED); // the probes now find no session: no derived start
        assertEq(guard.haltedSince(M), 0);
    }

    function test_NormalWeekendIsNotAHalt() public {
        guard.poke(M);
        // Open until Friday close (T0 + 4 h), closed for 62 h, open again.
        cal.addStep(T0 + 4 hours, Session.CLOSED);
        cal.addStep(T0 + 66 hours, Session.OPEN);
        _warp(60 hours);
        assertEq(guard.haltedSince(M), 0);
        PriceReading memory r = _r();
        _assertSession(r, Session.CLOSED);
        assertTrue(r.fresh);
        _warp(6 hours); // reopened with no new round yet: stale since T0 + 26 h + 1, in session first at reopen
        // Stale in session now; the derived start sits on the 6-hour probe grid (T0 + 26 h + 1 + 7 x 6 h).
        _assertSession(_r(), Session.HALTED);
        assertEq(guard.haltedSince(M), 0, "next probe is still in the future");
        _warp(2 hours + 1);
        assertEq(guard.haltedSince(M), T0 + 68 hours + 1);
        feed.push(250e8);
        _assertSession(_r(), Session.OPEN);
    }

    // ================================================================== R6 reference price

    function _withPyth() internal {
        MarketConfig memory c = _cfg();
        c.pythId = PYTH_ID;
        _set(M, c);
    }

    function test_RefPrefersFreshPyth() public {
        _withPyth();
        _pythAt(PYTH_ID, 251e8);
        (uint256 refP, bool fromPyth) = guard.refPrice(M);
        assertTrue(fromPyth);
        assertEq(refP, 251e18);
        assertEq(_r().refP, 251e18);
    }

    function test_RefFallsBackToTwap() public {
        _withPyth();
        uint256 twap;
        bool fromPyth;
        // stale
        pyth.setPrice(PYTH_ID, 251e8, 1e5, -8, _now() - 1 hours - 1);
        (twap, fromPyth) = guard.refPrice(M);
        assertFalse(fromPyth);
        assertApproxEqRel(twap, 250e18, 0.0001e18);
        // future-dated
        pyth.setPrice(PYTH_ID, 251e8, 1e5, -8, _now() + 1);
        (, fromPyth) = guard.refPrice(M);
        assertFalse(fromPyth);
        // confidence wider than 2%
        pyth.setPrice(PYTH_ID, 251e8, uint64(251e8 / 50 + 1), -8, _now());
        (, fromPyth) = guard.refPrice(M);
        assertFalse(fromPyth);
        pyth.setPrice(PYTH_ID, 251e8, uint64(251e8 / 50), -8, _now());
        (, fromPyth) = guard.refPrice(M);
        assertTrue(fromPyth, "exactly 2% is accepted");
        // unknown id (Pyth Core reverts PriceFeedNotFound for 10 of 12 names on 4663)
        MarketConfig memory c = _cfg();
        c.pythId = keccak256("never pushed");
        _set(M, c);
        (twap, fromPyth) = guard.refPrice(M);
        assertFalse(fromPyth);
        assertGt(twap, 0);
    }

    function test_RefZeroWhenBothUnavailable() public {
        MarketConfig memory c = _cfg();
        c.pythId = PYTH_ID;
        c.twapPool = address(0);
        _set(M, c);
        pyth.setPrice(PYTH_ID, 251e8, 1e5, -8, _now() - 7 days); // stale, as on chain
        (uint256 refP,) = guard.refPrice(M);
        assertEq(refP, 0);
    }

    function test_RefNeverSpot() public {
        // A spot move (slot0 tick) that the TWAP has not absorbed yet does not change the reference.
        (uint256 before,) = guard.refPrice(M);
        _setPoolTick(TICK_250 + 2000);
        (uint256 afterSpot,) = guard.refPrice(M);
        assertEq(afterSpot, before);
    }

    function test_TwapObserveRevertGivesZero() public {
        pool.setRevert(true);
        (uint256 refP,) = guard.refPrice(M);
        assertEq(refP, 0);
    }

    function test_TwapShortHistoryGivesZero() public {
        pool.setOldest(uint32(_now() - 30 minutes + 1));
        (uint256 refP,) = guard.refPrice(M);
        assertEq(refP, 0);
        pool.setOldest(uint32(_now() - 30 minutes));
        (refP,) = guard.refPrice(M);
        assertGt(refP, 0);
    }

    // ================================================================== R7 fail closed for buys

    function test_RefUnavailablePausesBuysOnly() public {
        MarketConfig memory c = _cfg();
        c.twapPool = address(0);
        _set(M, c);
        PriceReading memory r = _r();
        assertEq(r.p, 250e18, "p unchanged");
        _assertSession(r, Session.OPEN);
        assertTrue(r.fresh);
        assertEq(r.refP, 0);
        assertTrue(r.buysPaused);
        assertEq(r.reason, guard.REASON_REF_UNAVAILABLE());
        assertEq(guard.buysPausedReason(M), guard.REASON_REF_UNAVAILABLE());
    }

    function test_RefBandPausesBuysOnly() public {
        assertFalse(_r().buysPaused, "in band at start");
        _setPoolTick(TICK_250 + 300); // about +3%
        _warp(30 minutes);
        feed.push(ANSWER_250);
        PriceReading memory r = _r();
        assertEq(r.p, 250e18);
        _assertSession(r, Session.OPEN);
        assertTrue(r.fresh);
        assertEq(r.reason, guard.REASON_REF_BAND());
        // The other side, then back inside.
        _setPoolTick(TICK_250 - 300);
        _warp(30 minutes);
        feed.push(ANSWER_250);
        assertEq(_r().reason, guard.REASON_REF_BAND());
        _setPoolTick(TICK_250 + 100);
        _warp(30 minutes);
        feed.push(ANSWER_250);
        assertFalse(_r().buysPaused);
    }

    function test_RefChecksOnlyOnLiveReadings() public {
        guard.poke(M);
        _setPoolTick(TICK_250 + 300);
        _warp(30 minutes);
        cal.setKind(Session.CLOSED);
        PriceReading memory r = _r();
        assertGt(r.refP, 0, "reported in every session");
        assertFalse(r.buysPaused, "a closed session is the consumer's call, not a reference pause");
    }

    function testFuzz_RefBand(uint16 band, int24 dTick) public {
        band = uint16(bound(band, 1, 2000));
        dTick = int24(bound(dTick, -3000, 3000));
        MarketConfig memory c = _cfg();
        c.refBandBps = band;
        _set(M, c);
        _setPoolTick(TICK_250 + dTick);
        _warp(30 minutes);
        feed.push(ANSWER_250);
        PriceReading memory r = _r();
        uint256 diff = r.p > r.refP ? r.p - r.refP : r.refP - r.p;
        bool outside = diff * 10_000 > r.refP * band;
        assertEq(r.reason == guard.REASON_REF_BAND(), outside);
        assertEq(r.p, 250e18);
    }

    function test_NoSkipOnZeroRef() public view {
        // Behaviour: a zero reference pauses buys (above). Source: no "if (ref != 0) x = worse..." shape anywhere.
        string[5] memory files = [
            "src/oracle/ODOracleGuard.sol",
            "src/oracle/ODTwapReader.sol",
            "src/oracle/ODTickPrice.sol",
            "src/oracle/ODCalendar.sol",
            "src/oracle/ODMarketHours.sol"
        ];
        for (uint256 i; i < files.length; ++i) {
            bytes memory src = bytes(vm.readFile(files[i]));
            assertFalse(_lineHasBoth(src, "!= 0) ", "worse"), files[i]);
        }
    }

    function _lineHasBoth(bytes memory s, bytes memory a, bytes memory b) private pure returns (bool) {
        uint256 lineStart;
        for (uint256 i; i <= s.length; ++i) {
            if (i == s.length || s[i] == "\n") {
                uint256 ia = _find(s, a, lineStart, i);
                if (ia != type(uint256).max && _find(s, b, ia, i) != type(uint256).max) return true;
                lineStart = i + 1;
            }
        }
        return false;
    }

    function _find(bytes memory s, bytes memory pat, uint256 from, uint256 to) private pure returns (uint256) {
        if (to < pat.length) return type(uint256).max;
        for (uint256 i = from; i + pat.length <= to; ++i) {
            bool m = true;
            for (uint256 j; j < pat.length; ++j) {
                if (s[i + j] != pat[j]) {
                    m = false;
                    break;
                }
            }
            if (m) return i;
        }
        return type(uint256).max;
    }

    // ================================================================== R8 splits and continuity

    function test_SplitWindowPausesBuys() public {
        guard.poke(M);
        uint256 eff = _now() + 25 hours;
        token.setMultipliers(1e18, 2e18, eff);
        assertFalse(_r().buysPaused, "25 h before: not yet");
        _warp(1 hours);
        feed.push(ANSWER_250);
        assertEq(_r().reason, guard.REASON_SPLIT(), "24 h before");
        guard.poke(M);
        vm.warp(eff + 1 hours - 1);
        feed.push(ANSWER_250); // embedded feed: share price halves, multiplier doubles, per token unchanged
        assertEq(_r().reason, guard.REASON_SPLIT(), "until 1 h after");
        vm.warp(eff + 1 hours);
        feed.push(ANSWER_250);
        PriceReading memory r = _r();
        assertTrue(r.reason != guard.REASON_SPLIT());
    }

    function test_SmallPendingChangeDoesNotPause() public {
        token.setMultipliers(1e18, 1.002e18, _now() + 1 hours); // cash-distribution-size step
        assertFalse(_r().buysPaused);
    }

    function test_FeedMultiplierMismatchHalts() public {
        guard.poke(M);
        token.setMultipliers(1e18, 2e18, _now() + 2 hours);
        _warp(1 hours);
        feed.push(125e8); // the split share price arrived before the multiplier switched
        PriceReading memory r = _r();
        _assertSession(r, Session.HALTED);
        assertEq(r.p, 250e18, "last good, never the half price");
        vm.warp(T0 + 2 hours); // multiplier now effective: feed and multiplier agree again
        feed.push(ANSWER_250);
        guard.poke(M);
        r = _r();
        _assertSession(r, Session.OPEN);
        assertEq(r.p, 250e18);
    }

    function test_SplitLeavesPContinuous_NotEmbedded() public {
        MarketConfig memory c = _cfg();
        c.multiplierEmbedded = false;
        _set(M, c);
        guard.poke(M);
        token.setMultipliers(1e18, 2e18, _now() + 1 hours);
        vm.warp(T0 + 1 hours);
        feed.push(125e8); // per-share feed halves at the split; the multiplier doubles
        PriceReading memory r = _r();
        assertEq(r.p, 250e18, "per-token price continuous");
        _assertSession(r, Session.OPEN);
        assertEq(r.reason, guard.REASON_SPLIT());
    }

    function test_SplitLeavesPContinuous_Embedded() public {
        guard.poke(M);
        token.setMultipliers(1e18, 2e18, _now() + 1 hours);
        vm.warp(T0 + 1 hours);
        feed.push(ANSWER_250); // the embedded feed already carries the multiplier
        PriceReading memory r = _r();
        assertEq(r.p, 250e18);
        _assertSession(r, Session.OPEN);
    }

    function test_UnexplainedJumpLatches() public {
        guard.poke(M);
        _warp(1 minutes);
        feed.push(300e8); // +20% > 15% band, no multiplier change
        PriceReading memory r = _r();
        assertEq(r.reason, guard.REASON_CONTINUITY());
        _assertSession(r, Session.OPEN);
        guard.poke(M);
        assertTrue(guard.marketState(M).contPaused);
        (uint256 p,) = guard.lastGood(M);
        assertEq(p, 250e18, "the jump is not recorded");
    }

    function test_TwoRoundsClearContinuity() public {
        guard.poke(M);
        _warp(1 minutes);
        feed.push(300e8);
        guard.poke(M);
        guard.poke(M); // same round does not count
        assertEq(guard.marketState(M).confirmations, 0);
        _warp(1 minutes);
        feed.push(301e8);
        guard.poke(M);
        assertEq(guard.marketState(M).confirmations, 1);
        assertEq(_r().reason, guard.REASON_CONTINUITY());
        _warp(1 minutes);
        feed.push(300e8);
        guard.poke(M);
        assertFalse(guard.marketState(M).contPaused);
        (uint256 p,) = guard.lastGood(M);
        assertEq(p, 300e18);
        assertTrue(_r().reason != guard.REASON_CONTINUITY());
    }

    function test_NonConfirmingRoundRestartsCount() public {
        guard.poke(M);
        _warp(1 minutes);
        feed.push(300e8);
        guard.poke(M);
        _warp(1 minutes);
        feed.push(300e8);
        guard.poke(M);
        assertEq(guard.marketState(M).confirmations, 1);
        _warp(1 minutes);
        feed.push(400e8); // outside the band of the pending price: new pending, count restarts
        guard.poke(M);
        assertEq(guard.marketState(M).confirmations, 0);
        assertEq(guard.marketState(M).pendingP, 400e18);
    }

    function test_AdminUnpauseClearsContinuity() public {
        guard.poke(M);
        _warp(1 minutes);
        feed.push(300e8);
        guard.poke(M);
        vm.prank(admin);
        guard.setBuysPaused(M, false);
        (uint256 p,) = guard.lastGood(M);
        assertEq(p, 300e18);
        assertFalse(guard.marketState(M).contPaused);
    }

    function testFuzz_ContinuityBand(uint256 newP) public {
        newP = bound(newP, 1, 1000e8);
        guard.poke(M);
        _warp(1 minutes);
        feed.push(int256(newP));
        uint256 p = newP * 1e10;
        uint256 diff = p > 250e18 ? p - 250e18 : 250e18 - p;
        bool jump = diff * 10_000 > 250e18 * 1500;
        assertEq(_r().reason == guard.REASON_CONTINUITY(), jump);
    }

    // ================================================================== R9 ratio

    function test_RatioWorseSession() public {
        guard.poke(M);
        PriceReading memory r = guard.readRatio(M, ETH);
        _assertSession(r, Session.OPEN);
        cal.setKind(Session.CLOSED);
        r = guard.readRatio(M, ETH);
        _assertSession(r, Session.CLOSED);
        r = guard.readRatio(ETH, M);
        _assertSession(r, Session.CLOSED);
        token.setOraclePaused(true);
        r = guard.readRatio(ETH, M);
        _assertSession(r, Session.HALTED);
        assertFalse(r.fresh);
        assertTrue(r.buysPaused);
    }

    function test_RatioRefNeedsBoth() public {
        PriceReading memory r = guard.readRatio(M, ETH);
        assertEq(r.refP, 0, "ETH has no reference");
        assertTrue(r.buysPaused, "ETH leg pauses buys");
        _pythAt(keccak256("pyth ETH"), 3000e8);
        r = guard.readRatio(M, ETH);
        (uint256 refM,) = guard.refPrice(M);
        assertEq(r.refP, refM * 1e18 / 3000e18);
        assertEq(r.p, uint256(250e18) * 1e18 / 3000e18);
        assertFalse(r.buysPaused);
    }

    function testFuzz_RatioRounding(int256 a, int256 b) public {
        a = bound(a, 1, 1e20);
        b = bound(b, 1, 1e20);
        feed.push(a);
        ethFeed.push(b);
        uint256 pa = uint256(a) * 1e10;
        uint256 pb = uint256(b) * 1e10;
        PriceReading memory r = guard.readRatio(M, ETH);
        assertEq(r.p, pa * 1e18 / pb);
        assertLe(r.p * pb, pa * 1e18);
        assertGt((r.p + 1) * pb, pa * 1e18);
    }

    // ================================================================== R10 poke

    function test_PokeOnlyRecordsLiveGood() public {
        cal.setKind(Session.CLOSED);
        guard.poke(M);
        (uint256 p,) = guard.lastGood(M);
        assertEq(p, 0, "closed");
        cal.setKind(Session.OPEN);
        token.setOraclePaused(true);
        guard.poke(M);
        (p,) = guard.lastGood(M);
        assertEq(p, 0, "halted");
        token.setOraclePaused(false);
        vm.recordLogs();
        guard.poke(M);
        (p,) = guard.lastGood(M);
        assertEq(p, 250e18, "live");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], IODOracleGuard.LastGoodSet.selector);
    }

    function test_PokePermissionless() public {
        vm.prank(stranger);
        PriceReading memory r = guard.poke(M);
        assertEq(r.p, 250e18);
        (uint256 p, uint64 at) = guard.lastGood(M);
        assertEq(p, 250e18);
        assertEq(at, T0);
    }

    // ================================================================== R11 pauses and setMarket

    function test_GuardianCannotUnpause() public {
        vm.prank(guardian);
        guard.setBuysPaused(M, true);
        assertEq(_r().reason, guard.REASON_MANUAL());
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
        );
        vm.prank(guardian);
        guard.setBuysPaused(M, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ODRoles.GUARDIAN_ROLE
            )
        );
        vm.prank(stranger);
        guard.setBuysPaused(M, true);
    }

    function test_AdminUnpauses() public {
        vm.prank(guardian);
        guard.setBuysPaused(M, true);
        vm.prank(admin);
        guard.setBuysPaused(M, false);
        assertFalse(_r().buysPaused);
    }

    function test_SetMarketRejectsAggregatorAddress() public {
        MarketConfig memory c = _cfg();
        c.feed = aggImpl; // the aggregator behind a proxy has no aggregator()
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        _set(M, c);
        MockAggregator selfAgg = new MockAggregator(8, ANSWER_250); // aggregator() == itself
        c.feed = address(selfAgg);
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        _set(M, c);
        c.feed = address(0xbeef); // no code
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        _set(M, c);
        MockAggregator wide = _newFeed(37, 1);
        c.feed = address(wide);
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        _set(M, c);
    }

    function test_SetMarketBounds() public {
        MarketConfig memory c = _cfg();
        c.maxAgeClosed = 2 days - 1;
        _expectInvalid(c);
        c.maxAgeClosed = 14 days + 1;
        _expectInvalid(c);
        c = _cfg();
        c.refBandBps = 2001;
        _expectInvalid(c);
        c.refBandBps = 0;
        _expectInvalid(c);
        c = _cfg();
        c.maxAgeOpen = 0;
        _expectInvalid(c);
        c = _cfg();
        c.continuityBps = 0;
        _expectInvalid(c);
        c = _cfg();
        c.pythId = PYTH_ID;
        c.refMaxAge = 0;
        _expectInvalid(c);
        c = _cfg();
        c.twapWindow = 10 minutes - 1;
        _expectInvalid(c);
        c = _cfg();
        c.twapPool = address(_newPool(address(usdg), 0)); // pool without the Stock Token: USDG/USDG
        _expectInvalid(c);
        c = _cfg();
        c.stockToken = address(0xdead); // no code
        c.twapPool = address(0);
        _expectInvalid(c);
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        vm.prank(admin);
        guard.setMarket(bytes32(0), _cfg());
        // Edges accepted.
        c = _cfg();
        c.maxAgeClosed = 2 days;
        c.refBandBps = 2000;
        _set(M, c);
        c.maxAgeClosed = 14 days;
        _set(M, c);
        // Only the admin.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
        );
        vm.prank(guardian);
        guard.setMarket(M, c);
    }

    function _expectInvalid(MarketConfig memory c) private {
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        vm.prank(admin);
        guard.setMarket(M, c);
    }

    function test_ConstructorRejectsZero() public {
        vm.expectRevert(IODOracleGuard.ZeroAddress.selector);
        new ODOracleGuard(address(0), guardian, address(cal), address(pyth), address(0));
        vm.expectRevert(IODOracleGuard.ZeroAddress.selector);
        new ODOracleGuard(admin, address(0), address(cal), address(pyth), address(0));
        vm.expectRevert(IODOracleGuard.ZeroAddress.selector);
        new ODOracleGuard(admin, guardian, address(0), address(pyth), address(0));
    }

    function test_PythIdNeedsPyth() public {
        ODOracleGuard g = new ODOracleGuard(admin, guardian, address(cal), address(0), address(0));
        MarketConfig memory c = _cfg();
        c.pythId = PYTH_ID;
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        vm.prank(admin);
        g.setMarket(M, c);
    }

    // ================================================================== R12 sequencer (none on 4663; mock)

    function _guardWithSequencer() internal returns (ODOracleGuard g, MockAggregator seq) {
        seq = new MockAggregator(0, 0); // answer 0 = up, startedAt = deploy time
        g = _deployGuard(address(seq));
        vm.prank(admin);
        g.setMarket(M, _cfg());
    }

    function test_SequencerDownHalts() public {
        _warp(2 hours);
        feed.push(ANSWER_250);
        (ODOracleGuard g, MockAggregator seq) = _guardWithSequencer();
        _assertSession(g.read(M), Session.HALTED); // still inside the grace period after deploy
        _warp(1 hours);
        _assertSession(g.read(M), Session.OPEN);
        seq.setRound(1, _now()); // down
        _assertSession(g.read(M), Session.HALTED);
        vm.etch(address(seq), address(new BrokenSource(0)).code);
        _assertSession(g.read(M), Session.HALTED);
    }

    function test_SequencerGraceHalts() public {
        (ODOracleGuard g, MockAggregator seq) = _guardWithSequencer();
        _warp(2 hours);
        feed.push(ANSWER_250);
        seq.setRound(0, _now()); // came back up just now
        _assertSession(g.read(M), Session.HALTED);
        _warp(1 hours - 1);
        feed.push(ANSWER_250);
        _assertSession(g.read(M), Session.HALTED);
        _warp(1);
        _assertSession(g.read(M), Session.OPEN);
        assertEq(address(guard.sequencerFeed()), address(0), "the production guard takes address(0)");
    }

    // ================================================================== manipulation resistance

    function test_SingleBlockPoolSpikeDoesNotPauseBuys() public {
        _setPoolTick(TICK_250 + 10_000);
        _warp(1);
        _setPoolTick(TICK_250);
        _warp(12);
        feed.push(ANSWER_250);
        assertFalse(_r().buysPaused);
    }

    function test_SustainedPoolMoveIsSeen() public {
        _setPoolTick(TICK_250 + 400);
        _warp(30 minutes);
        feed.push(ANSWER_250);
        assertEq(_r().reason, guard.REASON_REF_BAND());
    }
}
