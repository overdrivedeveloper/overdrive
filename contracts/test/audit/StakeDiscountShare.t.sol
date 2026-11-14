// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODStake} from "overdrive/stake/ODStake.sol";
import {MockOvrd} from "../mocks/MockOvrd.sol";
import {GearConfig} from "overdrive/interfaces/ODTypes.sol";

contract AnyDiscount {
    uint256 internal v;

    constructor(uint256 v_) {
        v = v_;
    }

    function feeDiscountOf(address) external view returns (uint256) {
        return v;
    }
}

/// M-1 (audit early pass): ODStake tiers are bps OF the spread (at most 20% off). The minter used to subtract the
/// tier as absolute bps, so a 500 tier (5% off) took a 30 bps spread to 0. Wired to the REAL ODStake here.
contract StakeDiscountShareTest is SystemFixture {
    ODStake internal stk;
    MockOvrd internal ovrd;

    /// These tests check the spread mechanics under the lag floor; the floor itself is test/audit/LagRoundTrip.t.sol.
    function setUp() public override {
        super.setUp();
        IODMinter.TradeParams memory p = minter.tradeParams();
        p.lagBandBps = 1; // floor 2 bps on SPORT, under every spread below
        _setTradeParams(p);
    }

    function _wireStake(uint16 tierBps) internal {
        ovrd = new MockOvrd();
        stk = new ODStake(IERC20(address(ovrd)), IERC20(address(usdg)), admin, address(gov), makeAddr("bk"));
        ODStake.Tier[] memory t = new ODStake.Tier[](1);
        t[0] = ODStake.Tier({minStake: 1_000e18, spreadDiscountBps: tierBps});
        vm.startPrank(admin);
        stk.setTiers(t);
        minter.setStake(address(stk));
        vm.stopPrank();
        ovrd.mint(alice, 1_000e18);
        vm.startPrank(alice);
        ovrd.approve(address(stk), type(uint256).max);
        stk.stake(1_000e18);
        vm.stopPrank();
    }

    function _spread(address who, bytes32 id) internal returns (uint16) {
        vm.prank(who);
        return minter.quote(id, true, true, 100e6).spreadBps;
    }

    /// The audit PoC, flipped: the 500 tier is 5% off a 30 bps spread (29 bps after the discount rounds down).
    function test_M1_FivePercentTierIsShareOfSpread() public {
        _wireStake(500);
        assertEq(stk.feeDiscountOf(alice), 500);
        uint16 base = _spread(bob, sport);
        uint16 got = _spread(alice, sport);
        assertGe(got, base - (base * 500) / 10_000, "at most 5% off");
        assertGt(got, 0, "never zero");
        assertLt(got, base + 1);
    }

    /// The largest tier ODStake allows (20%) leaves at least 80% of the spread on every gear.
    function test_M1_MaxTierLeavesEightyPercent() public {
        _wireStake(2_000);
        bytes32[5] memory ids = [cruise, sport, race, eco, reverse];
        for (uint256 i; i < 5; ++i) {
            uint256 base = _spread(bob, ids[i]);
            uint256 got = _spread(alice, ids[i]);
            assertGe(got * 10_000, base * 8_000, "<= 20% off");
            assertGt(got, 0);
        }
    }

    /// Property: for ANY value a stake contract returns (also above ODStake's own cap) and any listed base spread,
    /// the discounted spread stays within [80% of base, base] and above zero whenever base is above zero.
    function testFuzz_M1_DiscountIsBoundedShare(uint256 discount, uint16 baseBps) public {
        baseBps = uint16(bound(baseBps, reg.MIN_SPREAD_BPS(), reg.MAX_SPREAD_BPS()));
        GearConfig memory g = reg.gear(sport);
        vm.prank(admin);
        reg.setParams(sport, g.capUsdWad, baseBps);
        uint256 base = _spread(bob, sport);
        address any = address(new AnyDiscount(discount));
        vm.prank(admin);
        minter.setStake(any);
        uint256 got = _spread(alice, sport);
        assertLe(got, base);
        assertGe(got * 10_000, base * 8_000, "never more than 20% off");
        assertGt(got, 0, "never zero");
    }
}
