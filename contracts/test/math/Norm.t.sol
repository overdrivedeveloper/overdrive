// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {Gear} from "../../src/interfaces/ODTypes.sol";
import {ODNorm} from "../../src/math/ODNorm.sol";
import {ODToll} from "../../src/math/ODToll.sol";
import {ODFixed} from "../../src/math/ODFixed.sol";

contract NormTest is ODTest {
    uint256 internal constant WAD = 1e18;

    function test_ZeroDtNoop() public pure {
        assertEq(ODNorm.step(0.7e18, 11415525115, 0), 0.7e18);
        assertEq(ODNorm.step(0.7e18, -11415525115, 0), 0.7e18);
        assertEq(ODNorm.step(0.7e18, 0, 30 days), 0.7e18, "zero toll");
        assertEq(ODNorm.step(5, 11415525115, 1 days), 5, "below the floor with a positive toll: unchanged");
    }

    /// One day of TSLA Sport (0.36/yr) moves NF by about 1 - e^(-0.36/365): the hourly product matches the
    /// continuous rate to about x^2 / 48 = 2e-8 (x = 0.36 / 365).
    function test_OneDaySpecExample() public pure {
        int256 perSec = ODToll.perSecond(ODToll.tollPerYear(Gear.SPORT, 6000, 0));
        uint256 nf = ODNorm.step(WAD, perSec, 1 days);
        uint256 cont = ODFixed.expWad(-int256(0.36e18) / 365);
        assertApproxEqRel(nf, cont, 3e10, "hourly product ~ continuous");
        assertLt(nf, WAD);
        // ECO: holders receive, NF rises.
        int256 eco = ODToll.perSecond(ODToll.tollPerYear(Gear.ECO, 6000, 0));
        assertGt(ODNorm.step(WAD, eco, 1 days), WAD);
    }

    /// Long gaps saturate at the bounds without reverting.
    function test_SaturatesAtBounds() public pure {
        int256 maxPerSec = ODNorm.MAX_ABS_PER_SEC;
        assertEq(ODNorm.step(WAD, maxPerSec, 3650 days), ODNorm.MIN_NF, "ten years at 400%: floor");
        assertEq(ODNorm.step(WAD, -maxPerSec, 3650 days), ODNorm.MAX_NF, "ten years at -400%: ceiling");
        assertEq(ODNorm.step(WAD, type(int256).max, type(uint256).max), ODNorm.MIN_NF);
        assertEq(ODNorm.step(WAD, type(int256).min, type(uint256).max), ODNorm.MAX_NF);
        assertEq(ODNorm.step(ODNorm.MAX_NF, -1, 1 days), ODNorm.MAX_NF);
    }

    function test_TollValue() public pure {
        // 10 tokens worth 100 each, NF falls 1%: 10 moved to the Governor.
        assertEq(ODNorm.tollValue(10e18, 100e18, 1e18, 0.99e18), 10e18);
        assertEq(ODNorm.tollValue(10e18, 100e18, 1e18, 1.01e18), -10e18, "holders receive");
        assertEq(ODNorm.tollValue(10e18, 100e18, 1e18, 1e18), 0);
        assertEq(ODNorm.tollValue(10e18, 100e18, 0, 1e18), 0, "nf 0");
    }
}
