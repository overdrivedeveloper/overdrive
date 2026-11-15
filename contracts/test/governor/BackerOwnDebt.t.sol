// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IODGear} from "overdrive/interfaces/IODGear.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// M-7, the attribution rule on the Governor's hooks alone. Only backer debt minted to an owner's wallet
/// (backerOwnDebt) changes how a sell is paid: the share for tokens that take supply below it comes from the gear's
/// lock, then free cash. Debt sold to the Governor lowers net and changes no payout, so a sell in a gear that such
/// sales took below zero is paid from free cash, the exit reserve, then insurance, as before the fix.
contract BackerOwnDebtTest is GovernorFixture {
    bytes32 id;
    address bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        id = _list(TSLA, NONE, Gear.SPORT, 1_000e18);
        _deposit(lp, 10_000e6);
    }

    function _direct(uint256 tokens, uint256 proceeds) internal {
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, tokens, true, proceeds, address(1)));
    }

    /// The backer's side of a mint to the owner's wallet: supply first, then the book with the sale value as the lock.
    function _own(uint256 tokens, uint256 lock) internal {
        IODGear gear = IODGear(address(_token(id)));
        vm.prank(address(minter));
        gear.mint(bob, tokens);
        vm.prank(backerC);
        assertTrue(gov.onBackerMint(id, tokens, false, lock, address(1)));
    }

    function _leaveCash(uint256 keep) internal {
        uint256 c = gov.freeCash();
        vm.prank(admin); // the keeper is metered (I4-5)
        gov.moveToExitReserve(c - keep);
    }

    function _fundInsurance(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(ins), amount);
        ins.fund(amount);
    }

    /// Sales to the Governor took net below zero; no mint to a wallet. I4-1b (D32): the holder's sell, which leaves
    /// net below zero, is paid from free cash only; short of it the sell is refused (the minter queues it) and the
    /// exit reserve and insurance do not move.
    function test_DirectSaleBelowZeroPaysFromFreeCashOnly() public {
        _buy(id, 300e18, 300e6);
        _direct(500e18, 500e6);
        assertEq(gov.netTokens(id), -200e18);
        assertEq(gov.backerOwnDebt(id), 0, "no own-minted debt");
        assertEq(gov.backerLock(id), 0);
        _leaveCash(100e6);
        uint256 res = gov.exitReserve();
        _fundInsurance(100e6);
        assertFalse(gov.canPaySell(id, 300e18, 100e6 + 1, 0), "quote: queued, one unit past free cash");
        uint256 snap = vm.snapshotState(); // the mock minter burns before it asks; the real one reverts UseQueue
        assertFalse(_sell(id, 300e18, 100e6 + res + 50e6), "refused: the minter queues it");
        assertEq(gov.exitReserve(), res, "exit reserve untouched");
        assertEq(ins.balance(), 100e6, "insurance untouched");
        vm.revertToState(snap);
        assertTrue(gov.canPaySell(id, 300e18, 100e6, 0), "quote: instant inside free cash");
        uint256 a0 = usdg.balanceOf(alice);
        assertTrue(_sell(id, 300e18, 100e6), "paid instantly from free cash");
        assertEq(usdg.balanceOf(alice) - a0, 100e6);
        assertEq(gov.freeCash(), 0);
        assertEq(gov.exitReserve(), res, "exit reserve untouched");
        assertEq(ins.balance(), 100e6, "insurance untouched");
    }

    /// The same sell while net stays at or above zero is paid as it always was: free cash, the reserve, insurance.
    function test_SellThatKeepsNetAtOrAboveZeroStillDrawsReserveAndInsurance() public {
        _buy(id, 300e18, 300e6);
        _direct(100e18, 100e6);
        _leaveCash(100e6);
        uint256 res = gov.exitReserve();
        _fundInsurance(100e6);
        uint256 out = 100e6 + res + 50e6;
        assertTrue(gov.canPaySell(id, 200e18, out, 0), "quote: instant");
        assertTrue(_sell(id, 200e18, out), "paid instantly"); // supply 300 to 100 = the debt: net zero
        assertEq(gov.netTokens(id), 0);
        assertEq(gov.freeCash(), 0, "free cash first");
        assertEq(gov.exitReserve(), 0, "then the exit reserve");
        assertEq(ins.balance(), 50e6, "then insurance");
        assertFalse(gov.canPaySell(id, 1e18, 1, 0), "one token further leaves net below zero: free cash only");
    }

    /// Both kinds of debt open, net below zero. The holder's tokens above the own-minted debt are paid from free cash
    /// only (I4-1b); the tokens that take supply below the own-minted debt from the lock, then free cash (M-7).
    function test_OnlyTheOwnMintedShareIsHeldToTheLock() public {
        _buy(id, 300e18, 300e6);
        _own(100e18, 80e6);
        _direct(500e18, 500e6);
        assertEq(gov.netTokens(id), -200e18);
        assertEq(gov.backerOwnDebt(id), 100e18);
        assertEq(gov.backerDebt(id), 600e18);
        assertEq(gov.backerLock(id), 80e6);
        _leaveCash(10e6);
        uint256 res = gov.exitReserve();

        // The holder: supply 400 to 100, never below the own-minted 100, but net stays below zero: free cash only.
        assertFalse(gov.canPaySell(id, 300e18, 300e6, 0), "short of free cash: queues, whatever the reserve holds");
        _fundCash(290e6);
        assertTrue(gov.canPaySell(id, 300e18, 300e6, 0));
        assertTrue(_sell(id, 300e18, 300e6), "holder paid instantly from free cash");
        assertEq(gov.freeCash(), 0);
        assertEq(gov.exitReserve(), res, "never the reserve");
        assertEq(gov.backerLock(id), 80e6, "lock untouched");

        // The owner's tokens: supply 100 to 0, all below the own-minted debt. Lock 80, free cash must find 20.
        assertFalse(gov.canPaySell(id, 100e18, 100e6, 0), "short of lock plus free cash: queues");
        _fundCash(20e6);
        assertTrue(gov.canPaySell(id, 100e18, 100e6, 0));
        assertTrue(minter.sell(id, bob, bob, 100e18, 100e6, 0));
        assertEq(gov.backerLock(id), 0, "the lock paid first");
        assertEq(gov.freeCash(), 0, "then free cash");
        assertEq(gov.exitReserve(), res, "never the reserve");
        assertEq(gov.backerOwnDebt(id), 100e18, "a sell clears no debt");
    }

    /// One sell across the line: 400 tokens, 100 of them below the own-minted debt. A quarter of the payout is held
    /// to the lock and free cash; the rest, at a net below zero, to free cash alone.
    function test_OneSellSplitsAtTheOwnMintedDebt() public {
        _buy(id, 300e18, 300e6);
        _own(100e18, 80e6);
        _direct(500e18, 500e6);
        IERC20 tok = _token(id);
        vm.prank(bob);
        assertTrue(tok.transfer(alice, 100e18));
        _leaveCash(30e6);
        uint256 res = gov.exitReserve();
        assertFalse(gov.canPaySell(id, 400e18, 400e6, 0), "30 of free cash is short of 20 + 300");
        _fundCash(290e6);
        assertTrue(_sell(id, 400e18, 400e6));
        assertEq(gov.backerLock(id), 0, "lock: 80 of the 100 share");
        assertEq(gov.freeCash(), 0, "free cash: 20 of that share and the 300 of the rest");
        assertEq(gov.exitReserve(), res, "never the reserve");
    }

    /// With the reserve and insurance full and free cash empty, the own-minted share alone cannot be paid.
    function test_OwnMintedShareNeverReachesReserveOrInsurance() public {
        _own(100e18, 80e6);
        _direct(500e18, 500e6);
        _leaveCash(0);
        _fundInsurance(1_000e6);
        uint256 res = gov.exitReserve();
        assertFalse(gov.canPaySell(id, 100e18, 100e6, 0));
        assertFalse(minter.sell(id, bob, bob, 100e18, 100e6, 0), "refused: the minter queues it");
        assertEq(gov.exitReserve(), res);
        assertEq(ins.balance(), 1_000e6);
        assertEq(gov.backerLock(id), 80e6);
    }

    /// I4-1: a repay lowers the own-minted debt, and releases the lock, only by the own-minted part the backer reports
    /// for it (the lock in that proportion of the own-minted debt). A repay of debt sold to the Governor moves neither.
    function test_RepayLowersOwnMintedDebtOnlyByTheOwnPart() public {
        _own(100e18, 80e6);
        _direct(500e18, 500e6);
        uint256 cash = gov.freeCash();
        vm.prank(backerC);
        gov.onBackerRepay(id, 300e18, 0, address(1)); // sold debt only
        assertEq(gov.backerDebt(id), 300e18);
        assertEq(gov.backerOwnDebt(id), 100e18, "own-minted debt untouched");
        assertEq(gov.backerLock(id), 80e6, "lock untouched");
        assertEq(gov.freeCash(), cash);
        vm.prank(backerC);
        gov.onBackerRepay(id, 250e18, 50e18, address(1)); // the last 200 sold, then 50 own-minted
        assertEq(gov.backerDebt(id), 50e18);
        assertEq(gov.backerOwnDebt(id), 50e18);
        assertEq(gov.backerLock(id), 40e6);
        assertEq(gov.freeCash(), cash + 40e6);
        vm.prank(backerC);
        gov.absorbLiquidation(id, 50e18, 50e18, 0, address(1));
        assertEq(gov.backerOwnDebt(id), 0);
        assertEq(gov.backerLock(id), 0);
        assertEq(gov.freeCash(), cash + 80e6);
    }

    /// The lock release rounds toward staying locked, and an own part above what is open clears all of it, no more.
    function test_RepayOwnPartRoundsAndClamps() public {
        _own(3, 10);
        uint256 cash = gov.freeCash();
        vm.prank(backerC);
        gov.onBackerRepay(id, 1, 1, address(1));
        assertEq(gov.backerLock(id), 7, "10 x 1 / 3 floors to 3 released");
        assertEq(gov.backerOwnDebt(id), 2);
        vm.prank(backerC);
        gov.onBackerRepay(id, 2, 5, address(1));
        assertEq(gov.backerOwnDebt(id), 0);
        assertEq(gov.backerLock(id), 0);
        assertEq(gov.freeCash(), cash + 10);
    }
}
