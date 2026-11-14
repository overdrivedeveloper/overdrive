// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ODTickPrice} from "../../src/oracle/ODTickPrice.sol";
import {ODTwapReader} from "../../src/oracle/ODTwapReader.sol";
import {MockV3OraclePool, BrokenSource} from "../mocks/OracleMocks.sol";

contract TwapProbe {
    function priceX128(int24 tick) external pure returns (uint256) {
        return ODTickPrice.priceX128(tick);
    }

    function price(address pool, uint32 window, bool baseIsToken0, uint8 scaleExp) external view returns (uint256) {
        return ODTwapReader.price(
            ODTwapReader.Source({pool: pool, window: window, baseIsToken0: baseIsToken0, scaleExp: scaleExp}), 1e33
        );
    }

    function oldestAge(address pool) external view returns (uint256) {
        return ODTwapReader.oldestObservationAge(pool);
    }

    function tickToPrice(int256 tick, bool baseIsToken0, uint8 scaleExp) external pure returns (uint256) {
        return ODTwapReader.tickToPrice(tick, baseIsToken0, scaleExp, 1e33);
    }
}

contract TwapReaderTest is Test {
    TwapProbe private probe;
    uint32 private constant WINDOW = 30 minutes;
    address private constant BASE = address(0x1000);
    address private constant QUOTE = address(0x2000);
    // Price 250 USDG (6 decimals) per 18-decimal token: 1.0001^-221107 * 1e12 = 249.99141...
    int24 private constant TICK_250 = -221_107;
    uint256 private constant P_250 = 249_991_414_989_782_094_182; // WAD, floor of the exact value

    function setUp() public {
        vm.warp(1_790_000_000);
        probe = new TwapProbe();
    }

    function _close(uint256 actual, uint256 expected) internal pure {
        assertApproxEqRel(actual, expected, 1e6); // one part in 1e12
    }

    function test_PriceAtTickMatchesHighPrecisionValues() public view {
        assertEq(probe.priceX128(0), 1 << 128);
        _close(probe.priceX128(1), 340316395157630557309720944892511388277);
        _close(probe.priceX128(-1), 340248342086729790484326174814286782777);
        _close(probe.priceX128(100), 343702089724658134425462205873642501801);
        _close(probe.priceX128(-100), 336896669234911992640369586824150439382);
        _close(probe.priceX128(230_270), 3402816172152106897752883789203779004780791714000);
        _close(probe.priceX128(-230_270), 34028311662831798279336896755);
        _close(probe.priceX128(276_324), 340281467274263344194458752290081064433641032252902);
        _close(probe.priceX128(-276_324), 340283266569992096456638595);
        _close(probe.priceX128(500_000), 1759859011403883232411658396185743491736454138057830842837113);
        _close(probe.priceX128(-500_000), 65796230542892166);
    }

    function testFuzz_PriceIsMonotonicInTick(int24 tick) public view {
        tick = int24(bound(tick, -600_000, 600_000));
        assertGe(probe.priceX128(tick + 1), probe.priceX128(tick));
    }

    function test_PriceX128NeverRevertsAtExtremeTicks() public view {
        int24[5] memory ticks = [int24(880_340), 880_341, 884_000, 887_271, 887_272];
        for (uint256 i; i < ticks.length; ++i) {
            probe.priceX128(ticks[i]);
            probe.priceX128(-ticks[i]);
        }
    }

    function test_ExtremeTickReadsUnavailable() public view {
        assertEq(probe.tickToPrice(887_272, true, 30), 0, "above MAX_P");
        assertEq(probe.tickToPrice(-887_272, false, 30), 0, "above MAX_P inverted");
        assertEq(probe.tickToPrice(887_273, true, 12), 0, "out of range");
        assertEq(probe.tickToPrice(0, true, 61), 0, "scale too large");
    }

    function test_BaseAsToken0AndToken1() public {
        MockV3OraclePool p0 = new MockV3OraclePool(BASE, QUOTE, TICK_250);
        MockV3OraclePool p1 = new MockV3OraclePool(QUOTE, BASE, -TICK_250);
        uint256 a = probe.price(address(p0), WINDOW, true, 30);
        uint256 b = probe.price(address(p1), WINDOW, false, 30);
        _close(a, P_250);
        _close(b, P_250);
    }

    function test_NegativeMeanTickRoundsDown() public {
        // cumulative delta of (-221107 * W - 1) must floor to -221108.
        MockV3OraclePool p = new MockV3OraclePool(BASE, QUOTE, TICK_250 - 1);
        uint256 lower = probe.price(address(p), WINDOW, true, 30);
        p.setTick(TICK_250);
        vm.warp(block.timestamp + WINDOW);
        p.setTick(TICK_250 - 1);
        vm.warp(block.timestamp + 1); // window now holds W-1 seconds of TICK_250 and 1 second of TICK_250 - 1
        assertEq(probe.price(address(p), WINDOW, true, 30), lower);
    }

    function test_ShortHistoryGivesZero() public {
        MockV3OraclePool p = new MockV3OraclePool(BASE, QUOTE, TICK_250);
        p.setOldest(uint32(block.timestamp - WINDOW + 1));
        assertEq(probe.oldestAge(address(p)), WINDOW - 1);
        assertEq(probe.price(address(p), WINDOW, true, 30), 0);
        p.setOldest(uint32(block.timestamp - WINDOW));
        _close(probe.price(address(p), WINDOW, true, 30), P_250);
    }

    function test_UninitialisedRingGivesZero() public {
        MockV3OraclePool p = new MockV3OraclePool(BASE, QUOTE, TICK_250);
        p.setUninitialised(true);
        assertEq(probe.price(address(p), WINDOW, true, 30), 0);
        p.setUninitialised(false);
        p.setRing(1, 1); // index out of the ring
        assertEq(probe.price(address(p), WINDOW, true, 30), 0);
        p.setRing(0, 0);
        assertEq(probe.price(address(p), WINDOW, true, 30), 0);
    }

    function test_UnavailablePoolOrWindowGivesZero() public {
        MockV3OraclePool p = new MockV3OraclePool(BASE, QUOTE, TICK_250);
        assertEq(probe.price(address(0), WINDOW, true, 30), 0, "no pool");
        assertEq(probe.price(address(0xdead), WINDOW, true, 30), 0, "no code");
        assertEq(probe.price(address(p), 0, true, 30), 0, "zero window");
        p.setRevert(true);
        assertEq(probe.price(address(p), WINDOW, true, 30), 0, "reverting pool");
        for (uint8 m; m < 6; ++m) {
            BrokenSource b = new BrokenSource(m);
            assertEq(probe.price(address(b), WINDOW, true, 30), 0);
            assertEq(probe.oldestAge(address(b)), 0);
        }
    }

    function test_SingleBlockSpikeMovesTwapByItsDuration() public {
        MockV3OraclePool p = new MockV3OraclePool(BASE, QUOTE, TICK_250);
        p.setTick(TICK_250 + 10_000); // about +172%, held for 1 second
        vm.warp(block.timestamp + 1);
        p.setTick(TICK_250);
        vm.warp(block.timestamp + 12);
        uint256 twap = probe.price(address(p), WINDOW, true, 30);
        // Mean tick moves by 10000 / 1800 = 5 ticks: about 0.06%.
        assertApproxEqRel(twap, P_250, 0.001e18);
    }
}
