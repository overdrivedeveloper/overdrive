// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R13: the Governor keeps 10% of toll received as a fee to ODFees; owed when there is no cash; ECO books none.
contract TollTest is GovernorFixture {
    bytes32 id;

    function setUp() public override {
        super.setUp();
        id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
    }

    function test_TollFeeTenPercent() public {
        _deposit(lp, 10_000e6);
        minter.toll(id, 5_000e18);
        assertEq(fees.notified("TOLL"), 500e6);
        assertEq(usdg.balanceOf(address(fees)), 500e6);
        assertEq(gov.trackedCash(), 9_500e6);
        assertEq(gov.feeOwed(), 0);
    }

    function test_FeeOwedWhenNoCash() public {
        minter.toll(id, 1_000e18);
        assertEq(gov.feeOwed(), 100e6);
        assertEq(gov.equity(), -100e18, "owed fee is a liability");
        _fundCash(50e6);
        assertEq(gov.feeOwed(), 50e6);
        assertEq(fees.notified("TOLL"), 50e6);
        // An empty vault with negative NAV takes no deposit (the depositor would absorb the debt).
        usdg.mint(lp, 1_000e6);
        vm.startPrank(lp);
        usdg.approve(address(gov), 1_000e6);
        vm.expectRevert();
        gov.deposit(1_000e6, lp);
        vm.stopPrank();
        _fundCash(1_000e6);
        assertEq(gov.feeOwed(), 0);
        assertEq(fees.notified("TOLL"), 100e6);
        // A fees contract whose notify reverts never blocks the toll: the USDG still moves, the event says so.
        fees.setReverting(true);
        minter.toll(id, 1_000e18);
        assertEq(gov.feeOwed(), 0);
        assertEq(usdg.balanceOf(address(fees)), 200e6);
    }

    function test_NegativeTollNoFee() public {
        _deposit(lp, 1_000e6);
        minter.toll(id, -5_000e18);
        assertEq(gov.feeOwed(), 0);
        assertEq(usdg.balanceOf(address(fees)), 0);
        assertEq(gov.trackedCash(), 1_000e6);
    }

    function test_SpreadShareToFees() public {
        _deposit(lp, 10_000e6);
        _buyS(id, 1_000e18, 1_010e6, 10e6);
        assertEq(fees.notified("SPREAD"), 1e6);
        // A sell books its share as owed so the payout is exactly pay's; the next inflow settles it.
        minter.sell(id, alice, alice, 100e18, 99e6, 2e6);
        assertEq(gov.feeOwed(), 0.2e6);
        _fundCash(1e6);
        assertEq(gov.feeOwed(), 0);
        assertEq(fees.notified("SPREAD"), 1.2e6);
    }
}
