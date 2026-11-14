// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// A Governor-bucket recipient that calls release on another bucket (or sync) from inside fundCash and pulls nothing.
contract ReleasingGov {
    ODFees internal fees;
    bytes32 internal bucket;
    bool internal syncInstead;

    function arm(ODFees f, bytes32 b) external {
        fees = f;
        bucket = b;
    }

    function armSync(ODFees f) external {
        fees = f;
        syncInstead = true;
    }

    function fundCash(uint256) external {
        if (syncInstead) fees.sync();
        else fees.release(bucket);
    }

    function fundExitReserve(uint256) external {}
}

/// Informational (invariant lane 2): ODFees._pay measures a callback payout as the fall in its own USDG balance. If the
/// recipient calls release(other bucket) inside the callback, that other bucket's payout is counted as paid to this
/// recipient too: the Governor bucket's books drop although it received nothing. Coverage still holds (balance >=
/// pending + totalHeld) and the drift is recovered by sync, so no value is created; it needs an admin-set recipient
/// that re-enters (the real ODGovernor and ODStake do not). Fixed: distribute, release and sync are nonReentrant, so the
/// re-entering callback reverts, nothing is pulled, and the Governor's share is held for a later release.
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
        // fixed: the Governor bucket keeps its whole share, the books stay exact, keepers were paid by distribute
        assertEq(fees.held(fees.B_GOVERNOR()), govHeldBefore + govShare, "Governor bucket keeps its books");
        assertEq(bal, books, "books exact after");
        assertEq(fees.held(fees.B_KEEPERS()), 0, "keepers paid");
        assertGt(usdg.balanceOf(keepers), keepersHeld, "keepers got their held share and round 2");
        assertEq(fees.sync(), 0, "nothing to recover");
    }

    /// S-3 on the fix: a callback that calls sync() would book the split still in flight (the later buckets' shares)
    /// as pending, so books would exceed the balance once those buckets are paid. sync is nonReentrant too.
    function test_Repro_ReentrantSyncCannotBookInFlightSplit() public {
        MockUSDG usdg = new MockUSDG();
        ReleasingGov gov = new ReleasingGov();
        address admin = makeAddr("admin");
        address notifier = makeAddr("notifier");
        ODFees fees = new ODFees(IERC20(address(usdg)), admin, address(gov));
        gov.armSync(fees);
        vm.startPrank(admin);
        fees.setNotifier(notifier, true);
        fees.setRecipient(fees.B_KEEPERS(), makeAddr("keepers"));
        fees.setRecipient(fees.B_HEDGERS(), makeAddr("hedgers"));
        fees.setRecipient(fees.B_TREASURY(), makeAddr("treasury"));
        vm.stopPrank();

        bytes32 toll = fees.K_TOLL();
        usdg.mint(address(fees), 1_000_000e6);
        vm.prank(notifier);
        fees.notify(toll, bytes32(0), 1_000_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 govShare = 1_000_000e6 * uint256(fees.opsBps()) / 10_000 * fees.governorBps() / 10_000;
        fees.distribute();

        assertEq(usdg.balanceOf(address(gov)), 0, "the Governor received nothing");
        assertEq(fees.held(fees.B_GOVERNOR()), govShare, "Governor share held");
        assertEq(usdg.balanceOf(address(fees)), fees.pending() + fees.totalHeld(), "books exact");
    }
}
