// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {DeployFixture, DeployHarness} from "./DeployFixture.sol";
import {TimelockHandoff} from "../../script/TimelockHandoff.s.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";

/// TimelockHandoff is idempotent: it finishes a half-done handoff and skips every finished step.
contract TimelockHandoffTest is DeployFixture {
    TimelockHandoff internal th;

    function setUp() public override {
        vm.warp(T0);
        ds = new DeployHarness();
        th = new TimelockHandoff();
        _buildConfig();
        d = ds.deployNoHandoff(_cfg(), deployer);
    }

    function test_FinishesHalfDoneHandoffThenSkips() public {
        SystemDeployer.Deployed memory x = _d();
        address[] memory cores = th.adminCores(x);
        assertEq(th.pendingSteps(x, deployer), 2 * cores.length, "all steps pending");
        // a run that stopped half way: the first three cores are already handed off
        vm.startPrank(deployer);
        for (uint256 i; i < 3; ++i) {
            IAccessControl(cores[i]).grantRole(0x00, x.timelock);
            IAccessControl(cores[i]).renounceRole(0x00, deployer);
        }
        vm.stopPrank();
        assertEq(th.handoff(x, deployer), 2 * (cores.length - 3), "only the unfinished steps run");
        assertEq(th.pendingSteps(x, deployer), 0);
        assertEq(th.handoff(x, deployer), 0, "second run skips everything");
        for (uint256 i; i < cores.length; ++i) {
            assertTrue(IAccessControl(cores[i]).hasRole(0x00, x.timelock));
            assertFalse(IAccessControl(cores[i]).hasRole(0x00, deployer));
        }
    }

    function test_DeploySystemAlreadyHandedOff() public {
        SystemDeployer.Deployed memory y = ds.deploy(_cfg(), makeAddr("deployer2"));
        assertEq(th.pendingSteps(y, makeAddr("deployer2")), 0);
        assertEq(th.handoff(y, makeAddr("deployer2")), 0);
    }
}
