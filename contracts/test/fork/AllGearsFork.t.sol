// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UD60x18, ud} from "@prb/math/src/UD60x18.sol";
import {ForkSystem} from "./ForkSystem.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {Gear, GearConfig, GearStatus, PriceReading, Quote} from "overdrive/interfaces/ODTypes.sol";

/// R1 to R5, R9 to R11 of todo 08 on the real Robinhood Chain state (see ForkSystem).
contract AllGearsForkTest is ForkSystem {
    // ------------------------------------------------------------------------------------- independent maths

    /// Value per token for the SELLER, computed with PRBMath only (never ODIndex): nf x r^power x unit, ratio rounded
    /// down (up for REVERSE, whose index falls with r), clamped to the [0.02, 50] domain.
    function _indepValue(GearConfig memory c, uint256 p, uint256 nf) internal pure returns (uint256) {
        uint256 r = c.gear == Gear.REVERSE ? (p * WAD + c.p0 - 1) / c.p0 : p * WAD / c.p0;
        if (r < 0.02e18) r = 0.02e18;
        if (r > 50e18) r = 50e18;
        UD60x18 x = ud(r);
        UD60x18 i;
        if (c.gear == Gear.SPORT) i = x.mul(x);
        else if (c.gear == Gear.RACE) i = x.mul(x).mul(x);
        else if (c.gear == Gear.CRUISE) i = x.mul(x.sqrt());
        else if (c.gear == Gear.ECO) i = x.sqrt();
        else i = ud(WAD).div(x);
        return ud(nf).mul(i).mul(ud(c.unitWad)).unwrap();
    }

    function _reading(bytes32 id) internal view returns (PriceReading memory) {
        GearConfig memory c = reg.gear(id);
        return c.marketB == NONE ? guard.read(c.marketA) : guard.readRatio(c.marketA, c.marketB);
    }

    /// Expected USDG for selling `tokens` now: tokens x min(value at p, value at refP) x (1 - spread).
    function _expectedSell(bytes32 id, uint256 tokens, uint16 spreadBps) internal view returns (uint256) {
        GearConfig memory c = reg.gear(id);
        uint256 nf = minter.normState(id).nf;
        PriceReading memory r = _reading(id);
        uint256 vp = _indepValue(c, r.p, nf);
        uint256 vr = _indepValue(c, r.refP, nf);
        uint256 v = vp < vr ? vp : vr;
        uint256 price = v * (10_000 - spreadBps) / 10_000;
        return tokens * price / 1e30;
    }

    /// Independent mirror of the M-4 per-gear lag floor (D28): f = ceil(|p| x band / 2 x (1 + |p| x band)) in bps,
    /// with |p| the gear's power (CRUISE 1.5, SPORT 2, RACE 3, ECO 0.5, REVERSE 1) and band = tradeParams().lagBandBps
    /// (twice that for a pair).
    /// The spread of a plain sell (no skew, no discount, no closed extra) is max(base spread, floor).
    function _expectedPlainSpread(bytes32 id) internal view returns (uint256) {
        GearConfig memory c = reg.gear(id);
        uint256 pw = c.gear == Gear.CRUISE
            ? 15
            : c.gear == Gear.SPORT ? 20 : c.gear == Gear.RACE ? 30 : c.gear == Gear.ECO ? 5 : 10;
        uint256 band = minter.tradeParams().lagBandBps;
        if (c.marketB != bytes32(0)) band *= 2; // a pair: both legs' bands (M-4 pair leg, rescore 2)
        uint256 m = pw * band; // |power| x band, in bps x 10 x 1e4 scale below
        // f_bps = (pw/10 x band/1e4) / 2 x (1 + pw/10 x band/1e4) x 1e4, rounded up; m = pw x band (units of 1e-1 bps).
        uint256 num = m * (100_000 + m); // m is in 1e-5 units
        uint256 den = 2 * 10 * 100_000; // 2 x 10 (power scale) x 1e5
        uint256 f = (num + den - 1) / den;
        return f > c.spreadBps ? f : c.spreadBps;
    }

    /// Hook sell of `tokens` checked against the independent expectation (within 1 wei of USDG).
    function _checkedSell(bytes32 id, uint256 tokens) internal returns (uint256 out) {
        minter.accrue(id); // NF now, same block as the sell
        Quote memory q = minter.quote(id, false, true, tokens);
        assertEq(q.spreadBps, _expectedPlainSpread(id), "max(base spread, lag floor), no skew on a shrinking sell");
        uint256 exp = _expectedSell(id, tokens, q.spreadBps);
        out = _hookSell(alice, id, tokens);
        assertApproxEqAbs(out, exp, 1, "tokens x NF x I x UNIT x (1 - spread)");
    }

    // ------------------------------------------------------------------------------------------------- R1

    function _roundTrip(bytes32 id) internal {
        GearConfig memory c = reg.gear(id);
        uint256 t = _hookBuy(alice, id, 1_000e6);
        assertGt(t, 0, "bought through the hook");
        uint256 nf0 = minter.normState(id).nf;
        _crank(24);
        uint256 nf1 = minter.normState(id).nf;
        if (c.gear == Gear.ECO) assertGt(nf1, nf0, "ECO NF rises");
        else assertLt(nf1, nf0, "toll paid");
        walkPrice(c.marketA, 1000);
        _refresh();
        uint256 up = _checkedSell(id, t / 2);
        walkPrice(c.marketA, -1000);
        _refresh();
        uint256 down = _checkedSell(id, t - t / 2);
        assertEq(_token(id).balanceOf(alice), 0);
        if (c.gear == Gear.REVERSE) assertGt(down, up, "REVERSE gains when the price falls");
        else assertGt(up, down);
    }

    function test_RoundTrip_ETH_CRUISE() public {
        _roundTrip(gearOf[ETH][Gear.CRUISE]);
    }

    function test_RoundTrip_ETH_SPORT() public {
        _roundTrip(gearOf[ETH][Gear.SPORT]);
    }

    function test_RoundTrip_ETH_ECO() public {
        _roundTrip(gearOf[ETH][Gear.ECO]);
    }

    function test_RoundTrip_ETH_REVERSE() public {
        _roundTrip(gearOf[ETH][Gear.REVERSE]);
    }

    function test_RoundTrip_BTC_CRUISE() public {
        _roundTrip(gearOf[BTC][Gear.CRUISE]);
    }

    function test_RoundTrip_BTC_SPORT() public {
        _roundTrip(gearOf[BTC][Gear.SPORT]);
    }

    function test_RoundTrip_BTC_ECO() public {
        _roundTrip(gearOf[BTC][Gear.ECO]);
    }

    function test_RoundTrip_BTC_REVERSE() public {
        _roundTrip(gearOf[BTC][Gear.REVERSE]);
    }

    function test_RoundTrip_NVDA_CRUISE() public {
        _roundTrip(gearOf[NVDA][Gear.CRUISE]);
    }

    function test_RoundTrip_NVDA_SPORT() public {
        _roundTrip(gearOf[NVDA][Gear.SPORT]);
    }

    function test_RoundTrip_NVDA_ECO() public {
        _roundTrip(gearOf[NVDA][Gear.ECO]);
    }

    function test_RoundTrip_NVDA_REVERSE() public {
        _roundTrip(gearOf[NVDA][Gear.REVERSE]);
    }

    function test_RoundTrip_TSLA_CRUISE() public {
        _roundTrip(gearOf[TSLA][Gear.CRUISE]);
    }

    function test_RoundTrip_TSLA_SPORT() public {
        _roundTrip(gearOf[TSLA][Gear.SPORT]);
    }

    function test_RoundTrip_TSLA_ECO() public {
        _roundTrip(gearOf[TSLA][Gear.ECO]);
    }

    function test_RoundTrip_TSLA_REVERSE() public {
        _roundTrip(gearOf[TSLA][Gear.REVERSE]);
    }

    function test_RoundTrip_SPY_CRUISE() public {
        _roundTrip(gearOf[SPY][Gear.CRUISE]);
    }

    function test_RoundTrip_SPY_SPORT() public {
        _roundTrip(gearOf[SPY][Gear.SPORT]);
    }

    function test_RoundTrip_SPY_RACE() public {
        _roundTrip(gearOf[SPY][Gear.RACE]);
    }

    function test_RoundTrip_SPY_ECO() public {
        _roundTrip(gearOf[SPY][Gear.ECO]);
    }

    function test_RoundTrip_SPY_REVERSE() public {
        _roundTrip(gearOf[SPY][Gear.REVERSE]);
    }

    function test_RoundTrip_QQQ_CRUISE() public {
        _roundTrip(gearOf[QQQ][Gear.CRUISE]);
    }

    function test_RoundTrip_QQQ_SPORT() public {
        _roundTrip(gearOf[QQQ][Gear.SPORT]);
    }

    function test_RoundTrip_QQQ_RACE() public {
        _roundTrip(gearOf[QQQ][Gear.RACE]);
    }

    function test_RoundTrip_QQQ_ECO() public {
        _roundTrip(gearOf[QQQ][Gear.ECO]);
    }

    function test_RoundTrip_QQQ_REVERSE() public {
        _roundTrip(gearOf[QQQ][Gear.REVERSE]);
    }

    function test_RoundTrip_NVDA_AMD_SPORT() public {
        _roundTrip(nvdaAmd);
    }

    function test_RoundTrip_QQQ_SPY_SPORT() public {
        _roundTrip(qqqSpy);
    }

    // ---------------------------------------------------------------------------------------- real references

    /// Before any mock: the stocks read the REAL v3 TWAP (Pyth is 7 days stale); ETH and BTC (no v3 pool) and COIN
    /// (pool cardinality 1) have no reference, so their buys pause REF_UNAVAILABLE.
    function test_RealStateReferences() public {
        vm.clearMockedCalls();
        bytes32[6] memory twap = [TSLA, NVDA, SPY, QQQ, AMD, MSTR];
        for (uint256 i; i < twap.length; ++i) {
            PriceReading memory r = guard.read(twap[i]);
            (uint256 refP, bool fromPyth) = guard.refPrice(twap[i]);
            assertFalse(fromPyth, "Pyth stale on 4663");
            assertGt(refP, 0, "real TWAP reference");
            assertEq(r.refP, refP);
        }
        bytes32[3] memory none = [ETH, BTC, COIN];
        for (uint256 i; i < none.length; ++i) {
            PriceReading memory r = guard.read(none[i]);
            assertEq(r.refP, 0, "no reference");
            if (r.fresh) assertEq(r.reason, guard.REASON_REF_UNAVAILABLE(), "buys pause");
            assertTrue(r.buysPaused);
        }
        // ETH buys refuse on the real state
        bytes32 id = gearOf[ETH][Gear.SPORT];
        vm.expectRevert(abi.encodeWithSelector(IODMinter.BuysClosed.selector, id, bytes32("REF_UNAVAILABLE")));
        minter.quote(id, true, true, 100e6);
        _fundUsdg(alice, 100e6);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _keyParams(id, true, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(router), 100e6);
        vm.expectRevert();
        router.swapExactIn(key, p);
        vm.stopPrank();
    }

    /// COIN keeps no reference even with a fresh feed: buys pause REF_UNAVAILABLE, so no COIN gear and no COIN/MSTR pair
    /// can list (DECISIONS D20 pair). Sells never depend on it (no supply exists).
    function test_CoinBuysPauseRefUnavailable() public {
        _refresh();
        PriceReading memory r = guard.read(COIN);
        assertTrue(r.fresh, "fresh feed");
        assertEq(r.refP, 0);
        assertEq(r.reason, guard.REASON_REF_UNAVAILABLE());
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, COIN));
        reg.listGear(COIN, NONE, Gear.SPORT, 1e18, 1_000_000e18, 30, "COIN2X");
        vm.expectRevert(abi.encodeWithSelector(ODGearRegistry.MarketNotReady.selector, COIN));
        reg.listGear(COIN, MSTR, Gear.SPORT, 1e18, 1_000_000e18, 30, "COIN/MSTR2X");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------- R2

    /// After +10% (same block, NF fixed): SPORT +21%, CRUISE +15.4%, RACE +33.1%, ECO +4.88%, REVERSE -9.09%.
    function test_OverviewTableOnChain() public {
        uint256[5] memory before;
        for (uint256 g; g < 5; ++g) {
            (before[g],) = minter.valuePerToken(gearOf[SPY][Gear(g)]);
        }
        walkPrice(SPY, 1000);
        // 1.1^p for CRUISE, SPORT, RACE, ECO, REVERSE
        uint256[5] memory want = [uint256(1.153689732987e18), 1.21e18, 1.331e18, 1.04880884817e18, 0.909090909091e18];
        for (uint256 g; g < 5; ++g) {
            (uint256 v, bool inDomain) = minter.valuePerToken(gearOf[SPY][Gear(g)]);
            assertTrue(inDomain);
            assertApproxEqRel(v * WAD / before[g], want[g], 1e9, "overview table"); // 1e-9 relative (8-dp feed)
        }
    }

    // ------------------------------------------------------------------------------------------------- R3

    /// Over 7 days at sigma 50% ECO's NF grows by exp(0.125 x 0.25 x 7/365) (ln within 1e-9); no toll fee booked.
    function test_EcoHoldersReceive() public {
        bytes32 eco = gearOf[TSLA][Gear.ECO];
        assertEq(sigmaOf[TSLA], 5000);
        _hookBuy(alice, eco, 1_000e6);
        minter.accrue(eco);
        uint256 nf0 = minter.normState(eco).nf;
        uint256 owed0 = gov.feeOwed();
        uint256 fees0 = usdg.balanceOf(address(fees));
        int256 rate = minter.tollPerDay(eco);
        assertLt(rate, 0, "ECO toll is negative: holders receive");
        for (uint256 h; h < 7 * 24; ++h) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _setPx(TSLA, px[TSLA]);
            guard.poke(TSLA);
            _repost(TSLA);
            minter.accrue(eco);
        }
        _refresh();
        uint256 nf1 = minter.normState(eco).nf;
        uint256 grown = ud(nf1).div(ud(nf0)).ln().unwrap();
        // measured 2.0e-9 below the closed form (per-second compounding and integer rates); bound 1e-8
        assertApproxEqAbs(grown, uint256(0.125e18) * 2500 / 10_000 * 7 / 365, 1e10, "ln NF growth");
        assertEq(gov.feeOwed(), owed0, "no toll fee owed");
        assertEq(usdg.balanceOf(address(fees)), fees0, "no toll fee paid");
    }

    // ------------------------------------------------------------------------------------------------- R4

    /// REVERSE domain edge. The ratio domain is [0.02, 50]: -97% (r = 0.03) is still inside; past -98% REVERSE is out:
    /// buys blocked, sells pay the clamped value (r = 0.02), then the timelock settles and SETTLED sells pay no spread.
    function test_ReverseDomainEdgeSettles() public {
        bytes32 rev = gearOf[TSLA][Gear.REVERSE];
        uint256 t = _hookBuy(alice, rev, 1_000e6);
        walkPrice(TSLA, -9700);
        (, bool inDomain) = minter.valuePerToken(rev);
        assertTrue(inDomain, "-97% is inside the [0.02, 50] ratio domain");
        walkPrice(TSLA, -5000); // -98.5% overall
        _refresh();
        (uint256 v, bool inD) = minter.valuePerToken(rev);
        assertFalse(inD, "out of domain");
        assertApproxEqAbs(v, minter.normState(rev).nf * 50, 1e6, "clamped at r = 0.02: index 50");
        _fundUsdg(bob, 100e6);
        vm.startPrank(bob);
        usdg.approve(address(minter), 100e6);
        vm.expectRevert();
        minter.buy(rev, 100e6, 0, bob, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();
        uint256 part = t / 4;
        minter.accrue(rev);
        uint256 exp = _expectedSell(rev, part, 30);
        assertApproxEqAbs(_sell(alice, rev, part), exp, 1, "clamped value sell");
        // timelock batch (D25): minter.settleGear then registry.setStatus(SETTLED)
        vm.startPrank(admin);
        minter.settleGear(rev);
        reg.setStatus(rev, GearStatus.SETTLED);
        vm.stopPrank();
        uint256 sv = minter.settledValue(rev);
        assertGt(sv, 0);
        Quote memory q = minter.quote(rev, false, true, t - part);
        assertEq(q.spreadBps, 0, "settled: no spread");
        uint256 out = _sell(alice, rev, t - part);
        assertEq(out, (t - part) * sv / 1e30, "settled value, no spread");
    }

    // ------------------------------------------------------------------------------------------------- R5

    function test_RaceRefusedOnTsla() public {
        vm.startPrank(admin);
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.listGear(TSLA, NONE, Gear.RACE, 1e18, 1_000_000e18, 30, "TSLA3X");
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.listGear(ETH, NONE, Gear.RACE, 1e18, 1_000_000e18, 30, "ETH3X");
        vm.expectRevert(IODGearRegistry.NotAllowed.selector);
        reg.listGear(NVDA, NONE, Gear.RACE, 1e18, 1_000_000e18, 30, "NVDA3X");
        vm.stopPrank();
        (, uint64 ceil) = vol.bounds(SPY);
        assertLe(ceil, 4000, "SPY RACE listed under the 40% ceiling");
        assertTrue(gearOf[SPY][Gear.RACE] != bytes32(0));
    }

    // ------------------------------------------------------------------------------------------------- R9

    /// With the hedger's delta posted, adding ECO to a SPORT book lowers the Governor's gamma (ECO's is the opposite
    /// sign) and lowers the stress loss versus SPORT alone.
    function test_EcoOffsetsSportGamma() public {
        _hookBuy(alice, gearOf[NVDA][Gear.SPORT], 20_000e6);
        (int256 d1, int256 g1,) = gov.exposure(NVDA);
        vm.prank(admin);
        gov.postHedge(NVDA, d1, 0, uint64(vm.getBlockTimestamp()));
        _poke();
        (uint256 loss1,) = gov.cachedStress(NVDA);
        _hookBuy(bob, gearOf[NVDA][Gear.ECO], 20_000e6);
        (int256 d2, int256 g2,) = gov.exposure(NVDA);
        assertGt(g1, 0);
        assertLt(g2, g1, "ECO lowers gamma");
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(admin);
        gov.postHedge(NVDA, d2, 0, uint64(vm.getBlockTimestamp()));
        _poke();
        (uint256 loss2,) = gov.cachedStress(NVDA);
        assertLt(loss2, loss1, "ECO offsets SPORT under stress");
    }

    // ------------------------------------------------------------------------------------------------ R11

    /// Backer mints SPORT sold to the Governor; +40% puts the vault under maintenance; seal, wait SEAL_DELAY, fresh
    /// round, execute: holders' balances unchanged, Governor book consistent (net = supply - debt, debt cleared).
    function test_BackerLiquidationOnFork() public {
        bytes32 id = gearOf[NVDA][Gear.SPORT];
        uint256 held = _hookBuy(alice, id, 2_000e6);
        _fundUsdg(carol, 1_000e6);
        vm.startPrank(carol);
        usdg.approve(address(backer), type(uint256).max);
        uint256 vid = backer.openVault(id, 1_000e6);
        backer.mint(vid, 450e18, true, 0);
        vm.stopPrank();
        assertEq(gov.backerDebt(id), 450e18);
        walkPrice(NVDA, 6000);
        _refresh();
        (,, uint256 ratio,,) = backer.health(vid);
        assertLt(ratio, 15000, "under maintenance");
        uint256[] memory ids = new uint256[](1);
        ids[0] = vid;
        uint256 b = backer.sealBatch(id, ids);
        _warpFresh(backer.SEAL_DELAY() + 1);
        vm.prank(bob);
        uint256 liq = backer.executeBatch(b);
        assertEq(liq, 1);
        assertEq(_token(id).balanceOf(alice), held, "holders untouched");
        assertEq(gov.backerDebt(id), 0, "debt absorbed");
        assertEq(gov.netTokens(id), int256(_token(id).totalSupply()) - int256(gov.backerDebt(id)), "book");
        (int256 eq,,) = gov.cachedEquity();
        assertGt(eq, 0);
    }
}

/// R10 on the real system: donation to the EMPTY Governor and to ODBacker, then 4, 2 and 5,000 USDG deposits.
contract DonationForkTest is ForkSystem {
    function _seedUsdg() internal pure override returns (uint256) {
        return 0;
    }

    function _dep(address who, uint256 amount) internal returns (uint256 shares) {
        vm.prank(admin);
        gov.setDepositor(who, true);
        _fundUsdg(who, amount);
        vm.startPrank(who);
        usdg.approve(address(gov), amount);
        shares = gov.deposit(amount, who);
        vm.stopPrank();
    }

    function test_DonationBeforeFirstDeposit() public {
        address donor = makeAddr("donor");
        _fundUsdg(donor, 20_000e6);
        vm.startPrank(donor);
        usdg.transfer(address(gov), 10_000e6);
        usdg.transfer(address(backer), 10_000e6);
        vm.stopPrank();
        uint256 s1 = _dep(lp, 4e6);
        uint256 s2 = _dep(bob, 2e6);
        uint256 s3 = _dep(carol, 5_000e6);
        assertApproxEqRel(s1 * 2, s2 * 4, 1e15, "fair shares 4 vs 2");
        assertApproxEqRel(s3 * 4, s1 * 5_000, 1e15, "fair shares 5000 vs 4");
        assertApproxEqAbs(gov.convertToAssets(s3), 5_000e6, 2, "no donation captured");
        _refresh();
        (,, bool tripped) = gov.drawdown();
        assertFalse(tripped, "no drawdown trip");
        (bool paused,) = gov.buysPaused();
        assertFalse(paused, "buys open");
        bytes32 id = gearOf[NVDA][Gear.SPORT];
        uint256 t = _hookBuy(alice, id, 1_200e6);
        // a real loss: NVDA +40% makes the SPORT holder about 1,150 USDG richer, supply unchanged
        walkPrice(NVDA, 4000);
        _refresh();
        (,, tripped) = gov.drawdown();
        assertTrue(tripped, "real -20% loss trips");
        (paused,) = gov.buysPaused();
        assertTrue(paused);
        _fundUsdg(bob, 100e6);
        vm.startPrank(bob);
        usdg.approve(address(minter), 100e6);
        vm.expectRevert();
        minter.buy(id, 100e6, 0, bob, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();
        uint256 out = _hookSell(alice, id, t);
        assertGt(out, 2_000e6, "sells pay");
    }
}
