// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ODTest} from "../utils/ODTest.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockPyth} from "../mocks/MockPyth.sol";
import {MockAggregatorImpl} from "../mocks/OracleMocks.sol";
import {DeploySystem} from "../../script/DeploySystem.s.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer} from "../../script/lib/SystemDeployer.sol";
import {Gear, MarketConfig} from "overdrive/interfaces/ODTypes.sol";
import {Holiday} from "overdrive/interfaces/IODMarketHours.sol";

/// Exposes the deploy without its handoff (a run that stopped half way).
contract DeployHarness is DeploySystem {
    function deployNoHandoff(Config memory c, address deployer) external returns (Deployed memory d) {
        validateConfig(c);
        vm.startBroadcast(deployer);
        d = _deployAll(c, deployer);
        vm.stopBroadcast();
    }
}

/// A local deploy of the real system (plain EVM, no fork): test USDG and OVRD, a v4 PoolManager, the standard
/// CREATE2 deployer for the hook, and two 24/7 markets (ETH, BTC) on mock Chainlink feeds and a mock Pyth, so the
/// four launch gears list at deploy time. Roles are distinct named addresses.
abstract contract DeployFixture is ODTest {
    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant BTC = "BTC";
    uint256 internal constant T0 = 1_800_000_000;

    address internal deployer = makeAddr("deployer");
    address internal ownerSafe = makeAddr("ownerSafe");
    address internal guardianSafe = makeAddr("guardianSafe");
    address internal keeper = makeAddr("keeper");
    address internal hedger = makeAddr("hedger");
    address internal volSigner = makeAddr("volSigner");
    address internal pmSigner = makeAddr("paymasterSigner");
    address internal treasury = makeAddr("treasury");

    DeployHarness internal ds;
    MockPyth internal pyth;
    SystemConfig.Config internal cfg;
    SystemDeployer.Deployed internal d;
    mapping(bytes32 => MockAggregator) internal feedOf;

    function setUp() public virtual {
        vm.warp(T0);
        ds = new DeployHarness();
        _buildConfig();
        d = ds.deploy(cfg, deployer);
    }

    function _buildConfig() internal {
        pyth = new MockPyth();
        address impl = address(new MockAggregatorImpl());
        cfg.network = "anvil";
        cfg.chainId = block.chainid;
        cfg.minDelay = 172800;
        cfg.roles = SystemConfig.Roles(ownerSafe, guardianSafe, keeper, hedger, volSigner, pmSigner, treasury);
        cfg.ext.pythCore = address(pyth);
        cfg.ext.entryPoint = makeAddr("entryPoint");
        cfg.dev = SystemConfig.Dev(true, true, true);
        cfg.paymaster = SystemConfig.PaymasterCfg(0.01 ether, 0.05 ether, 1 ether);
        cfg.holidays.push(Holiday({day: 20_783, closeMinute: 0})); // Thanksgiving 2026
        cfg.holidays.push(Holiday({day: 20_784, closeMinute: 780})); // the 13:00 close after it
        cfg.holidays.push(Holiday({day: 21_176, closeMinute: 0})); // 2027-12-24
        _addMarket(ETH, 3000e18, 2, impl);
        _addMarket(BTC, 90000e18, 2, impl);
        _addGear(ETH, Gear.CRUISE, 5_000_000, 40);
        _addGear(ETH, Gear.SPORT, 5_000_000, 40);
        _addGear(BTC, Gear.CRUISE, 5_000_000, 40);
        _addGear(BTC, Gear.SPORT, 5_000_000, 40);
    }

    function _addMarket(bytes32 m, uint256 pWad, uint8 group, address impl) internal {
        MockAggregator f = new MockAggregator(8, int256(pWad / 1e10));
        f.setAggregator(impl);
        feedOf[m] = f;
        bytes32 pid = keccak256(abi.encode("pyth", m));
        pyth.setPrice(pid, int64(int256(pWad / 1e10)), uint64(pWad / 1e13), -8, block.timestamp);
        MarketConfig memory c;
        c.feed = address(f);
        c.multiplierEmbedded = true;
        c.pythMultiplierEmbedded = true;
        c.alwaysOpen = true;
        c.pythId = pid;
        c.maxAgeOpen = 26 hours;
        c.maxAgeExtended = 26 hours;
        c.maxAgeClosed = 5 days;
        c.refMaxAge = 1 hours;
        c.twapWindow = 30 minutes;
        c.refBandBps = 200;
        c.continuityBps = 1500;
        c.enabled = true;
        cfg.markets.push(SystemConfig.MarketCfg(m, m == ETH ? "ETH" : "BTC", true, group, 3000, 20000, c));
    }

    function _addGear(bytes32 m, Gear g, uint256 capUsd, uint16 spread) internal {
        cfg.gears.push(SystemConfig.GearCfg(m, bytes32(0), g, uint128(capUsd * 1e18), spread, 1e18));
    }

    function _cfg() internal view returns (SystemConfig.Config memory) {
        return cfg;
    }

    function _d() internal view returns (SystemDeployer.Deployed memory) {
        return d;
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(d.timelock));
    }

    /// Schedules `data` on `target` through the real timelock as the owner Safe, refuses execution at 172799 s and
    /// executes at 172800 s.
    function _viaTimelock(address target, bytes memory data) internal {
        TimelockController t = _timelock();
        bytes32 salt = keccak256(abi.encode(target, data, block.timestamp));
        vm.prank(ownerSafe);
        t.schedule(target, 0, data, bytes32(0), salt, 172800);
        uint256 at = block.timestamp;
        vm.warp(at + 172799);
        vm.prank(ownerSafe);
        vm.expectRevert();
        t.execute(target, 0, data, bytes32(0), salt);
        vm.warp(at + 172800);
        vm.prank(ownerSafe);
        t.execute(target, 0, data, bytes32(0), salt);
    }
}
