// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockPyth} from "../mocks/MockPyth.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockKindCalendar, MockV3OraclePool, MockAggregatorImpl} from "../mocks/OracleMocks.sol";

/// Shared setup: one stock market ("TSLA") at 250 USD with a Chainlink-shaped feed (8 decimals), a Stock Token,
/// a v3 TWAP pool at the same price, Pyth configured off, and a step calendar that reads OPEN.
abstract contract OracleFixture is Test {
    bytes32 internal constant M = "TSLA";
    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant PYTH_ID = keccak256("pyth TSLA");
    uint256 internal constant T0 = 1_790_000_000;
    int24 internal constant TICK_250 = -221_107; // 249.9914 USDG per token
    int256 internal constant ANSWER_250 = 250e8;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    ODOracleGuard internal guard;
    MockKindCalendar internal cal;
    MockAggregator internal feed;
    MockAggregator internal ethFeed;
    MockStockToken internal token;
    MockUSDG internal usdg;
    MockV3OraclePool internal pool;
    MockPyth internal pyth;
    address internal aggImpl;

    function setUp() public virtual {
        vm.warp(T0);
        cal = new MockKindCalendar(Session.OPEN);
        pyth = new MockPyth();
        guard = _deployGuard(address(0));
        token = new MockStockToken();
        usdg = new MockUSDG();
        aggImpl = address(new MockAggregatorImpl());
        feed = _newFeed(8, ANSWER_250);
        ethFeed = _newFeed(8, 3000e8);
        pool = _newPool(address(token), TICK_250);
        vm.startPrank(admin);
        guard.setMarket(M, _cfg());
        guard.setMarket(ETH, _ethCfg());
        vm.stopPrank();
    }

    function _deployGuard(address sequencer) internal returns (ODOracleGuard) {
        return new ODOracleGuard(admin, guardian, address(cal), address(pyth), sequencer);
    }

    function _newFeed(uint8 decimals, int256 answer) internal returns (MockAggregator f) {
        f = new MockAggregator(decimals, answer);
        f.setAggregator(aggImpl);
    }

    /// A pool of `base` against USDG whose price is 1.0001^tick (base as token0) in raw units.
    function _newPool(address base, int24 tickBaseToken0) internal returns (MockV3OraclePool p) {
        bool baseIs0 = base < address(usdg);
        p = baseIs0
            ? new MockV3OraclePool(base, address(usdg), tickBaseToken0)
            : new MockV3OraclePool(address(usdg), base, -tickBaseToken0);
    }

    function _setPoolTick(int24 tickBaseToken0) internal {
        pool.setTick(address(token) < address(usdg) ? tickBaseToken0 : -tickBaseToken0);
    }

    function _cfg() internal view returns (MarketConfig memory c) {
        c.feed = address(feed);
        c.stockToken = address(token);
        c.multiplierEmbedded = true;
        c.pythMultiplierEmbedded = false;
        c.alwaysOpen = false;
        c.pythId = bytes32(0);
        c.twapPool = address(pool);
        c.maxAgeOpen = 26 hours;
        c.maxAgeExtended = 26 hours;
        c.maxAgeClosed = 5 days;
        c.refMaxAge = 1 hours;
        c.twapWindow = 30 minutes;
        c.refBandBps = 200;
        c.continuityBps = 1500;
        c.enabled = true;
    }

    function _ethCfg() internal view returns (MarketConfig memory c) {
        c.feed = address(ethFeed);
        c.alwaysOpen = true;
        c.maxAgeOpen = 26 hours;
        c.maxAgeClosed = 5 days;
        c.refMaxAge = 1 hours;
        c.pythId = keccak256("pyth ETH");
        c.refBandBps = 200;
        c.continuityBps = 1500;
        c.enabled = true;
    }

    function _set(bytes32 m, MarketConfig memory c) internal {
        vm.prank(admin);
        guard.setMarket(m, c);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    /// Pyth price for TSLA: price with expo -8, conf 0.1%, published now.
    function _pythAt(bytes32 id, int64 price) internal {
        pyth.setPrice(id, price, uint64(uint256(int256(price)) / 1000), -8, _now());
    }

    function _r() internal view returns (PriceReading memory) {
        return guard.read(M);
    }

    function _assertSession(PriceReading memory r, Session s) internal pure {
        assertEq(uint256(r.session), uint256(s), "session");
    }
}
