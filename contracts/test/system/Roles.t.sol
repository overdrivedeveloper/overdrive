// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployFixture} from "./DeployFixture.sol";
import {SettleGearBatch} from "../../script/ListGears.s.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {ODPaymaster} from "overdrive/agent/ODPaymaster.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {Gear, GearConfig, GearStatus} from "overdrive/interfaces/ODTypes.sol";

/// Rules R2 to R4 on a full DeploySystem run: admin is the timelock only, the timelock is the owner Safe's with 48 h,
/// the guardian only reduces risk, and every pause comes off only through the timelock after 172800 s.
contract RolesTest is DeployFixture {
    bytes32 internal ethSport;

    function setUp() public override {
        super.setUp();
        ethSport = ODGearRegistry(d.registry).idOf(ETH, bytes32(0), Gear.SPORT);
    }

    function _cores() internal view returns (address[] memory) {
        return ds.adminCores(_d());
    }

    function test_AdminIsTimelockOnly() public view {
        address[] memory cores = _cores();
        address[6] memory others = [deployer, ownerSafe, guardianSafe, keeper, hedger, volSigner];
        for (uint256 i; i < cores.length; ++i) {
            assertTrue(IAccessControl(cores[i]).hasRole(0x00, d.timelock), "timelock admin");
            for (uint256 k; k < others.length; ++k) {
                assertFalse(IAccessControl(cores[i]).hasRole(0x00, others[k]), "no other admin");
            }
        }
        assertEq(ODPaymaster(payable(d.paymaster)).owner(), d.timelock, "paymaster owner");
        assertEq(ODPaymaster(payable(d.paymaster)).pendingOwner(), address(0), "no pending owner");
    }

    function test_TimelockConfig() public view {
        TimelockController t = _timelock();
        assertEq(t.getMinDelay(), 172800);
        assertTrue(t.hasRole(t.PROPOSER_ROLE(), ownerSafe));
        assertTrue(t.hasRole(t.CANCELLER_ROLE(), ownerSafe));
        assertTrue(t.hasRole(t.EXECUTOR_ROLE(), ownerSafe));
        assertFalse(t.hasRole(t.EXECUTOR_ROLE(), address(0)), "executor not open");
        assertFalse(t.hasRole(0x00, deployer));
        assertFalse(t.hasRole(t.PROPOSER_ROLE(), guardianSafe));
    }

    function test_GuardianDistinct() public {
        address[7] memory guarded = [d.guard, d.vol, d.registry, d.governor, d.minter, d.backer, d.stake];
        for (uint256 i; i < guarded.length; ++i) {
            assertTrue(IAccessControl(guarded[i]).hasRole(ODRoles.GUARDIAN_ROLE, guardianSafe));
            assertFalse(IAccessControl(guarded[i]).hasRole(ODRoles.GUARDIAN_ROLE, ownerSafe));
            assertFalse(IAccessControl(guarded[i]).hasRole(ODRoles.GUARDIAN_ROLE, keeper));
            assertFalse(IAccessControl(guarded[i]).hasRole(ODRoles.GUARDIAN_ROLE, hedger));
        }
        SystemConfig.Config memory c = _cfg();
        c.roles.guardianSafe = ownerSafe;
        vm.expectRevert(
            abi.encodeWithSelector(
                SystemConfig.ConfigRefused.selector, "guardian must differ from the owner Safe and the bots"
            )
        );
        ds.validateConfig(c);
        c.roles.guardianSafe = keeper;
        vm.expectRevert();
        ds.validateConfig(c);
    }

    function test_BotsNotAdmins() public view {
        assertTrue(IAccessControl(d.governor).hasRole(ODRoles.HEDGER_ROLE, hedger));
        assertTrue(IAccessControl(d.marketHours).hasRole(ODRoles.KEEPER_ROLE, keeper));
        address[] memory cores = _cores();
        for (uint256 i; i < cores.length; ++i) {
            assertFalse(IAccessControl(cores[i]).hasRole(0x00, keeper));
            assertFalse(IAccessControl(cores[i]).hasRole(0x00, hedger));
            assertFalse(IAccessControl(cores[i]).hasRole(ODRoles.HEDGER_ROLE, ownerSafe));
            assertFalse(IAccessControl(cores[i]).hasRole(ODRoles.KEEPER_ROLE, ownerSafe));
            assertFalse(IAccessControl(cores[i]).hasRole(ODRoles.HEDGER_ROLE, guardianSafe));
        }
    }

    function test_DeployerHasNoRole() public view {
        address[] memory cores = _cores();
        bytes32[5] memory roles =
            [bytes32(0x00), ODRoles.GUARDIAN_ROLE, ODRoles.KEEPER_ROLE, ODRoles.HEDGER_ROLE, ODRoles.LIQUIDATOR_ROLE];
        for (uint256 i; i < cores.length; ++i) {
            for (uint256 k; k < roles.length; ++k) {
                assertFalse(IAccessControl(cores[i]).hasRole(roles[k], deployer));
            }
        }
        assertFalse(IAccessControl(d.stake).hasRole(ODStake(d.stake).FEES_ROLE(), deployer));
        TimelockController t = _timelock();
        assertFalse(t.hasRole(t.PROPOSER_ROLE(), deployer));
        assertFalse(t.hasRole(t.EXECUTOR_ROLE(), deployer));
        assertFalse(t.hasRole(t.CANCELLER_ROLE(), deployer));
    }

    /// D25: the minter holds no registry status role; settlement is one timelock batch (settleGear then SETTLED).
    function test_SettleBatchViaTimelock() public {
        assertFalse(IAccessControl(d.registry).hasRole(0x00, d.minter));
        assertFalse(IAccessControl(d.registry).hasRole(ODRoles.GUARDIAN_ROLE, d.minter));
        SettleGearBatch sb = new SettleGearBatch();
        SettleGearBatch.Batch memory b = sb.settleBatch(_d(), ethSport);
        TimelockController t = _timelock();
        vm.prank(ownerSafe);
        t.scheduleBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt, 172800);
        // the ETH feed stops: settlement needs the market halted for settleAfterHalt (30 days), well past the 48 h delay
        vm.warp(block.timestamp + 32 days);
        vm.prank(ownerSafe);
        t.executeBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);
        assertEq(uint8(ODGearRegistry(d.registry).gear(ethSport).status), uint8(GearStatus.SETTLED));
        assertGt(ODMinter(d.minter).settledValue(ethSport), 0);
    }

    struct Case {
        address target;
        bytes lowers;
        bytes raises;
    }

    /// R3 (D14): every guardian-callable function, risk-lowering arguments pass, risk-raising arguments revert.
    function test_GuardianOnlyReducesRisk() public {
        GearConfig memory g = ODGearRegistry(d.registry).gear(ethSport);
        (uint16 up, uint32 lead) = ODBacker(d.backer).uplift();
        Case[] memory cs = new Case[](11);
        cs[0] = Case(
            d.guard,
            abi.encodeCall(ODOracleGuard.setBuysPaused, (ETH, true)),
            abi.encodeCall(ODOracleGuard.setBuysPaused, (ETH, false))
        );
        cs[1] = Case(
            d.governor,
            abi.encodeCall(ODGovernor.setBuysPaused, (true)),
            abi.encodeCall(ODGovernor.setBuysPaused, (false))
        );
        cs[2] = Case(
            d.backer, abi.encodeCall(ODBacker.setMintPaused, (true)), abi.encodeCall(ODBacker.setMintPaused, (false))
        );
        cs[3] = Case(
            d.backer,
            abi.encodeCall(ODBacker.setUplift, (up + 100, lead)),
            abi.encodeCall(ODBacker.setUplift, (up, lead))
        );
        cs[4] = Case(
            d.registry,
            abi.encodeCall(ODGearRegistry.setParams, (ethSport, g.capUsdWad / 2, g.spreadBps)),
            abi.encodeCall(ODGearRegistry.setParams, (ethSport, g.capUsdWad, g.spreadBps))
        );
        cs[5] = Case(
            d.registry,
            abi.encodeCall(ODGearRegistry.setParams, (ethSport, g.capUsdWad / 2, g.spreadBps + 10)),
            abi.encodeCall(ODGearRegistry.setParams, (ethSport, g.capUsdWad / 2, g.spreadBps))
        );
        cs[6] = Case(
            d.registry,
            abi.encodeCall(ODGearRegistry.setStatus, (ethSport, GearStatus.BUYS_PAUSED)),
            abi.encodeCall(ODGearRegistry.setStatus, (ethSport, GearStatus.LISTED))
        );
        cs[7] = Case(
            d.registry,
            abi.encodeCall(ODGearRegistry.setStatus, (ethSport, GearStatus.SELL_ONLY)),
            abi.encodeCall(ODGearRegistry.setStatus, (ethSport, GearStatus.SETTLED))
        );
        cs[8] = Case(
            d.vol, abi.encodeCall(ODVolOracle.revokeSigner, ()), abi.encodeCall(ODVolOracle.setSigner, (volSigner))
        );
        cs[9] = Case(
            d.stake,
            abi.encodeCall(ODStake.setDepositsPaused, (true)),
            abi.encodeCall(ODStake.setDepositsPaused, (false))
        );
        cs[10] = Case(
            d.paymaster, abi.encodeCall(ODPaymaster.setPaused, (true)), abi.encodeCall(ODPaymaster.setPaused, (false))
        );
        for (uint256 i; i < cs.length; ++i) {
            vm.prank(guardianSafe);
            (bool ok,) = cs[i].target.call(cs[i].lowers);
            assertTrue(ok, string.concat("guardian lowers risk, case ", vm.toString(i)));
            vm.prank(guardianSafe);
            (ok,) = cs[i].target.call(cs[i].raises);
            assertFalse(ok, string.concat("guardian raises risk, case ", vm.toString(i)));
        }
    }

    /// R4: every pause from 02a to 10, paused by the guardian, comes off only through the real timelock after 48 h.
    function test_EveryPauseUnpausesViaTimelock() public {
        vm.startPrank(guardianSafe);
        ODOracleGuard(d.guard).setBuysPaused(ETH, true);
        ODGovernor(d.governor).setBuysPaused(true);
        ODGearRegistry(d.registry).setStatus(ethSport, GearStatus.BUYS_PAUSED);
        ODVolOracle(d.vol).revokeSigner();
        ODStake(d.stake).setDepositsPaused(true);
        ODPaymaster(payable(d.paymaster)).setPaused(true);
        vm.stopPrank();
        assertTrue(ODBacker(d.backer).mintPaused(), "backers deploy closed (D10)");

        vm.recordLogs();
        _viaTimelock(d.guard, abi.encodeCall(ODOracleGuard.setBuysPaused, (ETH, false)));
        assertTrue(_unpauseLogged(d.guard, keccak256("BuysPausedSet(bytes32,bool,bytes32)"), 0), "oracle pause off");
        vm.recordLogs();
        _viaTimelock(d.governor, abi.encodeCall(ODGovernor.setBuysPaused, (false)));
        assertTrue(_unpauseLogged(d.governor, keccak256("BuysPausedSet(bool)"), 0), "governor pause off");
        _viaTimelock(d.backer, abi.encodeCall(ODBacker.setMintPaused, (false)));
        assertFalse(ODBacker(d.backer).mintPaused(), "backer mint pause off");
        _viaTimelock(d.registry, abi.encodeCall(ODGearRegistry.setStatus, (ethSport, GearStatus.LISTED)));
        assertEq(uint8(ODGearRegistry(d.registry).gear(ethSport).status), uint8(GearStatus.LISTED), "gear relisted");
        _viaTimelock(d.vol, abi.encodeCall(ODVolOracle.setSigner, (volSigner)));
        assertEq(ODVolOracle(d.vol).signer(), volSigner, "vol signer back");
        _viaTimelock(d.stake, abi.encodeCall(ODStake.setDepositsPaused, (false)));
        assertFalse(ODStake(d.stake).depositsPaused(), "stake deposits open");
        _viaTimelock(d.paymaster, abi.encodeCall(ODPaymaster.setPaused, (false)));
        assertFalse(ODPaymaster(payable(d.paymaster)).paused(), "paymaster open");
    }

    /// True when `src` emitted `topic` with `false` as its first non-indexed bool (data word `word`) or as topic 2.
    function _unpauseLogged(address src, bytes32 topic, uint256 word) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != src || logs[i].topics[0] != topic) continue;
            if (logs[i].data.length >= 32 * (word + 1)) {
                uint256 v;
                bytes memory dt = logs[i].data;
                assembly {
                    v := mload(add(add(dt, 32), mul(word, 32)))
                }
                if (v == 0) return true;
            } else if (logs[i].topics.length > 2 && logs[i].topics[2] == bytes32(0)) {
                return true;
            }
        }
        return false;
    }
}
