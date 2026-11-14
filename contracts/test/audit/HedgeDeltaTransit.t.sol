// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "../governor/GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Audit rescore 1 L-2: the posted hedge delta was unbounded in stress and USDG in transit never aged. Fails on 3fe7859.
contract HedgeDeltaTransitTest is GovernorFixture {
    bytes32 internal sport;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
        sport = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
    }

    function _ticket(uint256 shares) internal returns (uint256 ticket) {
        vm.prank(lp);
        ticket = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
    }

    // ------------------------------------------------------------------------------------------------ L-2

    /// Transit that no post absorbs ages out: after hedgeMaxAge the hedge is stale (low edge without hedge equity,
    /// buys paused), and a post that absorbs it clears the age.
    function test_L2_TransitAges() public {
        vm.prank(hedger);
        gov.sendToHedger(10_000e6);
        assertFalse(gov.hedgeStale());
        vm.warp(vm.getBlockTimestamp() + gov.hedgeMaxAge() + 1);
        assertTrue(gov.hedgeStale(), "unabsorbed transit is stale after hedgeMaxAge");
        _poke();
        (bool paused, bytes32 why) = gov.buysPaused();
        assertTrue(paused);
        assertEq(why, "HEDGE_STALE");
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 10_000e6, uint64(vm.getBlockTimestamp()));
        (, int256 t) = gov.hedgeEquity();
        assertEq(t, 0);
        assertFalse(gov.hedgeStale(), "absorbed transit clears the age");
        // a later send restarts the clock from that send
        vm.prank(hedger);
        gov.sendToHedger(1_000e6);
        vm.warp(vm.getBlockTimestamp() + gov.hedgeMaxAge() - 1);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 11_000e6, uint64(vm.getBlockTimestamp()));
        vm.warp(vm.getBlockTimestamp() + 2);
        assertFalse(gov.hedgeStale());
    }

    /// A partial absorb does not restart the clock (a hedger cannot keep transit fresh by small sends or posts).
    function test_L2_TransitClockNotRefreshedBySmallSends() public {
        vm.prank(hedger);
        gov.sendToHedger(10_000e6);
        vm.warp(vm.getBlockTimestamp() + gov.hedgeMaxAge() / 2);
        vm.prank(hedger);
        gov.sendToHedger(1e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 5_000e6, uint64(vm.getBlockTimestamp()));
        vm.warp(vm.getBlockTimestamp() + gov.hedgeMaxAge() / 2 + 1);
        assertTrue(gov.hedgeStale());
    }

    /// A hostile delta made stress unbounded (claim room 0). The posted hedge P&L now counts at most the book's own move
    /// per shock, so stress is at most twice the unhedged stress, and a huge delta cannot overflow either.
    function test_L2_HostileDeltaBounded() public {
        _buy(sport, 1_000e18, 1_000e6);
        _poke();
        (uint256 s0,) = gov.stressLoss();
        assertGt(s0, 0);
        int256[4] memory ds = [int256(1e40), -1e40, type(int256).max, type(int256).min + 1];
        for (uint256 i; i < 4; ++i) {
            vm.prank(hedger);
            gov.postHedge(TSLA, ds[i], 0, uint64(vm.getBlockTimestamp()));
            _poke();
            (uint256 s1,) = gov.stressLoss();
            assertLe(s1, 2 * s0 + 1, "stress bounded by twice the unhedged loss");
        }
    }

    /// Property: for any posted delta, stress stays within twice the unhedged stress.
    function testFuzz_L2_StressBoundedForAnyDelta(int256 delta, uint256 tokens) public {
        tokens = bound(tokens, 1e18, 20_000e18);
        _buy(sport, tokens, tokens / 1e12);
        _poke();
        (uint256 s0,) = gov.stressLoss();
        vm.prank(hedger);
        gov.postHedge(TSLA, delta, 0, uint64(vm.getBlockTimestamp()));
        _poke();
        (uint256 s1,) = gov.stressLoss();
        assertLe(s1, 2 * s0 + 1);
    }
}
