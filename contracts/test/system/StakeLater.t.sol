// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployFixture, DeployHarness} from "./DeployFixture.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";
import {SystemDeployer, ODDevToken} from "../../script/lib/SystemDeployer.sol";
import {DeployStake} from "../../script/DeployStake.s.sol";
import {TimelockBatch} from "../../script/ListGears.s.sol";
import {ODFees} from "overdrive/fees/ODFees.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODBacker} from "overdrive/backer/ODBacker.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {ODVolOracle} from "overdrive/oracle/ODVolOracle.sol";
import {ODGearRegistry} from "overdrive/gear/ODGearRegistry.sol";
import {VolPost} from "overdrive/interfaces/IODVolOracle.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";

/// Two-phase deploy: phase 1 with no $OVRD (external.ovrd zero, dev.ovrd false) deploys everything but ODStake, passes
/// the post-deploy checks and trades; phase 2 (DeployStake) adds the stake, and one timelock batch executed after the
/// 48 h delay wires it and opens deposits; the checks pass again with the stake wired.
contract StakeLaterTest is DeployFixture {
    DeployStake internal st;
    uint256 internal volKey;
    uint64 internal volNonce;
    address internal bob = makeAddr("bob");

    function setUp() public override {
        vm.warp(T0);
        ds = new DeployHarness();
        st = new DeployStake();
        _buildConfig();
        (address vs, uint256 k) = makeAddrAndKey("volSignerKeyed");
        volKey = k;
        cfg.roles.volSigner = vs;
        cfg.dev = SystemConfig.Dev(true, false, true); // test USDG and PoolManager, no $OVRD
        cfg.ext.ovrd = address(0);
        d = ds.deploy(cfg, deployer);
    }

    function _noFailures(string[] memory f, string memory what) internal {
        for (uint256 i; i < f.length; ++i) {
            emit log(f[i]);
        }
        assertEq(f.length, 0, what);
    }

    function _refresh() internal {
        for (uint256 i; i < cfg.markets.length; ++i) {
            bytes32 m = cfg.markets[i].id;
            uint256 pWad = m == ETH ? 3000e18 : 90000e18;
            feedOf[m].setRound(int256(pWad / 1e10), block.timestamp);
            pyth.setPrice(
                cfg.markets[i].cfg.pythId, int64(int256(pWad / 1e10)), uint64(pWad / 1e13), -8, block.timestamp
            );
            VolPost memory p = VolPost({
                market: m,
                sigmaBps: 3500,
                buyBlockFrom: 0,
                buyBlockTo: 0,
                validUntil: uint64(block.timestamp + 2 hours),
                nonce: ++volNonce
            });
            ODVolOracle vol = ODVolOracle(d.vol);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(volKey, vol.hashPost(p));
            vol.post(p, abi.encodePacked(r, s, v));
        }
        bytes32[] memory ms = new bytes32[](2);
        ms[0] = ETH;
        ms[1] = BTC;
        ODGovernor(d.governor).pokeRisk(ms);
    }

    function _seed() internal {
        ODDevToken usdg = ODDevToken(d.usdg);
        usdg.mint(ownerSafe, 1_000_000e6);
        vm.startPrank(ownerSafe);
        usdg.approve(d.governor, 1_000_000e6);
        ODGovernor(d.governor).deposit(1_000_000e6, ownerSafe);
        vm.stopPrank();
    }

    function _buySell(address who) internal {
        bytes32 id = ODGearRegistry(d.registry).idOf(ETH, bytes32(0), Gear.SPORT);
        ODDevToken(d.usdg).mint(who, 100e6);
        vm.startPrank(who);
        IERC20(d.usdg).approve(d.minter, type(uint256).max);
        uint256 tokens = ODMinter(d.minter).buy(id, 100e6, 0, who, uint64(block.timestamp));
        assertGt(tokens, 0, "buy");
        uint256 out = ODMinter(d.minter).sell(id, tokens, 0, who, uint64(block.timestamp));
        assertGt(out, 0, "sell");
        vm.stopPrank();
    }

    function test_PhaseOneHasNoStakeAndTrades() public {
        assertTrue(ds.stakeLater(cfg));
        assertEq(d.stake, address(0), "no stake");
        assertEq(d.ovrd, address(0), "no ovrd");
        ODFees f = ODFees(d.fees);
        assertEq(f.recipientOf(f.B_STAKERS()), treasury, "STAKERS addressed to the treasury");
        assertEq(ODMinter(d.minter).stake(), address(0));
        assertEq(ODBacker(d.backer).stake(), address(0));
        assertEq(ds.adminCores(d).length, 10);
        _noFailures(ds.checkSystem(cfg, d, deployer), "phase 1 checks pass");
        // the record round trip: ODStake is "" and reads back as none
        string memory j = ds.renderDeployment(cfg, d, deployer, "abc1234");
        assertEq(vm.parseJsonString(j, ".contracts.ODStake"), "");
        SystemDeployer.Deployed memory x = ds.readDeployment(j);
        assertEq(x.stake, address(0));
        _noFailures(ds.checkSystem(cfg, x, deployer), "checks pass on the re-read phase 1 file");
        _seed();
        _refresh();
        _buySell(bob);
    }

    function test_PhaseOneRecordedStakeWithoutOvrdFails() public {
        SystemDeployer.Deployed memory x = d;
        x.stake = makeAddr("ghostStake");
        assertGt(ds.checkSystem(cfg, x, deployer).length, 0, "half a stake record is refused");
    }

    function test_PhaseTwoDeploysWiresAndOpensDeposits() public {
        _seed();
        _refresh();
        _buySell(bob);
        ODDevToken ovrd = new ODDevToken("Test OVRD", "tOVRD", 18);
        string memory j1 = ds.renderDeployment(cfg, d, deployer, "abc1234");

        SystemDeployer.Deployed memory d2 = st.deploy(cfg, d, address(ovrd), deployer);
        ODStake stake = ODStake(d2.stake);
        assertTrue(stake.depositsPaused(), "deposits start paused");
        assertTrue(stake.hasRole(stake.FEES_ROLE(), d.fees));
        assertTrue(stake.hasRole(ODRoles.GUARDIAN_ROLE, guardianSafe));
        assertTrue(stake.hasRole(0x00, d.timelock));
        assertFalse(stake.hasRole(0x00, deployer));
        _noFailures(st.checkStakeDeployed(cfg, d2, deployer), "the new stake alone checks");
        assertGt(ds.checkSystem(cfg, d2, deployer).length, 0, "not wired before the batch");

        // the record: the empty entry is filled and reads back with ovrd from the stake
        string memory j2 = st.recordStake(j1, d2.stake);
        SystemDeployer.Deployed memory r = ds.readDeployment(j2);
        assertEq(r.stake, d2.stake);
        assertEq(r.ovrd, address(ovrd));
        vm.expectRevert(abi.encodeWithSelector(DeployStake.StakeRefused.selector, "no empty ODStake entry to fill"));
        st.recordStake(j2, d2.stake);
        vm.expectRevert(abi.encodeWithSelector(DeployStake.StakeRefused.selector, "a stake is already recorded"));
        st.deploy(cfg, r, address(ovrd), deployer);

        TimelockBatch.Batch memory b = st.stakeBatch(r);
        assertEq(b.targets.length, 4);
        TimelockController t = TimelockController(payable(d.timelock));
        vm.prank(ownerSafe);
        t.scheduleBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt, 172800);
        assertEq(st.batchId(b), t.hashOperationBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt));
        uint256 at = block.timestamp;
        vm.warp(at + 172799);
        vm.prank(ownerSafe);
        vm.expectRevert();
        t.executeBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);
        vm.warp(at + 172800);
        vm.prank(ownerSafe);
        t.executeBatch(b.targets, b.values, b.payloads, bytes32(0), b.salt);

        ODFees f = ODFees(d.fees);
        assertEq(f.recipientOf(f.B_STAKERS()), address(stake));
        assertEq(ODMinter(d.minter).stake(), address(stake));
        assertEq(ODBacker(d.backer).stake(), address(stake));
        assertFalse(stake.depositsPaused(), "the batch opened deposits");
        _refresh();
        _noFailures(ds.checkSystem(cfg, r, deployer), "phase 2 checks pass with the stake wired");

        ovrd.mint(bob, 10e18);
        vm.startPrank(bob);
        ovrd.approve(address(stake), 10e18);
        stake.stake(10e18);
        vm.stopPrank();
        assertEq(stake.stakeOf(bob), 10e18, "deposit works after the batch");
        _buySell(makeAddr("carol"));
    }

    function test_PhaseTwoRefusesNoOvrd() public {
        vm.expectRevert(
            abi.encodeWithSelector(DeployStake.StakeRefused.selector, "no $OVRD address (set OD_OVRD or external.ovrd)")
        );
        st.deploy(cfg, d, address(0), deployer);
    }

    function test_DevOvrdStillRefusedOnMainnet() public {
        SystemConfig.Config memory c = _cfg();
        c.network = "mainnet";
        c.chainId = 4663;
        c.dev = SystemConfig.Dev(false, true, false);
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(SystemConfig.ConfigRefused.selector, "test tokens on mainnet"));
        ds.validateConfig(c);
    }
}
