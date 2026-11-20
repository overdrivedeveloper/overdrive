// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployFixture} from "./DeployFixture.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {ListGears} from "../../script/ListGears.s.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// DeploySystem on a plain EVM (rule R7 local half), the config files, the gear cap, no proxies (R6), the
/// deployments json round trip, and the ListGears batch through the real timelock.
contract DeploySystemTest is DeployFixture {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; // not-a-key: ERC-1967 slot

    function _all() internal view returns (address[] memory a) {
        address[] memory c = ds.adminCores(_d());
        a = new address[](c.length + 3);
        for (uint256 i; i < c.length; ++i) {
            a[i] = c[i];
        }
        a[c.length] = d.paymaster;
        a[c.length + 1] = d.agentRouter;
        a[c.length + 2] = d.factory;
    }

    function test_DeploysLocally() public view {
        assertEq(ODGearRegistry(d.registry).gearCount(), 4);
        assertEq(uint160(d.hook) & 0x3FFF, ODHookMiner.FLAGS, "mined hook flags");
    }

    function test_NoProxies() public view {
        address[] memory a = _all();
        bytes4[3] memory sel = [bytes4(0x3659cfe6), bytes4(0x4f1ef286), bytes4(0x52d1902d)]; // upgradeTo, upgradeToAndCall, proxiableUUID
        for (uint256 i; i < a.length; ++i) {
            assertEq(vm.load(a[i], IMPL_SLOT), bytes32(0), "ERC-1967 slot empty");
            bytes memory code = a[i].code;
            for (uint256 s; s < sel.length; ++s) {
                assertFalse(_hasPush4(code, sel[s]), "upgrade selector in bytecode");
            }
        }
    }

    /// PUSH4 <selector> appears in a dispatcher; any match is a fail.
    function _hasPush4(bytes memory code, bytes4 s) internal pure returns (bool) {
        if (code.length < 5) return false;
        for (uint256 i; i + 4 < code.length; ++i) {
            if (
                code[i] == 0x63 && code[i + 1] == s[0] && code[i + 2] == s[1] && code[i + 3] == s[2]
                    && code[i + 4] == s[3]
            ) {
                return true;
            }
        }
        return false;
    }

    function test_DeploymentJsonRoundTrip() public view {
        string memory j = ds.renderDeployment(_cfg(), _d(), deployer, "abc1234");
        SystemDeployer.Deployed memory x = ds.readDeployment(j);
        assertEq(x.governor, d.governor);
        assertEq(x.hook, d.hook);
        assertEq(x.timelock, d.timelock);
        assertEq(x.ovrd, d.ovrd);
        assertEq(vm.parseJsonUint(j, ".admin.minDelaySec"), 172800);
        assertEq(vm.parseJsonString(j, ".gears[1].gear"), "SPORT");
        assertEq(ds.checkSystem(_cfg(), x, deployer).length, 0, "checks pass on the re-read file");
    }

    function test_CommittedConfigsParse() public {
        string[4] memory nets = ["mainnet", "testnet", "fork", "anvil"];
        for (uint256 i; i < nets.length; ++i) {
            SystemConfig.Config memory c =
                ds.parseConfig(vm.readFile(string.concat(vm.projectRoot(), "/script/config/", nets[i], ".json")));
            assertEq(c.minDelay, 172800);
            assertLe(c.gears.length, 32);
        }
        SystemConfig.Config memory m =
            ds.parseConfig(vm.readFile(string.concat(vm.projectRoot(), "/script/config/mainnet.json")));
        assertEq(m.gears.length, 10, "D10 launch set: SPORT and CRUISE on five names");
        assertEq(m.markets.length, 5);
        assertFalse(m.seedApproved, "hook seed figures wait for the owner");
        vm.chainId(4663);
        // Roles are filled from the live Safes and bot wallets; $OVRD comes from the launchpad on launch day (D11), so
        // mainnet deploys in two phases: the system now without ODStake, the stake later (DeployStake).
        assertTrue(ds.stakeLater(m), "mainnet waits for $OVRD");
        ds.validateConfig(m);
    }

    function test_PlaceholderRefusesDeploy() public {
        SystemConfig.Config memory c = _cfg();
        c.roles.keeper = address(0);
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "placeholder role address"));
        ds.deploy(c, deployer);
    }

    function test_TestTokensRefusedOnMainnet() public {
        SystemConfig.Config memory c = _cfg();
        c.network = "mainnet";
        c.chainId = 4663;
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "test tokens on mainnet"));
        ds.validateConfig(c);
    }

    function test_GearCapRefused() public {
        SystemConfig.Config memory c = _cfg();
        SystemConfig.GearCfg[] memory gs = new SystemConfig.GearCfg[](33);
        for (uint256 i; i < 33; ++i) {
            gs[i] = c.gears[0];
        }
        c.gears = gs;
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "more gears than MAX_GEARS"));
        ds.validateConfig(c);
        SystemConfig.GearCfg[] memory per = new SystemConfig.GearCfg[](13);
        for (uint256 i; i < 13; ++i) {
            per[i] = c.gears[0];
        }
        c.gears = per;
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "more than 12 gears on one market"));
        ds.validateConfig(c);
    }

    /// A gear whose market was not ready at deploy is listed by the ListGears batch through the timelock.
    function test_ListGearsBatchListsDeferredGear() public {
        _addGear(ETH, Gear.ECO, 5_000_000, 40);
        ListGears lg = new ListGears();
        ListGears.Batch memory b = lg.listBatch(_cfg(), _d());
        assertEq(b.targets.length, 2, "one listing and one pool init");
        vm.prank(ownerSafe);
        _timelock().scheduleBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt, 172800);
        vm.warp(block.timestamp + 172800);
        feedOf[ETH].push(3000e8);
        pyth.setPrice(keccak256(abi.encode("pyth", ETH)), 3000e8, 3e5, -8, block.timestamp);
        vm.prank(ownerSafe);
        _timelock().executeBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);
        assertEq(ODGearRegistry(d.registry).gearCount(), 5);
        assertEq(ds.checkSystem(_cfg(), _d(), deployer).length, 0, "checks pass after the batch");
    }
}
