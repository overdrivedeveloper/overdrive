// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// R14: hedge posts within bounds; sends only to the configured wallet, bounded by equity.
contract HedgeTest is GovernorFixture {
    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
    }

    function _post(address who, bytes32 m, uint256 eq, uint64 asOf) internal {
        vm.prank(who);
        gov.postHedge(m, 1e18, eq, asOf);
    }

    function test_PostBounds() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        _post(hedger, TSLA, 5_000e6, t); // 5% of 100,000
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.BadAsOf.selector, t + 1));
        gov.postHedge(TSLA, 0, 5_000e6, t + 1);
        vm.warp(t + 2 hours); // the jump bound is per hedgeMaxAge window (M-2)
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.BadAsOf.selector, t - 1));
        gov.postHedge(TSLA, 0, 5_000e6, t - 1);
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.HedgeJump.selector, 5_000e6, 10_001e6, 5_000e6));
        gov.postHedge(TSLA, 0, 10_001e6, t + 2 hours);
        _post(hedger, TSLA, 10_000e6, t + 2 hours);
        vm.warp(t + 4 hours); // next window: room for the second market
        // A different market has its own previous post; the total counts in NAV.
        _post(hedger, NVDA, 2_000e6, t + 4 hours);
        (uint256 posted,) = gov.hedgeEquity();
        assertEq(posted, 12_000e6);
        assertEq(gov.equity(), 112_000e18);
        // The admin may post any jump (a correction).
        _post(admin, TSLA, 0, t + 4 hours);
        (posted,) = gov.hedgeEquity();
        assertEq(posted, 2_000e6);
        vm.prank(stranger);
        vm.expectRevert();
        gov.postHedge(TSLA, 0, 0, t + 4 hours);
        assertEq(gov.hedgeMaxAge(), 2 hours);
        assertEq(gov.maxHedgeJumpBps(), 500);
    }

    function test_SendBounded() public {
        vm.prank(hedger);
        gov.sendToHedger(30_000e6); // 30% of equity
        assertEq(gov.equity(), 100_000e18, "in transit: NAV unchanged");
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.HedgeCap.selector, 30_000e6 + 1, 30_000e6));
        gov.sendToHedger(1);
        // The next posts absorb the transit without a jump.
        _post(hedger, TSLA, 20_000e6, uint64(vm.getBlockTimestamp()));
        _post(hedger, NVDA, 10_000e6, uint64(vm.getBlockTimestamp()));
        (uint256 posted, int256 transit) = gov.hedgeEquity();
        assertEq(posted, 30_000e6);
        assertEq(transit, 0);
        assertEq(gov.equity(), 100_000e18);
        // Money back: tracked cash up, transit negative until the posts fall.
        usdg.mint(hedger, 0); // hedger holds nothing; the wallet returns via the hedger key
        vm.prank(hedgeWallet);
        usdg.transfer(hedger, 5_000e6);
        vm.startPrank(hedger);
        usdg.approve(address(gov), 5_000e6);
        gov.returnFromHedger(5_000e6);
        vm.stopPrank();
        assertEq(gov.equity(), 100_000e18);
        _post(hedger, TSLA, 15_000e6, uint64(vm.getBlockTimestamp()));
        (, transit) = gov.hedgeEquity();
        assertEq(transit, 0);
        assertEq(gov.equity(), 100_000e18);
    }

    function test_SendOnlyToConfiguredWallet() public {
        vm.prank(hedger);
        gov.sendToHedger(1_000e6);
        assertEq(usdg.balanceOf(hedgeWallet), 1_000e6);
        assertEq(usdg.balanceOf(hedger), 0);
        vm.prank(stranger);
        vm.expectRevert();
        gov.sendToHedger(1);
        vm.prank(admin);
        vm.expectRevert(IODGovernor.InvalidParams.selector);
        gov.setHedger(address(0));
        vm.prank(hedger);
        vm.expectRevert();
        gov.setHedger(hedger);
    }
}
