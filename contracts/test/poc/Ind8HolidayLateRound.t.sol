// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {HookStandIn} from "../minter/Hook.t.sol";
import {MockV3OraclePool} from "../mocks/OracleMocks.sol";
import {GearConfig, MarketConfig, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";

/// I8-1 (independent audit 8), regression. Before fix round 11 a feed round stamped a few seconds after a 24 hour
/// holiday close was under LONG_CLOSE old at the reopen and read live, so a buyer or seller who held the v3 pool at
/// the old price for one TWAP window traded at the pre-holiday value. Now a round printed before or inside a long
/// close is HALTED at the reopen: buys are closed, a TWAP-only sell goes to the queue, and the ticket fills at the
/// first round printed after the reopen. Each test here failed on 5a4c9e7 except the control.
contract Ind8HolidayLateRoundTest is SystemFixture {
    int24 internal constant TICK_250 = -221_107; // 249.9914 USDG per token
    MockV3OraclePool internal pool;
    HookStandIn internal hook;
    address internal pm = makeAddr("poolManager");
    uint256 internal closeAt;
    uint256 internal tokens;

    function setUp() public override {
        super.setUp();
        hook = new HookStandIn(pm, minter);
        vm.prank(admin);
        minter.setHook(address(hook));
        MarketConfig memory c = guard.config(TSLA);
        address base = c.stockToken;
        pool = base < address(usdg)
            ? new MockV3OraclePool(base, address(usdg), TICK_250)
            : new MockV3OraclePool(address(usdg), base, -TICK_250);
        c.twapPool = address(pool);
        vm.prank(admin);
        guard.setMarket(TSLA, c);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _refreshAll();
        tokens = _buy(alice, sport, 10_000e6);
        closeAt = vm.getBlockTimestamp() + 1 hours;
        cal.addStep(closeAt, Session.CLOSED); // the holiday eve, 20:00
        cal.addStep(closeAt + 24 hours, Session.EXTENDED); // the holiday, 20:00: the overnight session reopens
    }

    function _setTick(int24 tick) internal {
        pool.setTick(guard.config(TSLA).stockToken < address(usdg) ? tick : -tick);
    }

    function _v(uint256 p) internal view returns (uint256 v) {
        GearConfig memory c = reg.gear(sport);
        (v,) = ODIndex.value(c.gear, p, c.p0, minter.normState(sport).nf, c.unitWad, Math.Rounding.Floor);
    }

    /// The market falls 4% over the holiday (the pool follows), then the holder lifts the pool back to the old price
    /// for one TWAP window before the reopen. Pyth has no print inside refMaxAge at the reopen.
    function _holiday(int24 marketTick) internal {
        vm.warp(closeAt + 1 hours);
        _setTick(marketTick);
        vm.warp(closeAt + 24 hours - 31 minutes);
        _setTick(TICK_250);
        vm.warp(closeAt + 24 hours);
        _dropRef(TSLA);
    }

    function _assertHaltedAndQueued(bytes32 id, uint256 t) internal {
        PriceReading memory r = guard.read(TSLA);
        assertEq(uint256(r.session), uint256(Session.HALTED), "HALTED until the feed prints");
        assertFalse(r.fresh);
        assertTrue(_quote(id, false, true, t).queued, "the sell quotes as queued");
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(id, t, 0, alice, uint64(vm.getBlockTimestamp()));
    }

    /// The late round (13 s into the close) is HALTED at the reopen: no sell at the pre-holiday value. The exit is
    /// the queue, and the ticket fills at the market's price on the first post-reopen round.
    function test_LateRound_SellQueues_FillsAtTheMarketPrice() public {
        vm.warp(closeAt + 13);
        feedOf[TSLA].push(250e8);
        _holiday(TICK_250 - 408);
        _assertHaltedAndQueued(sport, tokens);

        uint256 fair = Math.mulDiv(tokens, _v(240e18), 1e30);
        vm.startPrank(alice);
        _token(sport).approve(address(minter), tokens);
        uint256 ticket = minter.queueSell(sport, tokens, 0, alice);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);

        // the lift ends, the pool is back at the market, the feed prints the market's price
        _setTick(TICK_250 - 408);
        vm.warp(vm.getBlockTimestamp() + 31 minutes);
        feedOf[TSLA].push(240e8);
        assertTrue(guard.read(TSLA).fresh, "the post-reopen round is live");
        vm.prank(stranger);
        uint256 out = minter.fillQueued(ticket);
        assertLe(out, fair, "never above the market value");
        assertGt(out, fair * 97 / 100, "and near it");
    }

    /// Wherever the last round lands around the close, the reopen reads HALTED.
    function testFuzz_RoundAroundTheClose_Halted(uint256 offset) public {
        offset = bound(offset, 0, 25 hours - 1); // one hour before the close to its last second
        if (offset != 0) {
            vm.warp(closeAt - 1 hours + offset);
            feedOf[TSLA].push(250e8);
        }
        vm.warp(closeAt + 24 hours);
        _dropRef(TSLA);
        _assertHaltedAndQueued(sport, tokens);
    }

    /// Control (passed before the fix too): the last round 13 s BEFORE the close.
    function test_Control_RoundBeforeTheClose_Queues() public {
        vm.warp(closeAt - 13);
        feedOf[TSLA].push(250e8);
        _holiday(TICK_250 - 408);
        _assertHaltedAndQueued(sport, tokens);
    }

    /// The other direction: the market rose 4%. No buy at the pre-holiday value on the late round, by the minter or
    /// through the hook.
    function test_LateRound_BuysClosed() public {
        vm.warp(closeAt + 13);
        feedOf[TSLA].push(250e8);
        _holiday(TICK_250 + 392);
        _repost(TSLA);
        _poke();

        _fund(bob, 50_000e6);
        vm.prank(bob);
        vm.expectPartialRevert(IODMinter.BuysClosed.selector);
        minter.buy(sport, 50_000e6, 0, bob, uint64(vm.getBlockTimestamp()));
        vm.expectPartialRevert(IODMinter.BuysClosed.selector);
        hook.swap(sport, true, true, 1_000e6, pm);
        vm.expectRevert(IODMinter.UseQueue.selector);
        hook.swap(sport, false, true, 1e18, address(hook));
    }

    /// With a Pyth print inside refMaxAge the HALTED reading still pays a sell, at the lower (market) value: the
    /// I7-1 rule. The lifted pool does not matter.
    function test_LateRound_FreshPythPaysTheMarketValue() public {
        vm.warp(closeAt + 13);
        feedOf[TSLA].push(250e8);
        _holiday(TICK_250 - 408);
        _ref(TSLA, 240e18);
        assertEq(uint256(guard.read(TSLA).session), uint256(Session.HALTED));
        uint256 fair = Math.mulDiv(tokens, _v(240e18), 1e30);
        uint256 out = _sell(alice, sport, tokens);
        assertLe(out, fair, "paid at the Pyth value, not the pre-holiday feed value");
        assertGt(out, fair * 97 / 100);
    }

    /// The pair gear: one leg's late round halts the pair.
    function test_LateRound_PairGear() public {
        uint256 t = _buy(alice, pair, 10_000e6);
        vm.warp(closeAt + 13);
        feedOf[TSLA].push(250e8);
        feedOf[NVDA].push(int256(_p(NVDA) / 1e10));
        vm.warp(closeAt + 24 hours);
        _dropRef(TSLA);
        _dropRef(NVDA);
        assertEq(uint256(guard.readRatio(TSLA, NVDA).session), uint256(Session.HALTED));
        assertTrue(_quote(pair, false, true, t).queued);
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(pair, t, 0, alice, uint64(vm.getBlockTimestamp()));
    }
}
