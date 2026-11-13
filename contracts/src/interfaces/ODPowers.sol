// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Gear} from "./ODTypes.sol";

/// Pure helper: the power p of each gear as a signed WAD.
library ODPowers {
    function powerWad(Gear gear) internal pure returns (int256) {
        if (gear == Gear.CRUISE) return 1.5e18;
        if (gear == Gear.SPORT) return 2e18;
        if (gear == Gear.RACE) return 3e18;
        if (gear == Gear.ECO) return 0.5e18;
        return -1e18; // REVERSE
    }
}
