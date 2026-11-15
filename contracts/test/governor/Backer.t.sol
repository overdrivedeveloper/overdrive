// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R15: backer hooks.
contract BackerTest is GovernorFixture {
    bytes32 id;

    function setUp() public override {
        super.setUp();
        id = _list(TSLA, NONE, Gear.SPORT, 1_000e18);
    }

    function test_MintReducesNet() public {
        _deposit(lp, 10_000e6);
        _buy(id, 1_000e18, 1_000e6);
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, 400e18, false, 0, address(1)));
        assertEq(gov.netTokens(id), 600e18);
        assertEq(gov.backerDebt(id), 400e18);
        vm.prank(backerC);
        gov.onBackerRepay(id, 100e18, 0, address(1));
        assertEq(gov.backerDebt(id), 300e18);
        vm.prank(backerC);
        gov.onBackerRepay(id, 1_000e18, 0, address(1)); // more than owed: floors at 0
        assertEq(gov.backerDebt(id), 0);
        vm.prank(stranger);
        vm.expectRevert(IODGovernor.NotBacker.selector);
        gov.onBackerRepay(id, 1, 0, address(1));
    }

    /// I6-1: a sale to the Governor pays nothing out. The proceeds are booked as sale credit, held to free cash, and
    /// settled later from free cash only; the exit reserve never pays them.
    function test_SoldMintNeverUsesReserve() public {
        _fundReserve(10_000e6);
        vm.prank(backerC);
        assertFalse(gov.onBackerMint(id, 100e18, true, 100e6, address(1)));
        assertEq(gov.backerDebt(id), 0);
        assertEq(gov.exitReserve(), 10_000e6);
        _fundCash(1_000e6);
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, 100e18, true, 100e6, address(1)));
        assertEq(usdg.balanceOf(backerC), 0, "nothing is paid at the sale");
        assertEq(gov.saleCredit(), 100e6, "owed to the vault");
        assertEq(gov.freeCash(), 1_000e6, "free cash untouched");
        vm.prank(backerC);
        assertFalse(gov.onBackerMint(id, 1e18, true, 901e6, address(1)), "credit of all vaults within free cash");
        // settled: 60 paid from free cash, 40 kept by the Governor (a buy-back cost)
        vm.prank(backerC);
        assertEq(gov.settleSaleCredit(60e6, 40e6), 60e6);
        assertEq(usdg.balanceOf(backerC), 60e6);
        assertEq(gov.freeCash(), 940e6);
        assertEq(gov.saleCredit(), 0);
        // free cash short: it pays what there is, the unpaid part stays owed, the reserve does not move
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, 100e18, true, 900e6, address(1)));
        vm.prank(admin);
        gov.moveToExitReserve(900e6);
        vm.prank(backerC);
        assertEq(gov.settleSaleCredit(900e6, 0), 40e6);
        assertEq(gov.saleCredit(), 860e6, "the rest stays owed");
        assertEq(gov.exitReserve(), 10_900e6, "the exit reserve never pays sale credit");
        vm.prank(backerC);
        vm.expectRevert();
        gov.settleSaleCredit(0, 861e6); // more than is owed
    }

    /// The cap rule on the hook alone: here supply does not rise with the mint (a mock backer). For a mint to the
    /// owner's wallet the hook checks total backer debt x value (M-7, governor/BackerLock.t.sol).
    function test_NetLongCapped() public {
        vm.prank(backerC);
        gov.onBackerMint(id, 1_000e18, false, 0, address(1)); // net long 1,000 = cap
        vm.prank(backerC);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.CapExceeded.selector, id, 1_001e18, 1_000e18));
        gov.onBackerMint(id, 1e18, false, 0, address(1));
    }

    function test_AbsorbLiquidation() public {
        vm.prank(backerC);
        gov.onBackerMint(id, 500e18, false, 0, address(1));
        vm.prank(backerC);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.UsdgNotReceived.selector, 300e6, 0));
        gov.absorbLiquidation(id, 500e18, 500e18, 300e6, address(1));
        usdg.mint(address(gov), 300e6); // the collateral arrives first
        vm.prank(backerC);
        gov.absorbLiquidation(id, 500e18, 500e18, 300e6, address(1));
        assertEq(gov.backerDebt(id), 0);
        assertEq(gov.backerOwnDebt(id), 0);
        assertEq(gov.freeCash(), 300e6);
    }
}
