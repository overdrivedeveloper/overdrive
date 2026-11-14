// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";

/// Audit rescore 1 M-4 (backer leg): a vault sold to the Governor (mint with sellToGovernor) and bought back
/// (repayWithUsdg) at the base spread, so a round trip across a move both sources did not show yet still paid inside
/// the lag band (RACE +89.70, SPORT +40.05 per 10,000 at 0.5%). ODBacker now applies the minter's per-gear lag floor.
/// Fails on 3fe7859. Directions: short (sell, value falls, buy back) and long (buy back, value rises, sell again).
contract BackerLagRoundTripTest is BackerFixture {
    /// Price move that lowers (short) or raises (long) the gear's value by moving TSLA by `bps` (sign by power).
    function _move(bytes32 id, uint256 bps, bool valueDown) internal {
        bool priceDown = id == reverse ? !valueDown : valueDown;
        uint256 p0 = _p(TSLA);
        uint256 p1 = priceDown ? p0 * (10_000 - bps) / 10_000 : p0 * (10_000 + bps) / 10_000;
        _price(TSLA, p1);
    }

    /// Short: mint and sell `tokens`, the value falls by up to the band, buy them back.
    function _short(bytes32 id, uint256 bps, uint256 tokens) internal returns (int256 pnl) {
        uint256 snap = vm.snapshotState();
        uint256 v = _open(alice, id, 50_000e6 + tokens / 1e12 * 3);
        uint256 proceeds = _mint(alice, v, tokens, true);
        if (bps != 0) _move(id, bps, true);
        vm.prank(alice);
        uint256 cost = backer.repayWithUsdg(v, tokens, type(uint256).max);
        pnl = int256(proceeds) - int256(cost);
        vm.revertToState(snap);
    }

    /// Long: a vault with debt buys `tokens` back, the value rises by up to the band, it mints and sells them again.
    function _long(bytes32 id, uint256 bps, uint256 tokens) internal returns (int256 pnl) {
        uint256 snap = vm.snapshotState();
        uint256 v = _open(alice, id, 50_000e6 + tokens / 1e12 * 3);
        _mint(alice, v, tokens, false); // debt held as tokens elsewhere: this vault owes `tokens`
        vm.prank(alice);
        uint256 cost = backer.repayWithUsdg(v, tokens, type(uint256).max);
        if (bps != 0) _move(id, bps, false);
        uint256 proceeds = _mint(alice, v, tokens, true);
        pnl = int256(proceeds) - int256(cost);
        vm.revertToState(snap);
    }

    function _band() internal view returns (uint256) {
        return minter.tradeParams().lagBandBps;
    }

    /// The PoC, flipped: RACE and SPORT short round trips at 0.5% lose.
    function test_M4Backer_PocFlipped() public {
        assertLe(_short(race, 50, 10_000e18), 0, "RACE short round trip pays inside the band");
        assertLe(_short(sport, 50, 10_000e18), 0, "SPORT short round trip pays inside the band");
    }

    /// Every backable gear at exactly the band, both directions; ECO is not backable.
    function test_M4Backer_AllGearsAtTheBand() public {
        bytes32[5] memory ids = [cruise, sport, race, reverse, pair];
        uint256 band = _band();
        for (uint256 i; i < 5; ++i) {
            assertLe(_short(ids[i], band, 10_000e18), 0, "short pays");
            assertLe(_long(ids[i], band, 10_000e18), 0, "long pays");
            assertLe(_short(ids[i], band, 10e18), 0, "short pays (small)");
        }
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(backer), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotBackable.selector, eco));
        backer.openVault(eco, 100e6);
        vm.stopPrank();
    }

    /// Property: every backable gear, any move inside the band, any size, both directions: never a profit.
    function testFuzz_M4Backer_RoundTripNeverProfits(uint8 g, uint16 move, uint64 size, bool long) public {
        bytes32[5] memory ids = [cruise, sport, race, reverse, pair];
        bytes32 id = ids[g % 5];
        uint256 bps = uint256(move) % (_band() + 1);
        uint256 tokens = bound(size, 10e18, 20_000e18);
        int256 pnl = long ? _long(id, bps, tokens) : _short(id, bps, tokens);
        assertLe(pnl, 0, "backer lag round trip profits");
    }

    /// The same with a wider band set by the timelock (the floor follows TradeParams.lagBandBps).
    function testFuzz_M4Backer_WiderBand(uint16 bandBps, uint8 g, bool long) public {
        IODMinter.TradeParams memory tp = minter.tradeParams();
        tp.lagBandBps = uint16(bound(bandBps, 1, 300));
        tp.maxTotalSpreadBps = 1000;
        _setTradeParams(tp);
        bytes32[5] memory ids = [cruise, sport, race, reverse, pair];
        bytes32 id = ids[g % 5];
        int256 pnl = long ? _long(id, tp.lagBandBps, 5_000e18) : _short(id, tp.lagBandBps, 5_000e18);
        assertLe(pnl, 0, "backer lag round trip profits");
    }
}
