// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ODBackerMath
/// @notice Pure arithmetic of a backer vault: debt value, collateral ratio, the backer toll fee, sale proceeds and the
/// buy-back cost. Every rounding favours the protocol: debt and costs round up, ratios, proceeds and fees round down.
library ODBackerMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant TO_WAD = 1e12; // USDG (6 dp) to WAD

    /// Debt value in USD WAD: tokens x value per token, Ceil.
    function debtValueWad(uint256 debtTokens, uint256 valuePerTokenWad) internal pure returns (uint256) {
        return Math.mulDiv(debtTokens, valuePerTokenWad, WAD, Math.Rounding.Ceil);
    }

    /// ratio = collateral x 1e12 x 10000 / debt value, Floor; no debt is an infinite ratio.
    function ratioBps(uint256 collateralUsdg, uint256 debtWad) internal pure returns (uint256) {
        if (debtWad == 0) return type(uint256).max;
        return Math.mulDiv(collateralUsdg * TO_WAD, BPS, debtWad);
    }

    /// Toll earned on the debt since the snapshot (USDG, Floor) and the fee share of it (Floor).
    function tollFee(uint256 debtTokens, uint256 cumNowWad, uint256 snapshotWad, uint256 feeBps)
        internal
        pure
        returns (uint256 feeUsdg)
    {
        if (cumNowWad <= snapshotWad || debtTokens == 0) return 0;
        uint256 earnedWad = Math.mulDiv(debtTokens, cumNowWad - snapshotWad, WAD);
        feeUsdg = Math.mulDiv(earnedWad, feeBps, BPS * TO_WAD);
    }

    /// The Governor's payment for a backer's sold exposure: tokens x value (the backer's worse side) x (1 - spread),
    /// Floor, in USDG.
    function proceedsUsdg(uint256 tokens, uint256 valueLowWad, uint256 spreadBps) internal pure returns (uint256) {
        uint256 priceWad = Math.mulDiv(valueLowWad, BPS - spreadBps, BPS);
        return Math.mulDiv(tokens, priceWad, WAD * TO_WAD);
    }

    /// Cost of buying `tokens` back from the Governor: tokens x value (high side) x (1 + spread), Ceil, in USDG.
    function buyBackUsdg(uint256 tokens, uint256 valueHighWad, uint256 spreadBps) internal pure returns (uint256) {
        uint256 priceWad = Math.mulDiv(valueHighWad, BPS + spreadBps, BPS, Math.Rounding.Ceil);
        return Math.mulDiv(tokens, priceWad, WAD * TO_WAD, Math.Rounding.Ceil);
    }
}
