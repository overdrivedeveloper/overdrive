// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ODFixed
/// @notice WAD (1e18) fixed-point helpers with an explicit rounding direction, plus exp and ln at 1e36 internal
/// precision (kept for tests and the TypeScript twin; pricing uses closed forms only, never a general pow).
/// @dev exp: a = k ln2 + r with k = round(a / ln2) and |r| <= ln2 / 2, then e^r by its Taylor series at 1e36 and
/// e^a = e^r * 2^k. ln: x = m * 2^n with m in [1/sqrt2, sqrt2), then ln m = 2 atanh(s) = 2 (s + s^3/3 + ...) with
/// s = (m - 1)/(m + 1). No tables of magic coefficients, so every step is checkable. No `unchecked` blocks.
library ODFixed {
    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    /// @dev Internal precision of the series.
    int256 internal constant R36 = 1e36;
    /// @dev ln 2 * 1e36, rounded to nearest.
    int256 internal constant LN2_36 = 693147180559945309417232121458176568;
    /// @dev ln(1e18) * 1e36, rounded to nearest (converts ln of a raw WAD integer to ln of its value).
    int256 internal constant LN_WAD_36 = 41446531673892822312323846184318555737;
    /// @dev sqrt 2 * 1e36, rounded to nearest.
    uint256 internal constant SQRT2_36 = 1414213562373095048801688724209698079;
    /// @dev expWad returns 0 below this (e^-42 < 1e-18).
    int256 internal constant EXP_MIN_WAD = -42e18;
    /// @dev expWad reverts above this (e^135 * 1e18 ~ 4.3e76 still fits in uint256).
    int256 internal constant EXP_MAX_WAD = 135e18;

    /// @notice Reverts when the exponent would overflow.
    /// @param x The input value.
    error ExpOverflow(int256 x);
    /// @notice Reverts when the logarithm input is not positive.
    error LnUndefined();

    /// @notice a * b / 1e18 rounded in `r` (512-bit intermediate, reverts only if the result exceeds uint256).
    function mulWad(uint256 a, uint256 b, Math.Rounding r) internal pure returns (uint256) {
        return Math.mulDiv(a, b, WAD, r);
    }

    /// @notice a * 1e18 / b rounded in `r`. Reverts on b == 0.
    function divWad(uint256 a, uint256 b, Math.Rounding r) internal pure returns (uint256) {
        return Math.mulDiv(a, WAD, b, r);
    }

    /// @notice sqrt(x / 1e18) * 1e18 = sqrt(x * 1e18), exactly rounded in `r` whenever x * 1e18 fits in 256 bits.
    /// @dev Larger x (about 1.16e59 and up, far outside pricing): sqrt(x) rounded in `r`, times 1e9.
    function sqrtWad(uint256 x, Math.Rounding r) internal pure returns (uint256) {
        if (x <= type(uint256).max / WAD) return Math.sqrt(x * WAD, r);
        return Math.sqrt(x, r) * 1e9;
    }

    /// @notice base^n in WAD for an integer n, by squaring, every product rounded in `r`.
    function rpowWad(uint256 base, uint256 n, Math.Rounding r) internal pure returns (uint256 z) {
        z = WAD;
        uint256 b = base;
        while (n > 0) {
            if (n & 1 == 1) z = Math.mulDiv(z, b, WAD, r);
            n >>= 1;
            if (n > 0) b = Math.mulDiv(b, b, WAD, r);
        }
    }

    /// @notice e^(x / 1e18) * 1e18. Saturates to 0 below -42e18, reverts above 135e18.
    function expWad(int256 x) internal pure returns (uint256) {
        if (x < EXP_MIN_WAD) return 0;
        if (x > EXP_MAX_WAD) revert ExpOverflow(x);
        (uint256 s, int256 k) = expReduced36(x * IWAD);
        if (k >= 0) return Math.mulDiv(s, uint256(1) << uint256(k), WAD);
        return s / (WAD << uint256(-k));
    }

    /// @notice ln(x / 1e18) * 1e18, rounded to nearest. Reverts for x == 0.
    function lnWad(uint256 x) internal pure returns (int256) {
        int256 l = ln36(x);
        return l >= 0 ? (l + IWAD / 2) / IWAD : (l - IWAD / 2) / IWAD;
    }

    /// @notice ln(x / 1e18) * 1e36 for a WAD x > 0. Absolute error about 1e-34.
    function ln36(uint256 x) internal pure returns (int256) {
        if (x == 0) revert LnUndefined();
        uint256 n = Math.log2(x);
        uint256 m = Math.mulDiv(x, uint256(R36), uint256(1) << n);
        int256 twoPow = int256(n);
        if (m > SQRT2_36) {
            m = Math.mulDiv(x, uint256(R36) / 2, uint256(1) << n);
            twoPow += 1;
        }
        int256 mi = int256(m);
        int256 s = ((mi - R36) * R36) / (mi + R36);
        int256 s2 = (s * s) / R36;
        int256 term = s;
        int256 sum = s;
        for (int256 i = 3;; i += 2) {
            term = (term * s2) / R36;
            int256 t = term / i;
            if (t == 0) break;
            sum += t;
        }
        return twoPow * LN2_36 + 2 * sum - LN_WAD_36;
    }

    /// @notice Splits e^(a / 1e36) into s / 1e36 * 2^k with s in [0.70e36, 1.42e36]. Requires |a| <= 1e40.
    function expReduced36(int256 a) internal pure returns (uint256 s, int256 k) {
        k = a >= 0 ? (a + LN2_36 / 2) / LN2_36 : (a - LN2_36 / 2) / LN2_36;
        int256 r = a - k * LN2_36;
        int256 sum = R36;
        int256 term = R36;
        for (int256 i = 1;; ++i) {
            term = (term * r) / (R36 * i);
            if (term == 0) break;
            sum += term;
        }
        s = uint256(sum);
    }
}
