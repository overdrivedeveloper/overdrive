// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

/// Backer debt sold to the Governor is not debt minted to an owner's wallet (M-7), and until fix round 8 a holder
/// sell on a gear whose net those sales alone had taken below zero was paid like any other: free cash, the exit
/// reserve, insurance. Decision D32 (I4-1b) changes that on purpose: a sell that leaves net below zero is paid from
/// free cash only, and queues when free cash is short ("holders queue sooner"), because the same path let one actor
/// move the whole reserve and insurance into the Governor's book. What this file now guards: (1) such a sell still
/// pays at once, in full, while free cash covers it; (2) short of free cash it queues and the reserve and insurance
/// do not move; (3) with net at or above zero the reserve pays a holder exactly as before.
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
        _mint(bob, v, reg.gear(sport).capUsdWad * 3 / 10 / value * 1e18, true);
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

        // (2) free cash nearly all moved to the exit reserve: the sell queues, the reserve and insurance stay whole
        uint256 keep = quoted / 20;
        uint256 c = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(c - keep);
        res0 = gov.exitReserve();
        assertTrue(minter.quote(sport, false, true, aliceTokens).queued, "quote: queued");
        vm.prank(alice);
        vm.expectRevert(IODMinter.UseQueue.selector);
        minter.sell(sport, aliceTokens, 0, alice, uint64(vm.getBlockTimestamp()));
        assertEq(gov.exitReserve(), res0, "exit reserve untouched");
        assertEq(ins.balance(), ins0, "insurance untouched");
        vm.prank(alice);
        uint256 ticket = minter.queueSell(sport, aliceTokens, 0, alice);
        vm.prank(admin);
        gov.moveFromExitReserve(c - keep); // cash returns (here: the timelock's path back)
        a0 = usdg.balanceOf(alice);
        minter.fillQueued(ticket);
        assertGt(usdg.balanceOf(alice), a0, "the queued sell is paid once free cash is back");
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
