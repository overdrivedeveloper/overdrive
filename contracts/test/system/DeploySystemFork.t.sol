// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {ForkPin} from "../utils/ForkPin.sol";
import {DeploySystem} from "../../script/DeploySystem.s.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";

/// Rule R7, fork half: DeploySystem with the committed script/config/fork.json on a fork of Robinhood Chain mainnet
/// (REAL USDG, PoolManager, CreateX, feeds, Stock Tokens, v3 pools). The hook goes through CreateX at the address
/// mined for the deployer. ETH and BTC read ready once their feed and Pyth are mocked fresh (Pyth on 4663 is stale),
/// so their four gears list; the stock gears wait for the ListGears batch. PostDeployCheck passes. The fork keeps
/// chain id 4663, so the test arms the guard (flag and file) the way the owner would; nothing leaves the test EVM.
contract DeploySystemForkTest is ODTest {
    DeploySystem internal ds;
    address internal deployer = makeAddr("forkDeployer");

    function setUp() public {
        if (bytes(vm.envOr("RHC_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        ForkPin.select(vm.envString("RHC_RPC_URL"));
        ds = new DeploySystem();
    }

    function _mockFresh(SystemConfig.Config memory c, bytes32 m, uint256 answer8) internal {
        for (uint256 i; i < c.markets.length; ++i) {
            if (c.markets[i].id != m) continue;
            uint256 t = block.timestamp;
            vm.mockCall(
                c.markets[i].cfg.feed,
                abi.encodeWithSignature("latestRoundData()"),
                abi.encode(uint80(7), int256(answer8), t, t, uint80(7))
            );
            vm.mockCall(
                c.ext.pythCore,
                abi.encodeWithSignature("getPriceUnsafe(bytes32)", c.markets[i].cfg.pythId),
                abi.encode(int64(int256(answer8)), uint64(answer8 / 1000), int32(-8), t)
            );
        }
    }

    function test_ForkDeployPassesPostDeployCheck() public {
        SystemConfig.Config memory c =
            ds.parseConfig(vm.readFile(string.concat(vm.projectRoot(), "/script/config/fork.json")));
        _mockFresh(c, "ETH", 3000e8);
        _mockFresh(c, "BTC", 90000e8);
        string memory flag = string.concat(vm.projectRoot(), "/out/od-fork-test-armed.flag");
        vm.writeFile(flag, "test\n");
        vm.setEnv("OVERDRIVE_ALLOW_REAL_DEPLOY", "1");
        vm.setEnv("OVERDRIVE_ALLOW_FILE", flag);
        SystemDeployer.Deployed memory d = ds.deploy(c, deployer);
        vm.setEnv("OVERDRIVE_ALLOW_REAL_DEPLOY", "");
        // CreateX's address rule for the deployer-permissioned salt: the first matching salt is the one deployed
        bytes memory init = ds.hookInitCode(d.poolManager, d.minter, d.registry, d.usdg, deployer);
        bytes32 h = keccak256(init);
        bool found;
        for (uint256 i; i < ODHookMiner.MAX_LOOP && !found; ++i) {
            bytes32 salt = bytes32(uint256(uint160(deployer)) << 96 | i);
            bytes32 guarded = keccak256(abi.encode(bytes32(uint256(uint160(deployer))), salt));
            address a = ODHookMiner.computeAddress(c.ext.createX, guarded, h);
            if (uint160(a) & 0x3FFF == ODHookMiner.FLAGS) {
                assertEq(a, d.hook, "hook at the first mined CreateX address");
                found = true;
            }
        }
        assertTrue(found, "salt found");
        assertEq(d.usdg, c.ext.usdg, "real USDG");
        assertEq(ODGearRegistry(d.registry).gearCount(), 4, "ETH and BTC gears listed, stocks deferred");
        string[] memory f = ds.checkSystem(c, d, deployer);
        for (uint256 i; i < f.length; ++i) {
            emit log(f[i]);
        }
        assertEq(f.length, 0, "post-deploy check passes on the fork");
    }
}
