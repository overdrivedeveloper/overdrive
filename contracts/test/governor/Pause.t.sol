// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {GovernorFixture} from "./GovernorFixture.sol";

/// The guardian pauses buys; only the admin, a 48 h timelock, unpauses.
contract PauseTest is GovernorFixture {
    function test_TimelockUnpauses() public {
        address[] memory who = new address[](1);
        who[0] = admin;
        TimelockController tl = new TimelockController(48 hours, who, who, address(0));
        bytes32 adminRole = gov.DEFAULT_ADMIN_ROLE();
        vm.startPrank(admin);
        gov.grantRole(adminRole, address(tl));
        gov.renounceRole(adminRole, admin);
        vm.stopPrank();
        vm.prank(guardian);
        gov.setBuysPaused(true);
        (bool paused,) = gov.buysPaused();
        assertTrue(paused);
        vm.prank(guardian);
        vm.expectRevert();
        gov.setBuysPaused(false);
        vm.prank(stranger);
        vm.expectRevert();
        gov.setBuysPaused(true);
        bytes memory data = abi.encodeCall(gov.setBuysPaused, (false));
        vm.prank(admin);
        tl.schedule(address(gov), 0, data, 0, 0, 48 hours);
        vm.warp(vm.getBlockTimestamp() + 48 hours - 1);
        vm.prank(admin);
        vm.expectRevert();
        tl.execute(address(gov), 0, data, 0, 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(admin);
        tl.execute(address(gov), 0, data, 0, 0);
        _poke();
        (paused,) = gov.buysPaused();
        assertFalse(paused);
    }
}
