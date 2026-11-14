// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

/// R10: the halted-sell queue.
contract QueueTest is SystemFixture {
    function _queue(address who, bytes32 id, uint256 tokens, uint256 minOut) internal returns (uint256 ticket) {
        vm.prank(who);
        ticket = minter.queueSell(id, tokens, minOut, who);
    }

    function test_QueueAnySession() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        _dropRef(TSLA);
        uint256 a = _queue(alice, sport, t / 4, 0);
        _session(Session.UNKNOWN);
        uint256 b = _queue(alice, sport, t / 4, 0);
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        uint256 c = _queue(alice, sport, t / 4, 0);
        vm.prank(admin);
        reg.setStatus(sport, GearStatusAlias.SELL_ONLY);
        uint256 d = _queue(alice, sport, t / 4, 0);
        assertEq(minter.ticketCount(), 4);
        assertEq(a + 1, b);
        assertEq(c + 1, d);
        assertEq(_token(sport).balanceOf(address(minter)), (t / 4) * 4, "escrowed in the minter");
    }

    function test_FillAtNextFreshPrice() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        _dropRef(TSLA);
        uint256 ticket = _queue(alice, sport, t, 0);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);
        // next fresh live reading
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _session(Session.OPEN);
        _refreshAll();
        // priced exactly as a live sell: compare with a live quote of the same tokens for the owner
        vm.prank(alice);
        uint256 want = minter.quote(sport, false, true, t).amountOut;
        uint256 before = usdg.balanceOf(alice);
        vm.prank(stranger);
        uint256 out = minter.fillQueued(ticket);
        assertEq(out, want);
        assertEq(usdg.balanceOf(alice) - before, out, "recipient paid");
        assertEq(_token(sport).totalSupply(), 0);
        (,,, uint256 left,) = minter.queuedSell(ticket);
        assertEq(left, 0);
    }

    function test_FillRespectsMin() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        uint256 ticket = _queue(alice, sport, t, 20_000e6);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);
        (,,, uint256 left,) = minter.queuedSell(ticket);
        assertEq(left, t, "ticket stays");
        // a failed payout also leaves it
        uint256 t2 = _buy(bob, sport, 1_000e6);
        uint256 ticket2 = _queue(bob, sport, t2, 0);
        usdg.setBlocked(bob, true);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket2));
        minter.fillQueued(ticket2);
        (,,, left,) = minter.queuedSell(ticket2);
        assertEq(left, t2);
    }

    function test_CancelAlwaysWorks() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        uint256 ticket = _queue(alice, sport, t, 0);
        stockOf[TSLA].setOraclePaused(true);
        guard.poke(TSLA);
        vm.prank(admin);
        reg.setStatus(sport, GearStatusAlias.SELL_ONLY);
        usdg.setPaused(true);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotTicketOwner.selector, ticket));
        minter.cancelQueued(ticket);
        vm.prank(alice);
        minter.cancelQueued(ticket);
        assertEq(_token(sport).balanceOf(alice), t, "tokens back");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotTicketOwner.selector, ticket));
        minter.cancelQueued(ticket); // once only
    }

    function test_StrangerCannotBlockOthers() public {
        uint256 ta = _buy(alice, sport, 10_000e6);
        uint256 tb = _buy(bob, sport, 10_000e6);
        uint256 a = _queue(alice, sport, ta, 0);
        uint256 s = _queue(bob, sport, tb, type(uint128).max); // unfillable ticket next to alice's
        vm.prank(stranger);
        vm.expectRevert();
        minter.cancelQueued(a);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, s));
        minter.fillQueued(s);
        assertGt(minter.fillQueued(a), 0, "alice's ticket fills regardless");
    }

    function test_EscrowStillCountsAsLiability() public {
        uint256 t = _buy(alice, sport, 10_000e6);
        uint256 supply = _token(sport).totalSupply();
        int256 net = gov.netTokens(sport);
        (, uint256 open) = gov.capOf(sport);
        _queue(alice, sport, t, 0);
        assertEq(_token(sport).totalSupply(), supply);
        assertEq(gov.netTokens(sport), net);
        (, uint256 open2) = gov.capOf(sport);
        assertEq(open2, open);
    }
}

import {GearStatus as GearStatusAlias} from "overdrive/interfaces/ODTypes.sol";
