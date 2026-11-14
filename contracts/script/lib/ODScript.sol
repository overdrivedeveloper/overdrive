// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

/// @title ODScript
/// @notice Base of every Overdrive operational script. Holds the real-broadcast guard: on Robinhood Chain mainnet
/// (4663) and testnet (46630) a broadcast is refused unless `OVERDRIVE_ALLOW_REAL_DEPLOY` is exactly "1" AND the file
/// named by `OVERDRIVE_ALLOW_FILE` exists. Plain anvil (31337) and LOCAL anvil forks stay free: an anvil fork keeps
/// the forked chain id (4663), so the guard asks the node for `anvil_nodeInfo`; a real node rejects that method, and an
/// RPC that cannot be asked counts as real.
/// @dev Nothing here reads or stores keys: sign with Foundry's own `--account` keystore prompt.
abstract contract ODScript is Script {
    uint256 internal constant CHAIN_MAINNET = 4663;
    uint256 internal constant CHAIN_TESTNET = 46630;

    error RealBroadcastRefused(uint256 chainId, string why);

    function _isRealChain(uint256 id) internal pure returns (bool) {
        return id == CHAIN_MAINNET || id == CHAIN_TESTNET;
    }

    /// Refuses a broadcast on 4663/46630 unless armed (flag "1" and the arming file present). Call before any
    /// `vm.broadcast`/`vm.startBroadcast`.
    function _guardRealBroadcast() internal {
        if (!_isRealChain(block.chainid)) return;
        if (_isLocalAnvil()) return;
        string memory flag = vm.envOr(_armFlagEnv(), string(""));
        if (keccak256(bytes(flag)) != keccak256("1")) {
            revert RealBroadcastRefused(block.chainid, "OVERDRIVE_ALLOW_REAL_DEPLOY is not 1");
        }
        string memory file = vm.envOr(_armFileEnv(), string(""));
        if (bytes(file).length == 0 || !vm.exists(file)) {
            revert RealBroadcastRefused(block.chainid, "OVERDRIVE_ALLOW_FILE missing");
        }
    }

    /// The arming variable names. Only the guard's own test overrides them (one name per test, so parallel tests never
    /// race on the process environment).
    function _armFlagEnv() internal view virtual returns (string memory) {
        return "OVERDRIVE_ALLOW_REAL_DEPLOY";
    }

    function _armFileEnv() internal view virtual returns (string memory) {
        return "OVERDRIVE_ALLOW_FILE";
    }

    /// A local anvil node answers `anvil_nodeInfo`; a real node rejects the method (the cheatcode reverts).
    function _isLocalAnvil() internal returns (bool) {
        try vm.rpc("anvil_nodeInfo", "[]") returns (bytes memory r) {
            return r.length != 0;
        } catch {
            return false;
        }
    }

    /// The network name used for config and output files: `OD_NETWORK` or, from the chain id, mainnet/testnet/anvil.
    function _network() internal view returns (string memory) {
        string memory n = vm.envOr("OD_NETWORK", string(""));
        if (bytes(n).length != 0) return n;
        if (block.chainid == CHAIN_MAINNET) return "mainnet";
        if (block.chainid == CHAIN_TESTNET) return "testnet";
        return "anvil";
    }

    /// Where the deployments json goes: `OD_DEPLOYMENTS_OUT` or `../app/deployments/<network>.json` for mainnet and
    /// testnet; fork and anvil runs write `../app/deployments/local/<network>.json` (git-ignored) so a dry run never
    /// changes a committed address source.
    function _deploymentPath(string memory network) internal view returns (string memory) {
        string memory p = vm.envOr("OD_DEPLOYMENTS_OUT", string(""));
        if (bytes(p).length != 0) return p;
        bytes32 h = keccak256(bytes(network));
        if (h == keccak256("mainnet") || h == keccak256("testnet")) {
            return string.concat(vm.projectRoot(), "/../app/deployments/", network, ".json");
        }
        return string.concat(vm.projectRoot(), "/../app/deployments/local/", network, ".json");
    }
}
