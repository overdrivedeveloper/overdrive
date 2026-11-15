// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";

/// Independent 6, I6-1, as a regression test. The finding: after the D32 rule a holder sell that left net below zero
/// was paid from free cash only, and a backer's direct sale both took net below zero and paid its proceeds out of free
/// cash. One actor could empty free cash and lock every holder of the gear out of a full exit reserve.
/// The fix: direct-sale proceeds never leave the Governor (sale credit, the vault's collateral, held until the debt
/// clears), so free cash is not taken, and a holder sell is paid from free cash, the exit reserve, then insurance at
/// any net. Both tests fail on 1ac8bf9 (they use only functions that exist there; the credit books themselves are
/// tested in backer/SaleCredit.t.sol).
contract Ind6ReserveLockoutTest is BackerFixture {
    uint256 internal constant RESERVE = 500_000e6;

    function _fundReserve() private {
        usdg.mint(lp, RESERVE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        vm.stopPrank();
    }

    /// The grader's sequence: bob sells debt to the Governor on three gears for as long as it lets him.
    function test_I6_DirectSalesCannotLockHoldersOutOfTheExitReserve() public {
        _fundReserve();
        uint256 aliceTokens = _buy(alice, sport, 10_000e6); // an ordinary holder
        _poke();
        uint256 quoted = minter.quote(sport, false, true, aliceTokens).amountOut;
        uint256 cash0 = gov.freeCash();
        uint256 backerBal0 = usdg.balanceOf(address(backer));
        uint256 bobIn = 5_000_000e6;
        bytes32[3] memory gs = [sport, cruise, race];
        uint256[3] memory vs;
        uint256 sales;
        for (uint256 k; k < 3; ++k) {
            vs[k] = _open(bob, gs[k], bobIn);
            uint256 step = minter.quote(gs[k], false, false, cash0 / 20).amountIn;
            for (uint256 i; i < 40; ++i) {
                vm.prank(bob);
                try backer.mint(vs[k], step, true, 0) returns (uint256) {
                    ++sales;
                } catch {
                    break;
                }
            }
        }
        assertGt(sales, 10, "bob's direct sales went through");
        assertLt(gov.netTokens(sport), 0, "net below zero on alice's gear");

        // the proceeds never left the Governor: free cash and the reserve are untouched, the backer received nothing
        assertEq(gov.freeCash(), cash0, "free cash untouched by direct sales");
        assertEq(gov.exitReserve(), RESERVE, "exit reserve untouched");
        assertEq(usdg.balanceOf(address(backer)), backerBal0 + 3 * bobIn, "the backer holds bob's own deposits only");
        // and bob cannot withdraw any of them while the debt is open: only his own deposit is his to take
        assertGt(_coll(vs[0]), bobIn, "the proceeds count as his collateral");
        vm.prank(bob);
        vm.expectRevert();
        backer.withdraw(vs[0], bobIn + 1, bob);

        // alice exits at once
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        quoted = minter.quote(sport, false, true, aliceTokens).amountOut;
        vm.prank(alice);
        uint256 out = minter.sell(sport, aliceTokens, 0, alice, uint64(vm.getBlockTimestamp()));
        assertEq(out, quoted, "alice is paid her quote");

        // bob leaves: buys all his debt back and withdraws; he gets no more than he put in and no credit is left
        uint256 back;
        for (uint256 k; k < 3; ++k) {
            uint256 d = _debt(vs[k]);
            vm.startPrank(bob);
            if (d != 0) backer.repayWithUsdg(vs[k], d, type(uint256).max);
            uint256 c = _coll(vs[k]);
            backer.withdraw(vs[k], c, bob);
            vm.stopPrank();
            back += c;
        }
        assertLe(back, 3 * bobIn, "bob made nothing");
        assertEq(gov.exitReserve(), RESERVE, "exit reserve never moved");
    }

    /// The state the finding needed: free cash is short and net is below zero. The holder is paid from the exit
    /// reserve all the same, because the money her tokens are owed never left the Governor.
    function test_I6_HolderBelowZeroIsPaidFromTheReserve() public {
        _fundReserve();
        uint256 aliceTokens = _buy(alice, sport, 10_000e6);
        _poke();
        // bob sells twice alice's supply to the Governor: net below zero whatever she sells
        uint256 v = _open(bob, sport, 5_000_000e6);
        vm.prank(bob);
        backer.mint(v, 2 * aliceTokens, true, 0);
        assertLt(gov.netTokens(sport), 0, "net below zero");
        // normal operations move nearly all free cash to the exit reserve
        uint256 cash = gov.freeCash();
        uint256 quoted = minter.quote(sport, false, true, aliceTokens).amountOut;
        vm.prank(admin);
        gov.moveToExitReserve(cash - quoted / 4);
        uint256 res0 = gov.exitReserve();
        assertLt(gov.freeCash(), quoted, "free cash alone cannot pay alice");

        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        vm.prank(alice);
        uint256 out = minter.sell(sport, aliceTokens, 0, alice, uint64(vm.getBlockTimestamp()));
        assertEq(out, quoted, "alice is paid her quote");
        assertLt(gov.exitReserve(), res0, "the exit reserve paid her");
        assertLe(res0 - gov.exitReserve(), quoted, "and no more than her payout");
    }
}
