// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// M-7 option A: a backer mint to the owner's wallet holds the tokens' sale value back from free cash in the gear's
/// backer sale lock. The share of a sell for tokens that take supply below the gear's own-minted backer debt is paid
/// from the lock, then free cash, never the exit reserve or insurance, and is never refused for the cap; a short lock
/// falls back to the sell queue. (Debt sold to the Governor changes no payout: governor/BackerOwnDebt.t.sol.)
contract BackerLockTest is BackerFixture {
    uint256 internal constant RESERVE = 100_000e6;
    uint256 internal constant INSURANCE = 50_000e6;

    uint256 internal res0;
    uint256 internal ins0;

    function _books() internal {
        usdg.mint(lp, RESERVE + INSURANCE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        usdg.approve(address(ins), INSURANCE);
        ins.fund(INSURANCE);
        vm.stopPrank();
        _poke();
        // These tests size their own mints against the gear cap, above the default lock ceiling (M-8: all locks at
        // most 20% of free cash plus locks), so they run at the parameter's upper bound. The ceiling itself is
        // tested in poc/Rescore4LockGrief.t.sol.
        IODGovernor.Params memory gp = gov.getParams();
        gp.maxLockBps = 5000;
        vm.prank(admin);
        gov.setParams(gp);
    }

    /// Tokens worth `bps` of the gear's static cap at the live value.
    function _capTokens(uint256 bps) internal view returns (uint256) {
        (uint256 value,) = minter.valuePerToken(sport);
        return reg.gear(sport).capUsdWad * bps / 10_000 / value * 1e18;
    }

    /// Keeper moves free cash into the exit reserve, leaving `keep`.
    function _leaveCash(uint256 keep) internal {
        uint256 c = gov.freeCash();
        if (c > keep) {
            vm.prank(admin);
            gov.moveToExitReserve(c - keep);
        }
        res0 = gov.exitReserve();
        ins0 = ins.balance();
    }

    function _assertReserveAndInsuranceWhole() internal view {
        assertEq(gov.exitReserve(), res0, "exit reserve untouched");
        assertEq(ins.balance(), ins0, "insurance untouched");
    }

    function test_MintToOwnLocksSaleValue() public {
        _books();
        uint256 v = _open(bob, sport, 2_500_000e6);
        uint256 cash0 = gov.freeCash();
        uint256 t = _capTokens(3000);
        uint256 sale = minter.quote(sport, false, true, t).amountOut;
        _mint(bob, v, t, false);
        uint256 lock = gov.backerLock(sport);
        assertGt(lock, 0, "locked");
        assertApproxEqRel(lock, sale, 0.02e18, "lock is about the tokens' sale value");
        assertEq(gov.freeCash(), cash0 - lock, "the lock comes out of free cash");
        assertEq(gov.backerDebt(sport), t);
        assertEq(gov.backerOwnDebt(sport), t, "counted as own-minted debt");
    }

    /// Required: an honest holder's sell is instant while a backer has minted to self, even after the backer sold
    /// first and the gear is below zero net, with free cash nearly all moved to the reserve.
    function test_HolderSellInstantWhileBackerMintedToSelf() public {
        _books();
        uint256 aliceTokens = _buy(alice, sport, 10_000e6);
        uint256 v = _open(bob, sport, 2_500_000e6);
        uint256 t = _capTokens(5000);
        _mint(bob, v, t, false);
        _sell(bob, sport, t); // takes net below zero
        assertLt(gov.netTokens(sport), 0);
        uint256 aliceOut = minter.quote(sport, false, true, aliceTokens).amountOut;
        _leaveCash(aliceOut / 20);
        uint256 lockBefore = gov.backerLock(sport);
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        uint256 out = _sell(alice, sport, aliceTokens);
        assertGt(out, 0, "holder paid instantly");
        _assertReserveAndInsuranceWhole();
        assertLt(gov.backerLock(sport), lockBefore, "paid from the lock");
    }

    /// Required: the handoff scenario. Holders H, the backer mints and keeps T, holders exit (net stays >= 0), then the
    /// backer sells to net -T: paid from the lock (then free cash), never the reserve or insurance.
    function test_MintThenHoldersExitThenBackerSells() public {
        _books();
        uint256 aliceTokens = _buy(alice, sport, 100_000e6);
        uint256 v = _open(bob, sport, 2_500_000e6);
        _mint(bob, v, aliceTokens, false);
        uint256 lock = gov.backerLock(sport);
        _sell(alice, sport, aliceTokens); // net from H to 0: an ordinary payout
        assertEq(gov.netTokens(sport), 0);
        assertEq(gov.backerLock(sport), lock, "a sell above zero leaves the lock alone");
        uint256 bobOut = minter.quote(sport, false, true, aliceTokens).amountOut;
        _leaveCash(bobOut / 20);
        uint256 cash1 = gov.freeCash();
        uint256 got = _sell(bob, sport, aliceTokens);
        assertEq(gov.netTokens(sport), -int256(aliceTokens));
        _assertReserveAndInsuranceWhole();
        uint256 fromLock = lock - gov.backerLock(sport);
        assertEq(fromLock + (cash1 - gov.freeCash()), got, "lock then free cash pay the whole sale");
        emit log_named_uint("lock (USDG)", lock);
        emit log_named_uint("backer sale (USDG)", got);
    }

    /// Required: a price rise leaves the lock short; with no free cash a below-zero sell falls back to the queue
    /// (quote says queued, UseQueue, then queueSell), never the reserve or insurance, and fills once cash returns.
    function test_LockShortFallsBackToQueue() public {
        _books();
        uint256 v = _open(bob, sport, 2_500_000e6);
        uint256 t = _capTokens(3000);
        _mint(bob, v, t, false);
        uint256 lock = gov.backerLock(sport);
        _price(TSLA, _p(TSLA) * 13 / 10);
        _poke();
        uint256 out = minter.quote(sport, false, true, t).amountOut;
        assertGt(out, lock, "the rise made the lock short");
        _leaveCash(0);
        IERC20 tok = _token(sport);
        vm.prank(bob);
        assertTrue(tok.transfer(carol, t)); // an honest holder now holds them
        assertTrue(minter.quote(sport, false, true, t).queued, "quote predicts the queue (QUOTE-1)");
        vm.prank(carol);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(sport, t, 0, carol, uint64(vm.getBlockTimestamp()));
        vm.prank(carol);
        uint256 ticket = minter.queueSell(sport, t, 0, carol);
        _assertReserveAndInsuranceWhole();
        assertEq(gov.backerLock(sport), lock, "lock untouched by the refused sell");
        // Cash comes back (an LP funds it): the queue fills from the lock then free cash.
        usdg.mint(lp, out);
        vm.startPrank(lp);
        usdg.approve(address(gov), out);
        gov.fundCash(out);
        vm.stopPrank();
        uint256 c0 = usdg.balanceOf(carol);
        minter.fillQueued(ticket);
        assertGt(usdg.balanceOf(carol), c0, "queued holder paid");
        assertEq(gov.backerLock(sport), 0, "the lock paid first");
        _assertReserveAndInsuranceWhole();
    }

    /// Required: cap refusal at mint. Total backer debt x value past the static cap reverts CapExceeded with ample free
    /// cash; the cap counts every mint on the gear. Free cash short of the lock refuses the mint too.
    function test_CapRefusalAtMint() public {
        _books();
        usdg.mint(lp, 2_000_000e6);
        vm.startPrank(lp);
        usdg.approve(address(gov), 2_000_000e6);
        gov.fundCash(2_000_000e6);
        vm.stopPrank();
        uint256 v = _open(bob, sport, 4_000_000e6);
        uint256 over = _capTokens(11_000);
        assertGt(gov.freeCash(), minter.quote(sport, false, true, over).amountOut, "ample free cash");
        vm.prank(bob);
        vm.expectPartialRevert(IODGovernor.CapExceeded.selector);
        backer.mint(v, over, false, 0);

        _mint(bob, v, _capTokens(6000), false);
        uint256 w = _open(carol, sport, 4_000_000e6);
        uint256 more = _capTokens(6000);
        vm.prank(carol);
        vm.expectPartialRevert(IODGovernor.CapExceeded.selector);
        backer.mint(w, more, false, 0);

        _leaveCash(0);
        uint256 small = _capTokens(100);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(w, small, false, 0);
    }

    /// Required: repay releases the lock to free cash pro rata to debt, by tokens and by USDG; all of it at zero debt.
    function test_LockReleaseOnRepay() public {
        _books();
        uint256 v = _open(bob, sport, 2_500_000e6);
        uint256 cash0 = gov.freeCash();
        uint256 t = _capTokens(4000);
        _mint(bob, v, t, false);
        uint256 lock = gov.backerLock(sport);

        vm.prank(bob);
        backer.repay(v, t / 4);
        assertApproxEqAbs(gov.backerLock(sport), lock - lock / 4, 1, "a quarter released");
        assertApproxEqAbs(gov.freeCash(), cash0 - lock + lock / 4, 1, "back to free cash");

        uint256 c1 = gov.freeCash();
        uint256 l1 = gov.backerLock(sport);
        vm.prank(bob);
        uint256 cost = backer.repayWithUsdg(v, t / 4, type(uint256).max);
        uint256 rel = l1 - gov.backerLock(sport);
        assertApproxEqAbs(rel, l1 / 3, 1, "a third of what was left released");
        assertEq(gov.freeCash(), c1 + cost + rel, "repay cost plus the release");

        vm.prank(bob);
        backer.repay(v, type(uint256).max);
        assertEq(gov.backerDebt(sport), 0);
        assertEq(gov.backerLock(sport), 0, "all released at zero debt");
    }

    /// The direct sale to the Governor locks nothing and keeps its own rules.
    function test_DirectSaleLocksNothing() public {
        _books();
        uint256 v = _open(bob, sport, 2_500_000e6);
        _mint(bob, v, _capTokens(1000), true);
        assertEq(gov.backerLock(sport), 0);
        assertEq(gov.backerOwnDebt(sport), 0, "a sale to the Governor is not own-minted debt");
    }
}

