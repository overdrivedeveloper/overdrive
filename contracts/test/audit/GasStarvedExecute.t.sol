// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";

/// Audit rescore 1 M-6: executeBatch swallowed an out-of-gas self-call, so a caller's chosen gas limit could mark the
/// batch done and liquidate nothing. Property: a successful execute never leaves a sealed, still-unhealthy vault
/// unliquidated, and a failed one never closes the batch. Fails on 3fe7859 (every limit from 325k to 570k voided it).
contract GasStarvedExecuteTest is BackerFixture {
    address internal keeper = makeAddr("keeper");
    address internal griefer = makeAddr("griefer");

    function _fundInsurance(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(ins), amount);
        ins.fund(amount);
    }

    function _sealMany(uint256 count) internal returns (uint256 b, uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _sportVault(address(uint160(0xA11CE000 + i)));
        }
        _price(TSLA, 300e18);
        b = backer.sealBatch(sport, ids);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
    }

    /// One attempt at `g` gas from `who`; returns whether it succeeded and whether the property held. State reverted.
    function _attempt(uint256 b, uint256[] memory ids, address who, uint256 g) internal returns (bool ok, bool holds) {
        uint256 snap = vm.snapshotState();
        vm.prank(who);
        (ok,) = address(backer).call{gas: g}(abi.encodeCall(backer.executeBatch, (b)));
        bool done = backer.batch(b).done;
        holds = true;
        if (ok) {
            for (uint256 i; i < ids.length; ++i) {
                if (_debt(ids[i]) != 0) holds = false;
            }
            if (!done) holds = false;
        } else if (done) {
            holds = false;
        }
        vm.revertToState(snap);
    }

    /// The PoC's sweep with the assertion flipped: no gas limit returns success with the vault still in debt.
    function test_GasSweepNeverVoidsBatch() public {
        (uint256 b, uint256[] memory ids) = _sealMany(1);
        uint256 lowestOk;
        for (uint256 g = 100_000; g <= 3_000_000; g += 5_000) {
            (bool ok, bool holds) = _attempt(b, ids, griefer, g);
            assertTrue(holds, "success with the vault unliquidated, or a failure that closed the batch");
            if (ok && lowestOk == 0) lowestOk = g;
        }
        emit log_named_uint("lowest gas limit that executes (1 vault)", lowestOk);
        assertGt(lowestOk, 0);
        // and the keeper still liquidates after any number of starved attempts
        vm.prank(griefer);
        (bool ok2,) = address(backer).call{gas: 400_000}(abi.encodeCall(backer.executeBatch, (b)));
        assertFalse(ok2);
        assertFalse(backer.batch(b).done);
        vm.prank(keeper);
        assertEq(backer.executeBatch(b), 1);
        assertEq(_debt(ids[0]), 0);
    }

    /// Nested starvation: a deep crash needs insurance; no gas limit may succeed with the insurance call starved
    /// (that would move the shortfall onto Governor equity as bad debt).
    function test_GasSweepNeverSkipsInsurance() public {
        _fundInsurance(5_000e6);
        uint256 id = _sportVault(alice);
        _price(TSLA, 350e18);
        _price(TSLA, 420e18);
        _price(TSLA, 480e18);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 b = backer.sealBatch(sport, ids);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        uint256 full = _insurancePaidAt(b, 30_000_000);
        assertGt(full, 0, "the honest execute draws insurance");
        for (uint256 g = 100_000; g <= 3_000_000; g += 5_000) {
            uint256 snap = vm.snapshotState();
            uint256 insBefore = ins.balance();
            vm.prank(griefer);
            (bool ok,) = address(backer).call{gas: g}(abi.encodeCall(backer.executeBatch, (b)));
            if (ok) {
                assertEq(_debt(id), 0, "success means liquidated");
                assertEq(insBefore - ins.balance(), full, "success means insurance paid in full");
            } else {
                assertFalse(backer.batch(b).done);
            }
            vm.revertToState(snap);
        }
    }

    function _insurancePaidAt(uint256 b, uint256 g) internal returns (uint256 paid) {
        uint256 snap = vm.snapshotState();
        uint256 before = ins.balance();
        vm.prank(keeper);
        (bool ok,) = address(backer).call{gas: g}(abi.encodeCall(backer.executeBatch, (b)));
        assertTrue(ok);
        paid = before - ins.balance();
        vm.revertToState(snap);
    }

    /// Fuzz over gas limits and batch sizes: success implies every sealed vault liquidated and the batch done; a
    /// revert leaves the batch open.
    function testFuzz_SuccessImpliesAllLiquidated(uint256 gasLimit, uint8 count) public {
        count = uint8(bound(count, 1, 6));
        gasLimit = bound(gasLimit, 100_000, 600_000 + uint256(count) * 700_000);
        (uint256 b, uint256[] memory ids) = _sealMany(count);
        (, bool holds) = _attempt(b, ids, griefer, gasLimit);
        assertTrue(holds);
    }

    /// Second route from the report: an executor that cannot receive USDG made every vault fail inside the catch and
    /// closed the batch. Now the batch stays open and the next executor liquidates.
    function test_BlockedExecutorLeavesBatchOpen() public {
        (uint256 b, uint256[] memory ids) = _sealMany(2);
        usdg.setBlocked(griefer, true);
        vm.prank(griefer);
        assertEq(backer.executeBatch(b), 0);
        assertFalse(backer.batch(b).done, "a failed vault keeps the batch open");
        vm.prank(keeper);
        assertEq(backer.executeBatch(b), 2);
        assertTrue(backer.batch(b).done);
        assertEq(_debt(ids[0]) + _debt(ids[1]), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.BatchDone.selector, b));
        backer.executeBatch(b);
    }

    /// Below MIN_VAULT_GAS before a vault the execute reverts with the named error.
    function test_UnderFloorRevertsNamed() public {
        (uint256 b,) = _sealMany(1);
        vm.prank(griefer);
        vm.expectRevert(IODBacker.ExecuteOutOfGas.selector);
        backer.executeBatch{gas: 500_000}(b);
    }
}
