// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SystemChecks} from "./lib/SystemChecks.sol";

/// @title TimelockHandoff
/// @notice Idempotent: for every core, grants DEFAULT_ADMIN_ROLE to the timelock where missing and renounces the
/// caller's where held. A finished step is skipped; with nothing left it broadcasts nothing. Use it to finish a
/// DeploySystem run that stopped before its handoff.
contract TimelockHandoff is SystemChecks {
    function run() external {
        string memory j = vm.readFile(vm.envOr("OD_DEPLOYMENT_FILE", _deploymentPath(_network())));
        uint256 steps = handoff(readDeployment(j), msg.sender);
        console2.log("TimelockHandoff steps taken:", steps);
    }

    function pendingSteps(Deployed memory d, address me) public view returns (uint256 n) {
        address[] memory cores = adminCores(d);
        for (uint256 i; i < cores.length; ++i) {
            if (!IAccessControl(cores[i]).hasRole(0x00, d.timelock)) ++n;
            if (IAccessControl(cores[i]).hasRole(0x00, me)) ++n;
        }
    }

    function handoff(Deployed memory d, address me) public returns (uint256 steps) {
        if (pendingSteps(d, me) == 0) return 0;
        _guardRealBroadcast();
        vm.startBroadcast(me);
        steps = _handoff(d, me);
        vm.stopBroadcast();
    }
}
