// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// Rescore 5, finding L-12 (Low), regression (flipped from the auditor's PoC, where a pass was the finding). The
/// M-8 lock ceiling (Params.maxLockBps of free cash plus locks) was one shared, first come quota: one vault owner took
/// all of it with own mints he never sold, at no cost, and every other backer's mint to the wallet was refused
/// MintingClosed("GOVERNOR_CASH") until he chose to leave. Now one owner holds at most Params.maxLockOwnerBps (25%) of
/// the ceiling across all his vaults and gears, so bob's attempt on the whole ceiling is refused and carol's mint
/// goes through while bob holds his full share. Step 2 is the flipped step.
contract Rescore5LockQuotaTest is BackerFixture {
    uint256 internal constant COLL = 3_000_000e6;

    function test_R5_OneOwnerCannotHoldTheWholeLockCeiling() public {
        _buy(alice, sport, 10_000e6);
        _poke();
        uint256 total = gov.freeCash();
        uint256 honest = minter.quote(race, false, false, total / 25).amountIn; // an honest own mint: 4% of free cash
        assertEq(gov.getParams().maxLockOwnerBps, 2500, "default: a quarter of the ceiling per owner");

        // 1. bob goes for the whole ceiling on a gear nobody holds: refused, in one vault or split over two
        uint256 v = _open(bob, cruise, COLL);
        uint256 all = minter.quote(cruise, false, false, total / 5).amountIn * 99 / 100;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(v, all, false, 0);
        // he takes his share (a quarter of the ceiling: 5% of free cash) and never sells
        uint256 tokens = all / 4;
        _mint(bob, v, tokens, false);
        assertEq(gov.backerLockOf(bob), gov.backerLock(cruise));
        assertGe(gov.backerLockOf(bob) * 1000, total * 49, "bob holds under 4.9% of free cash");
        assertLe(gov.backerLockOf(bob) * 20, total, "bob holds over his 5% share");
        uint256 v2 = _open(bob, race, COLL); // a second vault and another gear do not give him a second share
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(v2, honest, false, 0);

        // 2. (flipped) every other backer's own mint goes through while bob holds his whole share, now and a week on
        uint256 w = _open(carol, race, COLL);
        _mint(carol, w, honest / 2, false);
        _warpFresh(7 days);
        _mint(carol, w, honest / 2, false);
        assertGt(gov.backerLockOf(carol), 0);
        uint256 x = _open(alice, sport, COLL);
        _mint(alice, x, minter.quote(sport, false, false, total / 25).amountIn, false);

        // 3. bob leaves: his share is free again, and his own
        vm.startPrank(bob);
        backer.repay(v, tokens / 2);
        assertApproxEqAbs(gov.backerLockOf(bob), gov.backerLock(cruise), 1, "meter follows the gear lock");
        backer.repay(v, tokens - tokens / 2);
        vm.stopPrank();
        assertEq(gov.backerLockOf(bob), 0, "bob's meter is back at zero");
        _mint(bob, v2, honest, false);
        assertGt(gov.backerLockOf(bob), 0);
    }

    /// The share is the timelock's, at most 100% of the ceiling (the old behaviour); zero closes own mints.
    function test_R5_OwnerShareIsAdminBounded() public {
        IODGovernor.Params memory p = gov.getParams();
        p.maxLockOwnerBps = 10_001;
        vm.prank(admin);
        vm.expectRevert(IODGovernor.InvalidParams.selector);
        gov.setParams(p);
        p.maxLockOwnerBps = 10_000;
        vm.prank(guardian);
        vm.expectRevert();
        gov.setParams(p);
        vm.prank(admin);
        gov.setParams(p);
        _buy(alice, sport, 10_000e6);
        _poke();
        uint256 v = _open(bob, cruise, COLL);
        _mint(bob, v, minter.quote(cruise, false, false, gov.freeCash() / 5).amountIn * 99 / 100, false);
    }

    /// A liquidated vault frees its owner's share too.
    function test_R5_LiquidationFreesTheOwnerShare() public {
        uint256 v = _sportVault(bob);
        assertGt(gov.backerLockOf(bob), 0);
        _price(TSLA, 300e18); // under maintenance
        uint256 id = _seal(sport, v);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        backer.executeBatch(id);
        assertEq(_debt(v), 0, "liquidated");
        assertEq(gov.backerLockOf(bob), 0);
    }
}
