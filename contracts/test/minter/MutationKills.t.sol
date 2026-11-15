// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {GearStatus} from "overdrive/interfaces/ODTypes.sol";

/// Tests added from mutation testing (docs/reviews/mutation-2026-11-15.md): each pins a behaviour that a surviving
/// mutant showed no test checked.
contract MinterMutationKillsTest is SystemFixture {
    /// Kills m6553 (quote: the toll per day built as `rate - 1 days` instead of `rate * 1 days`). The quoted toll
    /// per day is the minter's own toll per day.
    function test_QuoteTollPerDayMatchesTollPerDay() public {
        _buy(alice, sport, 10_000e6);
        int256 perDay = minter.tollPerDay(sport);
        assertTrue(perDay != 0, "live gear pays a toll");
        assertEq(minter.quote(sport, true, true, 100e6).tollPerDayWad, perDay);
        assertEq(minter.quote(sport, false, true, 1e18).tollPerDayWad, perDay);
    }

    /// Kills m6574 and m6576 (valuePerToken: the settled branch skipped, so a settled gear was valued at the live
    /// price). After settlement the value per token stays the settled value whatever the market does.
    function test_SettledValueIgnoresLaterPrices() public {
        _buy(alice, sport, 10_000e6);
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(admin);
        minter.settleGear(sport);
        vm.prank(admin);
        reg.setStatus(sport, GearStatus.SETTLED);
        uint256 settled = minter.settledValue(sport);
        stockOf[TSLA].setOraclePaused(false);
        _price(TSLA, _p(TSLA) * 2);
        (uint256 v, bool inDomain) = minter.valuePerToken(sport);
        assertEq(v, settled, "settled value, not the live price");
        assertTrue(inDomain);
    }
}
