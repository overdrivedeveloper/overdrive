// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";

/// Guard for the M-7 fix (fix round 6): backer debt sold to the Governor is not debt minted to an owner's wallet. When
/// sales to the Governor alone take a gear's net below zero, an ordinary holder's sell is paid as it always was: free
/// cash, then the exit reserve, then insurance, instantly. Uses only the pre-fix surface, so the same file passes on
/// the code before the fix with the same amounts (the proof that this exit path did not change).
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

        // Free cash nearly all moved to the exit reserve, so the holder's payout has to come from the reserve.
        uint256 quoted = minter.quote(sport, false, true, aliceTokens).amountOut;
        uint256 keep = quoted / 20;
        uint256 c = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(c - keep);
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();
        uint256 a0 = usdg.balanceOf(alice);

        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "quote: instant");
        uint256 out = _sell(alice, sport, aliceTokens);

        assertEq(usdg.balanceOf(alice) - a0, out, "holder paid in the same call");
        assertEq(out, quoted, "paid what was quoted");
        uint256 fromReserve = res0 - gov.exitReserve();
        assertGe(fromReserve, out - keep, "the exit reserve paid what free cash could not");
        assertEq(ins.balance(), ins0, "insurance not needed");
        emit log_named_uint("holder payout (USDG units)", out);
        emit log_named_uint("from the exit reserve (USDG units)", fromReserve);
        emit log_named_uint("free cash after (USDG units)", gov.freeCash());
        emit log_named_int("net after (tokens)", gov.netTokens(sport));
    }
}
