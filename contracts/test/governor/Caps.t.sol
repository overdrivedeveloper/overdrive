// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// R9, R10: buys pass caps, stress and every pause; sells never do. buyBlock and canPay predict onBuy and pay (QUOTE-1).
contract CapsTest is GovernorFixture {
    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
    }

    function _expectBuyRevert(bytes32 id, uint256 tokens, bytes memory err) internal {
        usdg.mint(alice, tokens / 1e12);
        vm.prank(alice);
        usdg.approve(address(minter), tokens / 1e12);
        vm.expectRevert(err);
        minter.buy(id, alice, alice, tokens, tokens / 1e12, 0);
    }

    function test_CapUsesMinOfStaticAndEquity() public {
        bytes32 small = _list(TSLA, NONE, Gear.SPORT, 10_000e18);
        _buy(small, 10_000e18, 10_000e6);
        _expectBuyRevert(
            small, 1e18, abi.encodeWithSelector(IODGovernor.CapExceeded.selector, small, 10_001e18, 10_000e18)
        );
        // Static cap 1,000,000 but equity 100,000 x 50% = 50,000 binds (ECO keeps the stress low).
        bytes32 eco = _list(NVDA, NONE, Gear.ECO, 1_000_000e18);
        (uint256 cap,) = gov.capOf(eco);
        assertEq(cap, 50_000e18);
        _buy(eco, 50_000e18, 50_000e6);
        _expectBuyRevert(eco, 1e18, abi.encodeWithSelector(IODGovernor.CapExceeded.selector, eco, 50_001e18, 50_000e18));
    }

    function test_StressBudgetBlocksBuy() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 20_000e18, 20_000e6); // 11,250 <= 15,000
        // 30,000 x (1.25^2 - 1) = 16,875 > 15% x 100,000
        _expectBuyRevert(id, 10_000e18, abi.encodeWithSelector(IODGovernor.StressBudget.selector, 16_875e18, 15_000e18));
        assertEq(gov.buyBlock(id, 10_000e18), bytes32("STRESS"));
        assertEq(gov.buyBlock(id, 1_000e18), bytes32(0));
    }

    function test_HedgeStalePausesBuysOnly() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 1_000e18, 1_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 500e18, 0, uint64(vm.getBlockTimestamp()));
        vm.warp(vm.getBlockTimestamp() + 2 hours + 1);
        _poke();
        assertTrue(gov.hedgeStale());
        _expectBuyRevert(id, 1e18, abi.encodeWithSelector(IODGovernor.BuysPaused.selector, bytes32("HEDGE_STALE")));
        assertTrue(_sell(id, 100e18, 100e6));
        vm.prank(hedger);
        gov.postHedge(TSLA, 500e18, 0, uint64(vm.getBlockTimestamp()));
        _buy(id, 1e18, 1e6);
        // Retiring the market (delta 0, equity 0) means no hedge to be stale.
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 0, uint64(vm.getBlockTimestamp()));
        vm.warp(vm.getBlockTimestamp() + 3 hours);
        _poke();
        assertFalse(gov.hedgeStale());
    }

    function test_EquityStalePausesBuysOnly() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 1_000e18, 1_000e6);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        _expectBuyRevert(id, 1e18, abi.encodeWithSelector(IODGovernor.BuysPaused.selector, bytes32("EQUITY_STALE")));
        assertTrue(_sell(id, 100e18, 100e6));
        gov.pokeRisk(new bytes32[](0)); // anyone
        _buy(id, 1e18, 1e6);
    }

    function test_GuardianPausesBuys() public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        vm.prank(guardian);
        gov.setBuysPaused(true);
        _expectBuyRevert(id, 1e18, abi.encodeWithSelector(IODGovernor.BuysPaused.selector, bytes32("PAUSED")));
        assertEq(gov.buyBlock(id, 1e18), bytes32("PAUSED"));
    }

    function testFuzz_SellIgnoresEveryPause(uint8 flags) public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        _buy(id, 20_000e18, 20_000e6);
        if (flags & 1 != 0) {
            vm.prank(guardian);
            gov.setBuysPaused(true);
        }
        if (flags & 2 != 0) {
            vm.prank(hedger);
            gov.postHedge(TSLA, 1e18, 0, uint64(vm.getBlockTimestamp()));
            vm.warp(vm.getBlockTimestamp() + 3 hours);
            _poke();
        }
        if (flags & 4 != 0) {
            guard.set(TSLA, 353.6e18, 353.6e18);
            _poke(); // drawdown tripped
        }
        if (flags & 8 != 0) {
            vm.prank(admin);
            reg.setParams(id, 1e18, 30); // static cap far under open value
        }
        if (flags & 16 != 0) {
            IODGovernor.Params memory p = gov.getParams();
            p.stressBudgetBps = 1;
            _setParams(p);
        }
        if (flags & 32 != 0) vm.warp(vm.getBlockTimestamp() + 2 hours); // equity stale
        uint256 before = usdg.balanceOf(alice);
        assertTrue(_sell(id, 1_000e18, 1_000e6));
        assertEq(usdg.balanceOf(alice) - before, 1_000e6);
    }

    /// QUOTE-1: buyBlock(gear, tokens) == 0 exactly when the buy goes through.
    function testFuzz_BuyBlockPredictsOnBuy(uint256 tokens, uint256 priceT) public {
        bytes32 id = _list(TSLA, NONE, Gear.SPORT, 30_000e18);
        tokens = bound(tokens, 1e18, 60_000e18);
        guard.set(TSLA, bound(priceT, 200e18, 300e18), 250e18);
        bytes32 why = gov.buyBlock(id, tokens);
        uint256 usdgIn = tokens / 1e12;
        usdg.mint(alice, usdgIn);
        vm.prank(alice);
        usdg.approve(address(minter), usdgIn);
        try minter.buy(id, alice, alice, tokens, usdgIn, 0) {
            assertEq(why, bytes32(0));
        } catch {
            assertTrue(why != bytes32(0));
        }
    }

    /// QUOTE-1: canPay(x) is true exactly when pay(x) pays (healthy USDG).
    function testFuzz_CanPayPredictsPay(uint256 x, uint256 reserve, uint256 insured) public {
        reserve = bound(reserve, 0, 50_000e6);
        insured = bound(insured, 0, 50_000e6);
        x = bound(x, 0, 250_000e6);
        if (reserve != 0) {
            vm.prank(keeper);
            gov.moveToExitReserve(reserve);
        }
        usdg.mint(address(this), insured);
        usdg.approve(address(ins), insured);
        ins.fund(insured);
        bool can = gov.canPay(x);
        assertEq(minter.payOut(alice, x), can);
    }
}
