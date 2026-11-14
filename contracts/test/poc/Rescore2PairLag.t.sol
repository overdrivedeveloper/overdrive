// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";

/// Audit rescore 2, M-4 pair leg (ported PoC, assertion flipped). The lag floor was sized for ONE market moving by
/// lagBandBps. A pair gear is priced on the ratio of two markets; each feed may lag by its own band, so the ratio can
/// hide about twice the band: TSLA +50 bps and NVDA -50 bps paid +98.48 USDG per 10,000 on 2923f09. The floor for a
/// pair now uses both legs' bands. Fails on 2923f09, passes after the fix.
contract Rescore2PairLagTest is SystemFixture {
    function _roundTrip(int256 moveA, int256 moveB, uint256 usdgIn) internal returns (bool done, int256 pnl) {
        uint256 snap = vm.snapshotState();
        uint256 a1 = uint256(int256(_p(TSLA)) * (10_000 + moveA) / 10_000);
        uint256 b1 = uint256(int256(_p(NVDA)) * (10_000 + moveB) / 10_000);
        _fund(alice, usdgIn);
        uint64 dl = uint64(vm.getBlockTimestamp());
        vm.startPrank(alice);
        try minter.buy(pair, usdgIn, 0, alice, dl) returns (uint256 tokens) {
            vm.stopPrank();
            if (moveA != 0) _price(TSLA, a1);
            if (moveB != 0) _price(NVDA, b1);
            vm.startPrank(alice);
            _token(pair).approve(address(minter), tokens);
            try minter.sell(pair, tokens, 0, alice, dl) returns (uint256 out) {
                done = true;
                pnl = int256(out) - int256(usdgIn);
            } catch {}
        } catch {}
        vm.stopPrank();
        vm.revertToState(snap);
    }

    /// The PoC, flipped: each market moves by exactly the band, in opposite directions; the round trip loses.
    function test_PoC_PairBothLegsInsideBandLoses() public {
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        (bool done, int256 pnl) = _roundTrip(band, -band, 10_000e6);
        assertTrue(done, "round trip executed");
        assertLe(pnl, 0, "pair round trip at +band/-band pays");
        (done, pnl) = _roundTrip(band / 2 + 10, -(band / 2 + 10), 10_000e6);
        assertTrue(done, "round trip executed");
        assertLe(pnl, 0, "pair round trip at +35/-35 bps pays");
        (done, pnl) = _roundTrip(-band, band, 10_000e6);
        assertTrue(done, "round trip executed");
        assertLe(pnl, 0, "pair round trip at -band/+band pays");
    }

    /// Control (kept from the PoC): one leg at the band, and no move at all, both lose.
    function test_Control_OneLegAtBandLoses() public {
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        (bool done, int256 pnl) = _roundTrip(band, 0, 10_000e6);
        assertTrue(done);
        assertLe(pnl, 0);
        (done, pnl) = _roundTrip(0, 0, 10_000e6);
        assertTrue(done);
        assertLt(pnl, 0);
    }
}
