// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {GearConfig, GearStatus, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";

/// R6 to R9, R15, R16: exits are never gated, and never priced off one source alone.
contract SellTest is SystemFixture {
    function _v(bytes32 id, uint256 p) internal view returns (uint256 v) {
        GearConfig memory c = reg.gear(id);
        (v,) = ODIndex.value(c.gear, p, c.p0, minter.normState(id).nf, c.unitWad, Math.Rounding.Floor);
    }

    function _enterSession(uint8 s) internal {
        if (s == 4) {
            stockOf[TSLA].setOraclePaused(true);
            guard.poke(TSLA);
        } else {
            _session(Session(s));
        }
    }

    function testFuzz_SellUnderEveryPause(uint8 pauseKind, uint8 session) public {
        pauseKind = uint8(bound(pauseKind, 0, 5));
        session = uint8(bound(session, 0, 4));
        uint256 t = _buy(alice, sport, 10_000e6);
        if (pauseKind == 1) {
            vm.prank(guardian);
            gov.setBuysPaused(true);
        } else if (pauseKind == 2) {
            vm.prank(guardian);
            reg.setStatus(sport, GearStatus.BUYS_PAUSED);
        } else if (pauseKind == 3) {
            vm.prank(guardian);
            reg.setStatus(sport, GearStatus.SELL_ONLY);
        } else if (pauseKind == 4) {
            vm.prank(guardian);
            guard.setBuysPaused(TSLA, true);
        } else if (pauseKind == 5) {
            vm.prank(guardian);
            vol.revokeSigner();
            vm.warp(vm.getBlockTimestamp() + 4 days); // vol hard stale, Governor equity stale
            _price(TSLA, _p(TSLA));
        }
        _enterSession(session);
        uint256 out = _sell(alice, sport, t);
        assertGt(out, 9_000e6, "exit paid");
        assertEq(_token(sport).balanceOf(alice), 0);
    }

    function test_SellUnderEveryPause() public {
        for (uint8 k; k <= 5; ++k) {
            for (uint8 s; s <= 4; ++s) {
                uint256 snap = vm.snapshotState();
                testFuzz_SellUnderEveryPause(k, s);
                vm.revertToState(snap);
            }
        }
    }

    function test_WorseOfForSeller() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _ref(TSLA, 252.5e18);
        assertEq(_quote(sport, false, true, t).valuePerTokenWad, _v(sport, 250e18), "seller gets the lower value");
        _ref(TSLA, 247.5e18);
        assertEq(_quote(sport, false, true, t).valuePerTokenWad, _v(sport, 247.5e18));
    }

    function test_ClosedSellIsMinOfLastAndRef() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        _ref(TSLA, 255e18); // reference above the last good: last good value
        Quote memory q = _quote(sport, false, true, t);
        assertEq(q.valuePerTokenWad, _v(sport, 250e18));
        assertEq(q.spreadBps, 30 + 50, "closed extra");
        _ref(TSLA, 245e18); // reference below: reference value
        q = _quote(sport, false, true, t);
        assertEq(q.valuePerTokenWad, _v(sport, 245e18));
        assertEq(_sell(alice, sport, t), q.amountOut);
    }

    function test_ClosedNoRefUsesQueue() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        _dropRef(TSLA);
        assertTrue(_quote(sport, false, true, t).queued);
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(sport, t, 0, alice, uint64(vm.getBlockTimestamp()));
        // live session with no reference: the same
        _session(Session.OPEN);
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(sport, t, 0, alice, uint64(vm.getBlockTimestamp()));
    }

    function test_ReverseClosedSellUsesMinValue() public {
        uint256 t = _buy(alice, reverse, 10_000e6);
        _session(Session.CLOSED);
        _ref(TSLA, 245e18); // lower price = HIGHER reverse value: the min of values is at the last good price
        assertEq(_quote(reverse, false, true, t).valuePerTokenWad, _v(reverse, 250e18));
        _ref(TSLA, 255e18);
        assertEq(_quote(reverse, false, true, t).valuePerTokenWad, _v(reverse, 255e18));
    }

    function test_PayFailureUsesQueue() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        usdg.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(sport, t, 0, alice, uint64(vm.getBlockTimestamp()));
        assertEq(_token(sport).balanceOf(alice), t, "nothing burned");
        usdg.setBlocked(alice, false);
        usdg.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(sport, t, 0, alice, uint64(vm.getBlockTimestamp()));
        assertEq(_token(sport).balanceOf(alice), t, "nothing burned");
    }

    function test_DustSellAllowed() public {
        _buy(alice, sport, 10_000e6);
        uint256 out = _sell(alice, sport, 1);
        assertEq(out, 0, "dust exits for nothing, never reverts");
        _session(Session.CLOSED);
        _sell(alice, sport, 1);
    }

    function test_SellForExactUsdg() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        Quote memory q = _quote(sport, false, false, 5_000e6);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        uint256 used = minter.sellForExactUsdg(sport, 5_000e6, t, alice, uint64(vm.getBlockTimestamp()));
        assertEq(used, q.amountIn);
        assertEq(usdg.balanceOf(alice) - before, 5_000e6);
        assertEq(used, Math.mulDiv(5_000e6, 1e30, q.pricePerTokenWad, Math.Rounding.Ceil));
    }

    function testFuzz_RoundTripNoProfit(uint256 usdgIn, uint8 g) public {
        usdgIn = bound(usdgIn, 1e6, 50_000e6);
        bytes32[5] memory ids = [cruise, sport, race, eco, reverse];
        bytes32 id = ids[bound(g, 0, 4)];
        uint16 sb = _quote(id, true, true, usdgIn).spreadBps;
        uint256 t = _buy(alice, id, usdgIn);
        uint16 ss = _quote(id, false, true, t).spreadBps;
        uint256 out = _sell(alice, id, t);
        assertLe(out, Math.mulDiv(usdgIn, 10_000 - ss, 10_000 + sb), "round trip pays both spreads");
    }
}
