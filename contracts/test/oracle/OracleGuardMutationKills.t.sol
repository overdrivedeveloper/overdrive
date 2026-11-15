// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {IODOracleGuard} from "../../src/interfaces/IODOracleGuard.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {OracleFixture} from "./OracleFixture.t.sol";

/// Tests added from mutation testing (docs/reviews/mutation-2026-11-15.md): each pins a behaviour of the oracle
/// guard that a surviving mutant showed no test checked.
contract OracleGuardMutationKillsTest is OracleFixture {
    bytes32 private constant WIDE = "WIDE";

    /// A 24/7 market with no Stock Token and no reference, on `f`.
    function _bareCfg(MockAggregator f) private view returns (MarketConfig memory c) {
        c = _ethCfg();
        c.feed = address(f);
        c.pythId = bytes32(0);
    }

    // m7563: liquidationBlock names a missing reference REF_UNAVAILABLE, not REF_BAND.
    function test_LiquidationBlockNamesMissingReference() public {
        _set(WIDE, _bareCfg(_newFeed(8, 3000e8)));
        PriceReading memory r = guard.read(WIDE);
        _assertSession(r, Session.OPEN);
        assertEq(r.refP, 0, "no reference configured");
        assertEq(guard.liquidationBlock(WIDE), guard.REASON_REF_UNAVAILABLE(), "liquidation reason");
        assertEq(r.reason, guard.REASON_REF_UNAVAILABLE(), "buy reason");
    }

    // m7523: derivedConfig returns the feed decimals and the pool orientation fixed at setMarket.
    function test_DerivedConfigHoldsFeedAndPoolValues() public view {
        ODOracleGuard.Derived memory d = guard.derivedConfig(M);
        assertEq(d.feedDecimals, 8, "feed decimals");
        assertEq(d.baseIsToken0, address(token) < address(usdg), "base side");
        assertEq(d.scaleExp, 18 + token.decimals() - usdg.decimals(), "price scale");
        ODOracleGuard.Derived memory e = guard.derivedConfig(ETH);
        assertEq(e.feedDecimals, 8, "eth feed decimals");
        assertEq(e.scaleExp, 0, "no pool");
    }

    // m7852: poke inside a split window latches the pause until effectiveAt + SPLIT_TAIL.
    function test_PokeLatchesSplitPauseUntilTailEnd() public {
        guard.poke(M);
        uint256 eff = _now() + 2 hours;
        token.setMultipliers(1e18, 2e18, eff);
        vm.expectEmit(true, false, false, true, address(guard));
        emit IODOracleGuard.BuysPausedSet(M, true, guard.REASON_SPLIT());
        guard.poke(M);
        assertEq(guard.marketState(M).splitPauseUntil, eff + guard.SPLIT_TAIL(), "split pause end");
        // The issuer withdraws the pending change: the latch alone keeps buys paused until the tail end.
        token.setMultipliers(1e18, 0, 0);
        feed.push(ANSWER_250);
        assertEq(_r().reason, guard.REASON_SPLIT(), "latched");
        vm.warp(eff + guard.SPLIT_TAIL());
        feed.push(ANSWER_250);
        assertTrue(_r().reason != guard.REASON_SPLIT(), "latch over");
    }

    // m8147: a jump that matches the pending multiplier ratio (pending / ui) reads HALTED, never reverts.
    function test_JumpMatchingPendingRatioHalts() public {
        guard.poke(M);
        token.setMultipliers(1e18, 2e18, _now() + 10 days);
        _warp(1 hours);
        feed.push(500e8); // the feed moved by pending / ui before the multiplier switched
        PriceReading memory r = _r();
        _assertSession(r, Session.HALTED);
        assertEq(r.p, 250e18, "last good price");
        assertEq(r.reason, guard.REASON_HALTED(), "halted, not a continuity jump");
    }

    // m8285: a 36-decimal feed (the bound itself) is accepted.
    function test_FeedAtMaxDecimalsAccepted() public {
        _set(WIDE, _bareCfg(_newFeed(36, 3000e36)));
        assertEq(guard.derivedConfig(WIDE).feedDecimals, 36, "decimals");
        PriceReading memory r = guard.read(WIDE);
        _assertSession(r, Session.OPEN);
        assertEq(r.p, 3000e18, "scaled down to WAD");
        MarketConfig memory c = _bareCfg(_newFeed(37, 3000e36));
        vm.prank(admin);
        vm.expectRevert(IODOracleGuard.InvalidConfig.selector);
        guard.setMarket("WIDER", c);
    }

    // m8511: an always-open market's halt start is updatedAt + maxAgeOpen + 1, also after that instant.
    function test_AlwaysOpenHaltStartIsDerivedFromFeed() public {
        uint256 s = T0 + 26 hours + 1;
        vm.warp(s - 1);
        assertEq(guard.haltedSince(ETH), 0, "not stale yet");
        vm.warp(s);
        assertEq(guard.haltedSince(ETH), s, "at the start");
        vm.warp(s + 3 hours);
        assertEq(guard.haltedSince(ETH), s, "after the start");
        _assertSession(guard.read(ETH), Session.HALTED);
    }

    // m8692: a >18-decimal answer that scales to 0 reads as an invalid round (HALTED), never a revert.
    function test_WideFeedScalingToZeroReadsHalted() public {
        MockAggregator f = _newFeed(36, 3000e36);
        _set(WIDE, _bareCfg(f));
        guard.poke(WIDE);
        f.push(1); // 1e-36: zero at 18 decimals
        PriceReading memory r = guard.read(WIDE);
        _assertSession(r, Session.HALTED);
        assertEq(r.p, 3000e18, "last good price");
        assertFalse(r.fresh);
        assertEq(guard.haltedSince(WIDE), 0, "invalid round: no derived halt start");
    }
}
