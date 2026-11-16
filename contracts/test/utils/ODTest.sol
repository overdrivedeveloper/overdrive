// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ForkPin} from "./ForkPin.sol";

/// Shared base for every Overdrive test.
abstract contract ODTest is Test {
    /// Skips the test when RHC_RPC_URL is unset; otherwise forks the pinned block (ForkPin: needs an archive RPC).
    function forkOrSkip() internal returns (uint256 forkId) {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return 0;
        }
        forkId = ForkPin.select(url);
    }
}
