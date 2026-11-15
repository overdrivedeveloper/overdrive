// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackerFixture} from "./BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";

/// R6 minting, the mint pause.
contract BackerMintTest is BackerFixture {
    function test_MintToOwner() public {
        uint256 id = _open(alice, sport, 1_000e6);
        uint256 supply0 = _token(sport).totalSupply();
        int256 net0 = gov.netTokens(sport);
        uint256 proceeds = _mint(alice, id, 400e18, false);
        assertEq(proceeds, 0);
        assertEq(_token(sport).balanceOf(alice), 400e18);
        assertEq(_token(sport).totalSupply(), supply0 + 400e18);
        assertEq(_debt(id), 400e18);
        assertEq(_coll(id), 1_000e6);
        assertEq(gov.backerDebt(sport), 400e18);
        assertEq(gov.netTokens(sport), net0, "net unchanged: supply and debt both rose");
    }

    function test_MintSellToGovernorAddsCollateral() public {
        uint256 id = _open(alice, sport, 1_000e6);
        uint256 supply0 = _token(sport).totalSupply();
        uint256 cash0 = gov.freeCash();
        uint256 v = _valueAt(sport, 250e18, Math.Rounding.Floor);
        // the SPORT lag floor (51 bps at the 50 bps band, M-4) is above the 30 bps base spread
        uint256 expected = Math.mulDiv(400e18, Math.mulDiv(v, 10_000 - 51, 10_000), 1e30);
        uint256 proceeds = _mint(alice, id, 400e18, true);
        assertEq(proceeds, expected);
        assertGt(proceeds, 390e6);
        assertEq(_coll(id), 1_000e6 + proceeds);
        assertEq(backer.totalCollateral(), 1_000e6 + proceeds);
        assertEq(_token(sport).balanceOf(alice), 0);
        assertEq(_token(sport).totalSupply(), supply0, "no supply change");
        assertEq(gov.backerDebt(sport), 400e18);
        assertEq(gov.netTokens(sport), -400e18);
        assertEq(gov.freeCash(), cash0, "I6-1: the proceeds stay in the Governor's free cash");
        assertEq(gov.saleCredit(), proceeds, "owed to the vault");
        (uint256 held, uint256 locked) = backer.vaultHeld(id);
        assertEq(held, proceeds, "held by the Governor");
        assertEq(locked, proceeds, "locked behind the sold debt");
        assertEq(usdg.balanceOf(address(backer)), 1_000e6, "the backer contract holds the deposit only");
        assertEq(usdg.balanceOf(alice), 0, "proceeds never leave the vault");
    }

    function test_MintRefusedWhenClosed() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _session(Session.CLOSED);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("CLOSED")));
        backer.mint(id, 100e18, false, 0);
        _session(Session.OPEN);
        _dropRef(TSLA);
        vm.prank(alice);
        vm.expectRevert();
        backer.mint(id, 100e18, true, 0);
    }

    function test_MintRefusedBelowRatio() public {
        uint256 id = _open(alice, sport, 1_000e6);
        vm.prank(alice);
        vm.expectPartialRevert(IODBacker.Undercollateralized.selector);
        backer.mint(id, 501e18, false, 0);
        _mint(alice, id, 499e18, false);
        assertGe(_ratio(id), 20_000);
    }

    function test_MinProceeds() public {
        uint256 id = _open(alice, sport, 1_000e6);
        vm.prank(alice);
        vm.expectPartialRevert(IODBacker.Slippage.selector);
        backer.mint(id, 100e18, true, 100e6);
        vm.prank(alice);
        uint256 got = backer.mint(id, 100e18, true, 99e6);
        assertGe(got, 99e6);
    }

    function test_MintOnlyOwner() public {
        uint256 id = _open(alice, sport, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotVaultOwner.selector, id));
        backer.mint(id, 100e18, false, 0);
    }

    function test_TimelockUnpausesMint() public {
        uint256 id = _open(alice, sport, 1_000e6);
        vm.prank(guardian);
        backer.setMintPaused(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("PAUSED")));
        backer.mint(id, 100e18, false, 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("NotAllowed()"));
        backer.setMintPaused(false);
        vm.prank(admin); // the timelock
        backer.setMintPaused(false);
        _mint(alice, id, 100e18, false);
        assertEq(_debt(id), 100e18);
    }

    function test_BackerMintOnlyFromBacker() public {
        vm.prank(stranger);
        vm.expectRevert(IODMinter.NotBacker.selector);
        minter.backerMint(sport, stranger, 1e18);
        vm.prank(stranger);
        vm.expectRevert(IODMinter.NotBacker.selector);
        minter.backerBurn(sport, alice, 1e18);
    }
}
