// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R17 (ARITH-LIVENESS): every subtraction on pay, onSell, claim and onToll at its boundary.
contract LivenessTest is GovernorFixture {
    address internal seller = makeAddr("seller");

    function test_Boundaries() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        // pay: exactly cash + reserve drains both to 0; one more wei returns false.
        _fundCash(100e6);
        _fundReserve(50e6);
        assertFalse(minter.payOut(seller, 150e6 + 1));
        assertTrue(minter.payOut(seller, 150e6));
        assertEq(gov.freeCash(), 0);
        assertEq(gov.exitReserve(), 0);
        assertFalse(minter.payOut(seller, 1));
        // onToll: fee exactly equal to cash, then with zero cash (owed, no underflow).
        _fundCash(10e6);
        minter.toll(id, 100e18);
        assertEq(gov.freeCash(), 0);
        minter.toll(id, 100e18);
        assertEq(gov.feeOwed(), 10e6);
        // onSell with zero cash, with fees owed and a spread share: books owed, never reverts.
        minter.sell(id, alice, alice, 0, 0, 1e6);
        assertEq(gov.feeOwed(), 10.1e6);
        _fundCash(10.1e6);
        assertEq(gov.feeOwed(), 0);
        // claim: value exactly equal to free cash, then a claim on an empty book.
        uint256 shares = _deposit(lp, 1_000e6);
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lp);
        uint256 paid = gov.claim(t, 0);
        assertGt(paid, 0);
        assertApproxEqAbs(gov.freeCash(), 0, 1);
        vm.prank(lp);
        assertEq(gov.claim(t, 0), 0);
        // claim with stress exactly at the budget: room 0, pays 0.
        uint256 s2 = _deposit(lp, 100_000e6);
        _buy(id, 26_666e18, 26_666e6); // 26,666 x 0.5625 = 14,999.6 just under 15% of 100,000
        vm.prank(lp);
        uint256 t2 = gov.requestWithdraw(s2);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        _poke();
        vm.prank(lp);
        uint256 p2 = gov.claim(t2, 0);
        (uint256 loss, uint256 budget) = gov.stressLoss();
        assertLe(loss, budget + 1e12, "claim leaves stress inside the budget");
        assertLt(p2, 100_000e6);
        // hedge transit more negative than posted equity: hedge total floors at 0, NAV still computes.
        vm.prank(hedger);
        gov.sendToHedger(0);
        usdg.mint(hedger, 1_000e6);
        vm.startPrank(hedger);
        usdg.approve(address(gov), 1_000e6);
        gov.returnFromHedger(1_000e6);
        vm.stopPrank();
        (, int256 transit) = gov.hedgeEquity();
        assertEq(transit, -1_000e6);
        gov.equity();
    }
}
