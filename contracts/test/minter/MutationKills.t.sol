// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {GearStatus} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

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

    /// Kills m6442 (settleGear: the GearSettled event dropped). Settlement emits GearSettled with the gear and the
    /// stored final value per token, once.
    function test_SettleGearEmitsGearSettled() public {
        _buy(alice, sport, 10_000e6);
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.recordLogs();
        vm.prank(admin);
        minter.settleGear(sport);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(minter) || logs[i].topics[0] != IODMinter.GearSettled.selector) continue;
            ++seen;
            assertEq(logs[i].topics[1], sport, "gear id");
            assertEq(abi.decode(logs[i].data, (uint256)), minter.settledValue(sport), "final value");
        }
        assertEq(seen, 1, "one GearSettled");
        assertGt(minter.settledValue(sport), 0);
    }

    /// Kills m7002 (_haltedLong: the second leg's halt age taken as `now / hb` instead of `now - hb`). A pair gear
    /// whose second market (NVDA) halted for settleAfterHalt settles while the first leg (TSLA) is live.
    function test_PairSettlesWhenSecondLegHaltedLong() public {
        _buy(alice, pair, 10_000e6);
        stockOf[NVDA].setOraclePaused(true);
        guard.poke(NVDA);
        uint64 hb = guard.haltedSince(NVDA);
        assertGt(hb, 0, "NVDA halted");
        vm.warp(hb + 30 days - 1);
        _price(TSLA, _p(TSLA));
        assertEq(guard.haltedSince(TSLA), 0, "TSLA live");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotSettleable.selector, pair));
        minter.settleGear(pair);
        vm.warp(hb + 30 days);
        _price(TSLA, _p(TSLA));
        assertEq(guard.haltedSince(TSLA), 0, "TSLA still live");
        vm.prank(admin);
        minter.settleGear(pair);
        assertGt(minter.settledValue(pair), 0, "settled");
    }
}
