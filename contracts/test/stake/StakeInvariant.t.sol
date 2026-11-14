// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockOvrd, MockPriceSource, MockSwapAdapter} from "../mocks/MockOvrd.sol";

contract StakeHandler is Test {
    ODStake public stk;
    MockOvrd public ovrd;
    MockUSDG public usdg;
    MockSwapAdapter public adapter;
    address public governor;
    address public fees;
    address[3] public actors;

    constructor(ODStake s, MockOvrd o, MockUSDG u, MockSwapAdapter a, address g, address f) {
        (stk, ovrd, usdg, adapter, governor, fees) = (s, o, u, a, g, f);
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2")];
        for (uint256 i; i < 3; ++i) {
            vm.prank(actors[i]);
            ovrd.approve(address(s), type(uint256).max);
        }
        vm.prank(f);
        usdg.approve(address(s), type(uint256).max);
    }

    function stake(uint256 who, uint256 amount) external {
        address a = actors[who % 3];
        amount = bound(amount, 1e6, 1e24);
        ovrd.mint(a, amount);
        vm.prank(a);
        try stk.stake(amount) {} catch {}
    }

    function requestUnstake(uint256 who, uint256 shares) external {
        address a = actors[who % 3];
        uint256 have = stk.sharesOf(a);
        if (have == 0) return;
        vm.prank(a);
        stk.requestUnstake(bound(shares, 1, have));
    }

    function unstake(uint256 who) external {
        address a = actors[who % 3];
        (uint256 s, uint64 readyAt) = stk.requests(a);
        if (s == 0) return;
        if (vm.getBlockTimestamp() < readyAt) vm.warp(readyAt);
        vm.prank(a);
        stk.unstake();
    }

    function claim(uint256 who) external {
        vm.prank(actors[who % 3]);
        stk.claimRewards();
    }

    function notify(uint256 amount) external {
        amount = bound(amount, 0, 1e12);
        usdg.mint(fees, amount);
        vm.prank(fees);
        stk.notifyRewards(amount);
    }

    function slash(uint256 need, uint256 haircut) external {
        adapter.setHaircut(bound(haircut, 0, 600));
        vm.prank(governor);
        stk.slash(bound(need, 0, 1e13));
    }

    function warp(uint256 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 3 days));
    }
}

contract StakeInvariantTest is ODTest {
    ODStake internal stk;
    MockOvrd internal ovrd;
    MockUSDG internal usdg;
    StakeHandler internal h;

    function setUp() public {
        usdg = new MockUSDG();
        ovrd = new MockOvrd();
        MockPriceSource src = new MockPriceSource();
        src.set(0.5e18, 0.5e18);
        MockSwapAdapter adapter = new MockSwapAdapter(address(usdg), 0.5e18);
        address admin = makeAddr("timelock");
        address governor = makeAddr("governor");
        address fees = makeAddr("fees");
        stk = new ODStake(IERC20(address(ovrd)), IERC20(address(usdg)), admin, governor, makeAddr("backer"));
        vm.startPrank(admin);
        stk.setSlashRoute(address(src), address(adapter), 3000, 300);
        stk.grantRole(stk.FEES_ROLE(), fees);
        vm.stopPrank();
        h = new StakeHandler(stk, ovrd, usdg, adapter, governor, fees);
        targetContract(address(h));
    }

    /// The tracked stake is always held (a slash or exit never leaves shares unbacked).
    function invariant_AssetsHeld() public view {
        assertGe(ovrd.balanceOf(address(stk)), stk.totalAssets());
    }

    /// Every account's claimable rewards are covered by the USDG held.
    function invariant_RewardsSolvent() public view {
        uint256 owed;
        for (uint256 i; i < 3; ++i) {
            owed += stk.earned(h.actors(i));
        }
        assertGe(usdg.balanceOf(address(stk)), owed);
    }

    /// Share bookkeeping adds up and the share price never reaches zero while shares exist.
    function invariant_SharesAddUp() public view {
        uint256 active;
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            address a = h.actors(i);
            (uint256 req,) = stk.requests(a);
            active += stk.sharesOf(a);
            total += stk.sharesOf(a) + req;
        }
        assertEq(active, stk.activeShares());
        assertEq(total, stk.totalShares());
        if (stk.totalShares() != 0) assertGt(stk.totalAssets(), 0);
    }
}
