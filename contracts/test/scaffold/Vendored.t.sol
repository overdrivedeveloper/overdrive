// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

contract VendoredTest is ODTest {
    function test_PoolManagerDeploysLocally() public {
        PoolManager pm = new PoolManager(address(this));
        assertEq(pm.owner(), address(this));
        assertGt(address(pm).code.length, 0);
        assertEq(address(IPoolManager(address(pm))), address(pm));
    }

    function test_SolcAndEvmPinned() public {
        // Build-of-record settings live in foundry.toml; here we check the EVM the tests really run on.
        // cancun: TSTORE (EIP-1153) must work.
        uint256 v;
        assembly {
            tstore(0, 42)
            v := tload(0)
        }
        assertEq(v, 42);
        // Pragma is exactly 0.8.26 in every file; a mismatch would not compile. Chain id is the test default.
        assertEq(block.chainid, 31337);
    }
}
