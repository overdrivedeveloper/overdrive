// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ODIndex} from "../../src/math/ODIndex.sol";
import {ODToll} from "../../src/math/ODToll.sol";
import {ODNorm} from "../../src/math/ODNorm.sol";
import {Gear} from "../../src/interfaces/ODTypes.sol";

/// @title SystemSymbolic
/// @notice Halmos checks behind the system invariants (todo 12, R13): run with
/// `halmos --root contracts --contract SystemSymbolic --solver-timeout-assertion 60s`; forge test ignores `check_*`.
/// Each property holds for every input in the stated range.
contract SystemSymbolic is Test {
    uint256 internal constant WAD = 1e18;

    function _indexMonotone(Gear g, uint256 r1, uint256 r2) internal pure {
        vm.assume(r1 >= ODIndex.MIN_R && r2 <= ODIndex.MAX_R && r1 <= r2);
        uint256 i1 = ODIndex.index(g, r1, Math.Rounding.Floor);
        uint256 i2 = ODIndex.index(g, r2, Math.Rounding.Floor);
        if (g == Gear.REVERSE) assert(i1 >= i2);
        else assert(i1 <= i2);
    }

    /// The index rises with the price ratio for every long gear and falls for REVERSE (no rounding inversion).
    function check_IndexMonotone_SPORT(uint256 r1, uint256 r2) public pure {
        _indexMonotone(Gear.SPORT, r1, r2);
    }

    function check_IndexMonotone_RACE(uint256 r1, uint256 r2) public pure {
        _indexMonotone(Gear.RACE, r1, r2);
    }

    function check_IndexMonotone_CRUISE(uint256 r1, uint256 r2) public pure {
        _indexMonotone(Gear.CRUISE, r1, r2);
    }

    function check_IndexMonotone_ECO(uint256 r1, uint256 r2) public pure {
        _indexMonotone(Gear.ECO, r1, r2);
    }

    function check_IndexMonotone_REVERSE(uint256 r1, uint256 r2) public pure {
        _indexMonotone(Gear.REVERSE, r1, r2);
    }

    /// The toll sign matches the gear: ECO (p = 0.5) never charges from vol alone, every other gear never pays
    /// holders; the usage term only adds; the result stays within +-400%/yr.
    function check_TollSignMatchesGear(uint8 gi, uint64 sigmaBps, uint256 usageWad) public pure {
        vm.assume(gi <= uint8(Gear.REVERSE));
        Gear g = Gear(gi);
        int256 volOnly = ODToll.tollPerYear(g, sigmaBps, 0);
        int256 t = ODToll.tollPerYear(g, sigmaBps, usageWad);
        if (g == Gear.ECO) assert(volOnly <= 0);
        else assert(volOnly >= 0);
        assert(t >= volOnly);
        assert(t <= ODToll.MAX_ABS_TOLL_PER_YEAR && t >= -ODToll.MAX_ABS_TOLL_PER_YEAR);
    }

    /// The gap rate is never better for the holder than either the stored or the current rate.
    function check_GapRateIsWorseOf(int256 stored, int256 current) public pure {
        int256 r = ODToll.gapRate(stored, current);
        assert(r >= stored && r >= current);
        assert(r == stored || r == current);
    }

    /// One NF step: a negative toll never lowers NF, a positive one never raises it, and NF stays in range.
    function check_NormStepBounds(uint256 nf, int256 t, uint256 dt) public pure {
        vm.assume(nf >= ODNorm.MIN_NF && nf <= ODNorm.MAX_NF);
        vm.assume(t >= -ODNorm.MAX_ABS_PER_SEC && t <= ODNorm.MAX_ABS_PER_SEC);
        vm.assume(dt <= 1 hours);
        uint256 out = ODNorm.step(nf, t, dt);
        if (t < 0) assert(out >= nf);
        if (t > 0) assert(out <= nf);
        assert(out >= ODNorm.MIN_NF && out <= ODNorm.MAX_NF);
    }
}
