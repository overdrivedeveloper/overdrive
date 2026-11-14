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
        assertTrue(gov.onBackerMint(id, 400e18, false, 0));
        assertEq(gov.netTokens(id), 600e18);
        assertEq(gov.backerDebt(id), 400e18);
        vm.prank(backerC);
        gov.onBackerRepay(id, 100e18);
        assertEq(gov.backerDebt(id), 300e18);
        vm.prank(backerC);
        gov.onBackerRepay(id, 1_000e18); // more than owed: floors at 0
        assertEq(gov.backerDebt(id), 0);
        vm.prank(stranger);
        vm.expectRevert(IODGovernor.NotBacker.selector);
        gov.onBackerRepay(id, 1);
    }

    function test_SoldMintNeverUsesReserve() public {
        _fundReserve(10_000e6);
        vm.prank(backerC);
        assertFalse(gov.onBackerMint(id, 100e18, true, 100e6));
        assertEq(gov.backerDebt(id), 0);
        assertEq(gov.exitReserve(), 10_000e6);
        _fundCash(1_000e6);
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, 100e18, true, 100e6));
        assertEq(usdg.balanceOf(backerC), 100e6);
        assertEq(gov.trackedCash(), 900e6);
        assertEq(gov.exitReserve(), 10_000e6);
    }

    function test_NetLongCapped() public {
        vm.prank(backerC);
        gov.onBackerMint(id, 1_000e18, false, 0); // net long 1,000 = cap
        vm.prank(backerC);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.CapExceeded.selector, id, 1_001e18, 1_000e18));
        gov.onBackerMint(id, 1e18, false, 0);
    }

    function test_AbsorbLiquidation() public {
        vm.prank(backerC);
        gov.onBackerMint(id, 500e18, false, 0);
        vm.prank(backerC);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.UsdgNotReceived.selector, 300e6, 0));
        gov.absorbLiquidation(id, 500e18, 300e6);
        usdg.mint(address(gov), 300e6); // the collateral arrives first
        vm.prank(backerC);
        gov.absorbLiquidation(id, 500e18, 300e6);
        assertEq(gov.backerDebt(id), 0);
        assertEq(gov.trackedCash(), 300e6);
    }
}
