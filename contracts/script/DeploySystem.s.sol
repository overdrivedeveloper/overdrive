// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {SystemChecks} from "./lib/SystemChecks.sol";

/// @title DeploySystem
/// @notice Deploys the whole Overdrive system from `script/config/<network>.json`, wires it, lists the gears whose
/// markets read ready, writes the deployments json and hands every admin role to the 48 h timelock (the deployer keeps
/// nothing). Seeds nothing. On 4663/46630 it refuses to broadcast unless armed (ODScript), and the config refuses
/// placeholder addresses.
/// Usage: OD_NETWORK=fork forge script script/DeploySystem.s.sol --rpc-url $RPC --account overdrive-deployer --broadcast
contract DeploySystem is SystemChecks {
    function run() external returns (Deployed memory d) {
        string memory network = _network();
        Config memory c = loadConfig(network);
        d = deploy(c, msg.sender);
        string memory path = _deploymentPath(network);
        _writeFile(path, renderDeployment(c, d, msg.sender, vm.envOr("OD_COMMIT", string("unknown"))));
        console2.log("deployments json:", path);
        console2.log("gears listed now:", _gearCount(d), "of", c.gears.length);
    }

    /// Validates, guards, then deploys and hands off as `deployer` inside one broadcast.
    function deploy(Config memory c, address deployer) public returns (Deployed memory d) {
        validateConfig(c);
        _guardRealBroadcast();
        vm.startBroadcast(deployer);
        d = _deployAll(c, deployer);
        _handoff(d, deployer);
        vm.stopBroadcast();
    }

    function _gearCount(Deployed memory d) private view returns (uint256 n) {
        (bool ok, bytes memory r) = d.registry.staticcall(abi.encodeWithSignature("gearCount()"));
        if (ok) n = abi.decode(r, (uint256));
    }

    function _writeFile(string memory path, string memory body) internal {
        bytes memory p = bytes(path);
        uint256 cut = p.length;
        while (cut > 0 && p[cut - 1] != "/") --cut;
        if (cut > 1) {
            bytes memory dir = new bytes(cut - 1);
            for (uint256 i; i < cut - 1; ++i) {
                dir[i] = p[i];
            }
            vm.createDir(string(dir), true);
        }
        vm.writeFile(path, body);
    }
}
