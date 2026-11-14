// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {BackerFixture} from "../backer/BackerFixture.sol";
import {HookFixture} from "../hook/HookFixture.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

/// M-4, the general property after the rescore 2 pair leg: neither source may show a move of up to lagBandBps on ANY
/// market yet. With an independent move per leg (TSLA by moveA, NVDA by moveB, each inside the band, any signs), a
/// round trip across the moves never profits, for single and pair gears, on the minter, the backer and the hook.
/// Single gears read TSLA only, so moveB is a no-op for them; the pair reads TSLA / NVDA. Each contract has the
/// same two helpers (_legs moves the legs, _setup fuzzes the band and the moves) because the fixtures do not compose.
contract TwoLegLagMinterTest is SystemFixture {
    function _legs(int256 moveA, int256 moveB) internal {
        if (moveA != 0) _price(TSLA, uint256(int256(_p(TSLA)) * (10_000 + moveA) / 10_000));
        if (moveB != 0) _price(NVDA, uint256(int256(_p(NVDA)) * (10_000 + moveB) / 10_000));
    }

    /// Fuzzed band (1..300 when `wide`, else the default) and two moves inside it.
    function _setup(uint16 bandSeed, bool wide, int16 a, int16 b) internal returns (int256 moveA, int256 moveB) {
        IODMinter.TradeParams memory tp = minter.tradeParams();
        if (wide) {
            tp.lagBandBps = uint16(bound(bandSeed, 1, 300));
            tp.maxTotalSpreadBps = 1000;
            _setTradeParams(tp);
        }
        int256 band = int256(uint256(tp.lagBandBps));
        moveA = int256(a) % (band + 1);
        moveB = int256(b) % (band + 1);
    }

    function _roundTrip(bytes32 id, int256 moveA, int256 moveB, uint256 usdgIn)
        internal
        returns (bool done, int256 pnl)
    {
        uint256 snap = vm.snapshotState();
        _fund(alice, usdgIn);
        uint64 dl = uint64(vm.getBlockTimestamp());
        vm.startPrank(alice);
        try minter.buy(id, usdgIn, 0, alice, dl) returns (uint256 tokens) {
            vm.stopPrank();
            _legs(moveA, moveB);
            vm.startPrank(alice);
            _token(id).approve(address(minter), tokens);
            try minter.sell(id, tokens, 0, alice, dl) returns (uint256 out) {
                done = true;
                pnl = int256(out) - int256(usdgIn);
            } catch {}
        } catch {}
        vm.stopPrank();
        vm.revertToState(snap);
    }

    /// The four corners of the band for the pair (not vacuous: every round trip executes).
    function test_TwoLeg_PairCorners() public {
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        for (uint256 k; k < 4; ++k) {
            (bool done, int256 pnl) = _roundTrip(pair, k < 2 ? band : -band, k % 2 == 0 ? band : -band, 10_000e6);
            assertTrue(done, "round trip executed");
            assertLe(pnl, 0, "pair corner pays");
        }
    }

    function testFuzz_TwoLeg_MinterNeverProfits(uint8 g, int16 a, int16 b, uint16 band, bool wide, uint64 size) public {
        (int256 ma, int256 mb) = _setup(band, wide, a, b);
        bytes32[6] memory ids = [cruise, sport, race, eco, reverse, pair];
        (bool done, int256 pnl) = _roundTrip(ids[g % 6], ma, mb, bound(size, 10e6, 50_000e6));
        if (done) assertLe(pnl, 0, "two-leg lag round trip profits (minter)");
    }
}

contract TwoLegLagBackerTest is BackerFixture {
    function _legs(int256 moveA, int256 moveB) internal {
        if (moveA != 0) _price(TSLA, uint256(int256(_p(TSLA)) * (10_000 + moveA) / 10_000));
        if (moveB != 0) _price(NVDA, uint256(int256(_p(NVDA)) * (10_000 + moveB) / 10_000));
    }

    /// Fuzzed band (1..300 when `wide`, else the default) and two moves inside it.
    function _setup(uint16 bandSeed, bool wide, int16 a, int16 b) internal returns (int256 moveA, int256 moveB) {
        IODMinter.TradeParams memory tp = minter.tradeParams();
        if (wide) {
            tp.lagBandBps = uint16(bound(bandSeed, 1, 300));
            tp.maxTotalSpreadBps = 1000;
            _setTradeParams(tp);
        }
        int256 band = int256(uint256(tp.lagBandBps));
        moveA = int256(a) % (band + 1);
        moveB = int256(b) % (band + 1);
    }

    /// Short: mint and sell, the legs move, buy back. Long: buy back, the legs move, mint and sell again.
    function _roundTrip(bytes32 id, int256 moveA, int256 moveB, uint256 tokens, bool long)
        internal
        returns (int256 pnl)
    {
        uint256 snap = vm.snapshotState();
        uint256 v = _open(alice, id, 50_000e6 + tokens / 1e12 * 3);
        uint256 proceeds;
        uint256 cost;
        if (long) {
            _mint(alice, v, tokens, false);
            vm.prank(alice);
            cost = backer.repayWithUsdg(v, tokens, type(uint256).max);
            _legs(moveA, moveB);
            proceeds = _mint(alice, v, tokens, true);
        } else {
            proceeds = _mint(alice, v, tokens, true);
            _legs(moveA, moveB);
            vm.prank(alice);
            cost = backer.repayWithUsdg(v, tokens, type(uint256).max);
        }
        pnl = int256(proceeds) - int256(cost);
        vm.revertToState(snap);
    }

    function test_TwoLeg_BackerPairCorners() public {
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        for (uint256 k; k < 8; ++k) {
            int256 a = k % 4 < 2 ? band : -band;
            int256 b = k % 2 == 0 ? band : -band;
            assertLe(_roundTrip(pair, a, b, 10_000e18, k < 4), 0, "backer pair corner pays");
        }
    }

    function testFuzz_TwoLeg_BackerNeverProfits(
        uint8 g,
        int16 a,
        int16 b,
        uint16 band,
        bool wide,
        uint64 size,
        bool long
    ) public {
        (int256 ma, int256 mb) = _setup(band, wide, a, b);
        bytes32[5] memory ids = [cruise, sport, race, reverse, pair];
        int256 pnl = _roundTrip(ids[g % 5], ma, mb, bound(size, 10e18, 20_000e18), long);
        assertLe(pnl, 0, "two-leg lag round trip profits (backer)");
    }
}

contract TwoLegLagHookTest is HookFixture {
    function _legs(int256 moveA, int256 moveB) internal {
        if (moveA != 0) _price(TSLA, uint256(int256(_p(TSLA)) * (10_000 + moveA) / 10_000));
        if (moveB != 0) _price(NVDA, uint256(int256(_p(NVDA)) * (10_000 + moveB) / 10_000));
    }

    /// Fuzzed band (1..300 when `wide`, else the default) and two moves inside it.
    function _setup(uint16 bandSeed, bool wide, int16 a, int16 b) internal returns (int256 moveA, int256 moveB) {
        IODMinter.TradeParams memory tp = minter.tradeParams();
        if (wide) {
            tp.lagBandBps = uint16(bound(bandSeed, 1, 300));
            tp.maxTotalSpreadBps = 1000;
            _setTradeParams(tp);
        }
        int256 band = int256(uint256(tp.lagBandBps));
        moveA = int256(a) % (band + 1);
        moveB = int256(b) % (band + 1);
    }

    /// Buy through the pool, the legs move, sell the tokens back through the pool.
    function _roundTrip(bytes32 id, int256 moveA, int256 moveB, uint256 usdgIn) internal returns (int256 pnl) {
        uint256 snap = vm.snapshotState();
        uint256 tokens = _hookBuy(alice, id, usdgIn);
        _legs(moveA, moveB);
        (, uint256 out) = _swap(alice, id, false, true, tokens);
        pnl = int256(out) - int256(usdgIn);
        vm.revertToState(snap);
    }

    function test_TwoLeg_HookPairCorners() public {
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        for (uint256 k; k < 4; ++k) {
            assertLe(_roundTrip(pair, k < 2 ? band : -band, k % 2 == 0 ? band : -band, 5_000e6), 0, "hook pair pays");
        }
    }

    function testFuzz_TwoLeg_HookNeverProfits(uint8 g, int16 a, int16 b, uint16 band, bool wide, uint64 size) public {
        (int256 ma, int256 mb) = _setup(band, wide, a, b);
        bytes32[5] memory ids = [cruise, sport, race, reverse, pair];
        int256 pnl = _roundTrip(ids[g % 5], ma, mb, bound(size, 10e6, 10_000e6));
        assertLe(pnl, 0, "two-leg lag round trip profits (hook)");
    }
}
