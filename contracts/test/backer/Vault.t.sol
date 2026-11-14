// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "./BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {GearStatus} from "overdrive/interfaces/ODTypes.sol";

/// R1 backable gears, R2 minimum collateral and internal accounting.
contract BackerVaultTest is BackerFixture {
    function test_EcoNotBackable() public {
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(backer), 100e6);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotBackable.selector, eco));
        backer.openVault(eco, 100e6);
        vm.stopPrank();
    }

    function test_SettledNotBackable() public {
        vm.prank(admin);
        reg.setStatus(cruise, GearStatus.SETTLED);
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(backer), 100e6);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotBackable.selector, cruise));
        backer.openVault(cruise, 100e6);
        vm.stopPrank();
    }

    function test_BackableGears() public {
        assertEq(_open(alice, cruise, 50e6), 1);
        assertEq(_open(alice, sport, 50e6), 2);
        assertEq(_open(alice, race, 50e6), 3);
        assertEq(_open(alice, reverse, 50e6), 4);
        assertEq(_open(alice, ethSport, 50e6), 5);
        assertEq(_open(alice, pair, 50e6), 6);
        assertEq(backer.vaultCount(), 6);
    }

    function test_MinCollateral() public {
        usdg.mint(alice, 50e6);
        vm.startPrank(alice);
        usdg.approve(address(backer), 50e6);
        vm.expectRevert(IODBacker.BelowMinimumCollateral.selector);
        backer.openVault(sport, 50e6 - 1);
        uint256 id = backer.openVault(sport, 50e6);
        vm.stopPrank();
        (address owner, bytes32 g, uint256 c, uint256 d, uint256 b) = backer.vault(id);
        assertEq(owner, alice);
        assertEq(g, sport);
        assertEq(c, 50e6);
        assertEq(d, 0);
        assertEq(b, 0);
    }

    function test_DonationChangesNoVault() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 300e18, false);
        (uint256 c0, uint256 d0, uint256 r0,,) = backer.health(id);
        uint256 t0 = backer.totalCollateral();
        usdg.mint(stranger, 5_000e6);
        vm.prank(stranger);
        usdg.transfer(address(backer), 5_000e6);
        (uint256 c1, uint256 d1, uint256 r1,,) = backer.health(id);
        assertEq(c1, c0);
        assertEq(d1, d0);
        assertEq(r1, r0);
        assertEq(backer.totalCollateral(), t0);
        assertEq(_coll(id), 1_000e6);
    }

    function test_OpenVaultForOwner() public {
        usdg.mint(bob, 100e6);
        vm.startPrank(bob);
        usdg.approve(address(backer), 100e6);
        uint256 id = backer.openVaultFor(alice, sport, 100e6);
        vm.stopPrank();
        (address owner,,,,) = backer.vault(id);
        assertEq(owner, alice);
        assertEq(usdg.balanceOf(bob), 0);
    }

    function test_OperatorMintSellsToGovernor() public {
        uint256 id = _open(alice, sport, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotOperator.selector, alice, bob));
        backer.mintFor(id, 100e18, 0);
        vm.prank(alice);
        backer.setOperator(bob, true);
        assertTrue(backer.isOperator(alice, bob));
        uint256 bobBefore = usdg.balanceOf(bob);
        vm.prank(bob);
        uint256 proceeds = backer.mintFor(id, 100e18, 0);
        assertGt(proceeds, 0);
        assertEq(_coll(id), 1_000e6 + proceeds);
        assertEq(usdg.balanceOf(bob), bobBefore);
        assertEq(_token(sport).balanceOf(bob), 0);
        assertEq(_token(sport).balanceOf(alice), 0);
    }
}
