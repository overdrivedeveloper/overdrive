// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GovernorFixture} from "./GovernorFixture.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";
import {Vm} from "forge-std/Vm.sol";

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

    function _bookLogs(bytes32 id) internal returns (Vm.Log[] memory out, uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        out = new Vm.Log[](logs.length);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(gov) && logs[i].topics[0] == IODGovernor.BookUpdated.selector) {
                assertEq(logs[i].topics[1], id, "gear id");
                out[n++] = logs[i];
            }
        }
    }

    /// Kills m2605 (onBackerMint: the book event emitted when the mint was refused). A refused backer mint emits no
    /// BookUpdated; an accepted one emits exactly one with the new net and backer debt.
    function test_BackerMintBookEventOnlyWhenAccepted() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000e18);
        _fundReserve(10_000e6); // the reserve never backs a sale credit: the mint is refused
        vm.recordLogs();
        vm.prank(backerC);
        assertFalse(gov.onBackerMint(id, 100e18, true, 100e6, address(1)));
        (, uint256 n) = _bookLogs(id);
        assertEq(n, 0, "no book event on a refused mint");

        _fundCash(1_000e6);
        vm.recordLogs();
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, 100e18, true, 100e6, address(1)));
        (Vm.Log[] memory logs, uint256 m) = _bookLogs(id);
        assertEq(m, 1, "one book event");
        uint256 debt = gov.backerDebt(id);
        assertEq(debt, 100e18);
        int256 net = int256(IERC20(reg.gear(id).token).totalSupply()) - int256(debt);
        assertEq(logs[0].data, abi.encode(net, debt), "net and debt");
    }
}
