// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "../governor/GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// M-2 (audit early pass): the hedge jump limit was per call, so 200 posts of +5% in ONE block made NAV 11x and a
/// matured ticket for 1/11 of the shares took all the free cash. The bound is now cumulative per hedgeMaxAge window.
contract HedgeJumpWindowTest is GovernorFixture {
    bytes32[2] internal mk;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
        mk = [TSLA, NVDA];
    }

    function _aliceTicket() internal returns (uint256 ticket) {
        uint256 shares = _deposit(alice, 10_000e6);
        vm.prank(alice);
        ticket = gov.requestWithdraw(shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
    }

    /// The audit PoC, flipped: the second +5% post in the same block reverts; NAV moves at most 5%.
    function test_M2_RepeatedPostsInOneBlockRevert() public {
        uint256 ticket = _aliceTicket();
        uint64 t = uint64(vm.getBlockTimestamp());
        vm.startPrank(hedger);
        gov.postHedge(TSLA, 0, 5_500e6, t);
        uint256 posted = 5_500e6;
        for (uint256 i; i < 200; ++i) {
            posted += 5_500e6;
            vm.expectRevert();
            gov.postHedge(TSLA, 0, posted, t);
        }
        vm.stopPrank();
        assertLe(gov.equity(), 115_500e18, "NAV at most 5% over the 110,000 anchor");
        vm.prank(alice);
        uint256 paid = gov.claim(ticket, 0);
        assertLe(paid, 10_500e6 + 2, "alice gets her own share, not the other LP's money");
    }

    /// Spreading the posts over markets does not help, and the window restarts after hedgeMaxAge.
    function test_M2_WindowAcrossMarketsAndRestart() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        vm.startPrank(hedger);
        gov.postHedge(TSLA, 0, 3_000e6, t);
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.HedgeJump.selector, 0, 2_001e6, 2_000e6));
        gov.postHedge(NVDA, 0, 2_001e6, t);
        gov.postHedge(NVDA, 0, 2_000e6, t);
        // a fall inside the window frees room again (the bound is on the NET change against the anchor)
        gov.postHedge(TSLA, 0, 0, t);
        gov.postHedge(NVDA, 0, 5_000e6, t);
        vm.warp(t + gov.hedgeMaxAge());
        uint64 t2 = uint64(vm.getBlockTimestamp());
        // new window, new anchor: equity less hedge equity (L-5), 100,000 - 5,000, so 4,750 of room
        vm.expectRevert(abi.encodeWithSelector(IODGovernor.HedgeJump.selector, 0, 4_751e6, 4_750e6));
        gov.postHedge(TSLA, 0, 4_751e6, t2);
        gov.postHedge(TSLA, 0, 4_750e6, t2);
        vm.stopPrank();
    }

    /// Property: over random post sequences (two markets, random sizes, random waits), a hedger post succeeds exactly
    /// when hedgeJumpRange says so, and the posted total never moves more than maxHedgeJumpBps of the window's anchor
    /// equity from where the window started, however many posts land in one block.
    function testFuzz_M2_CumulativeBoundAndRangeParity(uint256 seed) public {
        uint256 bps = gov.maxHedgeJumpBps();
        uint256 age = gov.hedgeMaxAge();
        uint256 wStart;
        uint256 anchor;
        uint256 base;
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 r = seed % 4;
            if (r == 0) vm.warp(vm.getBlockTimestamp() + (seed >> 8) % (age + age / 2));
            bytes32 m = mk[(seed >> 64) % 2];
            (, uint256 prev,) = gov.hedgeOf(m);
            uint256 next = (seed >> 96) % 2 == 0 ? prev + (seed >> 128) % 8_000e6 : prev - (seed >> 128) % (prev + 1);
            (uint256 lo, uint256 hi) = gov.hedgeJumpRange(m);
            (uint256 before,) = gov.hedgeEquity();
            (int256 cached,,) = gov.cachedEquity();
            vm.prank(hedger);
            (bool ok,) =
                address(gov).call(abi.encodeCall(gov.postHedge, (m, int256(0), next, uint64(vm.getBlockTimestamp()))));
            assertEq(ok, next >= lo && next <= hi, "postHedge agrees with hedgeJumpRange");
            if (!ok) continue;
            if (wStart == 0 || vm.getBlockTimestamp() >= wStart + age) {
                wStart = vm.getBlockTimestamp();
                anchor = uint256(cached) / 1e12;
                base = before;
            }
            (uint256 posted,) = gov.hedgeEquity();
            uint256 d = posted > base ? posted - base : base - posted;
            assertLe(d, anchor * bps / 10_000, "cumulative change within the window bound");
        }
    }
}
