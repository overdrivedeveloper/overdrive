// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {ODScript} from "./lib/ODScript.sol";
import {ODHookSeed} from "overdrive/periphery/ODHookSeed.sol";

interface IERC6909Like {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function approve(address spender, uint256 id, uint256 amount) external returns (bool);
}

/// @title DeployHookSeed
/// @notice Deploys the D26 seed helper (no privileges: its owner is the owner Safe, fixed at construction). Anyone may
/// sign it; on 4663/46630 it refuses to broadcast unless armed (ODScript).
/// Usage: OD_POOL_MANAGER=0x.. OD_OWNER_SAFE=0x.. forge script script/HookSeed.s.sol:DeployHookSeed --broadcast ...
contract DeployHookSeed is ODScript {
    function run() external returns (address helper) {
        address pm = vm.envAddress("OD_POOL_MANAGER");
        address safe = vm.envAddress("OD_OWNER_SAFE");
        _guardRealBroadcast();
        vm.startBroadcast();
        helper = address(new ODHookSeed(IPoolManager(pm), safe));
        vm.stopBroadcast();
        console2.log("ODHookSeed:", helper);
    }
}

/// @title HookSeedBatch
/// @notice Writes the owner Safe's D26 hook seed transactions as Safe Transaction Builder JSON. Never sends anything.
/// OD_HOOK_SEED_MODE=seed: per token `approve(helper, amount)`, then `helper.seed(tokens, amounts)`. Amounts:
///   USDG = OD_SEED_USDG_PER_GEAR x gear count, each gear = OD_SEED_GEAR_WAD (the config's hookSeed figures).
/// OD_HOOK_SEED_MODE=remove: per token with a claim, PoolManager `approve(helper, id, claim)`, then
///   `helper.remove(tokens, claims)`, every claim the Safe holds on USDG and the gear tokens (read live).
/// Both approvals are consumed exactly by the helper call in the same batch. Env: OD_POOL_MANAGER, OD_OWNER_SAFE,
/// OD_HOOK_SEED_HELPER, OD_USDG, OD_GEAR_TOKENS (comma list), OD_BATCH_DIR (default ../.batches), OD_NETWORK.
contract HookSeedBatch is ODScript {
    struct Txs {
        address[] to;
        bytes[] data;
    }

    function run() external returns (string memory path) {
        string memory mode = vm.envString("OD_HOOK_SEED_MODE");
        address pm = vm.envAddress("OD_POOL_MANAGER");
        address safe = vm.envAddress("OD_OWNER_SAFE");
        ODHookSeed helper = ODHookSeed(vm.envAddress("OD_HOOK_SEED_HELPER"));
        require(
            address(helper.poolManager()) == pm && helper.owner() == safe, "helper is not for this PoolManager and Safe"
        );
        address[] memory gears = vm.envAddress("OD_GEAR_TOKENS", ",");
        address[] memory tokens = new address[](gears.length + 1);
        tokens[0] = vm.envAddress("OD_USDG");
        for (uint256 i; i < gears.length; ++i) {
            tokens[i + 1] = gears[i];
        }

        Txs memory t;
        if (keccak256(bytes(mode)) == keccak256("seed")) {
            uint256[] memory amounts = new uint256[](tokens.length);
            amounts[0] = vm.envUint("OD_SEED_USDG_PER_GEAR") * gears.length;
            for (uint256 i = 1; i < tokens.length; ++i) {
                amounts[i] = vm.envUint("OD_SEED_GEAR_WAD");
            }
            t = seedTxs(address(helper), tokens, amounts);
            for (uint256 i; i < tokens.length; ++i) {
                uint256 bal = IERC20(tokens[i]).balanceOf(safe);
                if (bal < amounts[i]) console2.log("WARNING the Safe holds less than the seed of", tokens[i], bal);
            }
        } else if (keccak256(bytes(mode)) == keccak256("remove")) {
            (address[] memory held, uint256[] memory claims) = claimsOf(pm, safe, tokens);
            if (held.length == 0) {
                console2.log("HookSeedBatch: the Safe holds no ERC-6909 claim on these tokens; nothing to remove");
                return "";
            }
            t = removeTxs(pm, address(helper), held, claims);
        } else {
            revert("OD_HOOK_SEED_MODE must be seed or remove");
        }
        path = _write(string.concat(_network(), "-hook-", mode), t);
        console2.log("HookSeedBatch:", path);
    }

    /// @notice The Safe's non-zero ERC-6909 claims on `tokens` (id = uint160(token)).
    function claimsOf(address pm, address safe, address[] memory tokens)
        public
        view
        returns (address[] memory held, uint256[] memory claims)
    {
        uint256 n;
        uint256[] memory all = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            all[i] = IERC6909Like(pm).balanceOf(safe, uint256(uint160(tokens[i])));
            if (all[i] != 0) ++n;
        }
        held = new address[](n);
        claims = new uint256[](n);
        uint256 k;
        for (uint256 i; i < tokens.length; ++i) {
            if (all[i] == 0) continue;
            held[k] = tokens[i];
            claims[k++] = all[i];
        }
    }

    function seedTxs(address helper, address[] memory tokens, uint256[] memory amounts)
        public
        pure
        returns (Txs memory t)
    {
        t.to = new address[](tokens.length + 1);
        t.data = new bytes[](tokens.length + 1);
        for (uint256 i; i < tokens.length; ++i) {
            t.to[i] = tokens[i];
            t.data[i] = abi.encodeCall(IERC20.approve, (helper, amounts[i]));
        }
        t.to[tokens.length] = helper;
        t.data[tokens.length] = abi.encodeCall(ODHookSeed.seed, (tokens, amounts));
    }

    function removeTxs(address pm, address helper, address[] memory tokens, uint256[] memory claims)
        public
        pure
        returns (Txs memory t)
    {
        t.to = new address[](tokens.length + 1);
        t.data = new bytes[](tokens.length + 1);
        for (uint256 i; i < tokens.length; ++i) {
            t.to[i] = pm;
            t.data[i] = abi.encodeCall(IERC6909Like.approve, (helper, uint256(uint160(tokens[i])), claims[i]));
        }
        t.to[tokens.length] = helper;
        t.data[tokens.length] = abi.encodeCall(ODHookSeed.remove, (tokens, claims));
    }

    function _write(string memory name, Txs memory t) private returns (string memory path) {
        string memory dir = vm.envOr("OD_BATCH_DIR", string.concat(vm.projectRoot(), "/../.batches"));
        vm.createDir(dir, true);
        path = string.concat(dir, "/", name, ".json");
        string memory body = string.concat(
            '{"version": "1.0", "chainId": "',
            vm.toString(block.chainid),
            '", "meta": {"name": "',
            name,
            '", "description": "owner Safe, one batch (MultiSend): approvals then the helper call"}, "transactions": ['
        );
        for (uint256 i; i < t.to.length; ++i) {
            body = string.concat(
                body,
                i == 0 ? "" : ", ",
                '{"to": "',
                vm.toString(t.to[i]),
                '", "value": "0", "data": "',
                vm.toString(t.data[i]),
                '"}'
            );
        }
        vm.writeFile(path, string.concat(body, "]}\n"));
    }
}
