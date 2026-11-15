// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackerFixture} from "./BackerFixture.sol";

/// I4-1 (fix round 7): own-minted debt (minted to the owner's wallet) is tracked per vault. A repay or a liquidation
/// lowers the gear's own-minted debt, and releases its lock, only by the own-minted part of the vault it clears, and
/// inside a vault the debt sold to the Governor clears first. These tests attack that rule with every ordering of
/// mint, repay, buy-back, transfer and liquidation across two owners, four vaults and two gears.
contract OwnDebtAttributionTest is BackerFixture {
    uint256 internal a; // bob, sport
    uint256 internal b; // bob, sport
    uint256 internal c; // bob, cruise
    uint256 internal d; // carol, sport

    function setUp() public override {
        super.setUp();
        a = _open(bob, sport, 20_000e6);
        b = _open(bob, sport, 20_000e6);
        c = _open(bob, cruise, 20_000e6);
        d = _open(carol, sport, 20_000e6);
    }

    function _own(bytes32 g) internal view returns (uint256) {
        return gov.backerOwnDebt(g);
    }

    function _lock(bytes32 g) internal view returns (uint256) {
        return gov.backerLock(g);
    }

    function _buyBack(address who, uint256 v, uint256 tokens) internal {
        vm.prank(who);
        backer.repayWithUsdg(v, tokens, type(uint256).max);
    }

    function _burn(address who, uint256 v, uint256 tokens) internal {
        vm.prank(who);
        backer.repay(v, tokens);
    }

    /// The finding's route: direct sale then buy-back in a second vault, many times. Nothing moves.
    function test_OtherVaultCyclesNeverTouchOwnDebtOrLock() public {
        _mint(bob, a, 500e18, false);
        uint256 lock0 = _lock(sport);
        for (uint256 i; i < 5; ++i) {
            _mint(bob, b, 3_000e18, true);
            _buyBack(bob, b, 3_000e18);
            _mint(carol, d, 3_000e18, true);
            _buyBack(carol, d, 1_000e18);
            _burnFromHolder(d, 500e18);
        }
        assertEq(_own(sport), 500e18);
        assertEq(_lock(sport), lock0);
        assertEq(backer.vaultOwnDebt(a), 500e18);
        assertEq(backer.vaultOwnDebt(b), 0);
        assertEq(backer.vaultOwnDebt(d), 0);
    }

    /// A stranger who bought tokens burns them against vault `v` (repay is open to anyone).
    function _burnFromHolder(uint256 v, uint256 tokens) internal {
        _buy(alice, sport, 2_000e6);
        vm.prank(alice);
        backer.repay(v, tokens);
    }

    /// Inside one vault the debt sold to the Governor clears first, whichever was minted first and however it is
    /// repaid; the lock leaves in the proportion of the own-minted debt cleared, all of it at the end.
    function test_MixedVaultClearsSoldDebtFirst(bool ownFirst, bool burn) public {
        if (ownFirst) _mint(bob, a, 300e18, false);
        _mint(bob, a, 200e18, true);
        if (!ownFirst) _mint(bob, a, 300e18, false);
        uint256 lock0 = _lock(sport);
        uint256 cash0 = gov.freeCash();
        assertEq(backer.vaultOwnDebt(a), 300e18);
        if (burn) _burn(bob, a, 200e18);
        else _buyBack(bob, a, 200e18);
        assertEq(_own(sport), 300e18, "the first 200 repaid are the sold debt");
        assertEq(_lock(sport), lock0);
        if (burn) assertEq(gov.freeCash(), cash0, "nothing released");
        if (burn) _burnFromHolder(a, 100e18);
        else _buyBack(bob, a, 100e18);
        assertEq(_own(sport), 200e18);
        assertEq(backer.vaultOwnDebt(a), 200e18);
        assertEq(_lock(sport), lock0 - lock0 / 3, "a third of the lock released (Floor)");
        _buyBack(bob, a, 200e18);
        assertEq(_own(sport), 0);
        assertEq(_lock(sport), 0);
    }

    /// A partial repay that crosses the line in one call: 250 of (200 sold + 300 own) clears 50 own.
    function test_OneRepayAcrossTheLine() public {
        _mint(bob, a, 300e18, false);
        _mint(bob, a, 200e18, true);
        uint256 lock0 = _lock(sport);
        _buyBack(bob, a, 250e18);
        assertEq(_own(sport), 250e18);
        assertEq(_lock(sport), lock0 - lock0 * 50 / 300);
        // new sold debt on top does not bring the cleared part back, and clears first again
        _mint(bob, a, 400e18, true);
        _buyBack(bob, a, 400e18);
        assertEq(_own(sport), 250e18);
    }

    /// Wallet tokens moved to another account and burned against another owner's sold-only vault: that vault's debt
    /// falls, the own-minted debt of the minting vault does not.
    function test_TransferThenBurnElsewhere() public {
        _mint(bob, a, 500e18, false);
        _mint(carol, d, 400e18, true);
        uint256 lock0 = _lock(sport);
        IERC20 t = _token(sport);
        vm.prank(bob);
        assertTrue(t.transfer(carol, 400e18));
        _burn(carol, d, 400e18);
        assertEq(_debt(d), 0);
        assertEq(_own(sport), 500e18, "vault a still owes its own-minted 500");
        assertEq(_lock(sport), lock0);
        // and a stranger burning against vault a does clear it: those tokens left supply
        vm.prank(bob);
        assertTrue(t.transfer(alice, 100e18));
        _burn(alice, a, 100e18);
        assertEq(_own(sport), 400e18);
        assertEq(_lock(sport), lock0 - lock0 / 5);
    }

    /// Two gears: a repay on one never moves the other's own-minted debt or lock.
    function test_TwoGearsAreSeparate() public {
        _mint(bob, a, 500e18, false);
        _mint(bob, c, 500e18, false);
        uint256 ls = _lock(sport);
        uint256 lc = _lock(cruise);
        _mint(bob, c, 300e18, true);
        _buyBack(bob, c, 300e18);
        _burn(bob, c, 200e18);
        assertEq(_own(sport), 500e18);
        assertEq(_lock(sport), ls);
        assertEq(_own(cruise), 300e18);
        assertEq(_lock(cruise), lc - lc * 200 / 500);
        _burn(bob, a, 500e18);
        assertEq(_lock(sport), 0);
        assertEq(_lock(cruise), lc - lc * 200 / 500);
    }

    /// Liquidation of a sold-only vault leaves another vault's own-minted debt and lock whole; liquidation of the
    /// own-minted vault clears exactly its part.
    function test_LiquidationClearsOnlyTheVaultsOwnPart() public {
        uint256 s1 = _open(carol, sport, 1_000e6);
        _mint(carol, s1, 950e18, true); // about 204%
        uint256 s2 = _open(carol, sport, 1_000e6);
        _mint(carol, s2, 300e18, false);
        _mint(carol, s2, 380e18, true); // mixed, about 202%
        _mint(bob, a, 500e18, false); // 20,000 USDG behind 500 tokens: stays healthy
        uint256 lock0 = _lock(sport);
        assertEq(_own(sport), 800e18);
        _price(TSLA, 300e18); // value x 1.44
        uint256 batch = _seal(sport, s1);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        assertEq(backer.executeBatch(batch), 1);
        assertEq(_debt(s1), 0);
        assertEq(_own(sport), 800e18, "a sold-only vault was liquidated");
        assertEq(_lock(sport), lock0);
        batch = _seal(sport, s2);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        assertEq(backer.executeBatch(batch), 1);
        assertEq(backer.vaultOwnDebt(s2), 0);
        assertEq(_own(sport), 500e18);
        assertEq(_lock(sport), lock0 - lock0 * 300 / 800);
        assertEq(_debt(s2), 0);
    }

    /// Any sequence of mints, buy-backs, burns, transfers and wallet sells over the four vaults: the Governor's count
    /// per gear is the sum of the vaults' own-minted debt, each vault's part is what it minted to its owner capped by
    /// the debt it still carries, an action on a vault with no own-minted debt never moves a lock, and a lock exists
    /// only while own-minted debt is open.
    function testFuzz_AnyOrdering(uint8[14] memory ops, uint96[14] memory amounts) public {
        uint256[4] memory vs = [a, b, c, d];
        uint256[4] memory model; // expected own-minted debt per vault
        for (uint256 i; i < ops.length; ++i) {
            uint256 k = ops[i] % 4;
            uint256 v = vs[k];
            address who = k == 3 ? carol : bob;
            bytes32 g = k == 2 ? cruise : sport;
            IERC20 t = _token(g);
            uint256 kind = (ops[i] / 4) % 6;
            uint256 amt = bound(amounts[i], 1e18, 400e18);
            uint256 lockS = _lock(sport);
            uint256 lockC = _lock(cruise);
            uint256 ownBefore = model[k];
            if (kind == 0) {
                _mint(who, v, amt, false);
                model[k] += amt;
            } else if (kind == 1) {
                _mint(who, v, amt, true);
            } else if (kind == 2) {
                if (_debt(v) == 0) continue;
                _buyBack(who, v, amt);
            } else if (kind == 3) {
                uint256 bal = t.balanceOf(who);
                if (bal == 0 || _debt(v) == 0) continue;
                _burn(who, v, amt > bal ? bal : amt);
            } else if (kind == 4) {
                // bob's wallet tokens go to carol, who burns them against the chosen vault
                uint256 bal = t.balanceOf(bob);
                if (bal == 0 || _debt(v) == 0) continue;
                if (amt > bal) amt = bal;
                vm.prank(bob);
                assertTrue(t.transfer(carol, amt));
                _burn(carol, v, amt);
            } else {
                uint256 bal = t.balanceOf(who);
                if (bal < 2e18) continue;
                vm.prank(who);
                try minter.sell(g, amt > bal ? bal : amt, 0, who, uint64(vm.getBlockTimestamp())) {} catch {}
                assertLe(_lock(sport), lockS, "a sell raised a lock");
                assertLe(_lock(cruise), lockC, "a sell raised a lock");
                continue;
            }
            uint256 debt = _debt(v);
            if (model[k] > debt) model[k] = debt;
            if (kind != 0 && model[k] == ownBefore) {
                assertEq(_lock(sport), lockS, "a lock moved with no own-minted debt cleared");
                assertEq(_lock(cruise), lockC, "a lock moved with no own-minted debt cleared");
            }
            if (g == sport) assertEq(_lock(cruise), lockC, "the other gear's lock moved");
            else assertEq(_lock(sport), lockS, "the other gear's lock moved");
        }
        for (uint256 k; k < 4; ++k) {
            assertEq(backer.vaultOwnDebt(vs[k]), model[k], "vault own-minted debt");
        }
        assertEq(_own(sport), model[0] + model[1] + model[3], "sport own-minted debt");
        assertEq(_own(cruise), model[2], "cruise own-minted debt");
        if (_own(sport) == 0) assertEq(_lock(sport), 0);
        if (_own(cruise) == 0) assertEq(_lock(cruise), 0);
        assertGe(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve() + _lock(sport) + _lock(cruise));
    }
}
