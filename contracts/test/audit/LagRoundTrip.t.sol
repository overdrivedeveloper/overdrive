// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "../system/SystemFixture.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

contract MaxDiscount {
    function feeDiscountOf(address) external pure returns (uint256) {
        return 2_000;
    }
}

/// M-4 (audit early pass, the R14 residual): when the feed AND the reference both lag a move, a buy before and a sell
/// after pays the trader |power| x move - 2 spreads (RACE +0.89%, SPORT +0.39% at 0.5% and 30 bps). The spread now has
/// a per-gear floor so that a round trip across any move up to TradeParams.lagBandBps never profits.
contract LagRoundTripTest is SystemFixture {
    function _roundTrip(bytes32 id, int256 moveBps, uint256 usdgIn) internal returns (bool done, int256 pnl) {
        uint256 snap = vm.snapshotState();
        uint256 p0 = _p(TSLA);
        uint256 p1 = uint256(int256(p0) * (10_000 + moveBps) / 10_000);
        _fund(alice, usdgIn);
        uint64 dl = uint64(vm.getBlockTimestamp());
        vm.startPrank(alice);
        try minter.buy(id, usdgIn, 0, alice, dl) returns (uint256 tokens) {
            vm.stopPrank();
            _price(TSLA, p1); // both sources now show the move the trader knew about
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

    /// The audit PoC, flipped: a 0.5% joint lag no longer pays on RACE or SPORT (in either direction).
    function test_M4_LagRoundTripUnprofitable() public {
        bytes32[2] memory ids = [race, sport];
        for (uint256 i; i < 2; ++i) {
            (bool up, int256 a) = _roundTrip(ids[i], 50, 10_000e6);
            (bool dn, int256 b) = _roundTrip(ids[i], -50, 10_000e6);
            assertTrue(up && dn, "round trips executed");
            assertLe(a, 0, "up move: no profit");
            assertLe(b, 0, "down move: no profit");
        }
    }

    /// Every gear at exactly the band, both ways, small and large sizes (the fuzz below must not be vacuous).
    function test_M4_AllGearsAtTheBand() public {
        bytes32[6] memory ids = [cruise, sport, race, eco, reverse, pair];
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        for (uint256 i; i < 6; ++i) {
            for (uint256 k; k < 4; ++k) {
                (bool done, int256 pnl) = _roundTrip(ids[i], k % 2 == 0 ? band : -band, k < 2 ? 10e6 : 40_000e6);
                assertTrue(done, "round trip executed");
                assertLe(pnl, 0, "no profit at the band");
            }
        }
    }

    /// The floor holds after the largest staking discount and in every session the quote can see.
    function test_M4_FloorSurvivesDiscount() public {
        address md = address(new MaxDiscount());
        vm.prank(admin);
        minter.setStake(md);
        IODMinter.TradeParams memory tp = minter.tradeParams();
        vm.prank(alice);
        uint16 s = minter.quote(race, true, true, 100e6).spreadBps;
        assertGe(uint256(s) * 2 * 10_000, uint256(30_000) * tp.lagBandBps, "RACE floor >= 3 x band / 2");
    }

    /// Property: for every gear, any move up to the lag band either way, any size and the largest staking
    /// discount, a buy-then-sell round trip across the move never returns more than it cost.
    function testFuzz_M4_RoundTripNeverProfits(uint8 g, int16 move, uint64 size, bool staker) public {
        bytes32[6] memory ids = [cruise, sport, race, eco, reverse, pair];
        bytes32 id = ids[g % 6];
        int256 band = int256(uint256(minter.tradeParams().lagBandBps));
        int256 m = int256(move) % (band + 1);
        uint256 usdgIn = bound(size, 10e6, 50_000e6);
        if (staker) {
            address md = address(new MaxDiscount());
            vm.prank(admin);
            minter.setStake(md);
        }
        (bool done, int256 pnl) = _roundTrip(id, m, usdgIn);
        if (done) assertLe(pnl, 0, "lag round trip profits");
    }

    /// The same property with a wider band set by the timelock (up to its 300 bps maximum).
    function testFuzz_M4_WiderBand(uint16 bandBps, uint8 g, bool up) public {
        IODMinter.TradeParams memory tp = minter.tradeParams();
        tp.lagBandBps = uint16(bound(bandBps, 1, 300));
        tp.maxTotalSpreadBps = 1000;
        _setTradeParams(tp);
        bytes32[5] memory ids = [cruise, sport, race, reverse, pair];
        int256 m = up ? int256(uint256(tp.lagBandBps)) : -int256(uint256(tp.lagBandBps));
        (bool done, int256 pnl) = _roundTrip(ids[g % 5], m, 5_000e6);
        if (done) assertLe(pnl, 0, "lag round trip profits");
    }
}
