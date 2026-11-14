// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "../governor/GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// M-3 (audit early pass): claim had no minimum out, and with a stale hedge post it burnt the whole ticket at a low
/// edge that leaves out all hedge equity (all shares for 70,000 of 100,000). Claims now fail closed while any hedge
/// post is stale and take a caller-set minAssetsOut.
contract ClaimMinOutTest is GovernorFixture {
    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
    }

    function _lpTicketWithHedge() internal returns (uint256 ticket, uint256 shares) {
        vm.prank(hedger);
        gov.sendToHedger(30_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 1e18, 30_000e6, uint64(vm.getBlockTimestamp()));
        shares = gov.balanceOf(lp);
        vm.prank(lp);
        ticket = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
    }

    function _repost() internal {
        vm.prank(hedger);
        gov.postHedge(TSLA, 1e18, 30_000e6, uint64(vm.getBlockTimestamp()));
    }

    /// The audit PoC, flipped: with a stale post the claim reverts and every share stays on the ticket.
    function test_M3_StaleHedgeClaimFailsClosed() public {
        (uint256 ticket, uint256 shares) = _lpTicketWithHedge();
        assertTrue(gov.hedgeStale());
        vm.prank(lp);
        vm.expectRevert(IODGovernor.HedgeStale.selector);
        gov.claim(ticket, 0);
        (, uint256 left,) = gov.ticketOf(ticket);
        assertEq(left, shares, "no share burnt");
        // once the hedger posts again the claim pays the cash part and keeps 30% of the shares on the ticket
        _repost();
        vm.prank(lp);
        uint256 paid = gov.claim(ticket, 69_000e6);
        (, left,) = gov.ticketOf(ticket);
        assertApproxEqAbs(paid, 70_000e6, 2);
        assertApproxEqRel(left, shares * 30 / 100, 1e15);
    }

    /// minAssetsOut is a hard floor on what the claim pays.
    function test_M3_MinAssetsOut() public {
        (uint256 ticket, uint256 shares) = _lpTicketWithHedge();
        _repost();
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.ClaimBelowMin.selector, 70_000e6, 70_000e6 + 1e6));
        gov.claim(ticket, 70_000e6 + 1e6);
        (, uint256 left,) = gov.ticketOf(ticket);
        assertEq(left, shares);
    }

    /// Property: for any minimum, any wait and either hedge state, a claim either reverts (leaving the ticket whole)
    /// or pays at least the minimum with a fresh hedge, and paid + the value left on the ticket is at least the
    /// ticket's value before (no share is burnt for less than its low-edge value).
    function testFuzz_M3_ClaimNeverBelowMinOrStale(uint256 minOut, uint32 wait, bool repost) public {
        (uint256 ticket, uint256 shares) = _lpTicketWithHedge();
        vm.warp(vm.getBlockTimestamp() + (wait % 6 hours));
        if (repost) _repost();
        minOut = bound(minOut, 0, 120_000e6);
        bool stale = gov.hedgeStale();
        uint256 before = gov.convertToAssets(shares);
        vm.prank(lp);
        (bool ok, bytes memory ret) = address(gov).call(abi.encodeCall(gov.claim, (ticket, minOut)));
        (, uint256 left,) = gov.ticketOf(ticket);
        if (!ok) {
            assertEq(left, shares, "a refused claim burns nothing");
            return;
        }
        uint256 paid = abi.decode(ret, (uint256));
        assertFalse(stale, "never pays while stale");
        assertGe(paid, minOut);
        assertGe(paid + gov.convertToAssets(left) + 2, before * 99 / 100, "value kept (low edge vs mid)");
    }
}
