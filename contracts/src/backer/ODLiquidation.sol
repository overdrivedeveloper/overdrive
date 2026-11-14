// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ODLiquidation
/// @notice Pure split of one liquidated backer vault. D = debt value at the sealed value (USDG, Ceil); executor bonus
/// B = BONUS_BPS of D (Floor); the Governor receives min(pool - B, D) and takes over the debt; what is left of the
/// vault's own collateral returns to the vault. `pool` is the vault's collateral plus whatever insurance and the stake
/// sent for the shortfall D + B - collateral. Holders appear nowhere: no path here touches a token balance.
library ODLiquidation {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant TO_WAD = 1e12; // USDG (6 dp) to WAD

    struct Split {
        uint256 debtUsdg; // D
        uint256 bonusDue; // B
        uint256 floor; // min(B, minimum reward): the executor always gets at least this
        uint256 gap; // shortfall D + B - collateral, asked of insurance then the stake
        uint256 bonus; // paid to the executor
        uint256 toGovernor; // USDG sent with absorbLiquidation
        uint256 surplus; // returned to the vault (only when there was no shortfall)
        uint256 badDebt; // D - toGovernor: absorbed by Governor equity
        uint256 floorGap; // what the pool could not pay of the floor (the Governor's free cash is asked)
    }

    function split(uint256 debtWad, uint256 collateralUsdg, uint256 bonusBps, uint256 minReward)
        internal
        pure
        returns (Split memory x)
    {
        x.debtUsdg = Math.ceilDiv(debtWad, TO_WAD);
        x.bonusDue = x.debtUsdg * bonusBps / BPS;
        x.floor = Math.min(x.bonusDue, minReward);
        uint256 need = x.debtUsdg + x.bonusDue;
        if (need > collateralUsdg) x.gap = need - collateralUsdg;
    }

    /// Splits `pool` (collateral plus recovered cover). Anything recovered beyond the shortfall goes to the Governor,
    /// never to the vault owner.
    function settle(Split memory x, uint256 pool) internal pure returns (Split memory) {
        x.bonus = Math.min(x.bonusDue, pool);
        uint256 rest = pool - x.bonus;
        x.toGovernor = Math.min(rest, x.debtUsdg);
        rest -= x.toGovernor;
        if (x.gap == 0) x.surplus = rest;
        else x.toGovernor += rest;
        x.badDebt = x.debtUsdg > x.toGovernor ? x.debtUsdg - x.toGovernor : 0;
        x.floorGap = x.bonus < x.floor ? x.floor - x.bonus : 0;
        return x;
    }
}
