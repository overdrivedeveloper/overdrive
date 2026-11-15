// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";

/// Backer debt sold to the Governor is not debt minted to an owner's wallet (M-7). Fix round 8 (decision D32, I4-1b)
/// paid a holder sell that left net below zero from free cash only; that rule let one actor lock holders out of a
/// full exit reserve (I6-1) and is gone. Fix round 9 closes I4-1b at its cause instead: the proceeds of a direct sale
/// never leave the Governor (sale credit), so the money holders are owed is still there. What this file guards:
/// (1) with net below zero from direct sales, a holder sell pays at once from free cash while free cash covers it;
/// (2) short of free cash the exit reserve pays it, at once, no more than her payout, insurance untouched, and the
/// direct sale itself moved neither; (3) with net at or above zero the reserve pays a holder as it always did.
contract DirectSaleBelowZeroTest is BackerFixture {
    uint256 internal constant RESERVE = 100_000e6;
    uint256 internal constant INSURANCE = 50_000e6;

    function test_HolderSellDrawsReserveWhenDirectSalesTookNetBelowZero() public {
        usdg.mint(lp, RESERVE + INSURANCE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        usdg.approve(address(ins), INSURANCE);
        ins.fund(INSURANCE);
        vm.stopPrank();
        uint256 aliceTokens = _buy(alice, sport, 10_000e6); // an ordinary holder
        _poke();

        // A backer sells 30% of the gear's cap straight to the Governor: net far below zero, nothing minted to a wallet.
        uint256 v = _open(bob, sport, 2_500_000e6);
        (uint256 value,) = minter.valuePerToken(sport);
        uint256 cashBefore = gov.freeCash();
        uint256 backerBefore = usdg.balanceOf(address(backer));
        _mint(bob, v, reg.gear(sport).capUsdWad * 3 / 10 / value * 1e18, true);
        assertEq(gov.freeCash(), cashBefore, "the direct sale took no free cash");
        assertEq(usdg.balanceOf(address(backer)), backerBefore, "and paid nothing out");
        assertLt(gov.netTokens(sport), -int256(aliceTokens), "net below zero before the holder sells");

        uint256 quoted = minter.quote(sport, false, true, aliceTokens).amountOut;
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();

        // (1) free cash covers it: paid at once, in full, from free cash
        uint256 snap = vm.snapshotState();
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        uint256 a0 = usdg.balanceOf(alice);
        uint256 out = _sell(alice, sport, aliceTokens);
        assertEq(usdg.balanceOf(alice) - a0, out, "holder paid in the same call");
        assertEq(out, quoted, "paid what was quoted");
        assertEq(gov.exitReserve(), res0, "from free cash, not the reserve");
        vm.revertToState(snap);

        // (2) free cash nearly all moved to the exit reserve: the reserve pays her, at once (I6-1: no queue)
        uint256 keep = quoted / 20;
        uint256 c = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(c - keep);
        res0 = gov.exitReserve();
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        a0 = usdg.balanceOf(alice);
        out = _sell(alice, sport, aliceTokens);
        assertEq(usdg.balanceOf(alice) - a0, quoted, "paid in full in the same call");
        assertGe(res0 - gov.exitReserve(), quoted - keep, "the exit reserve paid what free cash could not");
        assertLe(res0 - gov.exitReserve(), quoted, "and no more than her payout");
        assertEq(ins.balance(), ins0, "insurance untouched");
    }

    /// (3) Net at or above zero: the reserve pays a holder's sell when free cash cannot, as it always did.
    function test_HolderSellStillDrawsReserveWhileNetStaysAtOrAboveZero() public {
        usdg.mint(lp, RESERVE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        vm.stopPrank();
        uint256 aliceTokens = _buy(alice, sport, 10_000e6);
        _buy(carol, sport, 10_000e6);
        _poke();
        uint256 v = _open(bob, sport, 2_500_000e6);
        _mint(bob, v, aliceTokens / 2, true); // a direct sale smaller than the supply that stays
        uint256 quoted = minter.quote(sport, false, true, aliceTokens).amountOut;
        uint256 c = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(c - quoted / 20);
        uint256 res0 = gov.exitReserve();
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        uint256 out = _sell(alice, sport, aliceTokens);
        assertEq(out, quoted, "paid what was quoted");
        assertGe(gov.netTokens(sport), 0, "net stayed at or above zero");
        assertGe(res0 - gov.exitReserve(), out - quoted / 20, "the exit reserve paid what free cash could not");
    }
}
