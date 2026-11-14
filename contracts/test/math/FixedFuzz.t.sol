// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ODTest} from "../utils/ODTest.sol";
import {ODFixed} from "../../src/math/ODFixed.sol";

contract FixedHarness {
    function expWad(int256 x) external pure returns (uint256) {
        return ODFixed.expWad(x);
    }

    function lnWad(uint256 x) external pure returns (int256) {
        return ODFixed.lnWad(x);
    }
}

contract FixedFuzzTest is ODTest {
    uint256 internal constant WAD = 1e18;
    Math.Rounding internal constant FLOOR = Math.Rounding.Floor;
    Math.Rounding internal constant CEIL = Math.Rounding.Ceil;

    function test_KnownValues() public {
        assertEq(ODFixed.expWad(0), WAD);
        assertApproxEqAbs(ODFixed.expWad(1e18), 2718281828459045235, 1, "e");
        assertEq(ODFixed.lnWad(WAD), 0);
        assertApproxEqAbs(ODFixed.lnWad(2e18), 693147180559945309, 1, "ln 2");
        assertEq(ODFixed.expWad(-43e18), 0, "saturates low");
        assertEq(ODFixed.sqrtWad(4e18, FLOOR), 2e18);
        assertEq(ODFixed.sqrtWad(2e18, CEIL), 1414213562373095049);
        assertEq(ODFixed.rpowWad(2e18, 10, FLOOR), 1024e18);
        assertEq(ODFixed.rpowWad(0.5e18, 3, FLOOR), 0.125e18);
        assertEq(ODFixed.rpowWad(7e18, 0, FLOOR), WAD);
        assertEq(ODFixed.mulWad(3, 0.5e18, FLOOR), 1);
        assertEq(ODFixed.mulWad(3, 0.5e18, CEIL), 2);
        assertEq(ODFixed.divWad(1e18, 3e18, CEIL), 333333333333333334);
        FixedHarness h = new FixedHarness();
        vm.expectRevert(abi.encodeWithSelector(ODFixed.ExpOverflow.selector, int256(136e18)));
        h.expWad(136e18);
        vm.expectRevert(ODFixed.LnUndefined.selector);
        h.lnWad(0);
    }

    /// exp(ln x) round-trips within 1e-15 relative (or 2 wei).
    function testFuzz_ExpLnRoundTrip(uint256 x) public pure {
        x = bound(x, 1e12, 1e30);
        uint256 y = ODFixed.expWad(ODFixed.lnWad(x));
        // ln is rounded to 1e-18 absolute, so exp(ln x) is x within 1e-15 relative or a couple of wei.
        uint256 d = y > x ? y - x : x - y;
        if (d > 2) assertApproxEqRel(y, x, 1e3, "exp(ln x) = x");
    }

    /// rpowWad brackets: Floor <= Ceil, and the integer powers agree with repeated multiplication.
    function testFuzz_RpowBracket(uint256 b, uint256 n) public pure {
        b = bound(b, 0.5e18, 2e18);
        n = bound(n, 0, 40);
        uint256 lo = ODFixed.rpowWad(b, n, FLOOR);
        uint256 hi = ODFixed.rpowWad(b, n, CEIL);
        assertLe(lo, hi);
        uint256 loop = WAD;
        for (uint256 i; i < n; ++i) {
            loop = ODFixed.mulWad(loop, b, FLOOR);
        }
        uint256 d = lo > loop ? lo - loop : loop - lo;
        if (d > 2 * n) assertApproxEqRel(lo, loop, 1e6, "squaring ~ loop");
    }

    function testFuzz_SqrtWadRounding(uint256 x) public pure {
        x = bound(x, 0, 1e40);
        uint256 lo = ODFixed.sqrtWad(x, FLOOR);
        uint256 hi = ODFixed.sqrtWad(x, CEIL);
        assertLe(lo * lo, x * WAD);
        assertGe(hi * hi, x * WAD);
        assertLe(hi - lo, 1);
    }
}
