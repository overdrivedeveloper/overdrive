// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R1: internal accounting only (GEN-3, VAULT-1).
contract AccountingTest is GovernorFixture {
    function test_DonationIgnored() public {
        _deposit(lp, 50_000e6);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 1_000e18, 1_000e6);
        uint256 ta = gov.totalAssets();
        uint256 sp = gov.sharePriceWad();
        (int256 lo, int256 hi) = gov.navBand();
        uint256 cash = gov.freeCash();
        usdg.mint(address(gov), 1_000_000e6); // a plain transfer of 1,000,000 USDG
        assertEq(gov.totalAssets(), ta);
        assertEq(gov.sharePriceWad(), sp);
        (int256 lo2, int256 hi2) = gov.navBand();
        assertEq(lo2, lo);
        assertEq(hi2, hi);
        assertEq(gov.freeCash(), cash);
        // Deposits after the transfer are priced as before it.
        assertEq(gov.previewDeposit(1_000e6), gov.previewDeposit(1_000e6));
        // The admin sends the untracked amount to ODInsurance; the books do not move.
        vm.prank(admin);
        gov.skim();
        assertEq(ins.balance(), 1_000_000e6);
        assertEq(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve());
        assertEq(gov.totalAssets(), ta);
    }

    function test_SkimOnlyAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        gov.skim();
    }

    function test_OnBuyNeedsUsdgArrived() public {
        _deposit(lp, 10_000e6);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        // The minter calls onBuy without moving USDG: refused, even with untracked USDG present after skim.
        vm.prank(address(minter));
        vm.expectRevert();
        gov.onBuy(id, 1e18, 1e6, 0);
    }
}
