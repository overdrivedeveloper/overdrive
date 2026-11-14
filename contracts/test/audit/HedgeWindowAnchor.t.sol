// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "../governor/GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Audit rescore 1 L-5: the hedge jump window re-anchored on equity the hedger itself inflated (x1.7958 in 24 h on
/// 3fe7859). Fails on 3fe7859.
contract HedgeWindowAnchorTest is GovernorFixture {
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

    // ------------------------------------------------------------------------------------------------ L-5

    /// The rescore measurement, as a bound: posting the top of the range every window with a poke between no longer
    /// compounds (the anchor leaves hedge equity out). Was x1.7958 in 24 h; now each window adds at most 5% of the
    /// hedge-free equity.
    function test_L5_WindowAnchorExcludesHedge() public {
        uint256 e0 = uint256(gov.equity());
        uint256 age = gov.hedgeMaxAge();
        for (uint256 i; i < 12; ++i) {
            (, uint256 hi) = gov.hedgeJumpRange(TSLA);
            vm.prank(hedger);
            gov.postHedge(TSLA, 0, hi, uint64(vm.getBlockTimestamp()));
            _poke();
            vm.warp(vm.getBlockTimestamp() + age);
            _poke();
        }
        uint256 e1 = uint256(gov.equity());
        emit log_named_uint("equity after 24 h of max posts, bps of start", e1 * 10_000 / e0);
        assertLe(e1 * 10_000 / e0, 16_000, "linear: 12 windows x 5% of the hedge-free equity");
    }
}
