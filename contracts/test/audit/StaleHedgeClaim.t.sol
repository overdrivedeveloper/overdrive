// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "../governor/GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Audit rescore 1 L-6: one stale hedge post blocked every LP claim. Fails on 3fe7859 (HedgeStale).
contract StaleHedgeClaimTest is GovernorFixture {
    bytes32 internal sport;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
        sport = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
    }

    function _ticket(uint256 shares) internal returns (uint256 ticket) {
        vm.prank(lp);
        ticket = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
    }

    // ------------------------------------------------------------------------------------------------ L-6

    /// The rescore PoC, flipped: a silent hedger holding 1% of equity no longer blocks a claim whose owner passes an
    /// explicit minimum. A zero minimum still fails closed (M-3 intent).
    function test_L6_StaleHedgeClaimWithExplicitMin() public {
        vm.prank(hedger);
        gov.sendToHedger(1_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 1e18, 1_000e6, uint64(vm.getBlockTimestamp()));
        uint256 shares = gov.balanceOf(lp) / 10;
        uint256 ticket = _ticket(shares);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertTrue(gov.hedgeStale());
        vm.prank(lp);
        vm.expectRevert(IODGovernor.HedgeStale.selector);
        gov.claim(ticket, 0);
        // the hedge-free value of a tenth of a 100,000 pool with 1,000 at the venue: 9,900
        vm.prank(lp);
        vm.expectRevert();
        gov.claim(ticket, 9_950e6);
        vm.prank(lp);
        uint256 paid = gov.claim(ticket, 9_890e6);
        assertApproxEqAbs(paid, 9_900e6, 2);
        (, uint256 left,) = gov.ticketOf(ticket);
        assertEq(left, 0);
    }

    /// Property: a stale-hedge claim either reverts with the ticket whole, or had an explicit minimum it met, and never
    /// pays more than the hedge-free value (the LPs who stay are never paid out of hedge equity they cannot see).
    function testFuzz_L6_StaleClaimNeverAboveHedgeFree(uint256 minOut, uint256 hedgeUsdg, uint256 frac) public {
        hedgeUsdg = bound(hedgeUsdg, 1e6, 30_000e6);
        frac = bound(frac, 1, 100);
        vm.prank(hedger);
        gov.sendToHedger(hedgeUsdg);
        vm.prank(hedger);
        gov.postHedge(TSLA, 1e18, hedgeUsdg, uint64(vm.getBlockTimestamp()));
        uint256 shares = gov.balanceOf(lp) * frac / 100;
        uint256 ticket = _ticket(shares);
        assertTrue(gov.hedgeStale());
        uint256 hedgeFree = (100_000e6 - hedgeUsdg) * frac / 100;
        minOut = bound(minOut, 0, 120_000e6);
        vm.prank(lp);
        (bool ok, bytes memory ret) = address(gov).call(abi.encodeCall(gov.claim, (ticket, minOut)));
        (, uint256 left,) = gov.ticketOf(ticket);
        if (!ok) {
            assertEq(left, shares);
            return;
        }
        uint256 paid = abi.decode(ret, (uint256));
        assertGt(minOut, 0, "a zero minimum never pays while stale");
        assertGe(paid, minOut);
        assertLe(paid, hedgeFree + 2, "never above the hedge-free value");
    }
}
