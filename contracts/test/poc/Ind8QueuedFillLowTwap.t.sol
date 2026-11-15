// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {MockV3OraclePool} from "../mocks/OracleMocks.sol";
import {MarketConfig, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

/// I8-2 (independent audit 8), regression. A sell is paid the lower of the feed value and the reference value, and
/// the reference band closed buys only. A ticket queued in a closed market with a minimum of 0 (what the API
/// suggested) could be filled by anyone at a v3 TWAP far under the feed. Now a third party fills a ticket only while
/// buys are open on the reading (reference inside the band, no pause); the owner alone may fill outside it.
/// `test_LowTwap_StrangerCannotFill` failed on 5a4c9e7.
contract Ind8QueuedFillLowTwapTest is SystemFixture {
    int24 internal constant TICK_250 = -221_107;
    MockV3OraclePool internal pool;
    uint256 internal tokens;
    uint256 internal ticket;

    function setUp() public override {
        super.setUp();
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

        // the market closes; alice queues with no minimum (the worst case for her)
        _session(Session.CLOSED);
        _dropRef(TSLA);
        Quote memory q = _quote(sport, false, true, tokens);
        assertTrue(q.queued);
        vm.startPrank(alice);
        _token(sport).approve(address(minter), tokens);
        ticket = minter.queueSell(sport, tokens, 0, alice);
        vm.stopPrank();
    }

    function _setTick(int24 tick) internal {
        pool.setTick(guard.config(TSLA).stockToken < address(usdg) ? tick : -tick);
    }

    function _reopen() internal {
        vm.warp(vm.getBlockTimestamp() + 31 minutes);
        _session(Session.EXTENDED);
        feedOf[TSLA].push(250e8); // the first live round: the market is unchanged at 250
        _dropRef(TSLA); // no Pyth print inside refMaxAge
    }

    /// Control: TWAP at the market price. Anyone fills, near what alice paid.
    function test_Control_FillAtTheMarketPrice() public {
        _reopen();
        vm.prank(stranger);
        uint256 out = minter.fillQueued(ticket);
        assertGt(out, 9_800e6);
    }

    /// The pool is held 30% under the feed for one window. A stranger cannot fill; once the TWAP is back inside the
    /// band anyone can, at the market value.
    function test_LowTwap_StrangerCannotFill() public {
        _setTick(TICK_250 - 3_567); // 0.70 x
        _reopen();
        assertEq(guard.read(TSLA).p, 250e18, "the feed is live at 250");
        assertEq(guard.read(TSLA).reason, bytes32("REF_BAND"));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);

        _setTick(TICK_250);
        vm.warp(vm.getBlockTimestamp() + 31 minutes);
        feedOf[TSLA].push(250e8);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(stranger);
        uint256 out = minter.fillQueued(ticket);
        assertEq(usdg.balanceOf(alice) - before, out);
        assertGt(out, 9_800e6, "paid the market value");
    }

    /// The edge of the band: a stranger's fill is never more than the band under the feed value (times the gear).
    function test_InsideTheBand_StrangerFillIsBounded() public {
        uint256 band = guard.config(TSLA).refBandBps;
        _setTick(TICK_250 - int24(int256(band)) + 10); // just inside the band
        _reopen();
        assertEq(guard.read(TSLA).reason, bytes32(0), "inside the band: buys open");
        vm.prank(stranger);
        uint256 out = minter.fillQueued(ticket);
        // SPORT is the square: a reference `band` under the feed lowers the value by about twice the band
        assertGt(out, 9_800e6 * (10_000 - 2 * band - 50) / 10_000);
    }

    /// The owner may still fill outside the band (their own call), and the ticket's minimum binds them too.
    function test_LowTwap_OwnerMayFill_MinimumBinds() public {
        vm.prank(alice);
        minter.cancelQueued(ticket);
        vm.startPrank(alice);
        _token(sport).approve(address(minter), tokens);
        uint256 half = tokens / 2;
        uint256 withMin = minter.queueSell(sport, half, 4_800e6, alice);
        uint256 noMin = minter.queueSell(sport, tokens - half, 0, alice);
        vm.stopPrank();
        _setTick(TICK_250 - 3_567);
        _reopen();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, withMin));
        minter.fillQueued(withMin);
        uint256 out = minter.fillQueued(noMin);
        vm.stopPrank();
        assertLt(out, 2_500e6, "the owner chose the low price");
    }

    /// A manual pause closes third-party fills; the owner still exits. Settlement opens the queue to anyone.
    function test_Paused_OwnerFills_SettledAnyoneFills() public {
        _reopen();
        vm.prank(guardian);
        guard.setBuysPaused(TSLA, true);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);
        vm.prank(alice);
        assertGt(minter.fillQueued(ticket), 9_800e6);
    }
}
