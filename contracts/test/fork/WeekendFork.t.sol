// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ForkSystem} from "./ForkSystem.sol";
import {SessionWindow} from "overdrive/interfaces/IODMarketHours.sol";
import {Gear, GearConfig, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// R8: the weekend on the real calendar (ODMarketHours fallback, no pushed sessions), real state otherwise.
contract WeekendForkTest is ForkSystem {
    uint256 internal constant EST = 5 hours; // November: Eastern Standard Time

    function setUp() public override {
        super.setUp();
        if (!_forked()) return;
        vm.prank(keeper);
        mh.setSessionsWithKinds(new SessionWindow[](0), new Session[](0));
        vm.prank(admin);
        mh.setFallbackEnabled(true);
    }

    function _forked() internal view returns (bool) {
        return address(gov) != address(0);
    }

    /// The next Friday (UTC day index) at `etHour`:`etMin` Eastern, at least a day ahead.
    function _nextFriday(uint256 etHour, uint256 etMin) internal view returns (uint256) {
        uint256 day = (vm.getBlockTimestamp() - EST) / 1 days + 1;
        while ((day + 4) % 7 != 5) ++day; // 1970-01-01 was a Thursday
        return day * 1 days + etHour * 1 hours + etMin * 1 minutes + EST;
    }

    function _at(uint256 ts) internal {
        vm.warp(ts);
        _refresh();
    }

    function test_FridayUplift() public {
        uint256 fri = _nextFriday(14, 0);
        _at(fri);
        assertEq(uint256(mh.kindAt(fri)), uint256(Session.OPEN), "Friday 14:00 ET is regular hours");
        (uint64 closeAt, uint64 reopenAt) = mh.nextLongClose(fri, 24 hours);
        assertGt(closeAt, fri);
        assertGe(reopenAt - closeAt, 48 hours, "weekend close");
        (uint16 bps, uint32 lead) = backer.uplift();
        assertEq(lead, 2 hours);
        _at(closeAt - lead - 1);
        (bool on,) = backer.upliftActive(NVDA);
        assertFalse(on, "not yet");
        _at(closeAt - lead);
        uint16 got;
        (on, got) = backer.upliftActive(NVDA);
        assertTrue(on, "active from 2 h before the close");
        assertEq(got, bps);
        (on,) = backer.upliftActive(ETH);
        assertFalse(on, "24/7 market: no uplift");
        emit log_named_uint("close (ET hour)", ((closeAt - EST) % 1 days) / 1 hours);
    }

    uint256 internal fri11;

    function _saturdaySetup() internal returns (uint256 tStock, uint256 tEth, bytes32 id) {
        fri11 = _nextFriday(11, 0);
        _at(fri11);
        id = gearOf[NVDA][Gear.SPORT];
        tStock = _hookBuy(alice, id, 2_000e6);
        tEth = _hookBuy(alice, gearOf[ETH][Gear.SPORT], 2_000e6);
        _at(fri11 + 1 days + 1 hours); // Saturday noon ET
        assertEq(uint256(guard.read(NVDA).session), uint256(Session.CLOSED));
    }

    /// Saturday: stock buys blocked, ETH and BTC gears trade, stock sells pay min(lastValue, refValue).
    function test_SaturdayRules() public {
        (uint256 tStock,, bytes32 id) = _saturdaySetup();
        _fundUsdg(bob, 100e6);
        vm.startPrank(bob);
        usdg.approve(address(minter), 100e6);
        vm.expectRevert();
        minter.buy(id, 100e6, 0, bob, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();
        assertGt(_hookBuy(bob, gearOf[ETH][Gear.SPORT], 500e6), 0, "ETH trades");
        assertGt(_hookBuy(bob, gearOf[BTC][Gear.CRUISE], 500e6), 0, "BTC trades");
        GearConfig memory c = reg.gear(id);
        (uint256 last,) = guard.lastGood(NVDA);
        uint256 nf = minter.normState(id).nf;
        // reference below the last good: the reference value
        _mockPyth(NVDA, int64(int256((last * 97 / 100) * 1e18 / multOf[NVDA] / 1e10)), vm.getBlockTimestamp());
        PriceReading memory r = guard.read(NVDA);
        assertLt(r.refP, last);
        Quote memory q = minter.quote(id, false, true, tStock / 2);
        (uint256 vRef,) = ODIndex.value(c.gear, r.refP, c.p0, nf, c.unitWad, Math.Rounding.Floor);
        assertApproxEqRel(q.valuePerTokenWad, vRef, 1e12, "min = ref value");
        assertEq(q.spreadBps, 30 + 50, "closed sell extra");
        assertGt(_sell(alice, id, tStock / 2), 0, "closed sell paid");
        // reference above: the last good value
        _mockPyth(NVDA, int64(int256((last * 103 / 100) * 1e18 / multOf[NVDA] / 1e10)), vm.getBlockTimestamp());
        q = minter.quote(id, false, true, tStock / 4);
        (uint256 vLast,) = ODIndex.value(c.gear, last, c.p0, minter.normState(id).nf, c.unitWad, Math.Rounding.Floor);
        assertApproxEqRel(q.valuePerTokenWad, vLast, 1e12, "min = last value");
    }

    /// A sell queued on Saturday is not fillable until Monday's first live round, then fills at that price.
    function test_MondayQueueFills() public {
        (uint256 tStock,, bytes32 id) = _saturdaySetup();
        vm.startPrank(alice);
        _token(id).approve(address(minter), tStock);
        uint256 ticket = minter.queueSell(id, tStock, 0, alice);
        vm.stopPrank();
        vm.expectRevert();
        minter.fillQueued(ticket);
        // Monday 09:30 ET + 1 minute: first live round
        uint256 mon = fri11 + 3 days - 90 minutes + 1 minutes; // Monday 09:31 ET
        vm.warp(mon);
        assertEq(uint256(mh.kindAt(mon)), uint256(Session.OPEN));
        walkPrice(NVDA, 200); // Monday's first round, +2%
        _refresh();
        uint256 b0 = usdg.balanceOf(alice);
        Quote memory q = minter.quote(id, false, true, tStock);
        vm.prank(carol);
        uint256 out = minter.fillQueued(ticket);
        assertEq(out, q.amountOut, "filled at Monday's live price");
        assertEq(usdg.balanceOf(alice) - b0, out);
    }
}
