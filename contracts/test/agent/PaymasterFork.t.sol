// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ODPaymaster} from "overdrive/agent/ODPaymaster.sol";

/// Against the live chain (skipped without RHC_RPC_URL): the real EntryPoint v0.7 takes the deposit and stake, and the
/// Kernel factory and validator constants have code.
contract PaymasterForkTest is ODTest {
    address internal constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function test_ForkRealEntryPoint() public {
        forkOrSkip();
        assertGt(ENTRY_POINT_V07.code.length, 0);
        address[] memory t = new address[](1);
        t[0] = makeAddr("minter");
        address owner = makeAddr("timelock");
        ODPaymaster pm = new ODPaymaster(
            IEntryPoint(ENTRY_POINT_V07), owner, makeAddr("guardian"), makeAddr("signer"), t, makeAddr("usdg"),
            0.01 ether, 0.01 ether, 0.03 ether
        );
        assertGt(pm.KERNEL_FACTORY().code.length, 0, "kernel factory");
        assertGt(pm.ECDSA_VALIDATOR().code.length, 0, "ecdsa validator");
        vm.deal(address(this), 1 ether);
        pm.deposit{value: 0.1 ether}();
        assertEq(pm.depositBalance(), 0.1 ether);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        pm.addStake{value: 0.2 ether}(1 days);
        vm.prank(owner);
        pm.withdrawTo(payable(owner), 0.05 ether);
        assertEq(pm.depositBalance(), 0.05 ether);
    }
}
