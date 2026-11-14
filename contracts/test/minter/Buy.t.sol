// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {GearConfig, GearStatus, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";

/// R3, R4, R15 (buys) and the pause table.
contract BuyTest is SystemFixture {
    function _expectClosed(bytes32 id, bytes32 reason) internal {
        _fund(alice, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.BuysClosed.selector, id, reason));
        vm.prank(alice);
        minter.buy(id, 1_000e6, 0, alice, uint64(vm.getBlockTimestamp()));
    }

    function test_BuyBlockedWhenClosed() public {
        _session(Session.CLOSED);
        _expectClosed(sport, "CLOSED");
        _session(Session.UNKNOWN);
        _expectClosed(sport, "CLOSED");
        assertGt(_buy(alice, ethSport, 1_000e6), 0, "24/7 market stays open");
    }

    function test_BuyBlockedWhenRefMissing() public {
        _dropRef(TSLA);
        _expectClosed(sport, "REF_UNAVAILABLE");
        _expectClosed(pair, "REF_UNAVAILABLE");
    }

    function test_BuyBlockedOutOfDomain() public {
        uint256 p = _p(TSLA);
        while (p * 1e18 / reg.gear(sport).p0 >= ODIndex.MIN_R) {
            p = p * 6 / 10;
            _price(TSLA, p);
        }
        _poke();
        _expectClosed(sport, "DOMAIN");
    }

    function test_BuyBlockedHardStaleVol() public {
        vm.warp(vm.getBlockTimestamp() + 3 days + 3 hours);
        _price(TSLA, _p(TSLA));
        _price(NVDA, _p(NVDA));
        _price(ETH, _p(ETH));
        _poke();
        assertTrue(vol.read(TSLA).hardStale);
        _expectClosed(sport, "VOL_HARD_STALE");
    }

    function test_BuyBlockedInEarningsWindow() public {
        _warpFresh(1 minutes);
        vm.warp(vm.getBlockTimestamp() + 31);
        uint64 nowTs = uint64(vm.getBlockTimestamp());
        _postVolWindow(TSLA, 3500, nowTs, nowTs + 1 days);
        _expectClosed(sport, "EARNINGS");
        _expectClosed(race, "EARNINGS");
        _expectClosed(pair, "EARNINGS"); // a leg's window blocks the pair
        _warpFresh(1 days);
        _buy(alice, sport, 1_000e6); // the window ends by itself
    }

    function test_EcoIgnoresEarningsWindow() public {
        _warpFresh(1 minutes);
        vm.warp(vm.getBlockTimestamp() + 31);
        uint64 nowTs = uint64(vm.getBlockTimestamp());
        _postVolWindow(TSLA, 3500, nowTs, nowTs + 1 days);
        assertGt(_buy(alice, eco, 1_000e6), 0);
    }

    function test_BuyBlockedByStatusAndGovernor() public {
        vm.prank(guardian);
        reg.setStatus(sport, GearStatus.BUYS_PAUSED);
        _expectClosed(sport, "STATUS");
        vm.prank(guardian);
        gov.setBuysPaused(true);
        _expectClosed(cruise, "PAUSED");
    }

    function test_TimelockUnpausesBuys() public {
        vm.prank(guardian);
        gov.setBuysPaused(true);
        _expectClosed(sport, "PAUSED");
        vm.prank(guardian);
        vm.expectRevert();
        gov.setBuysPaused(false);
        vm.prank(admin); // the timelock
        gov.setBuysPaused(false);
        assertGt(_buy(alice, sport, 1_000e6), 0);
    }

    function test_BelowMinimum() public {
        _fund(alice, 1e6);
        vm.expectRevert(IODMinter.BelowMinimum.selector);
        vm.prank(alice);
        minter.buy(sport, 1e6 - 1, 0, alice, uint64(vm.getBlockTimestamp()));
    }

    function test_DeadlineAndSlippage() public {
        _fund(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(IODMinter.Expired.selector);
        minter.buy(sport, 1_000e6, 0, alice, uint64(vm.getBlockTimestamp() - 1));
        Quote memory q = _quote(sport, true, true, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.Slippage.selector, q.amountOut, q.amountOut + 1));
        minter.buy(sport, 1_000e6, q.amountOut + 1, alice, uint64(vm.getBlockTimestamp()));
    }

    function test_WorseOfForBuyer() public {
        _ref(TSLA, 252.5e18); // reference 1% above the feed, inside the band
        GearConfig memory c = reg.gear(sport);
        (uint256 vRef,) = ODIndex.value(c.gear, 252.5e18, c.p0, 1e18, c.unitWad, Math.Rounding.Ceil);
        assertEq(_quote(sport, true, true, 1_000e6).valuePerTokenWad, vRef, "sport buys at the reference");
        GearConfig memory r = reg.gear(reverse);
        (uint256 vP,) = ODIndex.value(r.gear, 250e18, r.p0, 1e18, r.unitWad, Math.Rounding.Ceil);
        assertEq(_quote(reverse, true, true, 1_000e6).valuePerTokenWad, vP, "reverse buys at the lower price");
    }

    function testFuzz_ExactInRounding(uint256 usdgIn) public {
        usdgIn = bound(usdgIn, 1e6, 50_000e6);
        Quote memory q = _quote(sport, true, true, usdgIn);
        uint256 tokens = _buy(alice, sport, usdgIn);
        assertEq(tokens, q.amountOut, "quote = execution");
        assertEq(tokens, Math.mulDiv(usdgIn, 1e30, q.pricePerTokenWad), "floor");
        assertLe(tokens * q.pricePerTokenWad, usdgIn * 1e30);
        assertGt((tokens + 1) * q.pricePerTokenWad, usdgIn * 1e30);
        assertEq(q.pricePerTokenWad, Math.mulDiv(q.valuePerTokenWad, 10_000 + q.spreadBps, 10_000, Math.Rounding.Ceil));
    }

    function testFuzz_ExactOutRounding(uint256 tokens) public {
        tokens = bound(tokens, 2e18, 50_000e18);
        Quote memory q = _quote(sport, true, false, tokens);
        _fund(alice, q.amountIn);
        uint256 balBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = minter.buyExactTokens(sport, tokens, q.amountIn, alice, uint64(vm.getBlockTimestamp()));
        assertEq(paid, q.amountIn, "quote = execution");
        assertEq(balBefore - usdg.balanceOf(alice), paid);
        assertEq(_token(sport).balanceOf(alice), tokens);
        assertEq(paid, Math.mulDiv(tokens, q.pricePerTokenWad, 1e30, Math.Rounding.Ceil), "ceil");
    }

    function test_UsdgGoesToGovernorFirst() public {
        uint256 before = usdg.balanceOf(address(gov));
        _buy(alice, sport, 1_000e6);
        assertGe(usdg.balanceOf(address(gov)) + usdg.balanceOf(address(fees)), before + 1_000e6);
        assertEq(usdg.balanceOf(address(minter)), 0, "the minter never holds USDG");
    }
}
