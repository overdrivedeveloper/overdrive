// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {DeployFixture} from "./DeployFixture.sol";
import {ODDevToken} from "../../script/lib/SystemDeployer.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {IODMarketHours, Holiday} from "overdrive/interfaces/IODMarketHours.sol";

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

    /// ORC-7: Robinhood Chain has no sequencer uptime feed, so a guard built with one is not the reviewed deploy.
    function test_FailsOnSequencerFeedOnRhc() public {
        SystemConfig.Config memory c = _cfg();
        c.chainId = 4663;
        SystemDeployer.Deployed memory x = _d();
        x.guard = address(new ODOracleGuard(address(this), address(this), d.marketHours, address(0), address(0xFEED)));
        _expectWith(c, x, "SEQUENCER");
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

    /// R8-1: the deploy writes the config's holiday list, and the check names a list that differs or is empty.
    function test_HolidaysWrittenAtDeploy_FailsWhenCleared() public {
        Holiday[] memory h = IODMarketHours(d.marketHours).holidays();
        assertEq(h.length, 3, "the config list is on chain");
        assertEq(h[0].day, 20_783);
        assertEq(h[1].closeMinute, 780);
        vm.prank(d.timelock);
        IODMarketHours(d.marketHours).setHolidays(new Holiday[](0));
        _expect("HOLIDAYS");
    }

    /// R8-1: a list that has ended fails the check, and a config with no list, or an ended one, cannot deploy.
    function test_HolidaysEndedOrMissing() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(uint256(21_176) * 1 days + 1);
        _expect("HOLIDAYS");
        SystemConfig.Config memory c = _cfg();
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "holiday list is in the past"));
        ds.validateConfig(c);
        vm.warp(t0);
        c.holidays = new Holiday[](0);
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "holiday list empty or over 64"));
        ds.validateConfig(c);
        c = _cfg();
        c.holidays[1].day = c.holidays[0].day;
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "holidays not ascending"));
        ds.validateConfig(c);
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

    /// I5-2 / I4-4: a market with no reference source (no v3 pool and no Pyth id) fails the check.
    function test_FailsOnMissingReference() public {
        assertFalse(_has(_run(_cfg(), _d()), "REFERENCE"), "control: every market has a reference source");
        SystemConfig.Config memory c = _cfg();
        c.markets[0].cfg.twapPool = address(0);
        c.markets[0].cfg.pythId = bytes32(0);
        _expectWith(c, _d(), "REFERENCE");
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

    /// F8: a wound-down Governor (zero shares) holding rounding dust or USDG its own books account for is not a seed.
    function test_WoundDownDustIsNotSeeded() public {
        ODDevToken(d.usdg).mint(d.governor, 11);
        assertFalse(_has(_run(_cfg(), _d()), "SEEDED"), "11 units of dust");
        ODDevToken(d.usdg).mint(d.governor, 50e6);
        vm.mockCall(d.governor, abi.encodeWithSignature("freeCash()"), abi.encode(uint256(50e6)));
        assertFalse(_has(_run(_cfg(), _d()), "SEEDED"), "booked as free cash");
        vm.clearMockedCalls();
        _expect("SEEDED");
    }

    function test_FailsOnGearCap() public {
        vm.mockCall(d.registry, abi.encodeWithSignature("MAX_GEARS()"), abi.encode(uint8(33)));
        _expect("GEAR_CAP");
    }
}
