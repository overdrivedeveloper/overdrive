// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";

/// BAT-1, PERP-3: an attacker who can push the reference price (the refP leg of the high-side value) for a moment tries
/// to seal a healthy vault and liquidate it in the same block or bundle. SEAL_DELAY refuses the same-block execute, a
/// reference that moves after the seal only voids the batch, and the execute never prices off the attacker's move.
contract LiquidationSandwichTest is BackerFixture {
    address internal attacker = makeAddr("attacker");
    uint256 internal victim;

    function setUp() public override {
        super.setUp();
        victim = _sportVault(alice); // 200% at 250
        _price(TSLA, 286e18); // value x 1.309: about 152.8%, healthy (maintenance 150%)
        (,, uint256 ratio,, uint256 maint) = backer.health(victim);
        assertGt(ratio, maint, "healthy before the attack");
    }

    /// The attacker lifts the reference 1.05% (inside the 2% band, so the reading stays live) and seals.
    function _attackSeal() internal returns (uint256 b) {
        _ref(TSLA, 289e18);
        (,, uint256 ratio,, uint256 maint) = backer.health(victim);
        assertLt(ratio, maint, "the pushed reference makes it sealable");
        vm.prank(attacker);
        b = _seal(sport, victim);
    }

    function test_SameBlockSealExecuteRefused() public {
        uint256 b = _attackSeal();
        uint64 s = uint64(vm.getBlockTimestamp());
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.BatchNotReady.selector, s + backer.SEAL_DELAY()));
        backer.executeBatch(b);
        assertEq(_debt(victim), 500e18);
    }

    function test_PoolMoveAfterSealOnlyVoids() public {
        // an honest seal at a real crash, then the attacker pushes the reference to lift the debt further
        _price(TSLA, 300e18);
        uint256 b = _seal(sport, victim);
        vm.warp(vm.getBlockTimestamp() + 30);
        _ref(TSLA, 305e18); // value +3.4% at the reference: beyond the 1% drift band
        vm.expectEmit(address(backer));
        emit IODBacker.BatchVoided(b, "DRIFT");
        vm.prank(attacker);
        assertEq(backer.executeBatch(b), 0);
        assertEq(_debt(victim), 500e18, "nothing liquidated at the pushed price");
        assertEq(usdg.balanceOf(attacker), 0);
    }

    function test_AttackerBundleLoses() public {
        uint256 collBefore = _coll(victim);
        uint256 b = _attackSeal();
        // the reference returns to the real price before the window opens (the attacker cannot hold it)
        vm.warp(vm.getBlockTimestamp() + 30);
        _price(TSLA, 286e18);
        vm.prank(attacker);
        assertEq(backer.executeBatch(b), 0, "voided on the drift back");
        assertEq(_debt(victim), 500e18);
        assertGe(_coll(victim) + backer.tollFeeOwed(victim) + 1e6, collBefore, "collateral kept (toll fee aside)");
        assertEq(usdg.balanceOf(attacker), 0, "the attacker earns nothing");
        // and the vault is free again: the owner can act at once
        (,,,, uint256 inBatch) = backer.vault(victim);
        assertEq(inBatch, 0);
    }
}
