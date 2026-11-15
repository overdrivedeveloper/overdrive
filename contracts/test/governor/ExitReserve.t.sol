// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R5, R6, R7: the ring-fenced exit reserve and `pay`.
contract ExitReserveTest is GovernorFixture {
    address internal seller = makeAddr("seller");

    function test_OnlyPayDrawsReserve() public {
        _fundReserve(1_000e6);
        // Hedger, backer, claim and skim paths all see zero spendable cash.
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.InsufficientCash.selector, 1, 0));
        gov.sendToHedger(1);
        vm.prank(backerC);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        vm.prank(backerC);
        assertFalse(gov.onBackerMint(id, 1e18, true, 1, address(1)));
        vm.prank(admin);
        gov.skim();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.InsufficientCash.selector, 1, 0));
        gov.moveToExitReserve(1);
        assertEq(gov.exitReserve(), 1_000e6);
        assertTrue(minter.payOut(seller, 400e6));
        assertEq(gov.exitReserve(), 600e6);
        assertEq(usdg.balanceOf(seller), 400e6);
    }

    function test_HedgerCannotTouchReserve() public {
        _deposit(lp, 10_000e6);
        vm.prank(admin); // the keeper is metered (I4-5)
        gov.moveToExitReserve(10_000e6);
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.InsufficientCash.selector, 1e6, 0));
        gov.sendToHedger(1e6);
        vm.prank(hedger);
        vm.expectRevert(IODGovernor.NotMinter.selector);
        gov.onSell(bytes32(0), 0, 0, hedger, 1);
        assertEq(gov.exitReserve(), 10_000e6);
    }

    function test_AdminCannotWithdrawReserve() public {
        _fundReserve(5_000e6);
        vm.startPrank(admin);
        vm.expectRevert(IODGovernor.NotMinter.selector);
        gov.onSell(bytes32(0), 0, 0, admin, 1);
        gov.skim(); // nothing untracked
        vm.expectRevert(IODGovernor.UseWithdrawalQueue.selector);
        gov.withdraw(1, admin, admin);
        vm.stopPrank();
        assertEq(gov.exitReserve(), 5_000e6);
        assertEq(usdg.balanceOf(address(gov)), 5_000e6);
    }

    function test_PayFreeCashThenReserve() public {
        _fundCash(100e6);
        _fundReserve(1_000e6);
        vm.expectEmit(address(gov));
        emit IODGovernor.PaidOut(seller, 300e6, true);
        assertTrue(minter.payOut(seller, 300e6));
        assertEq(gov.freeCash(), 0);
        assertEq(gov.exitReserve(), 800e6);
        assertTrue(minter.payOut(seller, 0));
    }

    function test_PayReturnsFalseWhenShort() public {
        _fundCash(100e6);
        _fundReserve(100e6);
        assertFalse(gov.canPay(201e6));
        assertFalse(minter.payOut(seller, 201e6));
        assertEq(gov.freeCash(), 100e6);
        assertEq(gov.exitReserve(), 100e6);
        // ODInsurance tops up the shortfall.
        usdg.mint(address(this), 1e6);
        usdg.approve(address(ins), 1e6);
        ins.fund(1e6);
        assertTrue(gov.canPay(201e6));
        assertTrue(minter.payOut(seller, 201e6));
        assertEq(usdg.balanceOf(seller), 201e6);
        assertEq(ins.balance(), 0);
        assertEq(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve());
    }

    function test_PayReturnsFalseOnUsdgPause() public {
        _fundCash(1_000e6);
        usdg.setPaused(true);
        assertFalse(minter.payOut(seller, 10e6));
        usdg.setPaused(false);
        usdg.setBlocked(seller, true);
        assertFalse(minter.payOut(seller, 10e6));
        assertEq(gov.freeCash(), 1_000e6);
        usdg.setBlocked(seller, false);
        assertTrue(minter.payOut(seller, 10e6));
    }

    /// Whatever gas the caller forwards, a healthy USDG payout never comes back `false`: it pays or the call reverts.
    function test_OutOfGasReverts() public {
        _fundCash(1_000_000e6);
        for (uint256 g = 20_000; g < 140_000; g += 500) {
            try minter.payOutWithGas(seller, 1e6, g) returns (bool ok) {
                assertTrue(ok, "false with healthy USDG");
            } catch {}
        }
        assertGt(usdg.balanceOf(seller), 0, "some gas levels paid");
    }

    function test_FloorFormula() public {
        assertEq(gov.exitReserveFloor(), 1_000e6, "minimum with no holders");
        _deposit(lp, 100_000e6);
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 20_000e18, 20_000e6);
        assertEq(gov.exitReserveFloor(), 2_000e6, "10% of 20,000 holder open value");
        guard.set(TSLA, 300e18, 300e18); // value 1.44
        assertEq(gov.exitReserveFloor(), 2_880e6);
    }
}
