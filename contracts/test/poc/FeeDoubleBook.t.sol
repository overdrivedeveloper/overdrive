// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";

/// F12-1 (invariant lane): ODFees booked more USDG than it held. distribute pays the Governor's share with fundCash;
/// fundCash settles the Governor's owed fees back to ODFees with notify (pending += x), and _pay measured only s0 - x
/// as paid, so the Governor bucket also kept x: x counted as pending and held. _pay now counts USDG booked back as
/// pending during the call as paid out. Fails on 2923f09, passes after the fix.
contract FeeDoubleBookTest is SystemFixture {
    function test_F12_1_DistributeNeverBooksMoreThanHeld() public {
        _buy(alice, sport, 15_000e6);
        uint256 free = gov.trackedCash();
        vm.prank(admin);
        gov.moveToExitReserve(free); // the keeper moves all free cash: owed fees cannot settle now
        _warpFresh(1 days);
        minter.accrue(sport);
        uint256 next = fees.nextDistributionAt();
        if (next > vm.getBlockTimestamp()) _warpFresh(next - vm.getBlockTimestamp());
        fees.distribute();
        assertGe(
            usdg.balanceOf(address(fees)), fees.pending() + fees.totalHeld(), "ODFees books more USDG than it holds"
        );
    }
}
