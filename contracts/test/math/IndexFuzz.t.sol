// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SD59x18, sd} from "@prb/math/src/SD59x18.sol";
import {UD60x18, ud} from "@prb/math/src/UD60x18.sol";
import {ODTest} from "../utils/ODTest.sol";
import {Gear} from "../../src/interfaces/ODTypes.sol";
import {ODIndex} from "../../src/math/ODIndex.sol";
import {ODPowers} from "../../src/interfaces/ODPowers.sol";

contract IndexFuzzTest is ODTest {
    Math.Rounding internal constant FLOOR = Math.Rounding.Floor;
    Math.Rounding internal constant CEIL = Math.Rounding.Ceil;

    function _gear(uint256 i) internal pure returns (Gear) {
        return Gear(uint8(bound(i, 0, 4)));
    }

    /// PRBMath as an independent reference: exp2(p * log2 r).
    function _prb(Gear g, uint256 r) internal pure returns (uint256) {
        if (g == Gear.REVERSE) return uint256(SD59x18.unwrap(sd(int256(r)).pow(sd(-1e18))));
        return UD60x18.unwrap(ud(r).pow(ud(uint256(ODPowers.powerWad(g)))));
    }

    /// R2: relative error <= 1e-15 against PRBMath over the domain. Below 1e3 wei of result the floor of a few wei
    /// (rounding, not the formula) dominates, so an absolute bound of 4 wei applies there.
    function testFuzz_MatchesPrbPow(uint256 r, uint256 gi) public pure {
        r = bound(r, ODIndex.MIN_R, ODIndex.MAX_R);
        Gear g = _gear(gi);
        uint256 got = ODIndex.index(g, r, FLOOR);
        uint256 want = _prb(g, r);
        uint256 diff = got > want ? got - want : want - got;
        if (diff > 4) assertLe(diff * 1e18 / want, 1e3, "relative error > 1e-15");
    }

    /// R3: Floor <= Ceil <= Floor + 3 wei, for the index and for the value.
    function testFuzz_RoundingBracket(uint256 r, uint256 gi, uint256 p, uint256 p0, uint256 nf) public pure {
        r = bound(r, ODIndex.MIN_R, ODIndex.MAX_R);
        Gear g = _gear(gi);
        uint256 lo = ODIndex.index(g, r, FLOOR);
        uint256 hi = ODIndex.index(g, r, CEIL);
        assertLe(lo, hi, "floor <= ceil");
        assertLe(hi, lo + 3, "ceil <= floor + 3");
        // Value end to end: the Ceil value is never below the Floor value.
        p0 = bound(p0, 1e9, 1e30);
        p = bound(p, 1, 1e30);
        nf = bound(nf, 1e9, 1e24);
        (uint256 vlo,) = ODIndex.value(g, p, p0, nf, 1e18, FLOOR);
        (uint256 vhi,) = ODIndex.value(g, p, p0, nf, 1e18, CEIL);
        assertLe(vlo, vhi, "value floor <= ceil");
    }

    /// R4: index non-decreasing in r for p > 0, non-increasing for REVERSE, in both rounding directions.
    function testFuzz_Monotone(uint256 a, uint256 b, uint256 gi, bool ceil) public pure {
        a = bound(a, ODIndex.MIN_R, ODIndex.MAX_R);
        b = bound(b, ODIndex.MIN_R, ODIndex.MAX_R);
        if (a > b) (a, b) = (b, a);
        Gear g = _gear(gi);
        Math.Rounding rnd = ceil ? CEIL : FLOOR;
        uint256 ia = ODIndex.index(g, a, rnd);
        uint256 ib = ODIndex.index(g, b, rnd);
        if (g == Gear.REVERSE) assertGe(ia, ib, "REVERSE non-increasing");
        else assertLe(ia, ib, "non-decreasing");
    }

    /// Value is monotone in the price too (ratio rounding included).
    function testFuzz_ValueMonotoneInPrice(uint256 p1, uint256 p2, uint256 gi, bool ceil) public pure {
        p1 = bound(p1, 1, 1e30);
        p2 = bound(p2, 1, 1e30);
        if (p1 > p2) (p1, p2) = (p2, p1);
        Gear g = _gear(gi);
        Math.Rounding rnd = ceil ? CEIL : FLOOR;
        (uint256 v1,) = ODIndex.value(g, p1, 1e20, 1e18, 1e18, rnd);
        (uint256 v2,) = ODIndex.value(g, p2, 1e20, 1e18, 1e18, rnd);
        if (g == Gear.REVERSE) assertGe(v1, v2);
        else assertLe(v1, v2);
    }
}
