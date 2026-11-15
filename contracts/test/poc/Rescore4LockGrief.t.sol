// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// Regression for rescore 4, finding M-8 (fix round 7). A backer mint to the owner's wallet moves the tokens' sale
/// value from the Governor's free cash into a lock and costs the owner nothing, so own mints on gears nobody holds
/// could park all free cash (measured 1,158,919 to 50 USDG): LP claims paid next to nothing, every holder sell fell on
/// the exit reserve and insurance, a 149,000 USDG holder round trip emptied both, and the next holder was queued.
/// Now an own mint is refused when the locks of all gears would pass Params.maxLockBps (20%) of free cash plus locks.
/// Same setup, amounts and steps as the auditor's file; the asserts are flipped.
contract Rescore4LockGriefTest is BackerFixture {
    uint256 internal constant RESERVE = 100_000e6;
    uint256 internal constant INSURANCE = 50_000e6;

    uint256 internal aliceTokens;
    uint256 internal carolTokens;
    uint256 internal carolIn = 149_000e6;

    function _books() internal {
        usdg.mint(lp, RESERVE + INSURANCE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        usdg.approve(address(ins), INSURANCE);
        ins.fund(INSURANCE);
        vm.stopPrank();
        aliceTokens = _buy(alice, sport, 10_000e6);
        carolTokens = _buy(carol, sport, carolIn);
        _poke();
    }

    function _locks() internal view returns (uint256 sum) {
        bytes32[6] memory gs = [cruise, sport, race, eco, ethSport, reverse];
        for (uint256 i; i < gs.length; ++i) {
            sum += gov.backerLock(gs[i]);
        }
    }

    /// Bob mints to his own wallet on `g` as much as the Governor lets him, from `want` down. Never sells.
    function _lockOn(bytes32 g, uint256 leave) internal {
        uint256 cash = gov.freeCash();
        if (cash <= leave) return;
        uint256 v = _open(bob, g, 3_000_000e6);
        uint256 want = cash - leave;
        for (uint256 i; i < 40 && want > 1e6; ++i) {
            uint256 tokens = minter.quote(g, false, false, want).amountIn;
            vm.prank(bob);
            (bool ok,) = address(backer).call(abi.encodeCall(backer.mint, (v, tokens, false, 0)));
            if (ok) return;
            want = want * 80 / 100;
        }
    }

    function _lockAll() internal {
        bytes32[4] memory gs = [cruise, race, ethSport, reverse]; // every backable gear but the held one
        for (uint256 r; r < 3; ++r) {
            for (uint256 i; i < gs.length; ++i) {
                _lockOn(gs[i], 50e6);
            }
        }
    }

    function test_R4_OwnMintsCannotParkFreeCash() public {
        _books();
        uint256 shares = gov.balanceOf(lp) / 10;
        vm.prank(lp);
        uint256 ticket = gov.requestWithdraw(shares);
        _warpFresh(72 hours + 1);
        uint256 cash0 = gov.freeCash();
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();

        // 1. Bob tries to park all free cash, three passes over the gears nobody holds, as in the finding.
        _lockAll();
        uint256 cash1 = gov.freeCash();
        uint256 locks = _locks();
        emit log_named_uint("free cash before (USDG)", cash0 / 1e6);
        emit log_named_uint("free cash after bob's own mints (USDG)", cash1 / 1e6);
        emit log_named_uint("locked (USDG)", locks / 1e6);
        assertEq(cash1 + locks, cash0, "own mints only move free cash into locks");
        assertLe(locks * 10_000, cash0 * 2000, "locks above 20% of free cash plus locks");
        assertGe(cash1 * 10_000, cash0 * 8000, "at least 80% of free cash stays free");

        // 2. The LP claim pays.
        vm.prank(lp);
        uint256 paid = gov.claim(ticket, 0);
        emit log_named_uint("LP claim paid (USDG)", paid / 1e6);
        assertGt(paid, 90_000e6, "LP claim starved");

        // 3. The holder round trip is paid from free cash: the reserve and insurance are whole.
        _sell(carol, sport, carolTokens);
        assertEq(gov.exitReserve(), res0, "reserve drawn");
        assertEq(ins.balance(), ins0, "insurance drawn");

        // 4. The ordinary holder sells at once.
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "holder sell queued");
        assertGt(_sell(alice, sport, aliceTokens), 0);
    }

    /// The ceiling at its edge: 20% of free cash plus locks passes to the unit, one more USDG worth is refused, and
    /// room returns when own-minted debt is repaid.
    function test_R4_CeilingEdgeAndRelease() public {
        _books();
        uint256 total = gov.freeCash();
        uint256 v = _open(bob, cruise, 3_000_000e6);
        uint256 tokens = minter.quote(cruise, false, false, total / 5).amountIn;
        vm.prank(bob);
        (bool ok,) = address(backer).call(abi.encodeCall(backer.mint, (v, tokens * 102 / 100, false, 0)));
        assertFalse(ok, "a mint past the ceiling went through");
        _mint(bob, v, tokens * 98 / 100, false);
        assertLe(gov.backerLock(cruise) * 5, total);
        // another gear shares the same ceiling
        uint256 w = _open(bob, race, 3_000_000e6);
        uint256 raceTokens = minter.quote(race, false, false, total / 20).amountIn;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(w, raceTokens, false, 0);
        // a sale to the Governor is not a lock and is not held to the ceiling
        _mint(bob, w, 1_000e18, true);
        // repaying own-minted debt frees the room
        vm.prank(bob);
        backer.repay(v, tokens * 98 / 100);
        assertEq(gov.backerLock(cruise), 0);
        _mint(bob, w, raceTokens, false);
    }

    /// The parameter is the timelock's, bounded at 50%; zero closes own mints (sales to the Governor stay open).
    function test_R4_MaxLockBpsIsAdminBounded() public {
        _books();
        IODGovernor.Params memory p = gov.getParams();
        assertEq(p.maxLockBps, 2000, "default");
        p.maxLockBps = 5001;
        vm.prank(admin);
        vm.expectRevert(IODGovernor.InvalidParams.selector);
        gov.setParams(p);
        p.maxLockBps = 3000;
        vm.prank(guardian);
        vm.expectRevert();
        gov.setParams(p);
        p.maxLockBps = 0;
        vm.prank(admin);
        gov.setParams(p);
        uint256 v = _open(bob, cruise, 10_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(v, 100e18, false, 0);
        _mint(bob, v, 100e18, true);
    }
}
