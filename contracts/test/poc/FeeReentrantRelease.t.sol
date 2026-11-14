// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// A Governor-bucket recipient that calls release on another bucket from inside fundCash and pulls nothing.
contract ReleasingGov {
    ODFees internal fees;
    bytes32 internal bucket;

    function arm(ODFees f, bytes32 b) external {
        fees = f;
        bucket = b;
    }

    function fundCash(uint256) external {
        fees.release(bucket);
    }

    function fundExitReserve(uint256) external {}
}

/// Informational (invariant lane 2): ODFees._pay measures a callback payout as the fall in its own USDG balance. If the
/// recipient calls release(other bucket) inside the callback, that other bucket's payout is counted as paid to this
/// recipient too: the Governor bucket's books drop although it received nothing. Coverage still holds (balance >=
/// pending + totalHeld) and the drift is recovered by sync, so no value is created; it needs an admin-set recipient
/// that re-enters (the real ODGovernor and ODStake do not). This test asserts the drift IS present on the current code.
contract FeeReentrantReleaseTest is Test {
    function test_Repro_ReentrantReleaseDropsGovernorBooks() public {
        MockUSDG usdg = new MockUSDG();
        ReleasingGov gov = new ReleasingGov();
        address admin = makeAddr("admin");
        address notifier = makeAddr("notifier");
        address keepers = makeAddr("keepers");
        ODFees fees = new ODFees(IERC20(address(usdg)), admin, address(gov));
        gov.arm(fees, fees.B_KEEPERS());
        vm.startPrank(admin);
        fees.setNotifier(notifier, true);
        fees.setRecipient(fees.B_KEEPERS(), keepers);
        vm.stopPrank();
        bytes32 toll = fees.K_TOLL();

        // round 1: keepers blocked, so their share is held
        usdg.setBlocked(keepers, true);
        usdg.mint(address(fees), 1_000_000e6);
        vm.prank(notifier);
        fees.notify(toll, bytes32(0), 1_000_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        fees.distribute();
        uint256 keepersHeld = fees.held(fees.B_KEEPERS());
        assertGt(keepersHeld, 0);
        assertEq(usdg.balanceOf(address(fees)), fees.pending() + fees.totalHeld(), "books exact before");

        // round 2: keepers unblocked; the Governor's callback releases them mid-payout
        usdg.setBlocked(keepers, false);
        usdg.mint(address(fees), 1_000_000e6);
        vm.prank(notifier);
        fees.notify(toll, bytes32(0), 1_000_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 govShare = 1_000_000e6 * uint256(fees.opsBps()) / 10_000 * fees.governorBps() / 10_000;
        uint256 govHeldBefore = fees.held(fees.B_GOVERNOR());
        fees.distribute();

        assertEq(usdg.balanceOf(address(gov)), 0, "the Governor received nothing");
        uint256 bal = usdg.balanceOf(address(fees));
        uint256 books = fees.pending() + fees.totalHeld();
        assertGe(bal, books, "coverage still holds");
        // bug present: the Governor bucket was booked as paid (keepers' release counted as its payout)
        assertLt(fees.held(fees.B_GOVERNOR()), govHeldBefore + govShare, "Governor bucket lost books");
        assertGt(bal - books, 0, "books fell below balance with no donation");
        assertEq(fees.sync(), bal - books, "sync recovers the drift");
    }
}
