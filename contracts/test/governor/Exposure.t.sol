// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R8: delta p V net, gamma p (p - 1) V net, open |net| V; a pair's marketB side has power -p.
contract ExposureTest is GovernorFixture {
    function setUp() public override {
        super.setUp();
        _deposit(lp, 1_000_000e6);
    }

    function test_DeltaGammaFormulas() public {
        bytes32 s = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        bytes32 c = _list(TSLA, NONE, Gear.CRUISE, 1_000_000e18);
        bytes32 e = _list(TSLA, NONE, Gear.ECO, 1_000_000e18);
        bytes32 r = _list(TSLA, NONE, Gear.REVERSE, 1_000_000e18);
        _buy(s, 1_000e18, 1_000e6);
        _buy(c, 2_000e18, 2_000e6);
        _buy(e, 4_000e18, 4_000e6);
        _buy(r, 8_000e18, 8_000e6);
        (int256 d, int256 g, uint256 open) = gov.exposure(TSLA);
        // delta = 2 x 1,000 + 1.5 x 2,000 + 0.5 x 4,000 - 1 x 8,000 = -1,000
        assertEq(d, -1_000e18);
        // gamma = 2 x 1,000 + 0.75 x 2,000 - 0.25 x 4,000 + 2 x 8,000 = 18,500
        assertEq(g, 18_500e18);
        assertEq(open, 15_000e18);
        // A backer's debt nets out of the book.
        vm.prank(backerC);
        gov.onBackerMint(s, 1_000e18, false, 0);
        (d,,) = gov.exposure(TSLA);
        assertEq(d, -3_000e18);
    }

    function test_PairSidesOpposite() public {
        bytes32 p = _list(TSLA, NVDA, Gear.SPORT, 1_000_000e18);
        _buy(p, 1_000e18, 1_000e6);
        (int256 dA, int256 gA, uint256 oA) = gov.exposure(TSLA);
        (int256 dB, int256 gB, uint256 oB) = gov.exposure(NVDA);
        assertEq(dA, 2_000e18);
        assertEq(dB, -2_000e18);
        assertEq(gA, 2_000e18); // 2 x 1
        assertEq(gB, 6_000e18); // -2 x -3
        assertEq(oA, oB);
    }
}
