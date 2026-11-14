// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ODNorm
/// @notice The normalisation factor NF: value per token = NF * I * unit, and NF(t) = product of (1 - toll_i * dt_i)
/// over hourly intervals (spec section 3). Holders pay the toll by NF falling, never by a transfer or a bill.
/// @dev A gap of dt seconds is n = ceil(dt / STEP) equal sub-intervals at the same rate, so
///   NF <- NF * f^n,  f = 1 - toll * dt / n.
/// f is formed exactly at 1e36 (rounded down) and raised to n by squaring at 1e36 (each product rounded down), so
/// gas is O(log n) for any gap and the result is within a wei or two of the naive hourly loop. Every step rounds down.
/// Liveness: the rate is clamped to the 400%/yr bound, so |toll * dt / n| <= 4/8760 per hour and f is never negative.
/// For a negative toll the power saturates at a factor of 1e18 (NF would pass MAX_NF long before).
/// Review F06 idea kept: a floor (MIN_NF) and a ceiling (MAX_NF), and the early exits never move NF the wrong way.
library ODNorm {
    uint256 internal constant STEP = 1 hours;
    uint256 internal constant MIN_NF = 1e9;
    uint256 internal constant MAX_NF = 1e24;
    uint256 internal constant R36 = 1e36;
    /// @dev Largest per-second toll magnitude: ceil(4e18 / 365 days).
    int256 internal constant MAX_ABS_PER_SEC = 126839167936;
    /// @dev Saturation of the power for a negative toll: a factor of 1e18.
    uint256 internal constant POW_CAP = 1e54;

    /// @notice NF <- NF * (1 - toll * dt / n)^n, n = ceil(dt / STEP). Rounds down. Clamped to [MIN_NF, MAX_NF].
    /// @dev dt == 0 or toll == 0 returns nf. A positive toll never raises NF (nf at or below MIN_NF stays); a
    /// negative toll never lowers it (nf at or above MAX_NF stays).
    function step(uint256 nf, int256 tollPerSecWad, uint256 dt) internal pure returns (uint256 nfNew) {
        if (dt == 0 || tollPerSecWad == 0) return nf;
        if (tollPerSecWad > 0 && nf <= MIN_NF) return nf;
        if (tollPerSecWad < 0 && nf >= MAX_NF) return nf;
        if (dt > type(uint128).max) dt = type(uint128).max; // past any saturation; keeps products in range
        int256 t = tollPerSecWad;
        if (t > MAX_ABS_PER_SEC) t = MAX_ABS_PER_SEC;
        if (t < -MAX_ABS_PER_SEC) t = -MAX_ABS_PER_SEC;
        uint256 n = (dt + STEP - 1) / STEP;
        // f36 = floor((1e36 * n - t * 1e18 * dt) / n). dt / n <= 3600, so |t * dt / n| <= 4.6e14 (in 1e18 units)
        // and the numerator stays positive. |t * 1e18 * dt| < 1.3e11 * 1e18 * 3.4e38 fits in int256.
        int256 num = int256(R36 * n) - t * int256(1e18) * int256(dt);
        uint256 f36 = uint256(num) / n;
        uint256 p36 = pow36(f36, n);
        nfNew = Math.mulDiv(nf, p36, R36);
        if (nfNew < MIN_NF) nfNew = MIN_NF;
        if (nfNew > MAX_NF) nfNew = MAX_NF;
    }

    /// @notice base^n at 1e36, by squaring, each product rounded down, saturating at POW_CAP.
    function pow36(uint256 base, uint256 n) internal pure returns (uint256 z) {
        z = R36;
        uint256 b = base;
        while (n > 0) {
            if (n & 1 == 1) {
                z = Math.mulDiv(z, b, R36);
                if (z > POW_CAP) z = POW_CAP;
                if (z == 0) return 0;
            }
            n >>= 1;
            if (n > 0) {
                b = Math.mulDiv(b, b, R36);
                if (b > POW_CAP) b = POW_CAP;
            }
        }
    }

    /// @notice Value moved by one step for `tokens` at value-before `vBeforeWad`: tokens * v * (1 - nfNew / nf).
    /// Positive: paid by holders. Negative: received by holders. Magnitude rounded down. nf == 0 gives 0.
    function tollValue(uint256 tokens, uint256 vBeforeWad, uint256 nf, uint256 nfNew) internal pure returns (int256) {
        if (nf == 0 || nf == nfNew) return 0;
        uint256 v = Math.mulDiv(tokens, vBeforeWad, 1e18);
        if (nfNew < nf) return int256(Math.mulDiv(v, nf - nfNew, nf));
        return -int256(Math.mulDiv(v, nfNew - nf, nf));
    }
}
