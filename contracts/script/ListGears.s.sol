// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SystemChecks} from "./lib/SystemChecks.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {GearStatus} from "overdrive/interfaces/ODTypes.sol";

/// @title TimelockBatch
/// @notice Builds timelock batches and writes them as Safe Transaction Builder JSON (one scheduleBatch transaction and
/// one executeBatch transaction for the owner Safe). Never executes anything.
abstract contract TimelockBatch is SystemChecks {
    struct Batch {
        address[] targets;
        uint256[] values;
        bytes[] payloads;
        bytes32 salt;
    }

    function batchId(Batch memory b) public pure returns (bytes32) {
        return keccak256(abi.encode(b.targets, b.values, b.payloads, bytes32(0), b.salt));
    }

    function scheduleData(Batch memory b, uint256 delay) public pure returns (bytes memory) {
        return
            abi.encodeCall(
                TimelockController.scheduleBatch, (b.targets, b.values, b.payloads, bytes32(0), b.salt, delay)
            );
    }

    function executeData(Batch memory b) public pure returns (bytes memory) {
        return abi.encodeCall(TimelockController.executeBatch, (b.targets, b.values, b.payloads, bytes32(0), b.salt));
    }

    function _safeTx(address timelock, bytes memory data) private pure returns (string memory) {
        return string.concat('{"to": "', vm.toString(timelock), '", "value": "0", "data": "', vm.toString(data), '"}');
    }

    function writeBatch(string memory name, address timelock, Batch memory b, uint256 delay)
        internal
        returns (string memory path)
    {
        string memory dir = vm.envOr("OD_BATCH_DIR", string.concat(vm.projectRoot(), "/../.batches"));
        vm.createDir(dir, true);
        path = string.concat(dir, "/", name, ".json");
        string memory meta = string.concat(
            '{"version": "1.0", "chainId": "',
            vm.toString(block.chainid),
            '", "meta": {"name": "',
            name,
            '", "description": "schedule now, execute after 48 h; batch id ',
            vm.toString(batchId(b)),
            '"}, "transactions": ['
        );
        vm.writeFile(path, string.concat(meta, _safeTx(timelock, scheduleData(b, delay)), "]}\n"));
        vm.writeFile(
            string.concat(dir, "/", name, ".execute.json"),
            string.concat(meta, _safeTx(timelock, executeData(b)), "]}\n")
        );
    }
}

/// @title ListGears
/// @notice Writes a timelock batch that lists every config gear not yet listed and initialises its hook pool.
contract ListGears is TimelockBatch {
    function run() external returns (bytes32[] memory batchIds) {
        string memory network = _network();
        Config memory c = loadConfig(network);
        Deployed memory d = readDeployment(vm.readFile(vm.envOr("OD_DEPLOYMENT_FILE", _deploymentPath(network))));
        Batch memory b = listBatch(c, d);
        batchIds = new bytes32[](b.targets.length == 0 ? 0 : 1);
        if (b.targets.length == 0) {
            console2.log("ListGears: every config gear is listed");
            return batchIds;
        }
        batchIds[0] = batchId(b);
        console2.log("ListGears batch:", writeBatch(string.concat(network, "-list-gears"), d.timelock, b, c.minDelay));
    }

    function listBatch(Config memory c, Deployed memory d) public view returns (Batch memory b) {
        ODGearRegistry reg = ODGearRegistry(d.registry);
        uint256 n;
        for (uint256 i; i < c.gears.length; ++i) {
            if (reg.gear(reg.idOf(c.gears[i].marketA, c.gears[i].marketB, c.gears[i].gear)).token == address(0)) ++n;
        }
        b.targets = new address[](2 * n);
        b.values = new uint256[](2 * n);
        b.payloads = new bytes[](2 * n);
        uint256 k;
        for (uint256 i; i < c.gears.length; ++i) {
            GearCfg memory g = c.gears[i];
            bytes32 id = reg.idOf(g.marketA, g.marketB, g.gear);
            if (reg.gear(id).token != address(0)) continue;
            string memory sym = g.marketB == bytes32(0)
                ? string.concat(symbolOf(g.marketA), reg.suffixOf(g.gear))
                : string.concat(symbolOf(g.marketA), "/", symbolOf(g.marketB), reg.suffixOf(g.gear));
            b.targets[k] = d.registry;
            b.payloads[k++] = abi.encodeCall(
                ODGearRegistry.listGear, (g.marketA, g.marketB, g.gear, g.unitWad, g.capUsdWad, g.spreadBps, sym)
            );
            b.targets[k] = d.hook;
            b.payloads[k++] = abi.encodeCall(ODHook.initializeGearPool, (id));
        }
        b.salt = keccak256(abi.encode("overdrive-list-gears", b.payloads));
    }
}

/// @title SettleGearBatch
/// @notice D25: one timelock batch calls `minter.settleGear(id)` then `registry.setStatus(id, SETTLED)`; the minter
/// holds no registry status role. Usage: OD_GEAR_ID=0x.. forge script script/ListGears.s.sol:SettleGearBatch
contract SettleGearBatch is TimelockBatch {
    function run() external returns (bytes32 id) {
        string memory network = _network();
        Config memory c = loadConfig(network);
        Deployed memory d = readDeployment(vm.readFile(vm.envOr("OD_DEPLOYMENT_FILE", _deploymentPath(network))));
        Batch memory b = settleBatch(d, vm.envBytes32("OD_GEAR_ID"));
        id = batchId(b);
        console2.log("SettleGear batch:", writeBatch(string.concat(network, "-settle-gear"), d.timelock, b, c.minDelay));
    }

    function settleBatch(Deployed memory d, bytes32 gearId) public pure returns (Batch memory b) {
        b.targets = new address[](2);
        b.values = new uint256[](2);
        b.payloads = new bytes[](2);
        b.targets[0] = d.minter;
        b.payloads[0] = abi.encodeCall(ODMinter.settleGear, (gearId));
        b.targets[1] = d.registry;
        b.payloads[1] = abi.encodeCall(ODGearRegistry.setStatus, (gearId, GearStatus.SETTLED));
        b.salt = keccak256(abi.encode("overdrive-settle-gear", gearId));
    }
}
