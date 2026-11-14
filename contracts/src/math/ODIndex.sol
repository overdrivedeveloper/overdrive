// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Gear} from "../interfaces/ODTypes.sol";
import {ODFixed} from "./ODFixed.sol";

/// @title ODIndex
/// @notice The gear index I = r^p (r = P_t / P_0, p in {1.5, 2, 3, 0.5, -1}) in closed form, and the value per token
/// nf * I * unit. Pure; callers never pass a zero price.
/// @dev Every index is exactly rounded in the requested direction for a given r (one rounding per result):
///   CRUISE r*sqrt(r) = sqrt(r^3 / 1e18) (floor/ceil of sqrt of the floor/ceil of an integer is the exact floor/ceil),
///   SPORT r*r / 1e18, RACE r*r*r / 1e36, ECO sqrt(r * 1e18), REVERSE 1e36 / r.
/// These equal the compositions mulWad(r, sqrtWad(r)), mulWad(r, r), mulWad(mulWad(r, r), r), sqrtWad(r) and
/// divWad(1e18, r) up to their intermediate roundings, with a tighter Floor/Ceil bracket (at most 1 wei).
library ODIndex {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MIN_R = 0.02e18; // ratio domain: -98% ...
    uint256 internal constant MAX_R = 50e18; // ... +4,900%

    error RatioZero();
    error ShockOutOfRange(int256 shockWad);

    /// @notice r = p / p0 (WAD) rounded in `rnd`, clamped into [MIN_R, MAX_R]; inDomain = false when clamped.
    function ratio(uint256 p, uint256 p0, Math.Rounding rnd) internal pure returns (uint256 r, bool inDomain) {
        if (p == 0 || p0 == 0) revert RatioZero();
        r = Math.mulDiv(p, WAD, p0, rnd);
        inDomain = true;
        if (r < MIN_R) {
            r = MIN_R;
            inDomain = false;
        } else if (r > MAX_R) {
            r = MAX_R;
            inDomain = false;
        }
    }

    /// @notice Price of A in units of B (WAD) for a pair gear, rounded down: pA * 1e18 / pB.
    function pairPrice(uint256 pA, uint256 pB) internal pure returns (uint256) {
        if (pA == 0 || pB == 0) revert RatioZero();
        return Math.mulDiv(pA, WAD, pB, Math.Rounding.Floor);
    }

    /// @notice I = r^power in closed form, exactly rounded in `rnd`.
    function index(Gear g, uint256 r, Math.Rounding rnd) internal pure returns (uint256) {
        if (g == Gear.SPORT) return Math.mulDiv(r, r, WAD, rnd);
        if (g == Gear.RACE) return Math.mulDiv(r * r, r, WAD * WAD, rnd);
        if (g == Gear.CRUISE) return Math.sqrt(Math.mulDiv(r * r, r, WAD, rnd), rnd);
        if (g == Gear.ECO) return ODFixed.sqrtWad(r, rnd);
        return Math.mulDiv(WAD, WAD, r, rnd); // REVERSE
    }

    /// @notice Value per token (USD WAD) = nf * I * unit / 1e36, rounded in `rnd` end to end.
    /// @dev The ratio is rounded in `rnd` for the rising gears and the opposite way for REVERSE (whose index falls
    /// with r), so the value is never moved against `rnd` by any step. inDomain = false: buys blocked, settlement.
    function value(Gear g, uint256 p, uint256 p0, uint256 nf, uint256 unitWad, Math.Rounding rnd)
        internal
        pure
        returns (uint256 valueWad, bool inDomain)
    {
        uint256 r;
        (r, inDomain) = ratio(p, p0, g == Gear.REVERSE ? opposite(rnd) : rnd);
        uint256 i = index(g, r, rnd);
        // nf <= 1e24 and I <= 50^3 * 1e18 keep nf * I far inside 256 bits; mulDiv takes the rest in 512 bits.
        valueWad = Math.mulDiv(nf * i, unitWad, WAD * WAD, rnd);
    }

    /// @notice Exact value multiplier for a price shock: (1 + shock)^power, shock a signed WAD (> -1e18).
    function shockFactor(Gear g, int256 shockWad, Math.Rounding rnd) internal pure returns (uint256) {
        if (shockWad <= -int256(WAD) || shockWad > int256(MAX_R)) revert ShockOutOfRange(shockWad);
        return index(g, uint256(int256(WAD) + shockWad), rnd);
    }

    /// @notice p (p - 1) / 2 as a signed WAD: the toll coefficient on sigma^2.
    function halfPPMinus1Wad(Gear g) internal pure returns (int256) {
        if (g == Gear.CRUISE) return 0.375e18;
        if (g == Gear.SPORT) return 1e18;
        if (g == Gear.RACE) return 3e18;
        if (g == Gear.ECO) return -0.125e18;
        return 1e18; // REVERSE: (-1)(-2)/2
    }

    function opposite(Math.Rounding rnd) internal pure returns (Math.Rounding) {
        if (rnd == Math.Rounding.Floor) return Math.Rounding.Ceil;
        if (rnd == Math.Rounding.Ceil) return Math.Rounding.Floor;
        if (rnd == Math.Rounding.Trunc) return Math.Rounding.Expand;
        return Math.Rounding.Trunc;
    }
}
