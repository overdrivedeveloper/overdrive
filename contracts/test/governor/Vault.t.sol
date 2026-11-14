// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R3, R4: allowlisted deposits at the high NAV edge, queue-only exits at the low edge, partial claims.
contract VaultTest is GovernorFixture {
    function test_OnlyAllowlistedDeposits() public {
        usdg.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdg.approve(address(gov), 10e6);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.DepositorNotAllowed.selector, stranger));
        gov.deposit(10e6, stranger);
        vm.stopPrank();
        // An allowlisted depositor cannot mint shares to someone else.
        usdg.mint(lp, 10e6);
        vm.startPrank(lp);
        usdg.approve(address(gov), 10e6);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.DepositorNotAllowed.selector, lp));
        gov.deposit(10e6, stranger);
        vm.expectRevert(IODGovernor.UseWithdrawalQueue.selector);
        gov.mint(1e12, lp);
        vm.expectRevert(IODGovernor.UseWithdrawalQueue.selector);
        gov.withdraw(1, lp, lp);
        vm.expectRevert(IODGovernor.UseWithdrawalQueue.selector);
        gov.redeem(1, lp, lp);
        vm.stopPrank();
        _deposit(lp, 10e6);
        assertEq(gov.freeCash(), 10e6);
    }

    function test_DepositPricedAtHighNav() public {
        _deposit(lp, 100_000e6);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 10_000e18, 10_000e6);
        guard.set(TSLA, 250e18, 240e18); // reference lower: the holders' gears are worth less at refP
        (int256 low, int256 high) = gov.navBand();
        // liability at p = 10,000; at refP = 10,000 x 0.96^2 = 9,216
        assertEq(high, 110_000e18 - 9_216e18);
        assertEq(low, 110_000e18 - 10_000e18);
        uint256 supply = gov.totalSupply();
        uint256 expected = uint256(1_000e6) * (supply + 1e6) / (100_784e6 + 1);
        assertEq(gov.previewDeposit(1_000e6), expected);
        uint256 shares = _deposit(lp, 1_000e6);
        assertEq(shares, expected);
        assertLt(shares, gov.convertToShares(1_000e6), "fewer shares than at mid NAV");
    }

    function test_MaxDepositNeverReverts() public {
        assertEq(gov.maxDeposit(stranger), 0);
        assertEq(gov.maxDeposit(lp), type(uint256).max);
        _deposit(lp, 1_000e6);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 100e18, 100e6);
        guard.setBomb(true);
        assertEq(gov.maxDeposit(lp), 0, "an unpriceable book reads 0, never reverts");
        guard.setBomb(false);
        assertEq(gov.maxDeposit(lp), type(uint256).max);
        assertEq(gov.maxMint(lp), 0);
        assertEq(gov.maxWithdraw(lp), 0);
        assertEq(gov.maxRedeem(lp), 0);
    }

    function test_VirtualSharesConstant() public view {
        assertEq(gov.decimals(), 12);
        assertEq(10 ** uint256(gov.decimals() - usdg.decimals()), 1e6);
    }

    function test_FirstDepositMinimum() public {
        usdg.mint(lp, 1e6);
        vm.startPrank(lp);
        usdg.approve(address(gov), 1e6);
        vm.expectRevert(IODGovernor.FirstDepositTooSmall.selector);
        gov.deposit(0.5e6, lp);
        vm.stopPrank();
    }

    function test_ClaimAfterDelay() public {
        uint256 shares = _deposit(lp, 100_000e6);
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares / 2);
        assertEq(gov.balanceOf(address(gov)), shares / 2);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lp);
        uint256 paid = gov.claim(t, 0);
        assertApproxEqAbs(paid, 50_000e6, 1);
        assertEq(usdg.balanceOf(lp), paid);
        (, uint256 left,) = gov.ticketOf(t);
        assertEq(left, 0);
    }

    function test_ClaimTooEarly() public {
        uint256 shares = _deposit(lp, 1_000e6);
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours - 1);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.TooEarly.selector, uint64(vm.getBlockTimestamp() + 1)));
        gov.claim(t, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.NotTicketOwner.selector, t));
        gov.claim(t, 0);
    }

    function test_PartialClaimKeepsRemainder() public {
        uint256 shares = _deposit(lp, 100_000e6);
        vm.prank(keeper);
        gov.moveToExitReserve(80_000e6);
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lp);
        uint256 paid = gov.claim(t, 0);
        assertEq(paid, 20_000e6, "limited by free cash");
        (, uint256 left,) = gov.ticketOf(t);
        assertApproxEqRel(left, shares * 8 / 10, 1e12);
        // More cash arrives: the rest is claimable.
        _fundCash(80_000e6);
        vm.prank(lp);
        uint256 paid2 = gov.claim(t, 0);
        // The exit reserve is still in NAV (backers own it, they just cannot take it): half of 160,000 is paid.
        assertEq(paid2, 80_000e6);
        (, left,) = gov.ticketOf(t);
        assertApproxEqRel(left, shares * 4 / 10, 1e12);
        // A claim with no free cash returns 0, never reverts.
        vm.prank(lp);
        assertEq(gov.claim(t, 0), 0);
    }

    function test_ClaimNeverTouchesExitReserve() public {
        uint256 shares = _deposit(lp, 10_000e6);
        vm.prank(keeper);
        gov.moveToExitReserve(10_000e6);
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lp);
        assertEq(gov.claim(t, 0), 0);
        assertEq(gov.exitReserve(), 10_000e6);
    }

    function test_ClaimLimitedByStressBudget() public {
        uint256 shares = _deposit(lp, 100_000e6);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 20_000e18, 20_000e6); // stress 20,000 x 0.5625 = 11,250 <= 15% of 100,000
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lp);
        uint256 paid = gov.claim(t, 0);
        // equity after must keep 11,250 <= 15% of it: equity >= 75,000, so at most 25,000 leaves.
        assertEq(paid, 25_000e6);
        (uint256 loss, uint256 budget) = gov.stressLoss();
        assertLe(loss, budget);
    }
}
