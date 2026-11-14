// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackerFixture} from "./BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {GearStatus, Session} from "overdrive/interfaces/ODTypes.sol";

/// R7 repay is never blocked; repay with USDG buys the tokens back from the Governor.
contract BackerRepayTest is BackerFixture {
    function test_RepayAnySession() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 400e18, false);
        IERC20 tok = _token(sport);
        vm.prank(alice);
        tok.transfer(bob, 100e18);
        Session[4] memory ss = [Session.EXTENDED, Session.CLOSED, Session.UNKNOWN, Session.HALTED];
        for (uint256 i; i < 4; ++i) {
            _session(ss[i]);
            vm.prank(alice);
            backer.repay(id, 50e18);
        }
        // anyone may repay for a vault, with their own tokens only
        vm.prank(bob);
        backer.repay(id, 100e18);
        assertEq(_debt(id), 100e18);
        assertEq(gov.backerDebt(sport), 100e18);
        assertEq(_token(sport).balanceOf(bob), 0);
        assertEq(_token(sport).balanceOf(alice), 100e18);
        // repaying more than the debt repays the debt only
        vm.prank(alice);
        backer.repay(id, 1_000e18);
        assertEq(_debt(id), 0);
        assertEq(_token(sport).balanceOf(alice), 0);
    }

    function test_RepayUnderEveryPause() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 400e18, false);
        vm.startPrank(guardian);
        backer.setMintPaused(true);
        gov.setBuysPaused(true);
        guard.setBuysPaused(TSLA, true);
        reg.setStatus(sport, GearStatus.SELL_ONLY);
        vm.stopPrank();
        _session(Session.CLOSED);
        backer.harnessSeal(id); // in a sealed batch, before execution
        (,,,, uint256 b) = backer.vault(id);
        assertGt(b, 0);
        vm.prank(alice);
        backer.repay(id, 400e18);
        assertEq(_debt(id), 0);
        assertEq(gov.backerDebt(sport), 0);
    }

    function test_RepayWithUsdgPricing() public {
        uint256 id = _open(alice, sport, 1_000e6);
        uint256 proceeds = _mint(alice, id, 400e18, true);
        uint256 cash0 = gov.freeCash();
        uint256 v = _valueAt(sport, 250e18, Math.Rounding.Ceil);
        // the SPORT lag floor (51 bps at the 50 bps band, M-4) is above the 30 bps base spread
        uint256 price = Math.mulDiv(v, 10_000 + 51, 10_000, Math.Rounding.Ceil);
        uint256 expected = Math.mulDiv(100e18, price, 1e30, Math.Rounding.Ceil);
        vm.prank(alice);
        vm.expectPartialRevert(IODBacker.Slippage.selector);
        backer.repayWithUsdg(id, 100e18, expected - 1);
        vm.prank(alice);
        uint256 cost = backer.repayWithUsdg(id, 100e18, expected);
        assertEq(cost, expected);
        assertGt(cost, 100e6, "buy price above value");
        assertEq(_coll(id), 1_000e6 + proceeds - cost);
        assertEq(_debt(id), 300e18);
        assertEq(gov.backerDebt(sport), 300e18);
        assertEq(gov.freeCash(), cash0 + cost);
        assertEq(gov.netTokens(sport), -300e18);
    }

    function test_RepayWithUsdgNeedsLive() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 400e18, true);
        _session(Session.CLOSED);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("CLOSED")));
        backer.repayWithUsdg(id, 100e18, type(uint256).max);
        // tokens still work
        _session(Session.OPEN);
        _buy(alice, sport, 200e6);
        _session(Session.CLOSED);
        vm.prank(alice);
        backer.repay(id, 100e18);
        assertEq(_debt(id), 300e18);
    }
}
