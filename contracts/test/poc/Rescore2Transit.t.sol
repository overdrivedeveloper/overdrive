// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "../governor/GovernorFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Audit rescore 2, L-8 (ported measurement, assertion flipped). A residue of transit that no post absorbs (venue fee,
/// an early loss, rounding in the per-market split) went stale after hedgeMaxAge on 2923f09 even though every hedge
/// post was fresh, pausing buys with HEDGE_STALE. Transit up to TRANSIT_DUST (1 USDG) no longer ages.
contract Rescore2TransitTest is GovernorFixture {
    bytes32 internal sport;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
        sport = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
    }

    function _postEvery(uint256 rounds, uint256 equity) internal {
        uint256 step = gov.hedgeMaxAge() / 2;
        for (uint256 i; i < rounds; ++i) {
            vm.warp(vm.getBlockTimestamp() + step);
            vm.prank(hedger);
            gov.postHedge(TSLA, 0, equity, uint64(vm.getBlockTimestamp())); // fresh, unchanged equity
        }
    }

    /// The measurement, flipped: 1 micro-USDG of unabsorbed transit never stales a fresh hedge.
    function test_PoC_TransitDustDoesNotStaleFreshHedge() public {
        vm.prank(hedger);
        gov.sendToHedger(10_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 10_000e6 - 1, uint64(vm.getBlockTimestamp()));
        (, int256 t) = gov.hedgeEquity();
        assertEq(t, 1, "1 micro-USDG of transit left");
        _postEvery(3, 10_000e6 - 1);
        assertFalse(gov.hedgeStale(), "dust transit stales a fresh hedge");
        _poke();
        (bool paused, bytes32 why) = gov.buysPaused();
        assertTrue(!paused || why != "HEDGE_STALE", "buys paused HEDGE_STALE on dust");
    }

    /// S-3 on the fix: a residue does not hand its old timestamp to a later send, which ages from its own time.
    function test_L8_LaterSendAgesFromItsOwnTime() public {
        vm.prank(hedger);
        gov.sendToHedger(10_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 10_000e6 - 1, uint64(vm.getBlockTimestamp()));
        _postEvery(3, 10_000e6 - 1); // the residue is now older than hedgeMaxAge
        vm.prank(hedger);
        gov.sendToHedger(5_000e6);
        assertFalse(gov.hedgeStale(), "a fresh send inherited the residue's age");
        vm.warp(vm.getBlockTimestamp() + gov.hedgeMaxAge() + 1);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 10_000e6 - 1, uint64(vm.getBlockTimestamp()));
        assertTrue(gov.hedgeStale(), "an unabsorbed real send must still age");
    }

    /// The floor is a floor: transit just above 1 USDG still ages, and sub-dust sends add up and age once above it.
    function test_L8_AboveDustStillAges() public {
        vm.prank(hedger);
        gov.sendToHedger(10_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 10_000e6 - 1e6 - 1, uint64(vm.getBlockTimestamp()));
        _postEvery(3, 10_000e6 - 1e6 - 1);
        assertTrue(gov.hedgeStale(), "1 USDG + 1 of transit must age");
    }

    function test_L8_SubDustSendsAddUp() public {
        vm.startPrank(hedger);
        gov.sendToHedger(0.6e6);
        gov.sendToHedger(0.6e6); // 1.2 USDG unabsorbed, above the floor from now
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + gov.hedgeMaxAge() + 1);
        assertTrue(gov.hedgeStale(), "sub-dust sends that add up above the floor must age");
    }
}
