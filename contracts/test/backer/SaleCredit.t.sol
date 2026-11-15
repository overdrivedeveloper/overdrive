// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "./BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";

/// I6-1: the proceeds of a sale to the Governor stay in the Governor as sale credit. They are the vault's collateral,
/// locked behind the sold debt, and reach the backer contract only as that debt is repaid or liquidated, from free
/// cash only.
contract SaleCreditTest is BackerFixture {
    address internal keeper = makeAddr("keeper");
    uint256 internal v;
    uint256 internal proceeds;

    function _sold(uint256 deposit, uint256 tokens) internal {
        v = _open(bob, sport, deposit);
        proceeds = _mint(bob, v, tokens, true);
    }

    function _books() internal view {
        assertEq(gov.saleCredit(), backer.totalHeld(), "credit == held");
        assertGe(
            usdg.balanceOf(address(backer)) + backer.totalHeld(),
            backer.totalCollateral() + backer.pendingFees(),
            "backer books"
        );
        assertGe(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve(), "governor books");
    }

    function test_DirectSale_ProceedsStayInTheGovernor() public {
        uint256 cash0 = gov.freeCash();
        uint256 nav0 = gov.totalAssets();
        uint256 govBal = usdg.balanceOf(address(gov));
        v = _open(bob, sport, 1_000e6);
        vm.expectEmit(true, true, false, false, address(gov));
        emit IODGovernor.SaleCreditBooked(sport, bob, 0, 0);
        proceeds = _mint(bob, v, 500e18, true);
        assertGt(proceeds, 0);
        assertEq(_coll(v), 1_000e6 + proceeds, "the proceeds are the vault's collateral");
        (uint256 held, uint256 locked) = backer.vaultHeld(v);
        assertEq(held, proceeds, "held by the Governor");
        assertEq(locked, proceeds, "locked behind the sold debt");
        assertEq(usdg.balanceOf(address(backer)), 1_000e6, "the backer contract holds the deposit only");
        assertEq(usdg.balanceOf(address(gov)), govBal, "no USDG left the Governor");
        assertEq(gov.freeCash(), cash0, "free cash untouched");
        assertEq(gov.saleCredit(), proceeds, "owed to the vault");
        // NAV does not count the credit: it moves by the spread the sale earned, not by the proceeds
        assertGe(gov.totalAssets(), nav0, "NAV did not fall");
        assertLt(gov.totalAssets() - nav0, proceeds / 10, "NAV did not book the proceeds");
        _books();
    }

    function test_HeldCollateralCannotBeWithdrawn() public {
        _sold(1_000e6, 100e18); // far above the initial ratio: only the hold stops the withdraw
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.Undercollateralized.selector, 0, 0));
        backer.withdraw(v, 1_000e6 + 1, bob);
        vm.prank(bob);
        backer.withdraw(v, 800e6, bob); // his own deposit, down to the ratio
        assertEq(usdg.balanceOf(bob), 800e6);
        (uint256 held,) = backer.vaultHeld(v);
        assertEq(held, proceeds, "still held");
        _books();
    }

    function test_CreditOfAllVaultsIsHeldToFreeCash() public {
        uint256 cash = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(cash - 100e6);
        v = _open(bob, sport, 10_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(v, 500e18, true, 0);
        _mint(bob, v, 50e18, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(v, 60e18, true, 0); // the second sale would take the credit of all vaults past free cash
    }

    function test_SettleSaleCreditIsBackerOnly() public {
        _sold(1_000e6, 500e18);
        vm.prank(bob);
        vm.expectRevert(IODGovernor.NotBacker.selector);
        gov.settleSaleCredit(1, 0);
    }

    function test_BuyBack_UsesTheCreditFirst_ThenReleasesInProportion() public {
        _sold(1_000e6, 500e18);
        uint256 cash0 = gov.freeCash();
        vm.prank(bob);
        uint256 cost = backer.repayWithUsdg(v, 200e18, type(uint256).max);
        (uint256 held, uint256 locked) = backer.vaultHeld(v);
        // 300 of 500 sold tokens are open: at most that share of the proceeds stays locked
        assertLe(locked, proceeds * 300 / 500 + 1, "the lock fell with the sold debt");
        assertEq(held, locked, "the Governor paid the unlocked part");
        assertEq(_coll(v), 1_000e6 + proceeds - cost, "the cost came out of collateral");
        // the cost was cancelled against the credit (no USDG moved for it); the rest of the unlocked part was paid
        assertEq(usdg.balanceOf(address(backer)), 1_000e6 + (proceeds - cost - held), "what was released arrived");
        assertEq(gov.freeCash(), cash0 - (proceeds - cost - held), "from free cash");
        _books();

        vm.startPrank(bob);
        backer.repayWithUsdg(v, 300e18, type(uint256).max);
        (held, locked) = backer.vaultHeld(v);
        assertEq(held, 0, "nothing held once the debt is gone");
        assertEq(locked, 0);
        uint256 c = _coll(v);
        backer.withdraw(v, c, bob);
        vm.stopPrank();
        assertLe(c, 1_000e6, "bob paid the spreads");
        assertEq(gov.saleCredit(), 0);
        _books();
    }

    function test_RepayWithTokens_ReleasesTheCredit() public {
        _sold(1_000e6, 500e18);
        uint256 bought = _buy(bob, sport, 2_000e6);
        assertGe(bought, 500e18);
        vm.prank(bob);
        backer.repay(v, 500e18);
        (uint256 held, uint256 locked) = backer.vaultHeld(v);
        assertEq(held, 0, "paid out with the debt cleared");
        assertEq(locked, 0);
        assertEq(usdg.balanceOf(address(backer)), 1_000e6 + proceeds, "the proceeds arrived at the repay");
        assertEq(_coll(v), 1_000e6 + proceeds);
        _books();
    }

    /// Free cash short when the debt clears: the unpaid credit stays held, unlocked, and is paid at a later
    /// withdraw. The exit reserve and insurance never pay it.
    function test_Release_WaitsForFreeCash_NeverTheReserve() public {
        _sold(1_000e6, 500e18);
        uint256 bought = _buy(bob, sport, 2_000e6);
        bought;
        uint256 cash = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(cash); // every dollar of free cash is in the exit reserve
        uint256 res0 = gov.exitReserve();
        uint256 ins0 = ins.balance();
        vm.prank(bob);
        backer.repay(v, 500e18); // never blocked
        assertEq(_debt(v), 0);
        (uint256 held, uint256 locked) = backer.vaultHeld(v);
        assertEq(held, proceeds, "not paid: free cash is empty");
        assertEq(locked, 0, "but unlocked");
        assertEq(gov.exitReserve(), res0, "the exit reserve did not pay the credit");
        assertEq(ins.balance(), ins0, "nor did insurance");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.Undercollateralized.selector, 0, 0));
        backer.withdraw(v, 1_000e6 + 1, bob); // still only his own deposit
        _books();

        vm.prank(admin);
        gov.moveFromExitReserve(res0); // cash is back
        vm.prank(bob);
        backer.withdraw(v, 1_000e6 + proceeds, bob);
        assertEq(usdg.balanceOf(bob), 1_000e6 + proceeds, "paid at the next withdraw");
        assertEq(gov.saleCredit(), 0);
        _books();
    }

    function test_Liquidation_TakesTheCreditFirst() public {
        (,,, uint256 req, uint256 maint) = _thresholds();
        // sell as much debt as the initial ratio allows on a 1,000 USDG deposit
        uint256 tokens = 1_000e18 * 10_000 / (req - 10_000) * 95 / 100;
        _sold(1_000e6, tokens);
        _price(TSLA, 300e18);
        assertLt(_ratio(v), maint, "unhealthy after the move");
        uint256 govBal = usdg.balanceOf(address(gov));
        uint256 cash0 = gov.freeCash();
        uint256 credit0 = gov.saleCredit();
        uint256 b = _seal(sport, v);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        vm.prank(keeper);
        assertEq(backer.executeBatch(b), 1);
        assertEq(_debt(v), 0);
        (uint256 held, uint256 locked) = backer.vaultHeld(v);
        assertEq(locked, 0, "nothing locked after the liquidation");
        assertLe(held, _coll(v), "what is still held is the vault's surplus");
        assertGt(usdg.balanceOf(keeper), 0, "the executor was paid");
        // the Governor kept the credit it cancelled: its balance rose only by what the backer contract sent
        uint256 cancelled = credit0 - gov.saleCredit() - 0;
        assertGt(cancelled, 0);
        assertGe(gov.freeCash() + cancelled, cash0, "free cash did not pay the credit out");
        assertGe(usdg.balanceOf(address(gov)), govBal, "no USDG left the Governor for the cancelled credit");
        _books();
    }

    function _thresholds() internal returns (uint256, uint256, uint256, uint256 req, uint256 maint) {
        uint256 id = _open(carol, sport, 100e6);
        (,,, req, maint) = backer.health(id);
        return (0, 0, 0, req, maint);
    }
}
