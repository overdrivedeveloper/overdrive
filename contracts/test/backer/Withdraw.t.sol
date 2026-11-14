// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "./BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";

/// R8 withdraw within ratio, deposit always, never withdraw from a vault in a live batch.
contract BackerWithdrawTest is BackerFixture {
    function test_WithdrawKeepsRatio() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 400e18, false); // 250%
        vm.prank(alice);
        backer.withdraw(id, 100e6, alice); // 225%
        assertEq(usdg.balanceOf(alice), 100e6);
        assertGe(_ratio(id), 20_000);
        vm.prank(alice);
        vm.expectPartialRevert(IODBacker.Undercollateralized.selector);
        backer.withdraw(id, 150e6, alice); // would be 187.5%
        // closed: the high-side valuation (last good, or a higher reference) still decides
        _session(Session.CLOSED);
        _ref(TSLA, 262e18);
        vm.prank(alice);
        vm.expectPartialRevert(IODBacker.Undercollateralized.selector);
        backer.withdraw(id, 40e6, alice); // fine at 250, not at the reference 262
        vm.prank(alice);
        backer.withdraw(id, 5e6, alice);
        // the uplift raises the bar
        _session(Session.OPEN);
        _price(TSLA, 250e18);
        _uplift(true);
        vm.prank(alice);
        vm.expectPartialRevert(IODBacker.Undercollateralized.selector);
        backer.withdraw(id, 1e6, alice);
    }

    function test_WithdrawFullWhenNoDebt() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _session(Session.CLOSED);
        vm.prank(alice);
        backer.withdraw(id, 1_000e6, bob);
        assertEq(usdg.balanceOf(bob), 1_000e6);
        assertEq(_coll(id), 0);
        assertEq(backer.totalCollateral(), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotVaultOwner.selector, id));
        backer.withdraw(id, 0, bob);
    }

    function test_DepositAnyone() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 400e18, false);
        vm.prank(guardian);
        backer.setMintPaused(true);
        _session(Session.HALTED);
        backer.harnessSeal(id);
        usdg.mint(bob, 300e6);
        vm.startPrank(bob);
        usdg.approve(address(backer), 300e6);
        backer.deposit(id, 300e6);
        vm.stopPrank();
        assertEq(_coll(id), 1_300e6);
        assertEq(backer.totalCollateral(), 1_300e6);
    }

    function test_NoWithdrawInBatch() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 100e18, false);
        uint256 b = backer.harnessSeal(id);
        (uint64 readyAt, uint64 expiresAt) = backer.batchWindow(b);
        assertEq(readyAt, vm.getBlockTimestamp() + backer.SEAL_DELAY());
        assertEq(expiresAt, vm.getBlockTimestamp() + backer.BATCH_TTL());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.InBatch.selector, id));
        backer.withdraw(id, 1e6, alice);
        // an expired batch frees its vaults
        _warpFresh(backer.BATCH_TTL() + 1);
        (,,,, uint256 live) = backer.vault(id);
        assertEq(live, 0);
        vm.prank(alice);
        backer.withdraw(id, 1e6, alice);
        assertEq(usdg.balanceOf(alice), 1e6);
    }

    function test_LiquidationGetters() public view {
        assertEq(backer.SEAL_DELAY(), 30);
        assertEq(backer.BATCH_TTL(), 15 minutes);
        assertEq(backer.BONUS_BPS(), 500);
        (uint64 r, uint64 e) = backer.batchWindow(77);
        assertEq(r, 0);
        assertEq(e, 0);
    }
}
