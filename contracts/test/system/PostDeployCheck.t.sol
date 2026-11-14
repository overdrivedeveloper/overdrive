// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {DeployFixture} from "./DeployFixture.sol";
import {ODDevToken} from "../../script/lib/SystemDeployer.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";

/// Rule R8: PostDeployCheck passes on a fresh deploy and names each broken check.
contract PostDeployCheckTest is DeployFixture {
    function _run(SystemConfig.Config memory c, SystemDeployer.Deployed memory x)
        internal
        view
        returns (string[] memory)
    {
        return ds.checkSystem(c, x, deployer);
    }

    function _has(string[] memory f, string memory tag) internal pure returns (bool) {
        bytes memory t = bytes(string.concat(tag, ": "));
        for (uint256 i; i < f.length; ++i) {
            bytes memory s = bytes(f[i]);
            if (s.length < t.length) continue;
            bool ok = true;
            for (uint256 k; k < t.length; ++k) {
                if (s[k] != t[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _expect(string memory tag) internal view {
        _expectWith(_cfg(), _d(), tag);
    }

    function _expectWith(SystemConfig.Config memory c, SystemDeployer.Deployed memory x, string memory tag)
        internal
        view
    {
        string[] memory f = _run(c, x);
        assertTrue(_has(f, tag), string.concat("expected a ", tag, " failure"));
    }

    function test_PassesOnFreshDeploy() public {
        string[] memory f = _run(_cfg(), _d());
        for (uint256 i; i < f.length; ++i) {
            emit log(f[i]);
        }
        assertEq(f.length, 0, "fresh deploy passes");
        assertEq(ODGearRegistry(d.registry).gearCount(), 4, "four gears listed at deploy");
    }

    function test_FailsOnWrongChain() public {
        SystemConfig.Config memory c = _cfg();
        c.network = "testnet";
        c.chainId = 46630;
        _expectWith(c, _d(), "CHAIN");
    }

    function test_FailsOnMissingCode() public {
        vm.etch(d.agentRouter, "");
        _expect("CODE");
    }

    function test_FailsOnWiringMismatch() public {
        SystemDeployer.Deployed memory x = _d();
        x.insurance = d.fees; // has code, wrong pointer
        _expectWith(_cfg(), x, "WIRING");
    }

    function test_FailsOnRole() public {
        vm.prank(d.timelock);
        IAccessControl(d.registry).grantRole(0x00, deployer);
        _expect("ROLE");
    }

    function test_FailsOnTimelockDelay() public {
        vm.prank(d.timelock);
        _timelock().updateDelay(3600);
        _expect("DELAY");
    }

    function test_FailsOnHookFlags() public {
        SystemDeployer.Deployed memory x = _d();
        x.hook = d.fees;
        _expectWith(_cfg(), x, "HOOK_FLAGS");
    }

    function test_FailsOnPoolNotInitialised() public {
        bytes32 id = ODGearRegistry(d.registry).gearIdAt(0);
        vm.mockCall(d.hook, abi.encodeCall(ODHook.poolIdOf, (id)), abi.encode(bytes32(uint256(1))));
        _expect("POOL");
    }

    function test_FailsOnFeedWithoutAggregator() public {
        vm.mockCallRevert(address(feedOf[ETH]), abi.encodeWithSignature("aggregator()"), "");
        _expect("FEED");
    }

    function test_FailsOnMarketConfig() public {
        SystemConfig.Config memory c = _cfg();
        c.markets[0].cfg.refBandBps += 1;
        _expectWith(c, _d(), "MARKET_CONFIG");
    }

    function test_FailsOnPoolCardinality() public {
        SystemConfig.Config memory c = _cfg();
        c.markets[1].cfg.twapPool = d.fees; // no v3 observations at all
        _expectWith(c, _d(), "ORC-CARD");
    }

    function test_FailsOnCapAboveLaunch() public {
        SystemConfig.Config memory c = _cfg();
        c.gears[0].capUsdWad = c.gears[0].capUsdWad / 2;
        _expectWith(c, _d(), "CAP");
    }

    function test_FailsOnSpreadBelowLaunch() public {
        SystemConfig.Config memory c = _cfg();
        c.gears[1].spreadBps = c.gears[1].spreadBps + 5;
        _expectWith(c, _d(), "CAP");
    }

    function test_FailsOnSeededByTransfer() public {
        ODDevToken(d.usdg).mint(d.governor, 1_000e6);
        _expect("SEEDED");
    }

    function test_FailsOnGearCap() public {
        vm.mockCall(d.registry, abi.encodeWithSignature("MAX_GEARS()"), abi.encode(uint8(33)));
        _expect("GEAR_CAP");
    }
}
