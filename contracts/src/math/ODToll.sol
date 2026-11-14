// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Gear} from "../interfaces/ODTypes.sol";
import {ODIndex} from "./ODIndex.sol";

/// @title ODToll
/// @notice The daily toll rate of a gear: p (p - 1) / 2 * sigma^2 per year plus a usage term, clamped to +-400%/yr.
/// Positive: holders pay (the normalisation factor falls). Negative (ECO): holders receive.
/// @dev Conversions to per second and per day round toward +infinity: a positive toll is never undercharged and a
/// negative toll is never overpaid, so the rounding always sides with the Governor.
/// Review F11/F34: a permissionless accrual uses `gapRate`, the larger of the stored and current rate, so the caller
/// cannot pick a favourable rate for the gap.
library ODToll {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    int256 internal constant MAX_ABS_TOLL_PER_YEAR = 4e18; // 400%/yr hard bound

    /// @notice Annual toll WAD = halfPPMinus1 * sigma^2 + usage, sigma = sigmaBps / 1e4, clamped to +-MAX.
    function tollPerYear(Gear g, uint64 sigmaBps, uint256 usageWad) internal pure returns (int256 t) {
        // sigma^2 in WAD = bps^2 * 1e10; bps < 2^64 keeps bps^2 * 1e10 < 3.5e48 and the product with |h| <= 3e18
        // below 1.1e67. h is a multiple of 0.125e18, so the division by 1e18 is exact.
        uint256 s2 = uint256(sigmaBps) * uint256(sigmaBps) * 1e10;
        t = (ODIndex.halfPPMinus1Wad(g) * int256(s2)) / int256(WAD);
        if (usageWad > uint256(2 * MAX_ABS_TOLL_PER_YEAR)) usageWad = uint256(2 * MAX_ABS_TOLL_PER_YEAR);
        t += int256(usageWad);
        if (t > MAX_ABS_TOLL_PER_YEAR) t = MAX_ABS_TOLL_PER_YEAR;
        if (t < -MAX_ABS_TOLL_PER_YEAR) t = -MAX_ABS_TOLL_PER_YEAR;
    }

    /// @notice Usage term (non-negative): usageMax * u^2, u = min(1, openValue / cap), rounded up.
    /// cap == 0 counts as full usage once anything is open.
    function usage(uint256 openValueWad, uint256 capWad, uint256 usageMaxWad) internal pure returns (uint256) {
        if (openValueWad == 0) return 0;
        if (openValueWad >= capWad) return usageMaxWad;
        // open < cap: each factor open / cap < 1, so the result stays <= usageMax.
        uint256 x = Math.mulDiv(usageMaxWad, openValueWad, capWad, Math.Rounding.Ceil);
        return Math.mulDiv(x, openValueWad, capWad, Math.Rounding.Ceil);
    }

    /// @notice Per-second rate, rounded toward +infinity.
    function perSecond(int256 perYearWad) internal pure returns (int256) {
        return ceilDiv(perYearWad, int256(YEAR));
    }

    /// @notice Per-day rate, rounded toward +infinity (display and the spec examples).
    function perDay(int256 perYearWad) internal pure returns (int256) {
        return ceilDiv(perYearWad, 365);
    }

    /// @notice Rate for a gap: the larger (signed) of the stored and current rate.
    function gapRate(int256 storedPerSec, int256 currentPerSec) internal pure returns (int256) {
        return storedPerSec > currentPerSec ? storedPerSec : currentPerSec;
    }

    function ceilDiv(int256 a, int256 d) private pure returns (int256 q) {
        q = a / d; // truncates toward zero
        if (a > 0 && q * d != a) q += 1;
    }
}
