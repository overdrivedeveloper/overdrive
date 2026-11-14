// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {GearConfig, GearStatus, Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {ODIndex} from "overdrive/math/ODIndex.sol";

/// R11: settlement after a long halt or out of domain.
contract SettleTest is SystemFixture {
    function _halt() internal {
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        assertGt(guard.haltedSince(TSLA), 0);
    }

    function _settle(bytes32 id) internal {
        vm.prank(admin);
        minter.settleGear(id);
        vm.prank(admin); // the same timelock batch marks the registry
        reg.setStatus(id, GearStatus.SETTLED);
    }

    function test_SettleAfter30DayHalt() public {
        _buy(alice, sport, 10_000e6);
        _halt();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        _settle(sport);
        GearConfig memory c = reg.gear(sport);
        (uint256 want,) =
            ODIndex.value(c.gear, 250e18, c.p0, minter.normState(sport).nf, c.unitWad, Math.Rounding.Floor);
        assertEq(minter.settledValue(sport), want, "value at last good, floor");
        (uint256 v,) = minter.valuePerToken(sport);
        assertEq(v, want);
        // NF stops
        uint256 nf = minter.normState(sport).nf;
        vm.warp(vm.getBlockTimestamp() + 10 days);
        minter.accrue(sport);
        assertEq(minter.normState(sport).nf, nf);
        assertEq(minter.tollPerDay(sport), 0);
    }

    function test_SettleOutOfDomain() public {
        _buy(alice, sport, 10_000e6);
        uint256 p = _p(TSLA);
        while (p * 1e18 / reg.gear(sport).p0 >= ODIndex.MIN_R) {
            p = p * 6 / 10;
            _price(TSLA, p);
        }
        _settle(sport);
        assertGt(minter.settledValue(sport), 0);
    }

    function test_SettledSellNoSpread() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _halt();
        vm.warp(vm.getBlockTimestamp() + 31 days);
        _settle(sport);
        uint256 v = minter.settledValue(sport);
        _session(Session.CLOSED); // any session, no reference
        uint256 out = _sell(alice, sport, t / 2);
        assertEq(out, Math.mulDiv(t / 2, v, 1e30), "settled value, no spread");
        assertEq(minter.quote(sport, false, true, 1e18).spreadBps, 0);
        // buys are refused for good
        _fund(bob, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.BuysClosed.selector, sport, bytes32("SETTLED")));
        minter.buy(sport, 1_000e6, 0, bob, uint64(vm.getBlockTimestamp()));
        // queued tickets fill at the settled value too
        vm.prank(alice);
        uint256 ticket = minter.queueSell(sport, t / 2, 0, alice);
        assertEq(minter.fillQueued(ticket), Math.mulDiv(t / 2, v, 1e30));
    }

    function test_NotSettleableEarly() public {
        _buy(alice, sport, 10_000e6);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotSettleable.selector, sport));
        minter.settleGear(sport);
        _halt();
        vm.warp(vm.getBlockTimestamp() + 29 days);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotSettleable.selector, sport));
        minter.settleGear(sport);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(stranger);
        vm.expectRevert();
        minter.settleGear(sport);
    }
}
