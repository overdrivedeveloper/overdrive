// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {HookFixture} from "./HookFixture.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";

/// Tests added from mutation testing (docs/reviews/mutation-2026-11-15.md): each pins a behaviour that a surviving
/// mutant showed no test checked.
contract HookMutationKillsTest is HookFixture {
    /// Kills m4878 (afterSwap: the revert commented out, so the unused callback returned zero values). Every
    /// callback the hook does not register reverts, whoever calls it.
    function test_UnusedCallbacksRevert() public {
        PoolKey memory k;
        IPoolManager.SwapParams memory sp;
        BalanceDelta d;
        vm.expectRevert(ODHook.HookNotImplemented.selector);
        hook.afterSwap(address(this), k, sp, d, "");
        vm.expectRevert(ODHook.HookNotImplemented.selector);
        hook.afterInitialize(address(this), k, 0, 0);
        vm.expectRevert(ODHook.HookNotImplemented.selector);
        hook.beforeDonate(address(this), k, 0, 0, "");
        vm.expectRevert(ODHook.HookNotImplemented.selector);
        hook.afterDonate(address(this), k, 0, 0, "");
    }
}
