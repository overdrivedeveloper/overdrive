// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {SystemChecks} from "./lib/SystemChecks.sol";

/// @title PostDeployCheck
/// @notice Read-only: checks a live deployment against its config (rule R8) and writes the result to
/// `security/post-deploy-<network>.txt`. Reverts when any check fails, so an owner script stops on it.
/// Usage: OD_NETWORK=mainnet forge script script/PostDeployCheck.s.sol --rpc-url $RPC
contract PostDeployCheck is SystemChecks {
    function run() external returns (string[] memory failures) {
        string memory network = _network();
        Config memory c = loadConfig(network);
        string memory file = vm.envOr("OD_DEPLOYMENT_FILE", _deploymentPath(network));
        string memory j = vm.readFile(file);
        failures = checkSystem(c, readDeployment(j), vm.parseJsonAddress(j, ".deployer"));
        string memory report = string.concat("post-deploy check ", network, " chain ", vm.toString(block.chainid), "\n");
        for (uint256 i; i < failures.length; ++i) {
            report = string.concat(report, "FAIL ", failures[i], "\n");
            console2.log("FAIL", failures[i]);
        }
        report = string.concat(report, failures.length == 0 ? "PASS\n" : "FAILED\n");
        string memory dir = string.concat(vm.projectRoot(), "/../security");
        vm.createDir(dir, true);
        vm.writeFile(string.concat(dir, "/post-deploy-", network, ".txt"), report);
        if (failures.length != 0) {
            revert(string.concat("PostDeployCheck: ", vm.toString(failures.length), " failures"));
        }
        console2.log("PostDeployCheck: PASS");
    }
}
