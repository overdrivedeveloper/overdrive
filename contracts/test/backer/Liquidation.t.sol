// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {BackerFixture, MockSlashStake} from "./BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {ODBackerMath} from "overdrive/backer/ODBackerMath.sol";
import {ODLiquidation} from "overdrive/backer/ODLiquidation.sol";
import {Session} from "overdrive/interfaces/ODTypes.sol";

/// 07b: sealed-batch liquidation. A vault sealed below maintenance at the high-side value is liquidated after
/// SEAL_DELAY at that value (5% of the debt value to the executor, the Governor takes the debt and up to D of the
/// collateral); a drift or a closed market voids the batch; holders are never touched.
contract LiquidationTest is BackerFixture {
    address internal keeper = makeAddr("keeper");

    /// TSLA up 20%: a 200% SPORT vault (value x 1.44) falls to about 139%, under the 150% maintenance.
    function _crash() internal {
        _price(TSLA, 300e18);
    }

    function _execute(uint256 b) internal returns (uint256 n) {
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        vm.prank(keeper);
        n = backer.executeBatch(b);
    }

    function _fundInsurance(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(ins), amount);
        ins.fund(amount);
    }

    function _dUsdg(uint256 b, uint256 tokens) internal view returns (uint256) {
        return Math.ceilDiv(ODBackerMath.debtValueWad(tokens, backer.batch(b).sealedValueWad), 1e12);
    }

    // ------------------------------------------------------------------------------------------ R1 seal

    function test_SealNeedsFreshRound() public {
        uint256 id = _sportVault(alice);
        _crash();
        _dropRef(TSLA);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("REF_UNAVAILABLE")));
        _seal(sport, id);
        _ref(TSLA, 300e18);
        _session(Session.CLOSED);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("NOT_LIVE")));
        _seal(sport, id);
        _session(Session.OPEN);
        uint256 b = _seal(sport, id);
        IODBacker.Batch memory bt = backer.batch(b);
        assertEq(bt.sealedAt, vm.getBlockTimestamp());
        assertEq(bt.feedUpdatedAt, vm.getBlockTimestamp(), "round of the crash");
        assertEq(bt.sealedValueWad, _valueAt(sport, 300e18, Math.Rounding.Ceil));
        assertEq(bt.vaultIds.length, 1);
        (,,,, uint256 inBatch) = backer.vault(id);
        assertEq(inBatch, b);
    }

    function test_SealRefusesStaleRound() public {
        uint256 id = _sportVault(alice);
        _crash();
        // 16 minutes without a new feed round: the reading is still fresh (26 h), the round is not
        vm.warp(vm.getBlockTimestamp() + 16 minutes);
        _ref(TSLA, 300e18);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("STALE_ROUND")));
        _seal(sport, id);
        _price(TSLA, 300e18);
        _seal(sport, id);
    }

    function test_SealKeepsOnlyUnhealthy() public {
        uint256 sick = _sportVault(alice);
        uint256 fine = _open(bob, sport, 1_000e6);
        _mint(bob, fine, 100e18, false); // 800%
        uint256 other = _open(carol, cruise, 1_000e6);
        _mint(carol, other, 10e18, false);
        uint256 empty = _open(carol, sport, 100e6);
        _crash();
        uint256[] memory ids = new uint256[](6);
        (ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]) = (fine, sick, other, empty, sick, 999);
        uint256 b = backer.sealBatch(sport, ids);
        uint256[] memory kept = backer.batch(b).vaultIds;
        assertEq(kept.length, 1);
        assertEq(kept[0], sick);
        // already in a live batch: nothing left to seal
        vm.expectRevert(abi.encodeWithSelector(IODBacker.SealRefused.selector, bytes32("NONE_UNHEALTHY")));
        _seal(sport, sick);
        // at most MAX_BATCH ids, at least one
        vm.expectRevert(ODBackerInvalidParams());
        backer.sealBatch(sport, new uint256[](51));
        vm.expectRevert(ODBackerInvalidParams());
        backer.sealBatch(sport, new uint256[](0));
    }

    function test_SealUsesTollNetCollateral() public {
        uint256 id = _sportVault(alice);
        _price(TSLA, 292e18);
        // ratio a bit above 150% on raw collateral; the toll fee owed is what tips it
        (uint256 c, uint256 dv, uint256 ratio,, uint256 maint) = backer.health(id);
        assertEq(c + backer.tollFeeOwed(id), _coll(id));
        assertEq(ratio < maint, ODBackerMath.ratioBps(c, dv) < maint);
    }

    // ------------------------------------------------------------------------------------------ R2 rescue

    function test_RescueBeforeExecute() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        // deposit and repay stay open while sealed
        usdg.mint(alice, 500e6);
        vm.startPrank(alice);
        backer.deposit(id, 500e6);
        backer.repay(id, 50e18);
        vm.stopPrank();
        assertEq(_debt(id), 450e18);
        assertEq(_execute(b), 0, "rescued");
        assertEq(_debt(id), 450e18);
        (,,,, uint256 inBatch) = backer.vault(id);
        assertEq(inBatch, 0, "released");
    }

    function test_NoWithdrawWhileSealed() public {
        uint256 id = _sportVault(alice);
        _crash();
        _seal(sport, id);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.InBatch.selector, id));
        backer.withdraw(id, 1e6, alice);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.InBatch.selector, id));
        backer.mint(id, 1e18, true, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------ R3 execute

    function test_ExecuteWindow() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        uint64 s = uint64(vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(IODBacker.BatchNotReady.selector, s + 30));
        backer.executeBatch(b);
        vm.warp(s + 29);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.BatchNotReady.selector, s + 30));
        backer.executeBatch(b);
        uint256 snap = vm.snapshotState();
        vm.warp(s + 901);
        vm.expectRevert(IODBacker.BatchExpired.selector);
        backer.executeBatch(b);
        (,,,, uint256 inBatch) = backer.vault(id);
        assertEq(inBatch, 0, "free after the TTL");
        vm.revertToState(snap);
        vm.warp(s + 900);
        assertEq(backer.executeBatch(b), 1, "last second of the window");
        vm.expectRevert(abi.encodeWithSelector(IODBacker.BatchDone.selector, b));
        backer.executeBatch(b);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.UnknownBatch.selector, 77));
        backer.executeBatch(77);
    }

    function test_VoidOnDrift() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        vm.warp(vm.getBlockTimestamp() + 30);
        _price(TSLA, 302e18); // value +1.3%: beyond the 1% band
        vm.expectEmit(address(backer));
        emit IODBacker.BatchVoided(b, "DRIFT");
        assertEq(backer.executeBatch(b), 0);
        assertEq(_debt(id), 500e18);
        (,,,, uint256 inBatch) = backer.vault(id);
        assertEq(inBatch, 0);
        // a small move inside the band still executes (a new batch)
        uint256 b2 = _seal(sport, id);
        vm.warp(vm.getBlockTimestamp() + 30);
        _price(TSLA, 303e18); // value +0.66%
        assertEq(backer.executeBatch(b2), 1);
    }

    function test_VoidWhenClosed() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        _session(Session.CLOSED);
        vm.warp(vm.getBlockTimestamp() + 30);
        vm.expectEmit(address(backer));
        emit IODBacker.BatchVoided(b, "NOT_LIVE");
        assertEq(backer.executeBatch(b), 0);
        assertEq(_debt(id), 500e18);
    }

    function test_RescuedVaultReleased() public {
        uint256 a = _sportVault(alice);
        uint256 c = _sportVault(carol);
        _crash();
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, c);
        uint256 b = backer.sealBatch(sport, ids);
        usdg.mint(carol, 400e6);
        vm.prank(carol);
        backer.deposit(c, 400e6);
        assertEq(_execute(b), 1);
        assertEq(_debt(a), 0, "liquidated");
        assertEq(_debt(c), 500e18, "rescued");
        (,,,, uint256 inBatch) = backer.vault(c);
        assertEq(inBatch, 0);
    }

    function test_PausesDoNotStopLiquidation() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        vm.prank(guardian);
        backer.setMintPaused(true);
        assertEq(_execute(b), 1);
    }

    // ------------------------------------------------------------------------------------------ R4 split

    function test_LiquidationSplit() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        uint256 debtBefore = IODGovernor(address(gov)).backerDebt(sport);
        uint256 govBal = usdg.balanceOf(address(gov));
        uint256 cashBefore = gov.freeCash();
        _execute(b);
        uint256 d = _dUsdg(b, 500e18);
        uint256 bonus = d * 500 / 10_000;
        assertEq(usdg.balanceOf(keeper), bonus, "5% of the debt value");
        assertEq(usdg.balanceOf(address(gov)) - govBal, d, "Governor gets D");
        assertGe(gov.freeCash(), cashBefore + d - 1e6, "tracked as cash");
        assertEq(IODGovernor(address(gov)).backerDebt(sport), debtBefore - 500e18, "debt taken over");
        assertEq(_debt(id), 0);
    }

    function test_SurplusReturnsToOwner() public {
        uint256 id = _sportVault(alice);
        _crash();
        uint256 b = _seal(sport, id);
        _execute(b);
        uint256 d = _dUsdg(b, 500e18);
        uint256 coll = 1_000e6 - usdg.balanceOf(address(fees)) - backer.pendingFees();
        assertEq(_coll(id), coll - d - d * 500 / 10_000, "rest stays in the vault");
        assertEq(backer.totalCollateral(), _coll(id));
        // the vault stays open with no debt; the owner can withdraw
        uint256 left = _coll(id);
        vm.prank(alice);
        backer.withdraw(id, left, alice);
        assertEq(usdg.balanceOf(alice), left);
    }

    function test_HolderBalancesUntouched() public {
        uint256 id = _sportVault(alice);
        uint256 held = _buy(bob, sport, 2_000e6);
        uint256 kept = _token(sport).balanceOf(alice);
        uint256 supply = _token(sport).totalSupply();
        _crash();
        _execute(_seal(sport, id));
        assertEq(_token(sport).balanceOf(bob), held);
        assertEq(_token(sport).balanceOf(alice), kept, "the backer's own minted tokens stay hers too");
        assertEq(_token(sport).totalSupply(), supply, "no burn, no mint");
    }

    // ------------------------------------------------------------------------------------------ R5 bad debt

    /// TSLA x 1.92 in three steps: value x 3.69, a 1000 USDG vault with about 1843 USDG of debt.
    function _deepCrash() internal {
        _price(TSLA, 350e18);
        _price(TSLA, 420e18);
        _price(TSLA, 480e18);
    }

    function test_BadDebtInsuranceFirst() public {
        uint256 id = _sportVault(alice);
        _fundInsurance(5_000e6);
        _deepCrash();
        uint256 b = _seal(sport, id);
        uint256 govBal = usdg.balanceOf(address(gov));
        vm.recordLogs();
        _execute(b);
        uint256 d = _dUsdg(b, 500e18);
        uint256 bonus = d * 500 / 10_000;
        assertEq(usdg.balanceOf(keeper), bonus);
        assertEq(usdg.balanceOf(address(gov)) - govBal, d, "no bad debt");
        assertEq(_coll(id), 0);
        assertEq(ins.balance(), 5_000e6 - (d + bonus - _seized()), "insurance paid the gap");
        assertEq(_lastBadDebt(), 0);
    }

    function test_BadDebtThenStake() public {
        uint256 id = _sportVault(alice);
        _fundInsurance(300e6);
        MockSlashStake st = new MockSlashStake(usdg);
        usdg.mint(address(st), 10_000e6);
        vm.prank(admin);
        backer.setStake(address(st));
        _deepCrash();
        uint256 b = _seal(sport, id);
        uint256 govBal = usdg.balanceOf(address(gov));
        vm.recordLogs();
        _execute(b);
        uint256 d = _dUsdg(b, 500e18);
        uint256 bonus = d * 500 / 10_000;
        assertEq(ins.balance(), 0, "insurance first, all of it");
        assertEq(st.asked(), d + bonus - _seized() - 300e6, "the stake covers the rest");
        assertEq(usdg.balanceOf(address(gov)) - govBal, d);
        assertEq(usdg.balanceOf(keeper), bonus);
        assertEq(_lastBadDebt(), 0);
    }

    function test_BadDebtThenGovernor() public {
        uint256 id = _sportVault(alice);
        _fundInsurance(100e6);
        MockSlashStake st = new MockSlashStake(usdg);
        st.setFail(true); // SlashFailed: returns 0, never reverts
        vm.prank(admin);
        backer.setStake(address(st));
        _deepCrash();
        uint256 b = _seal(sport, id);
        uint256 govBal = usdg.balanceOf(address(gov));
        uint256 debtBefore = IODGovernor(address(gov)).backerDebt(sport);
        vm.recordLogs();
        assertEq(_execute(b), 1);
        uint256 d = _dUsdg(b, 500e18);
        uint256 bonus = d * 500 / 10_000;
        uint256 pool = _seized() + 100e6;
        assertEq(usdg.balanceOf(keeper), bonus);
        assertEq(usdg.balanceOf(address(gov)) - govBal, pool - bonus);
        assertEq(_lastBadDebt(), d - (pool - bonus), "the Governor's equity absorbs the rest");
        assertEq(IODGovernor(address(gov)).backerDebt(sport), debtBefore - 500e18);
        assertGt(st.asked(), 0);
    }

    function test_SetStakeAdminOnly() public {
        vm.prank(guardian);
        vm.expectRevert();
        backer.setStake(address(1));
        vm.prank(admin);
        vm.expectEmit(address(backer));
        emit IODBacker.StakeSet(address(1));
        backer.setStake(address(1));
        assertEq(backer.stake(), address(1));
    }

    function test_MinRewardAtNegativeEquity() public {
        uint256 id = _sportVault(alice);
        _deepCrash();
        // collateral below even the executor's floor; no insurance, no stake: the Governor's free cash pays it
        _drain(id, _coll(id) - 1000, stranger);
        uint256 b = _seal(sport, id);
        uint256 cash = gov.freeCash();
        uint256 govBal = usdg.balanceOf(address(gov));
        vm.recordLogs();
        assertEq(_execute(b), 1);
        uint256 d = _dUsdg(b, 500e18);
        uint256 floor = Math.min(d * 500 / 10_000, backer.MIN_REWARD_USDG());
        assertEq(floor, 1e6);
        assertEq(usdg.balanceOf(keeper), floor, "executor always paid the floor");
        uint256 seized = _seized();
        assertEq(govBal - usdg.balanceOf(address(gov)), floor - seized, "Governor cash topped it up");
        assertEq(cash - gov.freeCash(), floor - seized);
        assertEq(_lastBadDebt(), d);
    }

    // ------------------------------------------------------------------------------------------ R6 no blocking

    function test_OneBadVaultDoesNotBlockBatch() public {
        uint256 a = _sportVault(alice);
        uint256 c = _open(carol, sport, 1_000e6);
        _mint(carol, c, 499e18, false);
        uint256 x = _open(bob, sport, 1_000e6);
        _mint(bob, x, 498e18, false);
        _crash();
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, c, x);
        uint256 b = backer.sealBatch(sport, ids);
        // the Governor refuses carol's vault (any external failure in one vault), bob repays all before execute
        vm.mockCallRevert(
            address(gov), abi.encodeWithSelector(IODGovernor.absorbLiquidation.selector, sport, 499e18), "boom"
        );
        vm.prank(bob);
        backer.repay(x, 498e18);
        assertEq(_execute(b), 1);
        assertEq(_debt(a), 0);
        assertEq(_debt(c), 499e18, "rolled back alone");
        assertGt(_coll(c), 999e6, "carol's collateral untouched but for the toll fee");
        assertEq(_debt(x), 0);
        assertEq(backer.totalCollateral(), _coll(a) + _coll(c) + _coll(x));
    }

    function test_DustVaultHarmless() public {
        uint256 a = _sportVault(alice);
        uint256 dust = _open(carol, sport, 50e6);
        _mint(carol, dust, 1e12, false);
        _drain(dust, 50e6 - 1, stranger); // 1 wei of collateral vs 2 wei of debt value
        _crash();
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (dust, a);
        uint256 b = backer.sealBatch(sport, ids);
        assertEq(backer.batch(b).vaultIds.length, 2);
        assertEq(_execute(b), 2);
        assertEq(_debt(a), 0);
        assertEq(_debt(dust), 0);
    }

    // ------------------------------------------------------------------------------------------ split maths

    function testFuzz_SplitConserves(uint256 dWad, uint256 coll, uint256 recovered) public pure {
        dWad = bound(dWad, 1, 1e15 * 1e18);
        coll = bound(coll, 0, 1e15 * 1e6);
        ODLiquidation.Split memory x = ODLiquidation.split(dWad, coll, 500, 1e6);
        recovered = bound(recovered, 0, x.gap * 2);
        x = ODLiquidation.settle(x, coll + recovered);
        assertEq(x.bonus + x.toGovernor + x.surplus, coll + recovered, "every USDG goes somewhere");
        assertEq(x.bonusDue, x.debtUsdg * 500 / 10_000);
        assertLe(x.bonus, x.bonusDue);
        if (x.gap != 0) assertEq(x.surplus, 0, "the owner never gets cover money");
        if (coll + recovered >= x.debtUsdg + x.bonusDue) {
            assertEq(x.bonus, x.bonusDue);
            assertEq(x.badDebt, 0);
        }
        assertEq(x.badDebt + Math.min(x.toGovernor, x.debtUsdg), x.debtUsdg);
        assertEq(x.bonus + x.floorGap >= x.floor, true);
    }

    // ------------------------------------------------------------------------------------------ helpers

    function ODBackerInvalidParams() internal pure returns (bytes4) {
        return bytes4(keccak256("InvalidParams()"));
    }

    function _liqLog() internal returns (Vm.Log memory l, bool found) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(backer) && logs[i].topics[0] == IODBacker.Liquidated.selector) {
                return (logs[i], true);
            }
        }
    }

    uint256 internal _seizedCache;
    uint256 internal _badCache;
    bool internal _cached;

    function _readLiq() internal {
        if (_cached) return;
        (Vm.Log memory l, bool found) = _liqLog();
        assertTrue(found, "Liquidated");
        (, uint256 seized,, uint256 bad) = abi.decode(l.data, (uint256, uint256, uint256, uint256));
        (_seizedCache, _badCache, _cached) = (seized, bad, true);
    }

    function _seized() internal returns (uint256) {
        _readLiq();
        return _seizedCache;
    }

    function _lastBadDebt() internal returns (uint256) {
        _readLiq();
        return _badCache;
    }
}
