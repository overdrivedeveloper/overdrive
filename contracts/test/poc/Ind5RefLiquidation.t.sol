// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackerFixture} from "../backer/BackerFixture.sol";
import {MockV3OraclePool} from "../mocks/OracleMocks.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {MarketConfig, PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";

/// Independent check 5, regressions (flipped from the auditor's PoCs, where a pass was the finding). On the repo's
/// own fixture (real ODBacker, ODGovernor, ODMinter, ODOracleGuard, ODInsurance; mock feed, Pyth and v3 pool).
///
/// I5-1 (Medium): `sealBatch` / `executeBatch` valued debt at max(value(p), value(refP)) and only needed a live
/// reading with refP != 0, so a reference that DISAGREED with the feed (a few seconds of a v3 TWAP at an extreme
/// tick) liquidated healthy vaults and drew insurance. Now a seal is refused and an execute is voided while the
/// guard's liquidationBlock is not zero: reference outside the band, continuity or split pause, not live.
///
/// I5-2 (Medium, not fixed here: an app-side lane owns the Pyth push): a Pyth-only market with no push stays fail
/// closed; the test records that state.
///
/// I5-3 (Low): a seal needed a feed round at most 15 minutes old while quiet feeds print hours apart. The round-age
/// rule is gone: the guard's per-market age limit and the agreeing, fresh reference stand for the round.
contract Ind5RefLiquidationTest is BackerFixture {
    int24 internal constant TICK0 = -221107; // 1.0001^tick * 1e12 = 249.99 USDG per stock token (18 dp vs 6 dp)
    MockV3OraclePool internal pool;

    /// TSLA as on mainnet today: Pyth configured but stale, so the v3 TWAP is the reference.
    function _twapIsTheReference() internal {
        pool = new MockV3OraclePool(address(stockOf[TSLA]), address(usdg), TICK0);
        MarketConfig memory c = guard.config(TSLA);
        c.twapPool = address(pool);
        c.twapWindow = 30 minutes;
        vm.prank(admin);
        guard.setMarket(TSLA, c);
        _dropRef(TSLA);
        (uint256 refP, bool fromPyth) = guard.refPrice(TSLA);
        assertFalse(fromPyth, "reference is the TWAP");
        assertApproxEqRel(refP, 250e18, 0.001e18, "TWAP starts at the feed price");
        assertFalse(guard.read(TSLA).buysPaused, "in band");
    }

    /// Holds the pool at `spikeTick` for `secs` seconds, then lets it fall back (what one buy-out of the in-range
    /// liquidity and a sell-back does to a v3 pool's tick cumulative).
    function _spike(int24 spikeTick, uint256 secs) internal {
        pool.setTick(spikeTick);
        vm.warp(vm.getBlockTimestamp() + secs);
        pool.setTick(TICK0);
    }

    function _ids(uint256 v) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = v;
    }

    function _ratioAtFeedOnly(uint256 v) internal view returns (uint256) {
        uint256 debtWad = Math.mulDiv(_debt(v), _valueAt(sport, guard.read(TSLA).p, Math.Rounding.Ceil), 1e18);
        return Math.mulDiv(_coll(v) * 1e12, 10_000, debtWad);
    }

    // ------------------------------------------------------------------------------------------------ control

    /// Control: with the reference inside the band a vault at the initial ratio cannot be sealed.
    function test_I5_1_Control_InBandReference_SealRefused() public {
        _twapIsTheReference();
        uint256 v = _sportVault(bob);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("NONE_UNHEALTHY")));
        backer.sealBatch(sport, _ids(v));
    }

    // ------------------------------------------------------------------------------------------------ I5-1

    /// A 12 second spike that lifts the 30 minute mean tick by 1,500 (+16%) used to liquidate a vault that sits at 200%
    /// on the feed (maintenance 150%). Now the seal is refused REF_BAND, for as long as the reference disagrees.
    function test_I5_1_OutOfBandTwap_CannotSealAHealthyVault() public {
        _twapIsTheReference();
        uint256 v = _sportVault(bob); // 1000 USDG, 500 tokens = 500 USD of debt at the feed price: 200%

        _spike(TICK0 + 225_000, 12); // mean tick over the window: +1,500

        PriceReading memory r = guard.read(TSLA);
        assertEq(r.p, 250e18, "the feed did not move");
        assertTrue(r.fresh && r.session == Session.OPEN, "live");
        assertEq(r.reason, bytes32("REF_BAND"), "the guard reports the disagreement");
        assertGt(r.refP, 285e18, "the TWAP reads +16%");
        assertGe(_ratioAtFeedOnly(v), 19_900, "the vault is at ~200% on the feed, far above maintenance");
        assertEq(guard.liquidationBlock(TSLA), bytes32("REF_BAND"));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_BAND")));
        backer.sealBatch(sport, _ids(v));
        assertEq(_coll(v), 1_000e6, "collateral untouched");
        assertEq(_debt(v), 500e18);
    }

    /// The same 12 seconds at the top of the tick range (price x2.08, SPORT value x4.33) used to take all collateral
    /// and draw 1,275 USDG of insurance. Now: refused, insurance untouched.
    function test_I5_1_ExtremeSpike_CannotSealOrDrawInsurance() public {
        _twapIsTheReference();
        usdg.mint(address(ins), 50_000e6);
        uint256 v = _sportVault(bob);

        _spike(TICK0 + 1_100_000, 12);
        assertEq(guard.read(TSLA).p, 250e18, "the feed did not move");

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_BAND")));
        backer.sealBatch(sport, _ids(v));
        assertEq(_coll(v), 1_000e6);
        assertEq(usdg.balanceOf(address(ins)), 50_000e6, "insurance untouched");
        assertEq(usdg.balanceOf(carol), 0);
    }

    /// A manual pause (or a disabled market) comes first in the guard's `reason`; it must not hide the disagreement,
    /// and by itself it must not stop a rightful liquidation.
    function test_I5_1_ManualPauseNeitherHidesTheBandNorBlocksLiquidation() public {
        _twapIsTheReference();
        uint256 v = _sportVault(bob);
        vm.prank(guardian);
        guard.setBuysPaused(TSLA, true);
        _spike(TICK0 + 225_000, 12);
        assertEq(guard.read(TSLA).reason, bytes32("MANUAL"), "the manual pause is the reported reason");
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_BAND")));
        backer.sealBatch(sport, _ids(v));

        // reference back in band at a price that really puts the vault under maintenance: sealable while paused
        MarketConfig memory c = guard.config(TSLA);
        c.twapPool = address(0);
        vm.prank(admin);
        guard.setMarket(TSLA, c);
        feedOf[TSLA].push(int256(300e18 / 1e10));
        _ref(TSLA, 300e18);
        assertEq(guard.read(TSLA).reason, bytes32("MANUAL"));
        assertEq(guard.liquidationBlock(TSLA), bytes32(0));
        backer.sealBatch(sport, _ids(v));
    }

    /// A vault rightly sealed is not executed on a reference that left the band after the seal: the batch is voided.
    function test_I5_1_ExecuteVoidsWhenTheReferenceLeavesTheBand() public {
        uint256 v = _sportVault(bob);
        _price(TSLA, 300e18); // under maintenance on both sources
        uint256 batchId = backer.sealBatch(sport, _ids(v));
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY() + 1);
        _ref(TSLA, 310e18); // +3.3%: outside the 2% band
        vm.expectEmit(address(backer));
        emit IODBacker.BatchVoided(batchId, "REF_BAND");
        assertEq(backer.executeBatch(batchId), 0);
        assertEq(_debt(v), 500e18, "not liquidated");
        (,,,, uint256 inBatch) = backer.vault(v);
        assertEq(inBatch, 0, "the vault is free again");
    }

    /// No reference outside the band ever seals, whatever its side or size; inside the band the seal is decided by
    /// the vault's health alone (here: healthy at the feed price, so never sealable on an in-band reference above
    /// maintenance by a wide margin).
    function testFuzz_I5_1_NoOutOfBandReferenceSeals(uint256 refP) public {
        refP = bound(refP, 1e18, 100_000e18);
        uint256 v = _sportVault(bob); // 200% at the feed price 250
        _ref(TSLA, refP);
        bool inBand = refP >= 245.1e18 && refP <= 254.9e18;
        bool outOfBand = refP < 244.9e18 || refP > 255.1e18;
        if (outOfBand) {
            vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_BAND")));
            backer.sealBatch(sport, _ids(v));
        } else if (inBand) {
            vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("NONE_UNHEALTHY")));
            backer.sealBatch(sport, _ids(v));
        }
    }

    // ------------------------------------------------------------------------------------------------ I5-2

    /// ETH (and BTC) on mainnet: twapPool is 0x0, so Pyth is the only reference. Nothing in the repo pushes Pyth.
    function test_I5_2_PythOnlyMarket_NoPush_NoBuySellFillOrSeal() public {
        uint256 tokens = _buy(alice, ethSport, 1_000e6);
        uint256 v = _open(bob, ethSport, 1_000e6);
        _mint(bob, v, 100e18, true);

        _dropRef(ETH); // nobody pushed Pyth inside refMaxAge (the live state on 4663)
        PriceReading memory r = guard.read(ETH);
        assertEq(r.refP, 0);
        assertEq(r.reason, bytes32("REF_UNAVAILABLE"));

        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(minter), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.BuysClosed.selector, ethSport, bytes32("REF_UNAVAILABLE")));
        minter.buy(ethSport, 100e6, 0, alice, uint64(vm.getBlockTimestamp() + 1));
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(ethSport, tokens, 0, alice, uint64(vm.getBlockTimestamp() + 1));
        uint256 ticket = minter.queueSell(ethSport, tokens, 0, alice);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);

        // a crash that leaves the vault far under maintenance on the feed: still no seal without a Pyth push
        feedOf[ETH].push(int256(_p(ETH) * 13 / 10 / 1e10));
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_UNAVAILABLE")));
        backer.sealBatch(ethSport, _ids(v));
    }

    // ------------------------------------------------------------------------------------------------ I5-3

    /// A vault under maintenance on both sources is sealable on a round hours old (it used to revert STALE_ROUND past
    /// 15 minutes), as long as the guard calls the round fresh and the fresh reference agrees inside the band.
    function test_I5_3_QuietFeed_UnhealthyVaultIsSealableOnAnOldRound() public {
        uint256 v = _sportVault(bob);
        _price(TSLA, 300e18); // SPORT value x1.44: ratio ~139%, under the 150% maintenance
        vm.warp(vm.getBlockTimestamp() + 3 hours);
        _ref(TSLA, 300e18); // the reference is fresh and agrees
        PriceReading memory r = guard.read(TSLA);
        assertTrue(r.fresh && !r.buysPaused && r.session == Session.OPEN, "live, fresh, in band");
        (,, uint256 ratio,, uint256 maint) = backer.health(v);
        assertLt(ratio, maint, "under maintenance");
        uint256 batchId = backer.sealBatch(sport, _ids(v));
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY() + 1);
        assertEq(backer.executeBatch(batchId), 1, "liquidated on the 3 h old round");
    }

    /// The Friday uplift window on a quiet feed: the uplift switches on 2 h before the close and puts a vault under
    /// maintenance with no new round. With a 3 h old round it is sealable; without an agreeing reference it is not.
    function test_I5_3_FridayUpliftWindowWithAThreeHourOldRound() public {
        uint256 v = _sportVault(bob); // 200% at 250
        _price(TSLA, 252e18); // the last round before a quiet afternoon: about 197%, far above the 150% maintenance
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("NONE_UNHEALTHY")));
        backer.sealBatch(sport, _ids(v));
        vm.warp(vm.getBlockTimestamp() + 3 hours);
        _ref(TSLA, 252e18);
        _uplift(true); // maintenance 150% + 50 points
        (,, uint256 ratio,, uint256 maint) = backer.health(v);
        assertLt(ratio, maint, "under maintenance with the uplift on");
        uint256 snap = vm.snapshotState();
        _dropRef(TSLA);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_UNAVAILABLE")));
        backer.sealBatch(sport, _ids(v));
        vm.revertToState(snap);
        backer.sealBatch(sport, _ids(v));
    }
}
