// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

/// R12 (QUOTE-1): quote equals execution to the wei, at EXACTLY the quoted limit, in money-moving states: toll due
/// since the last accrual, the protocol spread fee on, a fee owed outstanding, and payouts drawing the exit reserve.
/// Everything here is the real protocol (no mock that moves no cash).
contract QuoteEqualsExecutionTest is SystemFixture {
    uint256 internal bobTokens;
    uint256 internal aliceTokens;

    function _lpDeposit() internal pure override returns (uint256) {
        return 20_000e6;
    }

    function setUp() public override {
        super.setUp();
        IODGovernor.Params memory p = gov.getParams();
        p.stressBudgetBps = 5000;
        p.capScaleBps = 10_000;
        vm.prank(admin);
        gov.setParams(p);
        _poke();
        bobTokens = _buy(bob, sport, 15_000e6);
        aliceTokens = _buy(alice, sport, 1_000e6);
        // nearly all free cash into the exit reserve: fees stay owed, payouts draw the reserve
        uint256 cash = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(cash - 1e5);
        _warpFresh(1 days);
        minter.accrue(sport);
        assertGt(gov.feeOwed(), 0, "a fee is owed");
        _warpFresh(1 days); // toll due again since the last accrual
        assertLt(minter.normState(sport).lastAccrual, vm.getBlockTimestamp());
    }

    function _now64() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function test_BuyExactInAtLimit() public {
        Quote memory q = _quote(sport, true, true, 1_000e6);
        assertGt(q.protocolFeeUsdg, 0, "spread fee on");
        _fund(alice, 1_000e6);
        vm.prank(alice);
        uint256 out = minter.buy(sport, 1_000e6, q.amountOut, alice, _now64());
        assertEq(out, q.amountOut);
    }

    function test_BuyExactOutAtLimit() public {
        Quote memory q = _quote(sport, true, false, 500e18);
        _fund(alice, q.amountIn);
        vm.prank(alice);
        uint256 paid = minter.buyExactTokens(sport, 500e18, q.amountIn, alice, _now64());
        assertEq(paid, q.amountIn);
    }

    function test_SellExactInAtLimit() public {
        Quote memory q = _quote(sport, false, true, bobTokens / 2);
        assertFalse(q.queued);
        uint256 res = gov.exitReserve();
        vm.prank(bob);
        uint256 out = minter.sell(sport, bobTokens / 2, q.amountOut, bob, _now64());
        assertEq(out, q.amountOut);
        assertLt(gov.exitReserve(), res, "payout drew the exit reserve");
    }

    function test_SellExactOutAtLimit() public {
        Quote memory q = _quote(sport, false, false, 5_000e6);
        vm.prank(bob);
        uint256 used = minter.sellForExactUsdg(sport, 5_000e6, q.amountIn, bob, _now64());
        assertEq(used, q.amountIn);
    }

    function test_QuoteWithTollDue() public {
        Quote memory q = _quote(sport, false, true, aliceTokens);
        (uint256 vNow,) = minter.valuePerToken(sport);
        assertEq(q.valuePerTokenWad, vNow, "value after the trade's own accrual");
        vm.prank(alice);
        uint256 out = minter.sell(sport, aliceTokens, q.amountOut, alice, _now64());
        assertEq(out, q.amountOut);
        assertEq(minter.normState(sport).lastAccrual, vm.getBlockTimestamp());
        assertEq(q.tollPerDayWad, minter.tollPerDay(sport));
    }

    /// The payout boundary: exactly the money the Governor will have after the trade's own accrual paid its fees.
    function test_QuoteWithReserveDraw() public {
        // the underlying rallies: bob's holding is now worth more than every dollar the Governor can find
        _price(TSLA, 330e18);
        _price(TSLA, 420e18);
        _poke();
        // a little free cash: the accrual's toll fee settlement (owed fees first) takes it before the payout
        usdg.mint(address(this), 10e6);
        usdg.approve(address(gov), 10e6);
        gov.fundCash(10e6);
        uint256 snap = vm.snapshotState();
        minter.accrue(sport);
        uint256 avail = gov.freeCash() + gov.exitReserve();
        vm.revertToState(snap);
        assertLt(avail, gov.freeCash() + gov.exitReserve(), "the accrual's fee drain moves the boundary");

        Quote memory over = _quote(sport, false, false, avail + 1);
        assertTrue(over.queued, "one wei over: queued");
        vm.prank(bob);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sellForExactUsdg(sport, avail + 1, bobTokens, bob, _now64());

        Quote memory q = _quote(sport, false, false, avail);
        assertFalse(q.queued, "exactly the money there is: paid");
        vm.prank(bob);
        uint256 used = minter.sellForExactUsdg(sport, avail, q.amountIn, bob, _now64());
        assertEq(used, q.amountIn);
        assertEq(gov.freeCash() + gov.exitReserve(), 0, "drew every dollar, reserve included");
    }

    function testFuzz_QuoteEqualsExecution(uint8 mode, uint256 amount, uint32 dt, bool closed) public {
        mode = uint8(bound(mode, 0, 3));
        dt = uint32(bound(dt, 0, 20 hours));
        if (dt != 0) _warpFresh(dt);
        if (closed) _session(Session.CLOSED); // closed sells: min of last good and reference, wider spread
        bool isBuy = mode < 2;
        bool exactIn = mode % 2 == 0;
        if (mode == 0) amount = bound(amount, 1e6, 3_000e6);
        else if (mode == 1) amount = bound(amount, 1e18, 3_000e18);
        else if (mode == 2) amount = bound(amount, 1, bobTokens);
        else amount = bound(amount, 1, 10_000e6);
        Quote memory q;
        try minter.quote(sport, isBuy, exactIn, amount) returns (Quote memory x) {
            q = x;
        } catch (bytes memory err) {
            // a refused buy is refused by execution with the same error
            _fund(alice, 10_000e6);
            vm.prank(alice);
            vm.expectRevert(err);
            if (exactIn) minter.buy(sport, amount, 0, alice, _now64());
            else minter.buyExactTokens(sport, amount, type(uint256).max, alice, _now64());
            return;
        }
        if (isBuy) {
            _fund(alice, q.amountIn);
            vm.prank(alice);
            uint256 r = exactIn
                ? minter.buy(sport, amount, q.amountOut, alice, _now64())
                : minter.buyExactTokens(sport, amount, q.amountIn, alice, _now64());
            assertEq(r, exactIn ? q.amountOut : q.amountIn);
        } else if (q.queued) {
            vm.prank(bob);
            vm.expectRevert(IODMinter.UseQueue.selector);
            if (exactIn) minter.sell(sport, amount, 0, bob, _now64());
            else minter.sellForExactUsdg(sport, amount, type(uint256).max, bob, _now64());
        } else {
            if (!exactIn && q.amountIn > bobTokens) return;
            vm.prank(bob);
            uint256 r = exactIn
                ? minter.sell(sport, amount, q.amountOut, bob, _now64())
                : minter.sellForExactUsdg(sport, amount, q.amountIn, bob, _now64());
            assertEq(r, exactIn ? q.amountOut : q.amountIn);
        }
    }
}
