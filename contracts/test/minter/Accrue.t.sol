// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {NormState} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODNorm} from "overdrive/math/ODNorm.sol";
import {ODToll} from "overdrive/math/ODToll.sol";

/// R1, R2: accrual of the normalisation factor.
contract AccrueTest is SystemFixture {
    function test_AccrueMatchesNormLibrary() public {
        _buy(alice, sport, 100_000e6);
        NormState memory s0 = minter.normState(sport);
        assertEq(s0.nf, 1e18, "first touch starts at 1");
        assertGt(s0.tollPerSecWad, 0, "sport pays toll");
        _warpFresh(1 days);
        minter.accrue(sport);
        NormState memory s1 = minter.normState(sport);
        uint256 want = ODNorm.step(1e18, ODToll.gapRate(s0.tollPerSecWad, s1.tollPerSecWad), 1 days);
        assertEq(s1.nf, want, "nf = ODNorm.step(gap rate)");
        assertLt(s1.nf, 1e18);
        assertEq(s1.lastAccrual, vm.getBlockTimestamp());
        assertGt(s1.cumTollPerTokenWad, 0, "positive toll per token tracked");
    }

    function test_GapUsesMaxRate() public {
        _buy(alice, sport, 100_000e6);
        NormState memory s0 = minter.normState(sport);
        // the market's vol rises: the gap is charged at the higher current rate
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _postVol(TSLA, 4000);
        _refreshAll();
        minter.accrue(sport);
        NormState memory s1 = minter.normState(sport);
        assertGt(s1.tollPerSecWad, s0.tollPerSecWad, "rate rose");
        assertEq(s1.nf, ODNorm.step(s0.nf, s1.tollPerSecWad, 1 hours), "higher current rate used");
        // vol falls back: the gap is still charged at the higher stored rate
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _postVol(TSLA, 3200);
        _refreshAll();
        minter.accrue(sport);
        NormState memory s2 = minter.normState(sport);
        assertLt(s2.tollPerSecWad, s1.tollPerSecWad, "rate fell");
        assertEq(s2.nf, ODNorm.step(s1.nf, s1.tollPerSecWad, 1 hours), "higher stored rate used");
    }

    function test_SameSecondNoop() public {
        _buy(alice, sport, 100_000e6);
        _warpFresh(1 days);
        minter.accrue(sport);
        NormState memory a = minter.normState(sport);
        vm.recordLogs();
        minter.accrue(sport);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        NormState memory b = minter.normState(sport);
        assertEq(a.nf, b.nf);
        assertEq(a.tollPerSecWad, b.tollPerSecWad);
        assertEq(a.cumTollPerTokenWad, b.cumTollPerTokenWad);
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IODMinter.Accrued.selector, "no second accrual");
        }
    }

    function test_StaleVolKeepsLastSigma() public {
        _buy(alice, sport, 100_000e6);
        assertEq(minter.lastSigmaBps(sport), 3500);
        // a new post lands but is not used until an accrual reads it fresh; let it go stale first
        vm.warp(vm.getBlockTimestamp() + 31);
        _postVol(TSLA, 3900);
        vm.warp(vm.getBlockTimestamp() + 3 hours);
        _price(TSLA, _p(TSLA));
        assertTrue(vol.read(TSLA).stale);
        minter.accrue(sport); // never reverts on a stale post
        assertEq(minter.lastSigmaBps(sport), 3500, "stale post: last sigma kept");
        // fresh again: the new sigma is used
        _postVol(TSLA, 3900);
        vm.warp(vm.getBlockTimestamp() + 1);
        minter.accrue(sport);
        assertEq(minter.lastSigmaBps(sport), 3900);
    }

    function test_EcoNfGrows() public {
        _buy(alice, eco, 10_000e6);
        assertLt(minter.normState(eco).tollPerSecWad, 0, "eco toll negative");
        _warpFresh(30 days);
        minter.accrue(eco);
        assertGt(minter.normState(eco).nf, 1e18, "holders receive: nf grows");
        assertEq(minter.normState(eco).cumTollPerTokenWad, 0, "only positive toll is tracked");
    }

    function test_TradesAccrueFirst() public {
        uint256 t = _buy(alice, sport, 100_000e6);
        _warpFresh(1 days);
        uint256 vBefore;
        (vBefore,) = minter.valuePerToken(sport); // view simulates the accrual
        _sell(alice, sport, t / 2);
        NormState memory s = minter.normState(sport);
        assertEq(s.lastAccrual, vm.getBlockTimestamp(), "sell accrued");
        assertLt(s.nf, 1e18);
        (uint256 vAfter,) = minter.valuePerToken(sport);
        assertEq(vAfter, vBefore, "view value equals the value after the trade's accrual");
        _warpFresh(1 hours);
        _buy(bob, sport, 1_000e6);
        assertEq(minter.normState(sport).lastAccrual, vm.getBlockTimestamp(), "buy accrued");
        _warpFresh(1 hours);
        vm.prank(alice);
        uint256 ticket = minter.queueSell(sport, 1e18, 0, alice);
        minter.fillQueued(ticket);
        assertEq(minter.normState(sport).lastAccrual, vm.getBlockTimestamp(), "fill accrued");
    }
}
