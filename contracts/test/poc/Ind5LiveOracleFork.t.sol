// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ODOracleGuard} from "overdrive/oracle/ODOracleGuard.sol";
import {MarketConfig, PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";
import {MockKindCalendar} from "../mocks/OracleMocks.sol";

interface IV3PoolLike {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata)
        external
        returns (int256, int256);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// Independent check 5, live facts behind I5-1 and I5-2. Local fork of Robinhood Chain (4663) only: nothing is sent.
/// The real ODOracleGuard is deployed on the fork with the values of script/config/mainnet.json and reads the REAL
/// feed proxies, Pyth Core, Stock Tokens and v3 pools. Skips without RHC_RPC_URL.
contract Ind5LiveOracleForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    bytes32 internal constant ETH_ID = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace; // not-a-key: Pyth price id
    bytes32 internal constant BTC_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43; // not-a-key: Pyth price id
    bytes32 internal constant NVDA_ID = 0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593; // not-a-key: Pyth price id
    bytes32 internal constant SPY_ID = 0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5; // not-a-key: Pyth price id
    address internal constant ETH_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant SPY_STOCK = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant SPY_POOL = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    ODOracleGuard internal guard;
    address internal admin = makeAddr("admin");
    bool internal skipped;

    function setUp() public {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            skipped = true;
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        MockKindCalendar cal = new MockKindCalendar(Session.OPEN); // in session, whatever the day of the run
        guard = new ODOracleGuard(admin, makeAddr("guardian"), address(cal), PYTH, address(0));
        vm.startPrank(admin);
        guard.setMarket("ETH", _cfg(ETH_FEED, address(0), address(0), ETH_ID, 259200, true));
        guard.setMarket("SPY", _cfg(SPY_FEED, SPY_STOCK, SPY_POOL, SPY_ID, 259200, false));
        vm.stopPrank();
    }

    /// The market values of script/config/mainnet.json.
    function _cfg(address feed, address token, address pool, bytes32 pythId, uint32 maxAge, bool always)
        internal
        pure
        returns (MarketConfig memory c)
    {
        c.feed = feed;
        c.stockToken = token;
        c.multiplierEmbedded = true;
        c.pythMultiplierEmbedded = false;
        c.alwaysOpen = always;
        c.pythId = pythId;
        c.twapPool = pool;
        c.maxAgeOpen = maxAge;
        c.maxAgeExtended = maxAge;
        c.maxAgeClosed = 432000;
        c.refMaxAge = 120;
        c.twapWindow = 1800;
        c.refBandBps = 200;
        c.continuityBps = 1500;
        c.enabled = true;
    }

    function _pythAge(bytes32 id) internal view returns (bool found, uint256 age) {
        (bool ok, bytes memory data) = PYTH.staticcall(abi.encodeWithSignature("getPriceUnsafe(bytes32)", id));
        if (!ok || data.length < 128) return (false, 0);
        (,,, uint256 publishTime) = abi.decode(data, (int64, uint64, int32, uint256));
        return (true, block.timestamp - publishTime);
    }

    /// I5-2: the reference the mainnet config names first is not there. ETH and BTC then have no reference at all.
    function test_I5_2_Live_PythIsNotPushedOn4663() public {
        (bool fE, uint256 aE) = _pythAge(ETH_ID);
        (bool fB, uint256 aB) = _pythAge(BTC_ID);
        (bool fN, uint256 aN) = _pythAge(NVDA_ID);
        (bool fS, uint256 aS) = _pythAge(SPY_ID);
        emit log_named_uint("ETH  Pyth found (1/0)", fE ? 1 : 0);
        emit log_named_uint("ETH  Pyth age (s)", aE);
        emit log_named_uint("BTC  Pyth found (1/0)", fB ? 1 : 0);
        emit log_named_uint("BTC  Pyth age (s)", aB);
        emit log_named_uint("NVDA Pyth found (1/0)", fN ? 1 : 0);
        emit log_named_uint("NVDA Pyth age (s)", aN);
        emit log_named_uint("SPY  Pyth found (1/0)", fS ? 1 : 0);
        emit log_named_uint("SPY  Pyth age (s)", aS);
        assertTrue(!fE || aE > 120, "ETH Pyth is older than refMaxAge (120 s)");
        assertTrue(!fB || aB > 120, "BTC Pyth is older than refMaxAge (120 s)");

        PriceReading memory r = guard.read("ETH");
        assertEq(r.refP, 0, "ETH: no reference with the mainnet config");
        assertEq(r.reason, bytes32("REF_UNAVAILABLE"));
        assertTrue(r.buysPaused);

        (uint256 refSpy, bool fromPyth) = guard.refPrice("SPY");
        assertFalse(fromPyth, "SPY: the reference in force is the v3 TWAP, not Pyth");
        assertGt(refSpy, 0);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        if (a0 > 0) IERC20(IV3PoolLike(msg.sender).token0()).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(IV3PoolLike(msg.sender).token1()).transfer(msg.sender, uint256(a1));
    }

    /// I5-1 on the real SPY pool: buy the in-range liquidity (tick goes to the top), wait `HOLD` seconds, sell back.
    /// Measures the USDG the round trip costs and what the guard's reference reads afterwards.
    function test_I5_1_Live_TwapSpikeCostOnTheRealSpyPool() public {
        uint256 HOLD = 15;
        (uint256 ref0,) = guard.refPrice("SPY");
        IV3PoolLike pool = IV3PoolLike(SPY_POOL);
        require(pool.token1() == USDG && pool.token0() == SPY_STOCK, "pool sides");
        (, int24 tick0,,,,,) = pool.slot0();

        uint256 budget = 5_000_000e6;
        deal(USDG, address(this), budget);
        // USDG in (token1), stock out (token0), no price limit
        (int256 d0, int256 d1) = pool.swap(address(this), false, int256(budget), MAX_SQRT, "");
        uint256 spent = uint256(d1);
        uint256 bought = uint256(-d0);
        (, int24 tick1,,,,,) = pool.slot0();

        vm.warp(block.timestamp + HOLD);
        vm.roll(block.number + HOLD);
        (, int256 back1) = pool.swap(address(this), true, int256(bought), MIN_SQRT, "");
        uint256 got = uint256(-back1);
        (, int24 tick2,,,,,) = pool.slot0();

        (uint256 ref1,) = guard.refPrice("SPY");
        emit log_named_int("tick before", tick0);
        emit log_named_int("tick during the hold", tick1);
        emit log_named_int("tick after the sell-back", tick2);
        emit log_named_decimal_uint("USDG spent buying the range", spent, 6);
        emit log_named_decimal_uint("USDG back from the sell", got, 6);
        emit log_named_decimal_uint("round trip cost (USDG)", spent > got ? spent - got : 0, 6);
        emit log_named_decimal_uint("guard reference before (USD)", ref0, 18);
        emit log_named_decimal_uint("guard reference after  (USD)", ref1, 18);
        emit log_named_uint("reference move (bps)", (ref1 - ref0) * 10_000 / ref0);
        emit log_named_uint("SPORT debt value multiplier (bps)", ref1 * ref1 / ref0 * 10_000 / ref0);

        PriceReading memory r = guard.read("SPY");
        // SPORT debt value moves with the square: above x1.3334 a vault at the 200% initial ratio is under 150%
        assertGt(ref1 * ref1 / ref0 * 10_000 / ref0, 13_334, "a 15 s hold makes a 200% SPORT vault sealable");
        assertTrue(r.fresh && r.session == Session.OPEN, "the reading stays live, so sealBatch accepts it");
        assertEq(r.reason, bytes32("REF_BAND"));
    }
}
