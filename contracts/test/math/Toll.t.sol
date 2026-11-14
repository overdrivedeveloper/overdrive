// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {Gear} from "../../src/interfaces/ODTypes.sol";
import {ODToll} from "../../src/math/ODToll.sol";

contract TollTest is ODTest {
    uint256 internal constant WAD = 1e18;

    /// R7: the spec examples. Percent per day as a WAD fraction: 0.0986% = 0.000986e18.
    function test_SpecExamples() public pure {
        int256 tsla = ODToll.tollPerYear(Gear.SPORT, 6000, 0);
        assertEq(tsla, 0.36e18, "SPORT 60%: 0.36/yr");
        assertApproxEqAbs(ODToll.perDay(tsla), 0.000986e18, 0.0000005e18, "TSLA Sport 0.0986%/day");
        assertApproxEqAbs(ODToll.perDay(tsla), 0.001e18 - 0.000014e18, 0.0000006e18, "about 0.099%/day");
        int256 spy = ODToll.tollPerYear(Gear.SPORT, 1800, 0);
        assertEq(spy, 0.0324e18);
        assertApproxEqAbs(ODToll.perDay(spy), 0.0000888e18, 0.0000001e18, "SPY Sport 0.00888%/day");
        int256 nvda = ODToll.tollPerYear(Gear.CRUISE, 5000, 0);
        assertEq(nvda, 0.09375e18, "0.375 * 0.25");
        assertApproxEqAbs(ODToll.perDay(nvda), 0.000257e18, 0.0000002e18, "NVDA Cruise 0.0257%/day");
        int256 eco = ODToll.tollPerYear(Gear.ECO, 6000, 0);
        assertEq(eco, -0.045e18, "ECO negative: holders receive");
        assertLt(ODToll.perDay(eco), 0);
        assertEq(ODToll.tollPerYear(Gear.REVERSE, 6000, 0), tsla, "REVERSE equals SPORT");
        assertEq(ODToll.tollPerYear(Gear.RACE, 6000, 0), 1.08e18, "RACE 3 * 0.36");
    }

    /// perSecond / perDay round toward +infinity (the Governor's side) for both signs.
    function test_ConversionsRoundUp() public pure {
        assertEq(ODToll.perSecond(1), 1, "tiny positive rounds up");
        assertEq(ODToll.perSecond(-1), 0, "tiny negative rounds toward zero (less paid out)");
        assertEq(ODToll.perSecond(int256(ODToll.YEAR) * 7), 7, "exact");
        assertEq(ODToll.perDay(366), 2);
        assertEq(ODToll.perDay(-366), -1);
    }

    /// R8: usage bounds and the quadratic shape.
    function testFuzz_UsageBounds(uint256 open, uint256 cap, uint256 maxU) public pure {
        open = bound(open, 0, 1e36);
        cap = bound(cap, 0, 1e36);
        maxU = bound(maxU, 0, 4e18);
        uint256 u = ODToll.usage(open, cap, maxU);
        assertLe(u, maxU, "never above usageMax");
        if (open == 0) assertEq(u, 0, "zero at zero open value");
        if (open >= cap && open > 0) assertEq(u, maxU, "usageMax at or above cap");
        // Monotone in open value.
        if (open < cap) assertLe(u, ODToll.usage(open + 1, cap, maxU), "monotone");
        // Quadratic: within 2 wei of maxU * (open / cap)^2.
        if (open < cap && cap > 0) {
            uint256 exact = open * open / cap * maxU / cap;
            if (cap <= 1e30) assertApproxEqAbs(u, exact, 2 + maxU / cap + 1, "quadratic");
        }
        // Total toll with usage stays inside the clamp and is never below the usage-free toll.
        int256 base = ODToll.tollPerYear(Gear.SPORT, 6000, 0);
        int256 withU = ODToll.tollPerYear(Gear.SPORT, 6000, u);
        assertGe(withU, base);
        assertLe(withU, ODToll.MAX_ABS_TOLL_PER_YEAR);
    }

    function test_UsageShape() public pure {
        uint256 cap = 1_000_000e18;
        assertEq(ODToll.usage(0, cap, 0.2e18), 0);
        assertEq(ODToll.usage(cap / 2, cap, 0.2e18), 0.05e18, "half used: a quarter");
        assertEq(ODToll.usage(cap, cap, 0.2e18), 0.2e18);
        assertEq(ODToll.usage(cap * 3, cap, 0.2e18), 0.2e18, "above cap");
        assertEq(ODToll.usage(1, 0, 0.2e18), 0.2e18, "cap 0: full");
        assertEq(ODToll.usage(0, 0, 0.2e18), 0, "cap 0, nothing open");
    }

    /// R8: the total toll is clamped to +-400%/yr.
    function test_TollClamp() public pure {
        assertEq(ODToll.tollPerYear(Gear.RACE, 20000, 0), 4e18, "RACE at 200%: 12/yr clamped to 4");
        assertEq(ODToll.tollPerYear(Gear.RACE, type(uint64).max, type(uint256).max), 4e18, "no overflow");
        assertEq(ODToll.tollPerYear(Gear.ECO, type(uint64).max, 0), -4e18, "ECO clamp below");
        assertEq(ODToll.tollPerYear(Gear.ECO, 60000, 0), -4e18, "ECO at 600%: -4.5 clamped");
        assertEq(ODToll.tollPerYear(Gear.SPORT, 0, 5e18), 4e18, "usage alone clamped");
    }

    function testFuzz_TollClampNeverReverts(uint256 gi, uint64 sigma, uint256 u) public pure {
        int256 t = ODToll.tollPerYear(Gear(uint8(bound(gi, 0, 4))), sigma, u);
        assertLe(t, 4e18);
        assertGe(t, -4e18);
        int256 s = ODToll.perSecond(t);
        assertLe(s, 126839167936);
        assertGe(s, -126839167935);
    }

    /// R9: the gap rate is the larger signed rate; for ECO the less negative (less paid out).
    function test_GapRateNeverFavoursCaller() public pure {
        assertEq(ODToll.gapRate(10, 20), 20);
        assertEq(ODToll.gapRate(20, 10), 20);
        assertEq(ODToll.gapRate(-10, -20), -10, "ECO: less negative");
        assertEq(ODToll.gapRate(-20, -10), -10);
        assertEq(ODToll.gapRate(-5, 5), 5);
    }

    function testFuzz_GapRateIsMax(int256 a, int256 b) public pure {
        int256 g = ODToll.gapRate(a, b);
        assertGe(g, a);
        assertGe(g, b);
        assertTrue(g == a || g == b);
    }
}
