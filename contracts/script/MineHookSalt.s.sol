// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";

/// Mines the CREATE2 salt for ODHook against a given deployer. View only: prints the address and salt, never
/// broadcasts. Constructor args come from the environment (the salt depends on them):
///   OD_POOL_MANAGER (default: the Robinhood Chain PoolManager), OD_MINTER, OD_REGISTRY, OD_USDG, OD_HOOK_ADMIN.
/// Usage: forge script script/MineHookSalt.s.sol --sig 'run(address)' <deployer>
contract MineHookSalt is Script {
    address internal constant RHC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run(address deployer) external view returns (address hook, bytes32 salt) {
        (hook, salt) = mine(
            deployer,
            vm.envOr("OD_POOL_MANAGER", RHC_POOL_MANAGER),
            vm.envAddress("OD_MINTER"),
            vm.envAddress("OD_REGISTRY"),
            vm.envAddress("OD_USDG"),
            vm.envAddress("OD_HOOK_ADMIN")
        );
        console2.log("deployer", deployer);
        console2.log("hook", hook);
        console2.logBytes32(salt);
    }

    function mine(address deployer, address pm, address minter, address registry, address usdg, address admin)
        public
        view
        returns (address hook, bytes32 salt)
    {
        return ODHookMiner.find(deployer, creationCode(pm, minter, registry, usdg, admin));
    }

    function creationCode(address pm, address minter, address registry, address usdg, address admin)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(ODHook).creationCode, abi.encode(pm, minter, registry, usdg, admin));
    }
}
