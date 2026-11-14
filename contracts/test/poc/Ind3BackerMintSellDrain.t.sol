// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";

/// Regression for M-7 (independent check 3, 2026-11-14). A backer minted to their own wallet (sellToGovernor = false)
/// and sold the tokens through ODMinter like a holder: paid from free cash, then the whole exit reserve, then the
/// insurance fund, with no cap. On the old code the attack sell paid 1,158,834 USDG and left free cash, the reserve and
/// insurance at 0 / 0 / 1,159 with the gear net long at 2.1 x its cap.
/// Now a mint to the owner's wallet holds the tokens' sale value back from free cash in the gear's backer sale lock and
/// is refused when free cash is short or the gear's total backer debt x value would pass its static cap; sells below
/// zero net are paid from that lock, then free cash, never the reserve or insurance. Uses only the pre-fix surface so
/// the same file shows the old behaviour.
contract Ind3BackerMintSellDrainTest is BackerFixture {
    uint256 internal constant RESERVE = 100_000e6;
    uint256 internal constant INSURANCE = 50_000e6;

    function _setUpBooks() internal returns (uint256 aliceTokens) {
        usdg.mint(lp, RESERVE + INSURANCE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        usdg.approve(address(ins), INSURANCE);
        ins.fund(INSURANCE);
        vm.stopPrank();
        aliceTokens = _buy(alice, sport, 10_000e6); // an ordinary holder
        _poke();
    }

    /// The PoC, flipped: the mint to the owner of the drain size is refused, nothing moves; a mint inside the cap then
    /// sold leaves the reserve and insurance alone, and the ordinary holder still sells instantly.
    function test_M7_BackerMintThenSellCannotDrain() public {
        uint256 aliceTokens = _setUpBooks();
        uint256 cash0 = gov.freeCash();
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();
        uint256 target = (cash0 + res0 + ins0) * 999 / 1000;
        uint256 tokens = minter.quote(sport, false, false, target).amountIn;
        uint256 v = _open(bob, sport, 2_500_000e6);

        // Control: the direct sale to the Governor of the same size is refused.
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        (bool direct,) = address(backer).call(abi.encodeCall(backer.mint, (v, tokens, true, 0)));
        assertFalse(direct, "the direct sale of this size must be refused");
        vm.revertToState(snap);

        // The attack mint to the owner's wallet is refused as well.
        vm.prank(bob);
        (bool own,) = address(backer).call(abi.encodeCall(backer.mint, (v, tokens, false, 0)));
        assertFalse(own, "the mint to the owner of this size must be refused");
        assertEq(gov.freeCash(), cash0, "free cash untouched");
        assertEq(gov.exitReserve(), res0, "exit reserve untouched");
        assertEq(ins.balance(), ins0, "insurance untouched");

        // The largest round size inside the cap, minted to the owner and sold: the reserve and insurance stay whole.
        (uint256 value,) = minter.valuePerToken(sport);
        uint256 inside = reg.gear(sport).capUsdWad * 9 / 10 / value * 1e18;
        _mint(bob, v, inside, false);
        uint256 got = _sell(bob, sport, inside);
        emit log_named_uint("backer sale inside the cap (USDG)", got / 1e6);
        assertEq(gov.exitReserve(), res0, "exit reserve untouched by the backer sale");
        assertEq(ins.balance(), ins0, "insurance untouched by the backer sale");

        // The ordinary holder sells instantly, wholly below zero net, and the reserve still stays whole.
        uint256 out = _sell(alice, sport, aliceTokens);
        assertGt(out, 0, "holder paid");
        assertEq(gov.exitReserve(), res0, "exit reserve untouched by the holder sale below zero");
        assertEq(ins.balance(), ins0, "insurance untouched by the holder sale below zero");
    }
}
