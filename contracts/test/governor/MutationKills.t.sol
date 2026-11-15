// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GovernorFixture} from "./GovernorFixture.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";

/// Tests added from mutation testing (docs/reviews/mutation-2026-11-15.md): each pins a behaviour that a surviving
/// mutant showed no test checked.
contract GovernorMutationKillsTest is GovernorFixture {
    function _deployWith(uint256 zeroAt) internal returns (bool reverted) {
        address[7] memory a =
            [address(usdg), admin, guardian, address(reg), address(guard), address(ins), address(fees)];
        a[zeroAt] = address(0);
        try new ODGovernor(
            IERC20(a[0]), a[1], a[2], IODGearRegistry(a[3]), IODOracleGuard(a[4]), IODInsurance(a[5]), a[6]
        ) returns (
            ODGovernor
        ) {
            return false;
        } catch (bytes memory err) {
            assertEq(bytes4(err), IODGovernor.InvalidParams.selector);
            return true;
        }
    }

    /// Kills m2380 (constructor zero-address check: the first `||` turned into `&&`, so a zero admin alone passed).
    /// Each constructor address on its own must be refused when zero.
    function test_ConstructorRefusesEachZeroAddress() public {
        for (uint256 i; i < 7; ++i) {
            assertTrue(_deployWith(i), "zero address accepted");
        }
    }

    /// Kills m3354 (claim: the equity cache refreshed with `mid * paid` instead of `mid - paid`). After a claim the
    /// cached equity is the live equity, less nothing else.
    function test_ClaimRefreshesCachedEquity() public {
        uint256 shares = _deposit(lp, 100_000e6);
        vm.prank(lp);
        uint256 t = gov.requestWithdraw(shares / 2);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lp);
        uint256 paid = gov.claim(t, 0);
        assertGt(paid, 0);
        (int256 e,,) = gov.cachedEquity();
        assertApproxEqAbs(e, gov.equity(), 1e12, "cache equals live equity after the claim");
    }
}
