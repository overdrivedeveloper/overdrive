// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackerFixture} from "./BackerFixture.sol";
import {ODBackerMath} from "overdrive/backer/ODBackerMath.sol";

/// R9 the toll shrinks the debt; 10% of the toll the debt earned is charged to the vault for ODFees.
contract BackerTollTest is BackerFixture {
    function _cum(bytes32 g) internal view returns (uint256) {
        return minter.normState(g).cumTollPerTokenWad;
    }

    function test_BackerFeeTenPercentOfToll() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 400e18, false);
        uint256 snap = _cum(sport);
        (, uint256 dv0,,,) = backer.health(id);
        _warpFresh(3 days);
        uint256 cumNow = _cum(sport);
        assertGt(cumNow, snap, "positive toll on SPORT");
        uint256 earned = Math.mulDiv(400e18, cumNow - snap, 1e18) / 1e12;
        uint256 expected = Math.mulDiv(400e18, cumNow - snap, 1e18) * 1000 / 1e16;
        assertEq(backer.tollFeeOwed(id), expected);
        assertApproxEqAbs(expected, earned / 10, 1);
        assertGt(expected, 0);
        // the debt's value fell with NF at an unchanged price
        (, uint256 dv1,,,) = backer.health(id);
        assertLt(dv1, dv0);
        uint256 feesBal = usdg.balanceOf(address(fees));
        usdg.mint(bob, 1e6);
        vm.startPrank(bob);
        usdg.approve(address(backer), 1e6);
        backer.deposit(id, 1e6);
        vm.stopPrank();
        assertEq(_coll(id), 1_000e6 + 1e6 - expected);
        assertEq(usdg.balanceOf(address(fees)), feesBal + expected, "sent to ODFees");
        assertEq(backer.pendingFees(), 0);
        assertEq(backer.tollFeeOwed(id), 0);
        assertEq(usdg.balanceOf(address(backer)), backer.totalCollateral());
    }

    function test_FeeChargedOnEveryAction() public {
        uint256 id = _open(alice, sport, 2_000e6);
        _mint(alice, id, 300e18, false);
        _buy(alice, sport, 100e6);
        usdg.mint(alice, 10e6);
        for (uint256 i; i < 5; ++i) {
            _warpFresh(1 days);
            assertGt(backer.tollFeeOwed(id), 0);
            uint256 c0 = _coll(id);
            vm.startPrank(alice);
            if (i == 0) backer.deposit(id, 1e6);
            else if (i == 1) backer.withdraw(id, 1e6, alice);
            else if (i == 2) backer.mint(id, 10e18, false, 0);
            else if (i == 3) backer.repay(id, 10e18);
            else backer.repayWithUsdg(id, 10e18, type(uint256).max);
            vm.stopPrank();
            assertEq(backer.tollFeeOwed(id), 0);
            if (i == 0) assertLt(_coll(id), c0 + 1e6);
        }
    }

    function testFuzz_FeeNeverExceedsTollEarned(uint256 debt, uint256 cum0, uint256 dCum, uint16 bps) public pure {
        debt = bound(debt, 0, 1e30);
        cum0 = bound(cum0, 0, 1e30);
        dCum = bound(dCum, 0, 1e24);
        bps = uint16(bound(bps, 0, 10_000));
        uint256 fee = ODBackerMath.tollFee(debt, cum0 + dCum, cum0, bps);
        uint256 earnedUsdg = Math.mulDiv(debt, dCum, 1e18) / 1e12;
        assertLe(fee, earnedUsdg);
        assertLe(fee, earnedUsdg * bps / 10_000 + 1);
        assertEq(ODBackerMath.tollFee(debt, cum0, cum0 + dCum, bps), 0, "index never runs backward");
    }
}
