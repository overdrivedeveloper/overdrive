// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ForkSystem} from "./ForkSystem.sol";
import {GearConfig, Gear, PriceReading} from "overdrive/interfaces/ODTypes.sol";

/// R6: pair gears (SPORT) on the real state. Pairs per DECISIONS: NVDA/AMD and QQQ/SPY list; COIN/MSTR cannot (COIN has
/// no reference: AllGearsFork::test_CoinBuysPauseRefUnavailable).
contract PairsForkTest is ForkSystem {
    /// A and B both +10%: pair value unchanged (same block, no toll); A +10% and B flat: pair SPORT +21%.
    function test_PairFollowsRatio() public {
        bytes32[2] memory ps = [nvdaAmd, qqqSpy];
        for (uint256 i; i < 2; ++i) {
            GearConfig memory c = reg.gear(ps[i]);
            uint256 snap = vm.snapshotState();
            (uint256 v0,) = minter.valuePerToken(ps[i]);
            walkPrice(c.marketA, 1000);
            walkPrice(c.marketB, 1000);
            (uint256 v1,) = minter.valuePerToken(ps[i]);
            assertApproxEqRel(v1, v0, 1e10, "both legs +10%: unchanged"); // 1e-8 (8-dp feeds)
            vm.revertToState(snap);
            _remock();
            walkPrice(c.marketA, 1000);
            (uint256 v2,) = minter.valuePerToken(ps[i]);
            assertApproxEqRel(v2 * 1e18 / v0, 1.21e18, 1e10, "A +10%, B flat: +21%");
            vm.revertToState(snap);
            _remock();
        }
        // with the toll: one day of the crank on a held pair moves value only by the toll
        uint256 t = _hookBuy(alice, nvdaAmd, 1_000e6);
        (uint256 a0,) = minter.valuePerToken(nvdaAmd);
        uint256 nf0 = minter.normState(nvdaAmd).nf;
        _crank(24);
        walkPrice(NVDA, 1000);
        walkPrice(AMD, 1000);
        (uint256 a1,) = minter.valuePerToken(nvdaAmd);
        uint256 nf1 = minter.normState(nvdaAmd).nf;
        assertLt(nf1, nf0, "toll paid");
        assertApproxEqRel(a1, a0 * nf1 / nf0, 1e10, "only the toll moved the value");
        assertGt(_hookSell(alice, nvdaAmd, t), 0);
    }

    /// A pair is closed for buys if either leg is: B paused (manual) or B halted (stale feed); A's own gears trade.
    function test_PairClosedIfEitherClosed() public {
        _hookBuy(alice, nvdaAmd, 500e6); // open
        uint256 snap = vm.snapshotState();
        vm.prank(guardian);
        guard.setBuysPaused(AMD, true);
        PriceReading memory r = guard.readRatio(NVDA, AMD);
        assertTrue(r.buysPaused, "B paused closes the pair");
        _expectBuyRevert(nvdaAmd);
        assertGt(_hookBuy(alice, gearOf[NVDA][Gear.SPORT], 500e6), 0, "A single name still trades");
        vm.revertToState(snap);
        _remock();
        // B's feed goes stale in session: HALTED
        _mockFeed(AMD, px[AMD] / 1e10, vm.getBlockTimestamp() - 200_000);
        guard.poke(AMD);
        r = guard.readRatio(NVDA, AMD);
        assertFalse(r.fresh && !r.buysPaused, "B halted closes the pair");
        _expectBuyRevert(nvdaAmd);
        // A paused: same
        vm.revertToState(snap);
        _remock();
        vm.prank(guardian);
        guard.setBuysPaused(NVDA, true);
        _expectBuyRevert(nvdaAmd);
        // sells stay open
        vm.revertToState(snap);
    }

    function _expectBuyRevert(bytes32 id) internal {
        _fundUsdg(bob, 100e6);
        vm.startPrank(bob);
        usdg.approve(address(minter), 100e6);
        vm.expectRevert();
        minter.buy(id, 100e6, 0, bob, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();
    }

    /// Governor exposure shows +2V on A and -2V on B (V = holders' value of the pair).
    function test_PairExposureBothSides() public {
        uint256 t = _hookBuy(alice, nvdaAmd, 10_000e6);
        (uint256 v,) = minter.valuePerToken(nvdaAmd);
        uint256 val = t * v / 1e18;
        (int256 dA,,) = gov.exposure(NVDA);
        (int256 dB,,) = gov.exposure(AMD);
        assertApproxEqRel(dA, int256(2 * val), 1e12, "+2V on A");
        assertApproxEqRel(dB, -int256(2 * val), 1e12, "-2V on B");
        // QQQ/SPY likewise
        t = _hookBuy(alice, qqqSpy, 5_000e6);
        (v,) = minter.valuePerToken(qqqSpy);
        val = t * v / 1e18;
        (int256 dQ,,) = gov.exposure(QQQ);
        (int256 dS,,) = gov.exposure(SPY);
        assertApproxEqRel(dQ, int256(2 * val), 1e12);
        assertApproxEqRel(dS, -int256(2 * val), 1e12);
    }
}
