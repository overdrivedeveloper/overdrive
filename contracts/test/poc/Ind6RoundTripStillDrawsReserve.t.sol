// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";

/// Independent 6, I4-1b (still open on 1ac8bf9), as a regression test. The finding: buy as a holder, sell the same
/// amount of debt straight to the Governor, sell the bought tokens. The direct sale paid its proceeds out of free
/// cash into the actor's vault, so his own exit was paid by the exit reserve (then insurance), up to the honest
/// supply on the gear, and honest holders queued from then on.
/// The fix: the proceeds stay in the Governor's free cash as sale credit, so the round trip moves nothing: the
/// actor's exit is paid by his own buy. Fails on 1ac8bf9 (the reserve fell by 68,067 USDG there).
contract Ind6RoundTripStillDrawsReserveTest is BackerFixture {
    function test_I6_RoundTripDrawsNoReserveOrInsurance_HoldersExit() public {
        usdg.mint(lp, 50_000e6);
        vm.startPrank(lp);
        usdg.approve(address(ins), 50_000e6);
        ins.fund(50_000e6);
        vm.stopPrank();
        uint256 carolTokens = _buy(carol, sport, 100_000e6); // honest holders
        _poke();
        // normal operations: most free cash sits in the exit reserve (the keeper's job), 30k stays free
        uint256 c0 = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(c0 - 30_000e6);
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();
        uint256 cash0 = gov.freeCash();

        // bob: buy X, sell X of debt to the Governor, sell the X bought tokens; ten times
        uint256 v = _open(bob, sport, 2_000_000e6);
        usdg.mint(bob, 1_000_000e6);
        uint256 w0 = usdg.balanceOf(bob);
        uint256 backerBal0 = usdg.balanceOf(address(backer));
        uint256 sales;
        for (uint256 i; i < 10; ++i) {
            uint256 bought = _buy(bob, sport, 10_000e6);
            vm.prank(bob);
            // refused once the credit of all vaults would pass free cash (he then only buys and sells)
            try backer.mint(v, bought, true, 0) returns (uint256) {
                ++sales;
            } catch {}
            vm.prank(bob);
            minter.sell(sport, bought, 0, bob, uint64(vm.getBlockTimestamp())); // never queued
        }
        assertGt(sales, 2, "direct sales went through");
        assertEq(gov.exitReserve(), res0, "the round trips drew nothing from the exit reserve");
        assertEq(ins.balance(), ins0, "nor from insurance");
        assertGe(gov.freeCash(), cash0, "free cash did not fall (it keeps bob's spreads)");
        assertEq(usdg.balanceOf(address(backer)), backerBal0, "no proceeds reached the backer contract");
        // the fixture hands bob the 10,000 USDG of each buy: he ends below what he was given
        assertLt(usdg.balanceOf(bob), w0 + 10 * 10_000e6, "bob paid the spreads");

        // honest carol exits in full, at once: free cash, then the exit reserve, never more than her payout
        uint256 quoted = minter.quote(sport, false, true, carolTokens).amountOut;
        assertFalse(minter.quote(sport, false, true, carolTokens).queued, "the honest holder is not queued");
        vm.prank(carol);
        uint256 out = minter.sell(sport, carolTokens, 0, carol, uint64(vm.getBlockTimestamp()));
        assertEq(out, quoted, "carol is paid her quote");
        assertLt(gov.netTokens(sport), 0, "her exit left net below zero and was paid all the same");
        assertLe(res0 - gov.exitReserve(), quoted, "the reserve paid at most what she was owed");
        assertEq(ins.balance(), ins0, "insurance untouched");
    }
}
