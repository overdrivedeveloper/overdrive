// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// Regression for independent check 4, finding I4-1 (fix round 7). The first two tests are the auditor's file with its
/// asserts unchanged (the first failed before the fix: 148,443 USDG of backer-minted supply paid by the exit reserve
/// and insurance). The third states the bound of the accepted variant I4-1b (SECURITY.md, Accepted risks).
/// The finding: the M-7 fix pays the share of a sell "below the gear's own-minted
/// backer debt" from the lock, never from the exit reserve or insurance. But `ODGovernorRisk.repay` lowers
/// `backerOwnDebt` and releases the lock PRO RATA to ANY debt of the gear that is repaid, while the own-minted tokens
/// stay in the owner's wallet. A direct sale to the Governor followed by `repayWithUsdg` of the same tokens (no token is
/// burned) therefore dilutes the own-minted count and frees the lock; the wallet tokens are then sold through the
/// minter and paid from free cash, the exit reserve and insurance again.
contract Ind4OwnDebtDilutionTest is BackerFixture {
    uint256 internal constant RESERVE = 100_000e6;
    uint256 internal constant INSURANCE = 50_000e6;

    function _books() internal returns (uint256 aliceTokens) {
        usdg.mint(lp, RESERVE + INSURANCE);
        vm.startPrank(lp);
        usdg.approve(address(gov), RESERVE);
        gov.fundExitReserve(RESERVE);
        usdg.approve(address(ins), INSURANCE);
        ins.fund(INSURANCE);
        vm.stopPrank();
        aliceTokens = _buy(alice, sport, 10_000e6);
        _poke();
        // M-8 (same round): own mints are held to maxLockBps of free cash plus locks, 20% by default. The auditor's
        // own mint is 39% of it, so these tests run at the parameter's upper bound (the only line added to the file).
        IODGovernor.Params memory gp = gov.getParams();
        gp.maxLockBps = 5000;
        vm.prank(admin);
        gov.setParams(gp);
    }

    /// Direct sales to the Governor on other gears until free cash is nearly gone (ordinary backer activity).
    function _drainFreeCash() internal {
        bytes32[4] memory gs = [cruise, race, reverse, ethSport];
        for (uint256 i; i < gs.length; ++i) {
            uint256 c = gov.freeCash();
            if (c < 6_000e6) break;
            (uint256 value,) = minter.valuePerToken(gs[i]);
            uint256 room = reg.gear(gs[i]).capUsdWad * 8 / 10;
            uint256 want = (c - 5_000e6) * 1e12;
            if (want > room) want = room;
            uint256 v = _open(bob, gs[i], 3_000_000e6);
            _mint(bob, v, want * 1e18 / value, true);
        }
    }

    function _run(uint256 cycles) internal returns (uint256 res0, uint256 ins0, uint256 aliceTokens, uint256 x) {
        aliceTokens = _books();
        (uint256 value,) = minter.valuePerToken(sport);
        uint256 cap = reg.gear(sport).capUsdWad;
        x = cap * 45 / 100 / value * 1e18;
        uint256 y = cap * 40 / 100 / value * 1e18; // sized to the free cash left after the lock
        uint256 a = _open(bob, sport, 2_500_000e6);
        uint256 b = _open(bob, sport, 2_500_000e6);
        _mint(bob, a, x, false); // minted to the owner's wallet: value locked, own-minted debt = x
        emit log_named_uint("own-minted debt after the mint (tokens)", gov.backerOwnDebt(sport) / 1e18);
        emit log_named_uint("lock after the mint (USDG)", gov.backerLock(sport) / 1e6);
        uint256 spent0 = usdg.balanceOf(bob) + _coll(a) + _coll(b);
        for (uint256 i; i < cycles; ++i) {
            _mint(bob, b, y, true); // direct sale, proceeds join vault b's collateral
            vm.prank(bob);
            backer.repayWithUsdg(b, y, type(uint256).max); // bought back from collateral, nothing burned
        }
        emit log_named_uint("dilution cost (USDG)", (spent0 - usdg.balanceOf(bob) - _coll(a) - _coll(b)) / 1e6);
        emit log_named_uint("own-minted debt after the cycles (tokens)", gov.backerOwnDebt(sport) / 1e18);
        emit log_named_uint("lock after the cycles (USDG)", gov.backerLock(sport) / 1e6);
        emit log_named_uint("wallet tokens still held by the owner", _token(sport).balanceOf(bob) / 1e18);
        _drainFreeCash();
        res0 = gov.exitReserve();
        ins0 = ins.balance();
        emit log_named_uint("free cash before the sale (USDG)", gov.freeCash() / 1e6);
    }

    /// Failed before fix round 7: the backer-minted wallet tokens are paid from the exit reserve and insurance.
    function test_I4_1_OwnMintedSupplyNeverDrawsReserve_afterDilution() public {
        (uint256 res0, uint256 ins0, uint256 aliceTokens, uint256 x) = _run(2);
        uint256 holderShare = minter.quote(sport, false, true, aliceTokens).amountOut * 102 / 100;
        // sell what free cash + the reserve + insurance can pay (all of it is wallet supply minted by the vault owner)
        uint256 target = (gov.freeCash() + res0 + ins0) * 99 / 100;
        uint256 sellTokens = minter.quote(sport, false, false, target).amountIn;
        assertLe(sellTokens, x, "sale is inside the owner's minted wallet tokens");
        uint256 got = _sell(bob, sport, sellTokens);
        emit log_named_uint("backer wallet sale paid (USDG)", got / 1e6);
        emit log_named_uint("exit reserve after (USDG)", gov.exitReserve() / 1e6);
        emit log_named_uint("insurance after (USDG)", ins.balance() / 1e6);
        emit log_named_uint("free cash after (USDG)", gov.freeCash() / 1e6);
        emit log_named_int("sport net (tokens)", gov.netTokens(sport) / 1e18);
        emit log_named_uint("sport cap (USD)", reg.gear(sport).capUsdWad / 1e18);
        emit log_string(minter.quote(sport, false, true, aliceTokens).queued ? "holder sell: QUEUED" : "holder sell: instant");
        // The only supply not minted to an owner's wallet is the holder's: at most its share may come from the reserve.
        assertLe((res0 - gov.exitReserve()) + (ins0 - ins.balance()), holderShare, "reserve + insurance paid backer-minted supply");
    }

    /// Control, passes: with no dilution the same sale is paid from the lock and leaves the reserve and insurance whole.
    function test_I4_1_control_NoDilution() public {
        (uint256 res0, uint256 ins0, uint256 aliceTokens, uint256 x) = _run(0);
        uint256 holderShare = minter.quote(sport, false, true, aliceTokens).amountOut * 102 / 100;
        uint256 got = _sell(bob, sport, x);
        assertGt(got, 0);
        emit log_named_uint("control: reserve + insurance drawn (USDG)", ((res0 - gov.exitReserve()) + (ins0 - ins.balance())) / 1e6);
        assertLe((res0 - gov.exitReserve()) + (ins0 - ins.balance()), holderShare, "only the holder share may come from the reserve");
    }

    /// I4-1b, accepted (SECURITY.md, Accepted risks): no mint to a wallet. One actor buys as a holder (paid in full),
    /// sells debt straight to the Governor (checked against the live net, which the bought tokens hold up), then sells
    /// the bought tokens. Those tokens are ordinary holder supply, so the sell is paid like any holder's: free cash, the
    /// exit reserve, insurance. This is the path `DirectSaleBelowZero.t.sol` keeps on purpose. What bounds it:
    /// the reserve and insurance pay no more than the payout of tokens that were bought and paid for; the actor gets
    /// back less than they paid in; the gear ends past its cap by at most the value of the holder supply that left;
    /// and the vault behind the debt still holds at least the initial ratio in collateral.
    function test_I4_1b_AcceptedRisk_HolderExitAfterDirectSale_IsBounded() public {
        _books();
        (uint256 value,) = minter.valuePerToken(sport);
        uint256 cap = reg.gear(sport).capUsdWad;
        uint256 spent = cap * 30 / 100 / 1e12;
        uint256 h;
        for (; spent >= 10_000e6; spent = spent * 8 / 10) {
            _fund(bob, spent);
            vm.prank(bob);
            (bool ok, bytes memory ret) =
                address(minter).call(abi.encodeCall(minter.buy, (sport, spent, 0, bob, uint64(vm.getBlockTimestamp()))));
            if (ok) {
                h = abi.decode(ret, (uint256));
                break;
            }
        }
        uint256 v = _open(bob, sport, 3_000_000e6);
        _mint(bob, v, h + cap * 90 / 100 / value * 1e18, true);
        (, uint256 openBefore) = gov.capOf(sport);
        assertLe(openBefore, cap, "the direct sale itself stays inside the cap");
        assertEq(gov.backerOwnDebt(sport), 0, "no own-minted debt: this is not the M-7 route");
        _drainFreeCash();
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();
        uint256 target = (gov.freeCash() + res0 + ins0) * 99 / 100;
        uint256 sellTokens = minter.quote(sport, false, false, target).amountIn;
        if (sellTokens > h) sellTokens = h;
        uint256 got = _sell(bob, sport, sellTokens);
        uint256 paidIn = spent * sellTokens / h;
        uint256 drawn = (res0 - gov.exitReserve()) + (ins0 - ins.balance());
        (, uint256 open) = gov.capOf(sport);
        emit log_named_uint("bought as a holder (USDG)", spent / 1e6);
        emit log_named_uint("paid in for the tokens sold (USDG)", paidIn / 1e6);
        emit log_named_uint("payout of the tokens sold (USDG)", got / 1e6);
        emit log_named_uint("reserve + insurance drawn (USDG)", drawn / 1e6);
        emit log_named_uint("sport open value after (USD)", open / 1e18);
        emit log_named_uint("sport cap (USD)", cap / 1e18);
        emit log_named_uint("vault ratio after (bps)", _ratio(v));
        assertLe(drawn, got, "reserve + insurance paid more than the payout of paid-for holder tokens");
        assertLt(got, paidIn, "the round trip paid the actor");
        assertLe(open, cap + sellTokens * value / 1e18 * 101 / 100, "past the cap by more than the supply that left");
        assertGe(_ratio(v), reg.gear(sport).collateralBps, "the debt is no longer backed at the initial ratio");
    }
}
