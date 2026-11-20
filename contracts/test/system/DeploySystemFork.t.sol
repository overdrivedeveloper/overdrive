// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {ForkPin} from "../utils/ForkPin.sol";
import {DeploySystem} from "../../script/DeploySystem.s.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployStake} from "../../script/DeployStake.s.sol";
import {TimelockBatch} from "../../script/ListGears.s.sol";
import {ODDevToken} from "../../script/lib/SystemDeployer.sol";
import {ListGears} from "../../script/ListGears.s.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// The two-phase fork test arms under its own variable names, so it never races the other test on the process env.
contract StakeLaterForkDeploySystem is DeploySystem {
    function _armFlagEnv() internal pure override returns (string memory) {
        return "OD_TEST_ARM_STAKE_LATER";
    }

    function _armFileEnv() internal pure override returns (string memory) {
        return "OD_TEST_ARM_STAKE_LATER_FILE";
    }
}

/// The tiny exit reserve fork test arms under its own names too (forge runs tests in parallel on one process env).
contract TinyReserveForkDeploySystem is DeploySystem {
    function _armFlagEnv() internal pure override returns (string memory) {
        return "OD_TEST_ARM_TINY_RESERVE";
    }

    function _armFileEnv() internal pure override returns (string memory) {
        return "OD_TEST_ARM_TINY_RESERVE_FILE";
    }
}

contract StakeLaterForkDeployStake is DeployStake {
    function _armFlagEnv() internal pure override returns (string memory) {
        return "OD_TEST_ARM_STAKE_LATER";
    }

    function _armFileEnv() internal pure override returns (string memory) {
        return "OD_TEST_ARM_STAKE_LATER_FILE";
    }
}

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

    /// The two-phase mainnet path on the fork: no $OVRD (phase 1) passes the checks; DeployStake plus its timelock
    /// batch after 48 h (phase 2) pass them again with the stake wired and deposits open.
    function test_ForkDeployWithoutOvrdThenStake() public {
        SystemConfig.Config memory c =
            ds.parseConfig(vm.readFile(string.concat(vm.projectRoot(), "/script/config/fork.json")));
        c.dev.ovrd = false;
        c.ext.ovrd = address(0);
        _mockFresh(c, "ETH", 3000e8);
        _mockFresh(c, "BTC", 90000e8);
        string memory flag = string.concat(vm.projectRoot(), "/out/od-fork-stake-later-armed.flag");
        vm.writeFile(flag, "test\n");
        vm.setEnv("OD_TEST_ARM_STAKE_LATER", "1");
        vm.setEnv("OD_TEST_ARM_STAKE_LATER_FILE", flag);
        SystemDeployer.Deployed memory d = new StakeLaterForkDeploySystem().deploy(c, deployer);
        assertEq(d.stake, address(0), "phase 1 has no stake");
        string[] memory f = ds.checkSystem(c, d, deployer);
        for (uint256 i; i < f.length; ++i) {
            emit log(f[i]);
        }
        assertEq(f.length, 0, "phase 1 checks pass on the fork");
        DeployStake st = new StakeLaterForkDeployStake();
        d = st.deploy(c, d, address(new ODDevToken("Test OVRD", "tOVRD", 18)), deployer);
        vm.setEnv("OD_TEST_ARM_STAKE_LATER", "");
        assertEq(st.checkStakeDeployed(c, d, deployer).length, 0, "stake alone checks");
        TimelockBatch.Batch memory b = st.stakeBatch(d);
        TimelockController t = TimelockController(payable(d.timelock));
        vm.prank(c.roles.ownerSafe);
        t.scheduleBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt, c.minDelay);
        vm.warp(block.timestamp + c.minDelay);
        vm.prank(c.roles.ownerSafe);
        t.executeBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);
        _mockFresh(c, "ETH", 3000e8);
        _mockFresh(c, "BTC", 90000e8);
        f = ds.checkSystem(c, d, deployer);
        for (uint256 i; i < f.length; ++i) {
            emit log(f[i]);
        }
        assertEq(f.length, 0, "phase 2 checks pass on the fork");
    }

    /// D-tiny-reserve on the fork: the list-gears batch built with mainnet.json's governorParams sets the exit reserve
    /// minimum through the real timelock; with no open interest the floor is 100 USDG and every other param is kept.
    function test_ForkListGearsBatchSetsTinyExitReserve() public {
        SystemConfig.Config memory c =
            ds.parseConfig(vm.readFile(string.concat(vm.projectRoot(), "/script/config/fork.json")));
        SystemConfig.Config memory m =
            ds.parseConfig(vm.readFile(string.concat(vm.projectRoot(), "/script/config/mainnet.json")));
        c.minExitReserveUsdg = m.minExitReserveUsdg;
        _mockFresh(c, "ETH", 3000e8);
        _mockFresh(c, "BTC", 90000e8);
        string memory flag = string.concat(vm.projectRoot(), "/out/od-fork-tiny-reserve-armed.flag");
        vm.writeFile(flag, "test\n");
        vm.setEnv("OD_TEST_ARM_TINY_RESERVE", "1");
        vm.setEnv("OD_TEST_ARM_TINY_RESERVE_FILE", flag);
        SystemDeployer.Deployed memory d = new TinyReserveForkDeploySystem().deploy(c, deployer);
        vm.setEnv("OD_TEST_ARM_TINY_RESERVE", "");
        IODGovernor g = IODGovernor(d.governor);
        IODGovernor.Params memory before = g.getParams();
        // the stock gears wait for their markets; the batch here carries only what is ready plus setParams
        SystemConfig.GearCfg[] memory ready = new SystemConfig.GearCfg[](4);
        uint256 n;
        for (uint256 i; i < c.gears.length; ++i) {
            if (c.gears[i].marketA == "ETH" || c.gears[i].marketA == "BTC") ready[n++] = c.gears[i];
        }
        assertEq(n, 4);
        c.gears = ready;
        ListGears lg = new ListGears();
        TimelockBatch.Batch memory b = lg.listBatch(c, d);
        assertEq(b.targets.length, 1, "only setParams: the crypto gears are listed");
        assertEq(b.targets[0], d.governor);
        TimelockController t = TimelockController(payable(d.timelock));
        vm.prank(c.roles.ownerSafe);
        t.scheduleBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt, c.minDelay);
        vm.warp(block.timestamp + c.minDelay);
        vm.prank(c.roles.ownerSafe);
        t.executeBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);
        IODGovernor.Params memory got = g.getParams();
        assertEq(got.minExitReserveUsdg, 100e6);
        before.minExitReserveUsdg = 100e6;
        assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(before)), "every other param unchanged");
        assertEq(g.exitReserveFloor(), 100e6, "100 USDG floor with zero open interest");
    }
}
