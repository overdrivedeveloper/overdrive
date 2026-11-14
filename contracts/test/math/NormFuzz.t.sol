// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ODTest} from "../utils/ODTest.sol";
import {ODNorm} from "../../src/math/ODNorm.sol";

contract NormFuzzTest is ODTest {
    int256 internal constant MAXT = ODNorm.MAX_ABS_PER_SEC;

    /// The spec product, written out: n multiplications by the exact factor (n * 1e18 - t * dt) / (n * 1e18),
    /// each rounded down, clamped like the library.
    function _loop(uint256 nf, int256 t, uint256 dt) internal pure returns (uint256) {
        uint256 n = (dt + 3599) / 3600;
        uint256 den = n * 1e18;
        uint256 num = uint256(int256(den) - t * int256(dt));
        for (uint256 i; i < n; ++i) {
            nf = Math.mulDiv(nf, num, den);
        }
        if (nf < ODNorm.MIN_NF) nf = ODNorm.MIN_NF;
        if (nf > ODNorm.MAX_NF) nf = ODNorm.MAX_NF;
        return nf;
    }

    /// R10: equals the naive loop within 2 wei per step, dt up to 60 days.
    function testFuzz_StepMatchesLoop(uint256 nf, int256 t, uint256 dt) public pure {
        nf = bound(nf, ODNorm.MIN_NF, ODNorm.MAX_NF);
        t = bound(t, -MAXT, MAXT);
        dt = bound(dt, 1, 60 days);
        if (t == 0) return;
        uint256 got = ODNorm.step(nf, t, dt);
        uint256 want = _loop(nf, t, dt);
        uint256 n = (dt + 3599) / 3600;
        assertApproxEqAbs(got, want, 2 * n, "within 2 wei per step");
    }

    /// R10: bounds and direction.
    function testFuzz_StepBounds(uint256 nf, int256 t, uint256 dt) public pure {
        nf = bound(nf, ODNorm.MIN_NF, ODNorm.MAX_NF);
        t = bound(t, -MAXT, MAXT);
        dt = bound(dt, 0, 3650 days);
        uint256 out = ODNorm.step(nf, t, dt);
        assertGe(out, ODNorm.MIN_NF, "never below MIN_NF");
        assertLe(out, ODNorm.MAX_NF, "never above MAX_NF");
        if (t > 0) assertLe(out, nf, "positive toll: non-increasing");
        if (t < 0) assertGe(out, nf, "negative toll: non-decreasing");
        if (dt == 0) assertEq(out, nf);
        // A longer gap at the same positive rate never leaves NF higher.
        if (t > 0) assertLe(ODNorm.step(nf, t, dt + 3600), out, "more time, more toll");
    }

    /// R10 ARITH-LIVENESS: never reverts for any nf, rate and gap.
    function testFuzz_StepNeverReverts(uint256 nf, int256 t, uint256 dt) public pure {
        uint256 out = ODNorm.step(nf, t, dt);
        if (dt != 0 && t != 0 && nf >= ODNorm.MIN_NF && nf <= ODNorm.MAX_NF) {
            assertGe(out, ODNorm.MIN_NF);
            assertLe(out, ODNorm.MAX_NF);
        }
    }

    /// R11: stepping h1 then h2 whole hours equals stepping h1 + h2, within 1e-12 relative (or 2 wei of rounding,
    /// which is larger than 1e-12 only for NF below 2e12).
    function testFuzz_StepAdditive(uint256 nf, int256 t, uint256 h1, uint256 h2) public pure {
        nf = bound(nf, ODNorm.MIN_NF, ODNorm.MAX_NF);
        t = bound(t, -MAXT, MAXT);
        h1 = bound(h1, 1, 720);
        h2 = bound(h2, 1, 720);
        uint256 a = ODNorm.step(ODNorm.step(nf, t, h1 * 3600), t, h2 * 3600);
        uint256 b = ODNorm.step(nf, t, (h1 + h2) * 3600);
        uint256 diff = a > b ? a - b : b - a;
        if (diff > 2) assertLe(diff * 1e18 / b, 1e6, "split-additive within 1e-12");
    }

    /// Toll value sign follows the NF move and never exceeds the position value.
    function testFuzz_TollValue(uint256 tokens, uint256 v, uint256 nf, uint256 nfNew) public pure {
        tokens = bound(tokens, 0, 1e30);
        v = bound(v, 0, 1e30);
        nf = bound(nf, 1, 1e24);
        nfNew = bound(nfNew, 0, 1e24);
        int256 tv = ODNorm.tollValue(tokens, v, nf, nfNew);
        uint256 pos = Math.mulDiv(tokens, v, 1e18);
        if (nfNew < nf) {
            assertGe(tv, 0);
            assertLe(uint256(tv), pos);
        } else {
            assertLe(tv, 0);
        }
    }
}
