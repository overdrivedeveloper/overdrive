// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
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
        gp.maxLockOwnerBps = 10_000; // one owner on purpose: the per-owner share (L-12) is not the subject here
        vm.prank(admin);
        gov.setParams(gp);
    }

    /// Free cash nearly gone. Before fix round 9 this was done with direct sales on other gears, which paid their
    /// proceeds out of free cash; a direct sale now takes none (I6-1), so the timelock moves it to the exit reserve.
    function _drainFreeCash() internal {
        uint256 c = gov.freeCash();
        if (c < 6_000e6) return;
        vm.prank(admin);
        gov.moveToExitReserve(c - 5_000e6);
    }

    /// I4-1b (D32): a sell that leaves net below zero is paid from free cash (and its lock) only, so the share of the
    /// owner's sale above the own-minted debt (at most the holder's supply) needs free cash; give it that much.
    function _cashFor(uint256 amount) internal {
        usdg.mint(lp, amount);
        vm.startPrank(lp);
        usdg.approve(address(gov), amount);
        gov.fundCash(amount);
        vm.stopPrank();
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
        if (sellTokens > x) sellTokens = x; // the exit reserve is larger now (free cash was moved into it)
        assertLe(sellTokens, x, "sale is inside the owner's minted wallet tokens");
        _cashFor(holderShare);
        uint256 got = _sell(bob, sport, sellTokens);
        emit log_named_uint("backer wallet sale paid (USDG)", got / 1e6);
        emit log_named_uint("exit reserve after (USDG)", gov.exitReserve() / 1e6);
        emit log_named_uint("insurance after (USDG)", ins.balance() / 1e6);
        emit log_named_uint("free cash after (USDG)", gov.freeCash() / 1e6);
        emit log_named_int("sport net (tokens)", gov.netTokens(sport) / 1e18);
        emit log_named_uint("sport cap (USD)", reg.gear(sport).capUsdWad / 1e18);
        emit log_string(minter.quote(sport, false, true, aliceTokens).queued
                ? "holder sell: QUEUED"
                : "holder sell: instant");
        // The only supply not minted to an owner's wallet is the holder's: at most its share may come from the reserve.
        assertLe(
            (res0 - gov.exitReserve()) + (ins0 - ins.balance()),
            holderShare,
            "reserve + insurance paid backer-minted supply"
        );
    }

    /// Control, passes: with no dilution the same sale is paid from the lock and leaves the reserve and insurance whole.
    function test_I4_1_control_NoDilution() public {
        (uint256 res0, uint256 ins0, uint256 aliceTokens, uint256 x) = _run(0);
        uint256 holderShare = minter.quote(sport, false, true, aliceTokens).amountOut * 102 / 100;
        _cashFor(holderShare);
        uint256 got = _sell(bob, sport, x);
        assertGt(got, 0);
        emit log_named_uint(
            "control: reserve + insurance drawn (USDG)", ((res0 - gov.exitReserve()) + (ins0 - ins.balance())) / 1e6
        );
        assertLe(
            (res0 - gov.exitReserve()) + (ins0 - ins.balance()),
            holderShare,
            "only the holder share may come from the reserve"
        );
    }

    /// I4-1b, closed in fix round 9 by design (flipped from the accepted-risk test, which measured 148,445 of 150,000
    /// USDG of reserve plus insurance drawn for a cost of 2,932; the D32 rule of fix round 8 is gone). No mint to a
    /// wallet: one actor buys as a holder, sells debt straight to the Governor, then sells the bought tokens. The
    /// direct sale pays nothing out (its proceeds stay in the Governor as sale credit), so his exit is paid by the
    /// free cash his own buy brought: the exit reserve and insurance never move, and the honest holder still exits.
    function test_I4_1b_HolderExitAfterDirectSale_DrawsNoReserveOrInsurance() public {
        uint256 aliceTokens = _books();
        (uint256 value,) = minter.valuePerToken(sport);
        uint256 cap = reg.gear(sport).capUsdWad;
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();
        uint256 cash0 = gov.freeCash();
        assertEq(res0 + ins0, RESERVE + INSURANCE);
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
        uint256 backer0 = usdg.balanceOf(address(backer));
        uint256 cash1 = gov.freeCash();
        _mint(bob, v, h + cap * 90 / 100 / value * 1e18, true);
        assertEq(gov.backerOwnDebt(sport), 0, "no own-minted debt: this is not the M-7 route");
        assertEq(usdg.balanceOf(address(backer)), backer0, "the direct sale paid nothing out");
        assertEq(gov.freeCash(), cash1, "and took no free cash");
        assertLt(gov.netTokens(sport), 0, "net is below zero before he sells");

        // the auditor's step 3: he sells the bought tokens, in one piece and in pieces. Paid at once every time,
        // from free cash; nothing is drawn from the exit reserve or insurance
        uint256 snap = vm.snapshotState();
        assertFalse(minter.quote(sport, false, true, h).queued, "quote: instant");
        _sell(bob, sport, h);
        assertEq(gov.exitReserve(), res0, "exit reserve untouched");
        assertEq(ins.balance(), ins0, "insurance untouched");
        assertGe(gov.freeCash(), cash0, "free cash is where it was before he came, plus his spreads");
        vm.revertToState(snap);
        uint256 piece = h / 50;
        for (uint256 i; i < 50; ++i) {
            _sell(bob, sport, piece);
            assertEq(gov.exitReserve(), res0, "exit reserve untouched by a piece");
            assertEq(ins.balance(), ins0, "insurance untouched by a piece");
        }
        assertGe(gov.freeCash(), cash0, "free cash is where it was before he came");

        // the honest holder exits at once, and the debt is still backed
        assertFalse(minter.quote(sport, false, true, aliceTokens).queued, "the holder is not queued");
        _sell(alice, sport, aliceTokens);
        assertEq(ins.balance(), ins0, "insurance untouched");
        assertGe(_ratio(v), reg.gear(sport).collateralBps, "the debt is still backed at the initial ratio");
    }
}
