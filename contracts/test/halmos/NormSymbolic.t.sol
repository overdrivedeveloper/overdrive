// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ODNorm} from "../../src/math/ODNorm.sol";

/// @title NormSymbolic
/// @notice Halmos symbolic checks (functions named `check_*`, run with `halmos --root contracts --contract
/// NormSymbolic`; forge test ignores them). Each property holds for every input in the stated range, not a sample.
/// @dev Gaps are bounded to one hour (one sub-interval, so the power loop runs once) to keep the 512-bit mulDiv
/// inside the solver's reach; longer gaps are covered by NormFuzz.t.sol (loop comparison, bounds, additivity).
contract NormSymbolic is Test {
    int256 internal constant MAXT = ODNorm.MAX_ABS_PER_SEC;

    /// A positive toll never raises NF.
    function check_StepNeverIncreasesForPositiveToll(uint256 nf, int256 t, uint256 dt) public pure {
        vm.assume(t > 0);
        vm.assume(dt <= 1 hours);
        uint256 out = ODNorm.step(nf, t, dt);
        assert(out <= nf);
    }

    /// From any NF in range, any toll and any gap up to an hour: never below MIN_NF, never above MAX_NF.
    function check_StepNeverBelowMin(uint256 nf, int256 t, uint256 dt) public pure {
        vm.assume(nf >= ODNorm.MIN_NF && nf <= ODNorm.MAX_NF);
        vm.assume(t >= -MAXT && t <= MAXT);
        vm.assume(dt <= 1 hours);
        uint256 out = ODNorm.step(nf, t, dt);
        assert(out >= ODNorm.MIN_NF);
        assert(out <= ODNorm.MAX_NF);
    }
}
