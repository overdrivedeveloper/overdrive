// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {MockV3OraclePool} from "../mocks/OracleMocks.sol";
import {GearConfig, GearStatus, MarketConfig, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";
import {HookStandIn} from "./Hook.t.sol";

/// I7-1: off a live reading (CLOSED, UNKNOWN, HALTED) the feed price is frozen, so the reference alone decides what a
/// sell is paid. A v3 TWAP is not enough there: one actor can hold a thin pool at the frozen price for one window.
/// Such a sell needs a Pyth print inside refMaxAge on every leg; otherwise it queues and fills at the first live round.
/// Every market here has BOTH a Pyth id and a v3 pool, as on mainnet.
contract ClosedSellReferenceTest is SystemFixture {
    int24 internal constant TICK_250 = -221_107; // 249.9914 USDG per token (18 dp against 6 dp)
    int24 internal constant TICK_125 = TICK_250 - 6_932; // half

    mapping(bytes32 => MockV3OraclePool) internal poolOf;
    HookStandIn internal hook;
    address internal pm = makeAddr("poolManager");

    function setUp() public override {
        super.setUp();
        _addPool(TSLA, TICK_250, false);
        _addPool(NVDA, TICK_125, false);
        hook = new HookStandIn(pm, minter);
        vm.prank(admin);
        minter.setHook(address(hook));
        vm.warp(vm.getBlockTimestamp() + 1 hours); // the pools have a full window of history
        _refreshAll();
    }

    /// Gives `m` a v3 pool at `tick` (stock token as base). `dropPyth`: the market has no Pyth id at all (plan B).
    function _addPool(bytes32 m, int24 tick, bool dropPyth) internal {
        MarketConfig memory c = guard.config(m);
        address base = c.stockToken;
        MockV3OraclePool p = base < address(usdg)
            ? new MockV3OraclePool(base, address(usdg), tick)
            : new MockV3OraclePool(address(usdg), base, -tick);
        poolOf[m] = p;
        c.twapPool = address(p);
        if (dropPyth) c.pythId = bytes32(0);
        vm.prank(admin);
        guard.setMarket(m, c);
    }

    function _setTick(bytes32 m, int24 tick) internal {
        poolOf[m].setTick(guard.config(m).stockToken < address(usdg) ? tick : -tick);
    }

    function _v(bytes32 id, uint256 p) internal view returns (uint256 v) {
        GearConfig memory c = reg.gear(id);
        (v,) = ODIndex.value(c.gear, p, c.p0, minter.normState(id).nf, c.unitWad, Math.Rounding.Floor);
    }

    /// 1 CLOSED, 2 UNKNOWN (calendar), 3 HALTED (issuer pause, calendar open).
    function _notLive(uint8 kind) internal {
        if (kind == 1) {
            _session(Session.CLOSED);
        } else if (kind == 2) {
            _session(Session.UNKNOWN);
        } else {
            stockOf[TSLA].setOraclePaused(true);
            guard.poke(TSLA);
        }
    }

    function _assertQueued(bytes32 id, uint256 t) internal {
        Quote memory q = _quote(id, false, true, t);
        assertTrue(q.queued, "quote: queue");
        assertEq(q.amountOut, 0, "no price quoted");
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(id, t, 0, alice, uint64(vm.getBlockTimestamp()));
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sellForExactUsdg(id, 1e6, t, alice, uint64(vm.getBlockTimestamp()));
        vm.expectRevert(IODMinter.UseQueue.selector);
        hook.swap(id, false, true, t, address(hook));
        vm.expectRevert(IODMinter.UseQueue.selector);
        hook.swap(id, false, false, 1e6, address(hook));
    }

    function _twapOnly(bytes32 m) internal {
        _dropRef(m);
        (uint256 refP, bool fromPyth) = guard.refPrice(m);
        assertGt(refP, 0, "the guard still reports the TWAP");
        assertFalse(fromPyth, "not Pyth");
    }

    // ------------------------------------------------------------------------------------ the rule, each session

    /// TWAP alone: CLOSED, UNKNOWN and HALTED sells all queue, on the direct path and the hook path.
    function test_NotLive_TwapOnly_Queues() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        for (uint8 k = 1; k <= 3; ++k) {
            uint256 snap = vm.snapshotState();
            _notLive(k);
            _twapOnly(TSLA);
            assertEq(uint256(guard.read(TSLA).session), k == 1 ? 2 : k == 2 ? 3 : 4, "session");
            _assertQueued(sport, t);
            vm.revertToState(snap);
        }
    }

    /// A fresh Pyth print: the same sells are paid at the lower of the frozen value and the Pyth value, and the quote
    /// is the execution to the wei.
    function test_NotLive_FreshPyth_PaysTheLowerValue() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        for (uint8 k = 1; k <= 3; ++k) {
            uint256 snap = vm.snapshotState();
            _notLive(k);
            _setTick(TSLA, TICK_250 + 2_000); // the pool says +22%: ignored while Pyth answers
            vm.warp(vm.getBlockTimestamp() + 31 minutes);
            _ref(TSLA, 245e18);
            Quote memory q = _quote(sport, false, true, t);
            assertFalse(q.queued);
            assertEq(q.valuePerTokenWad, _v(sport, 245e18), "the Pyth value (lower)");
            assertEq(_sell(alice, sport, t / 2), _quote(sport, false, true, t / 2).amountOut, "quote = execution");
            _ref(TSLA, 255e18);
            assertEq(_quote(sport, false, true, t / 2).valuePerTokenWad, _v(sport, 250e18), "the frozen value (lower)");
            vm.revertToState(snap);
        }
    }

    /// The attack of I7-1 in one test: the market fell while closed, the holder lifts the pool to the frozen price or
    /// far above it for longer than the window. No lift makes the sell payable; the exit is the queue, filled at the
    /// first live round at the market's price.
    function test_LiftedTwap_NeverPays_QueueFillsAtTheLivePrice() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        _dropRef(TSLA);
        _setTick(TSLA, TICK_250 - 408); // the weekend: the pool trades 4% lower
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        _assertQueued(sport, t);
        int24[3] memory lifts = [TICK_250, TICK_250 + 500, TICK_250 + 5_000];
        for (uint256 i; i < 3; ++i) {
            _setTick(TSLA, lifts[i]);
            vm.warp(vm.getBlockTimestamp() + 31 minutes);
            assertGe(guard.read(TSLA).refP, 249.9e18, "the TWAP is back at the frozen price or above");
            _assertQueued(sport, t);
        }
        uint256 cash = usdg.balanceOf(address(gov));
        vm.startPrank(alice);
        _token(sport).approve(address(minter), t);
        uint256 ticket = minter.queueSell(sport, t, 0, alice);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);
        assertEq(usdg.balanceOf(address(gov)), cash, "nothing paid while closed");

        // the first live round prints the market's price; the pool is still held up
        _session(Session.OPEN);
        _price(TSLA, 240e18);
        Quote memory q = _quote(sport, false, true, t);
        assertEq(q.valuePerTokenWad, _v(sport, 240e18), "the live value");
        uint256 out = minter.fillQueued(ticket);
        assertEq(out, q.amountOut, "quote = fill");
        assertLt(out, 10_000e6 * 93 / 100, "SPORT on a 4% fall: about 8% lower, not the frozen price");
    }

    /// In session nothing changes: a live feed price with the TWAP as the only reference still pays a sell.
    function test_Live_TwapOnly_StillPays() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _twapOnly(TSLA);
        Quote memory q = _quote(sport, false, true, t);
        assertFalse(q.queued);
        assertEq(_sell(alice, sport, t), q.amountOut);
    }

    // ------------------------------------------------------------------------------------------------ pair gear

    /// A pair needs a Pyth print on BOTH legs: one leg on its TWAP is enough to move the ratio.
    function test_Pair_NeedsPythOnBothLegs() public {
        uint256 t = _buy(alice, pair, 10_000e6);
        _session(Session.CLOSED);
        _twapOnly(NVDA); // numerator on Pyth, denominator on the pool
        _assertQueued(pair, t);
        _ref(NVDA, 125e18);
        _twapOnly(TSLA); // the other way round
        _assertQueued(pair, t);
        _dropRef(NVDA); // neither
        _assertQueued(pair, t);
        _ref(TSLA, 250e18);
        _ref(NVDA, 125e18);
        Quote memory q = _quote(pair, false, true, t);
        assertFalse(q.queued, "both legs on Pyth: payable");
        assertEq(_sell(alice, pair, t), q.amountOut);
    }

    /// One leg HALTED (issuer pause) while the calendar is open: the pair is not live, same rule.
    function test_Pair_OneLegHalted() public {
        uint256 t = _buy(alice, pair, 10_000e6);
        stockOf[NVDA].setOraclePaused(true);
        guard.poke(NVDA);
        _twapOnly(NVDA);
        _assertQueued(pair, t);
        _ref(NVDA, 125e18);
        assertEq(_sell(alice, pair, t), _quote(pair, false, true, t).amountOut);
    }

    // ----------------------------------------------------------------------------- no Pyth at all (plan B)

    /// Pyth removed from the market (the trial lapsed): the TWAP is the only reference. In session sells are paid;
    /// off session every sell queues, and the queue fills at the next live round. No exit is stuck.
    function test_NoPythConfigured_ClosedSellsExitThroughTheQueue() public {
        _addPool(TSLA, TICK_250, true);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _refreshAll();
        uint256 t = _buy(alice, sport, 10_000e6);
        assertEq(_sell(alice, sport, t / 4), _quote(sport, false, true, t / 4).amountOut, "live: paid");
        t -= t / 4;
        for (uint8 k = 1; k <= 3; ++k) {
            uint256 snap = vm.snapshotState();
            _notLive(k);
            _assertQueued(sport, t);
            vm.revertToState(snap);
        }
        _session(Session.CLOSED);
        vm.startPrank(alice);
        _token(sport).approve(address(minter), t);
        uint256 ticket = minter.queueSell(sport, t, 0, alice);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        _session(Session.OPEN);
        _refreshAll();
        uint256 before = usdg.balanceOf(alice);
        uint256 out = minter.fillQueued(ticket);
        assertGt(out, 7_000e6, "the queued exit is paid at the live price");
        assertEq(usdg.balanceOf(alice) - before, out);
    }

    /// Pyth configured but silent for days (stale, absent, or its contract gone): same as no Pyth.
    function test_PythSilent_QueueThenCancelOrFill() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        _assertQueued(sport, t);
        vm.startPrank(alice);
        _token(sport).approve(address(minter), t);
        uint256 ticket = minter.queueSell(sport, t / 2, 0, alice);
        minter.cancelQueued(ticket); // the holder is never locked into the queue
        assertEq(_token(sport).balanceOf(alice), t);
        ticket = minter.queueSell(sport, t, 0, alice);
        vm.stopPrank();
        _session(Session.OPEN);
        feedOf[TSLA].push(250e8); // a live round; the reference is the pool (Pyth still silent)
        guard.poke(TSLA);
        _repost(TSLA);
        _poke();
        assertGt(minter.fillQueued(ticket), 9_000e6, "fills on the live round with the TWAP as reference");
    }

    /// A market that never reopens: after settleAfterHalt the timelock settles the gear and every exit, queued or
    /// not, is paid at the settled value with no reference at all.
    function test_HaltedForGood_SettlementPaysTheQueue() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        _dropRef(TSLA);
        _assertQueued(sport, t);
        vm.startPrank(alice);
        _token(sport).approve(address(minter), t);
        uint256 ticket = minter.queueSell(sport, t / 2, 0, alice);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(admin);
        minter.settleGear(sport);
        vm.prank(admin);
        reg.setStatus(sport, GearStatus.SETTLED);
        assertGt(minter.fillQueued(ticket), 0, "queued exit paid at settlement");
        assertGt(_sell(alice, sport, t - t / 2), 0, "direct exit paid at settlement");
    }

    /// 24/7 markets are always live: nothing here touches them.
    function test_AlwaysOpenMarketUnaffected() public {
        uint256 t = _buy(alice, ethSport, 10_000e6);
        _session(Session.CLOSED);
        assertEq(_sell(alice, ethSport, t), _quote(ethSport, false, true, t).amountOut);
    }

    // ------------------------------------------------------------------------------------------------ invariant

    /// No sell off a live reading pays more than the value at a reference one actor cannot move: with the pool at
    /// any level and Pyth silent it pays nothing (queue); with a Pyth print it pays at most the Pyth value.
    function testFuzz_NotLiveSellNeverAboveThePythValue(uint8 kind, int24 dTick, uint256 pythP, bool pythFresh, uint8 g)
        public
    {
        kind = uint8(bound(kind, 1, 3));
        dTick = int24(bound(dTick, -20_000, 20_000));
        pythP = bound(pythP, 150e18, 400e18);
        bytes32[5] memory ids = [cruise, sport, race, eco, reverse];
        bytes32 id = ids[bound(g, 0, 4)];
        uint256 t = _buy(alice, id, 5_000e6);
        _notLive(kind);
        _setTick(TSLA, TICK_250 + dTick);
        vm.warp(vm.getBlockTimestamp() + 31 minutes);
        _dropRef(TSLA);
        if (pythFresh) _ref(TSLA, pythP);
        Quote memory q = _quote(id, false, true, t);
        if (!pythFresh) {
            assertTrue(q.queued, "no Pyth: queue, whatever the pool says");
            vm.prank(alice);
            vm.expectRevert(IODMinter.UseQueue.selector);
            minter.sell(id, t, 0, alice, uint64(vm.getBlockTimestamp()));
            return;
        }
        PriceReading memory r = guard.read(TSLA);
        if (q.queued) return; // refused for another reason (reserve, reference dropped): never a payout
        assertLe(q.valuePerTokenWad, _v(id, r.refP), "at most the Pyth value");
        assertLe(q.valuePerTokenWad, _v(id, r.p), "at most the frozen value");
        assertEq(_sell(alice, id, t), q.amountOut, "quote = execution");
    }
}
