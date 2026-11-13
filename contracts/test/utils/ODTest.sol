// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// Shared base for every Overdrive test.
abstract contract ODTest is Test {
    /// Skips the test when RHC_RPC_URL is unset; otherwise forks the latest block
    /// (the public RPC keeps about 10 minutes of state, so never pin an old block).
    function forkOrSkip() internal returns (uint256 forkId) {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return 0;
        }
        forkId = vm.createSelectFork(url);
    }
}
