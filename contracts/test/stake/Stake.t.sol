// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {IODStake} from "overdrive/interfaces/IODStake.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockOvrd, MockPriceSource, MockSwapAdapter} from "../mocks/MockOvrd.sol";

contract StakeTest is ODTest {
    MockUSDG internal usdg;
    MockOvrd internal ovrd;
    MockPriceSource internal src;
    MockSwapAdapter internal adapter;
    ODStake internal stk;

    address internal admin = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal governor = makeAddr("governor");
    address internal backer = makeAddr("backer");
    address internal fees = makeAddr("fees");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdg = new MockUSDG();
        ovrd = new MockOvrd();
        src = new MockPriceSource();
        src.set(0.5e18, 0.5e18);
        adapter = new MockSwapAdapter(address(usdg), 0.5e18);
        stk = new ODStake(IERC20(address(ovrd)), IERC20(address(usdg)), admin, governor, backer);
        vm.startPrank(admin);
        stk.setSlashRoute(address(src), address(adapter), 3000, 300);
        stk.grantRole(stk.FEES_ROLE(), fees);
        stk.grantRole(ODRoles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            ovrd.mint(who[i], 1_000_000e18);
            vm.prank(who[i]);
            ovrd.approve(address(stk), type(uint256).max);
        }
        usdg.mint(fees, 1_000_000e6);
        vm.prank(fees);
        usdg.approve(address(stk), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return stk.stake(amount);
    }

    function _reward(uint256 amount) internal {
        vm.prank(fees);
        stk.notifyRewards(amount);
    }

    // ---- R6

    function test_UnstakeDelay() public {
        assertEq(_stake(alice, 1_000e18), 1_000e18, "1:1 before any slash");
        vm.prank(alice);
        stk.requestUnstake(400e18);
        (, uint64 readyAt) = stk.requests(alice);
        assertEq(readyAt, vm.getBlockTimestamp() + 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODStake.NotReady.selector, readyAt));
        stk.unstake();
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 before = ovrd.balanceOf(alice);
        vm.prank(alice);
        assertEq(stk.unstake(), 400e18);
        assertEq(ovrd.balanceOf(alice) - before, 400e18);
        assertEq(stk.stakeOf(alice), 600e18);
    }

    function test_PendingUnstakeSlashable() public {
        _stake(alice, 1_000e18);
        vm.prank(alice);
        stk.requestUnstake(1_000e18);
        vm.prank(governor);
        uint256 sent = stk.slash(97e6); // 200 OVRD at $0.50 less 3%
        assertEq(sent, 100e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(alice);
        uint256 out = stk.unstake();
        assertApproxEqAbs(out, 800e18, 1e6, "the pending stake took the loss");
    }

    // ---- R7

    function test_StreamedRewards() public {
        _stake(alice, 1_000e18);
        _reward(700e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertApproxEqAbs(stk.earned(alice), 100e6, 1);
        _stake(bob, 1_000e18);
        vm.warp(vm.getBlockTimestamp() + 6 days);
        assertApproxEqAbs(stk.earned(alice), 400e6, 2);
        assertApproxEqAbs(stk.earned(bob), 300e6, 2);
        vm.warp(vm.getBlockTimestamp() + 30 days); // stream ended
        vm.prank(alice);
        uint256 a = stk.claimRewards();
        vm.prank(bob);
        uint256 b = stk.claimRewards();
        assertLe(a + b, 700e6);
        assertApproxEqAbs(a + b, 700e6, 4);
    }

    function test_NoJustInTimeCapture() public {
        _stake(alice, 1_000_000e18);
        _reward(100e6);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        // bob deposits a large stake one block before the next notify and leaves right after
        _stake(bob, 1_000_000e18);
        _reward(10_000e6);
        vm.warp(vm.getBlockTimestamp() + 12);
        vm.prank(bob);
        stk.requestUnstake(1_000_000e18);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(bob);
        uint256 got = stk.claimRewards();
        assertLt(got, 10_000e6 / 10_000, "under 0.01% of the notified amount");
    }

    function test_RewardsWithNobodyStakedAreRestreamed() public {
        _reward(70e6);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _stake(alice, 1e18);
        _reward(0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertApproxEqAbs(stk.earned(alice), 70e6, 2);
    }

    function test_NotifyRewardsFeesOnly() public {
        bytes32 role = stk.FEES_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        stk.notifyRewards(1e6);
        // a donation is not streamed: only notified USDG counts
        usdg.mint(address(stk), 1_000e6);
        _stake(alice, 1e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(stk.earned(alice), 0);
    }

    // ---- R8

    function test_SlashOnlyCallers() public {
        _stake(alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(IODStake.NotSlasher.selector);
        stk.slash(1e6);
        vm.prank(admin);
        vm.expectRevert(IODStake.NotSlasher.selector);
        stk.slash(1e6);
        vm.prank(backer);
        assertGt(stk.slash(1e6), 0);
        vm.prank(governor);
        assertGt(stk.slash(1e6), 0);
        assertGt(usdg.balanceOf(backer), 0, "USDG goes to the caller");
    }

    function test_SlashProRata() public {
        _stake(alice, 1_000e18);
        _stake(bob, 3_000e18);
        vm.prank(bob);
        stk.requestUnstake(1_000e18);
        vm.prank(backer);
        uint256 sent = stk.slash(388e6); // 800 OVRD
        assertEq(sent, 400e6);
        assertApproxEqAbs(stk.stakeOf(alice), 800e18, 1e6);
        assertApproxEqAbs(stk.stakeOf(bob), 1_600e18, 1e6);
        assertApproxEqAbs(stk.assetsOf(1_000e18), 800e18, 1e6, "pending loses the same fraction");
        // new stakers enter at the post-slash price
        uint256 shares = _stake(carol, 800e18);
        assertApproxEqRel(shares, 1_000e18, 1e9);
    }

    function test_SlashNoRouteReturnsZero() public {
        _stake(alice, 1_000e18);
        // failing route
        adapter.setFail(true);
        vm.expectEmit(address(stk));
        emit IODStake.SlashFailed(10e6);
        vm.prank(governor);
        assertEq(stk.slash(10e6), 0);
        adapter.setFail(false);
        // TWAP unavailable, short return, spot off the TWAP
        src.setMode(1);
        vm.prank(governor);
        assertEq(stk.slash(10e6), 0);
        src.setMode(2);
        vm.prank(governor);
        assertEq(stk.slash(10e6), 0);
        src.setMode(0);
        src.set(0.5e18, 0.6e18);
        vm.prank(governor);
        assertEq(stk.slash(10e6), 0);
        src.set(0.5e18, 0.5e18);
        // route below the slippage floor
        adapter.setHaircut(500);
        vm.prank(governor);
        assertEq(stk.slash(10e6), 0);
        // no route at all
        vm.prank(admin);
        stk.setSlashRoute(address(0), address(0), 0, 300);
        vm.prank(governor);
        assertEq(stk.slash(10e6), 0);
        assertEq(stk.coverValueUsdg(), 0);
        assertEq(stk.stakeOf(alice), 1_000e18, "nothing taken");
    }

    function test_SlashCappedByStake() public {
        _stake(alice, 1_000e18);
        vm.prank(admin);
        stk.setCoverCap(1_000e6);
        assertEq(stk.coverValueUsdg(), 484_999_999, "value at TWAP less slippage, above the floor");
        vm.prank(governor);
        uint256 sent = stk.slash(1_000_000e6);
        assertLe(sent, 500e6);
        assertGe(sent, 485e6);
        assertEq(stk.totalAssets(), 1_000e6, "share-price floor kept");
        assertGt(stk.assetsOf(1e18), 0);
        vm.prank(governor);
        assertEq(stk.slash(1e6), 0, "nothing left to sell");
    }

    function testFuzz_SlashNeverReverts(uint96 stakeAmt, uint64 need, uint8 mode, uint16 haircut) public {
        uint256 s = bound(stakeAmt, 1e6, 1e24);
        _stake(alice, s);
        src.setMode(bound(mode, 0, 2));
        adapter.setHaircut(bound(haircut, 0, 9_999));
        uint256 before = stk.totalAssets();
        vm.prank(governor);
        uint256 sent = stk.slash(need);
        assertLe(sent, uint256(need) * 10_000 / 9_700 + 1, "at most the slippage allowance over");
        assertLe(stk.totalAssets(), before);
    }

    // ---- R9

    function test_VotingPowerWarmup() public {
        uint256 t0 = vm.getBlockTimestamp();
        _stake(alice, 100e18);
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 0);
        vm.warp(t0 + 7 days - 1);
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 0);
        vm.warp(t0 + 7 days);
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 100e18);
        // a fresh top-up does not count until it is warm
        vm.warp(t0 + 7 days + 1);
        _stake(alice, 50e18);
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 100e18);
        // moving stake out counts at once, and restaking it starts the warm-up again
        vm.prank(alice);
        stk.requestUnstake(150e18);
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 0);
        vm.prank(alice);
        stk.cancelUnstake();
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 0);
        uint256 t1 = vm.getBlockTimestamp();
        vm.warp(t1 + 7 days);
        assertEq(stk.votingPower(alice, vm.getBlockTimestamp()), 150e18);
        // history is kept
        assertEq(stk.votingPower(alice, t0 + 7 days), 100e18);
        vm.expectRevert(abi.encodeWithSelector(ODStake.FutureLookup.selector, vm.getBlockTimestamp() + 1));
        stk.votingPower(alice, vm.getBlockTimestamp() + 1);
    }

    /// No core contract reads stake beyond `feeDiscountOf` and `slash` (the vote never moves toll maths, NF or pricing).
    /// Mirrors `check_stake_usage` in scripts/ci-local.sh.
    function test_CoresUseOnlyDiscountAndSlash() public view {
        Vm.DirEntry[] memory entries = vm.readDir(string.concat(vm.projectRoot(), "/src"), 4);
        string[6] memory banned =
            [".votingPower(", ".coverValueUsdg(", ".stake(", ".requestUnstake(", ".unstake(", ".claimRewards("];
        uint256 checked;
        for (uint256 i; i < entries.length; ++i) {
            Vm.DirEntry memory e = entries[i];
            if (e.isDir || !_has(e.path, ".sol")) continue;
            if (_has(e.path, "/src/stake/") || _has(e.path, "/src/interfaces/")) continue;
            string memory body = vm.readFile(e.path);
            assertFalse(_has(body, "votingPower"), string.concat("votingPower read in ", e.path));
            bool usesStake = _has(body, "IODStake}") || _has(body, "IODStake(") || _has(body, "IODStake ")
                || _has(body, "IODStake;");
            if (!usesStake) continue;
            for (uint256 j; j < banned.length; ++j) {
                assertFalse(_has(body, banned[j]), string.concat(banned[j], " used in ", e.path));
            }
            ++checked;
        }
        checked; // zero today: the Minter (05b) and Backer (07) wire in later and are checked then
    }

    function _has(string memory s, string memory key) private pure returns (bool) {
        return vm.indexOf(s, key) != type(uint256).max;
    }

    // ---- R10

    function _tiers() internal {
        ODStake.Tier[] memory t = new ODStake.Tier[](3);
        t[0] = ODStake.Tier(1_000e18, 500);
        t[1] = ODStake.Tier(10_000e18, 1_000);
        t[2] = ODStake.Tier(100_000e18, 2_000);
        vm.prank(admin);
        stk.setTiers(t);
    }

    function test_DiscountTiers() public {
        assertEq(stk.feeDiscountOf(alice), 0, "no tiers");
        _tiers();
        _stake(alice, 999e18);
        assertEq(stk.feeDiscountOf(alice), 0);
        _stake(alice, 1e18);
        assertEq(stk.feeDiscountOf(alice), 500);
        _stake(bob, 50_000e18);
        assertEq(stk.feeDiscountOf(bob), 1_000);
        _stake(carol, 100_000e18);
        assertEq(stk.feeDiscountOf(carol), 2_000);
        // a pending unstake no longer earns the discount
        vm.prank(carol);
        stk.requestUnstake(100_000e18);
        assertEq(stk.feeDiscountOf(carol), 0);
        // bounds
        ODStake.Tier[] memory bad = new ODStake.Tier[](1);
        bad[0] = ODStake.Tier(1e18, 2_001);
        vm.prank(admin);
        vm.expectRevert(ODStake.InvalidParams.selector);
        stk.setTiers(bad);
        ODStake.Tier[] memory unsorted = new ODStake.Tier[](2);
        unsorted[0] = ODStake.Tier(2e18, 1);
        unsorted[1] = ODStake.Tier(1e18, 2);
        vm.prank(admin);
        vm.expectRevert(ODStake.InvalidParams.selector);
        stk.setTiers(unsorted);
    }

    function test_DiscountGasBound() public {
        ODStake.Tier[] memory t = new ODStake.Tier[](4);
        for (uint256 i; i < 4; ++i) {
            t[i] = ODStake.Tier(uint128((i + 1) * 1e24), uint16(100 * (i + 1)));
        }
        vm.prank(admin);
        stk.setTiers(t);
        _stake(alice, 1e18); // below every tier: the longest walk
        uint256 g = gasleft();
        uint16 d = stk.feeDiscountOf(alice);
        uint256 used = g - gasleft();
        assertEq(d, 0);
        assertLt(used, 30_000, "cheap enough for the minter's gas cap");
        // a staticcall with a 50k cap succeeds (the minter treats failure as 0)
        (bool ok,) = address(stk).staticcall{gas: 50_000}(abi.encodeCall(IODStake.feeDiscountOf, (alice)));
        assertTrue(ok);
    }

    // ---- pauses

    function test_TimelockUnpausesStake() public {
        _stake(alice, 1_000e18);
        _reward(70e6);
        vm.prank(alice);
        vm.expectRevert();
        stk.setDepositsPaused(true);
        vm.prank(guardian);
        stk.setDepositsPaused(true);
        vm.prank(bob);
        vm.expectRevert(ODStake.DepositsPaused.selector);
        stk.stake(1e18);
        // exits and claims are never paused
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.startPrank(alice);
        assertGt(stk.claimRewards(), 0);
        stk.requestUnstake(500e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(stk.unstake(), 500e18);
        vm.stopPrank();
        // the guardian cannot unpause
        bytes32 adminRole = stk.DEFAULT_ADMIN_ROLE();
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole)
        );
        stk.setDepositsPaused(false);
        vm.prank(admin);
        stk.setDepositsPaused(false);
        _stake(bob, 1e18);
    }
}
