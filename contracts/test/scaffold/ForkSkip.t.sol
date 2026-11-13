// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";

contract ForkSkipTest is ODTest {
    /// Skips (not fails) when RHC_RPC_URL is unset; with it set, forks and sees a live chain.
    function test_SkipsWithoutRpc() public {
        forkOrSkip();
        assertGt(block.number, 0);
    }
}
