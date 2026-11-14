// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ODTest} from "../utils/ODTest.sol";
import {Gear} from "../../src/interfaces/ODTypes.sol";
import {ODIndex} from "../../src/math/ODIndex.sol";
import {ODFixed} from "../../src/math/ODFixed.sol";

/// External wrapper so reverts of the internal library can be expected.
contract IndexHarness {
    function ratio(uint256 p, uint256 p0) external pure returns (uint256 r, bool inDomain) {
        return ODIndex.ratio(p, p0, Math.Rounding.Floor);
    }

    function shockFactor(Gear g, int256 s) external pure returns (uint256) {
        return ODIndex.shockFactor(g, s, Math.Rounding.Floor);
    }
}

contract IndexTest is ODTest {
    uint256 internal constant WAD = 1e18;
    Math.Rounding internal constant FLOOR = Math.Rounding.Floor;
    Math.Rounding internal constant CEIL = Math.Rounding.Ceil;
    IndexHarness internal h;

    function setUp() public {
        h = new IndexHarness();
    }

    function _gear(uint256 i) internal pure returns (Gear) {
        return Gear(uint8(i));
    }

    /// R1: the closed forms at known points, and agreement with the plain mulWad/sqrtWad/divWad compositions.
    function test_ClosedFormsAtKnownPoints() public pure {
        // Exact points.
        assertEq(ODIndex.index(Gear.SPORT, 2e18, FLOOR), 4e18, "2^2");
        assertEq(ODIndex.index(Gear.RACE, 2e18, FLOOR), 8e18, "2^3");
        assertEq(ODIndex.index(Gear.RACE, 10e18, FLOOR), 1000e18, "10^3");
        assertEq(ODIndex.index(Gear.ECO, 0.5e18 / 2 * 1, FLOOR), 0.5e18, "sqrt 0.25");
        assertEq(ODIndex.index(Gear.REVERSE, 2e18, FLOOR), 0.5e18, "1/2");
        assertEq(ODIndex.index(Gear.REVERSE, 10e18, FLOOR), 0.1e18, "1/10");
        assertEq(ODIndex.index(Gear.SPORT, 0.5e18, FLOOR), 0.25e18, "0.5^2");
        assertEq(ODIndex.index(Gear.RACE, 0.5e18, FLOOR), 0.125e18, "0.5^3");
        assertEq(ODIndex.index(Gear.SPORT, 1.1e18, FLOOR), 1.21e18, "1.1^2");
        assertEq(ODIndex.index(Gear.RACE, 1.1e18, FLOOR), 1.331e18, "1.1^3");
        assertEq(ODIndex.index(Gear.SPORT, 0.9e18, FLOOR), 0.81e18, "0.9^2");
        assertEq(ODIndex.index(Gear.RACE, 0.9e18, FLOOR), 0.729e18, "0.9^3");
        // Irrational points, floor of the true value (checked by hand to 18 digits).
        assertEq(ODIndex.index(Gear.CRUISE, 2e18, FLOOR), 2828427124746190097, "2^1.5");
        assertEq(ODIndex.index(Gear.ECO, 2e18, FLOOR), 1414213562373095048, "2^0.5");
        assertEq(ODIndex.index(Gear.CRUISE, 10e18, FLOOR), 31622776601683793319, "10^1.5");
        assertEq(ODIndex.index(Gear.CRUISE, 0.5e18, FLOOR), 353553390593273762, "0.5^1.5");
        assertEq(ODIndex.index(Gear.REVERSE, 0.9e18, FLOOR), 1111111111111111111, "1/0.9");
        assertEq(ODIndex.index(Gear.REVERSE, 0.9e18, CEIL), 1111111111111111112, "1/0.9 ceil");
        uint256[6] memory pts = [uint256(0.5e18), 0.9e18, 1e18, 1.1e18, 2e18, 10e18];
        for (uint256 k; k < pts.length; ++k) {
            uint256 r = pts[k];
            for (uint256 g; g < 5; ++g) {
                uint256 i = ODIndex.index(_gear(g), r, FLOOR);
                uint256 c = _composition(_gear(g), r);
                assertApproxEqAbs(i, c, 11, "matches the mulWad composition");
                if (r == 1e18) assertEq(i, WAD, "1^p = 1");
            }
        }
    }

    function _composition(Gear g, uint256 r) internal pure returns (uint256) {
        if (g == Gear.CRUISE) return ODFixed.mulWad(r, ODFixed.sqrtWad(r, FLOOR), FLOOR);
        if (g == Gear.SPORT) return ODFixed.mulWad(r, r, FLOOR);
        if (g == Gear.RACE) return ODFixed.mulWad(ODFixed.mulWad(r, r, FLOOR), r, FLOOR);
        if (g == Gear.ECO) return ODFixed.sqrtWad(r, FLOOR);
        return ODFixed.divWad(WAD, r, FLOOR);
    }

    /// R5: the overview table, within 0.05 percentage points.
    function test_OverviewTable() public pure {
        int256[5] memory up = [int256(15.4e16), 21e16, 33.1e16, 4.88e16, -9.09e16];
        int256[5] memory down = [int256(-14.6e16), -19e16, -27.1e16, -5.13e16, 11.1e16];
        for (uint256 g; g < 5; ++g) {
            (uint256 vu,) = ODIndex.value(_gear(g), 110e18, 100e18, WAD, WAD, FLOOR);
            (uint256 vd,) = ODIndex.value(_gear(g), 90e18, 100e18, WAD, WAD, FLOOR);
            assertApproxEqAbs(int256(vu) - 1e18, up[g], 0.05e16, "r = 1.1");
            assertApproxEqAbs(int256(vd) - 1e18, down[g], 0.05e16, "r = 0.9");
        }
    }

    /// R6: clamping and the flag.
    function test_RatioClampsAndFlags() public view {
        (uint256 r, bool ok) = h.ratio(1e18, 100e18); // 0.01
        assertEq(r, ODIndex.MIN_R);
        assertFalse(ok);
        (r, ok) = h.ratio(2e18, 100e18); // exactly 0.02
        assertEq(r, ODIndex.MIN_R);
        assertTrue(ok);
        (r, ok) = h.ratio(5000e18, 100e18); // exactly 50
        assertEq(r, ODIndex.MAX_R);
        assertTrue(ok);
        (r, ok) = h.ratio(5001e18, 100e18);
        assertEq(r, ODIndex.MAX_R);
        assertFalse(ok);
        (r, ok) = h.ratio(123e18, 100e18);
        assertEq(r, 1.23e18);
        assertTrue(ok);
        (uint256 v, bool inDomain) = ODIndex.value(Gear.SPORT, 1, 100e18, WAD, WAD, FLOOR);
        assertFalse(inDomain);
        assertEq(v, 0.0004e18, "clamped value at 0.02^2");
    }

    function test_RatioZeroReverts() public {
        vm.expectRevert(ODIndex.RatioZero.selector);
        h.ratio(0, 1e18);
        vm.expectRevert(ODIndex.RatioZero.selector);
        h.ratio(1e18, 0);
    }

    /// R14: a pair gear prices on the ratio pA / pB.
    function test_PairUsesRatio() public pure {
        uint256 p0Ratio = ODIndex.pairPrice(200e18, 100e18); // A = 2 B at the start
        // A up 10%, B flat: the SPORT pair is up 21%, like a single asset up 10%.
        (uint256 v,) = ODIndex.value(Gear.SPORT, ODIndex.pairPrice(220e18, 100e18), p0Ratio, WAD, WAD, FLOOR);
        assertEq(v, 1.21e18, "A beats B by 10%");
        // Both up 10%: no change ("one token for this beats that" measures only the relative move).
        (v,) = ODIndex.value(Gear.SPORT, ODIndex.pairPrice(220e18, 110e18), p0Ratio, WAD, WAD, FLOOR);
        assertEq(v, 1e18, "both moved together");
        // B up 10%, A flat: REVERSE pair gains 10%.
        (v,) = ODIndex.value(Gear.REVERSE, ODIndex.pairPrice(200e18, 110e18), p0Ratio, WAD, WAD, CEIL);
        assertApproxEqAbs(v, 1.1e18, 2, "REVERSE pair");
        // Pair price rounds down.
        assertEq(ODIndex.pairPrice(1e18, 3e18), 333333333333333333);
    }

    function test_ValueScalesWithNfAndUnit() public pure {
        (uint256 v,) = ODIndex.value(Gear.SPORT, 110e18, 100e18, 0.5e18, 100e18, FLOOR);
        assertEq(v, 60.5e18, "0.5 * 1.21 * 100");
    }

    function test_ShockFactor() public view {
        assertEq(ODIndex.shockFactor(Gear.SPORT, 0.1e18, FLOOR), 1.21e18);
        assertEq(ODIndex.shockFactor(Gear.RACE, -0.1e18, FLOOR), 0.729e18);
        assertEq(ODIndex.shockFactor(Gear.REVERSE, 0, FLOOR), 1e18);
        // value(r * (1 + s)) / value(r) = (1 + s)^p for SPORT at r = 1.2, s = 0.1
        uint256 a = ODIndex.index(Gear.SPORT, 1.2e18, FLOOR);
        uint256 b = ODIndex.index(Gear.SPORT, 1.32e18, FLOOR);
        assertEq(b * 1e18 / a, ODIndex.shockFactor(Gear.SPORT, 0.1e18, FLOOR));
        assertEq(h.shockFactor(Gear.ECO, -0.5e18), 707106781186547524);
    }

    function test_ShockOutOfRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ODIndex.ShockOutOfRange.selector, int256(-1e18)));
        h.shockFactor(Gear.REVERSE, -1e18);
    }

    function test_HalfPPMinus1() public pure {
        assertEq(ODIndex.halfPPMinus1Wad(Gear.CRUISE), 0.375e18);
        assertEq(ODIndex.halfPPMinus1Wad(Gear.SPORT), 1e18);
        assertEq(ODIndex.halfPPMinus1Wad(Gear.RACE), 3e18);
        assertEq(ODIndex.halfPPMinus1Wad(Gear.ECO), -0.125e18);
        assertEq(ODIndex.halfPPMinus1Wad(Gear.REVERSE), 1e18);
    }
}
