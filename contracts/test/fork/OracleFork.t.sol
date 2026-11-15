// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {ODTest} from "../utils/ODTest.sol";
import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {ODMarketHours} from "../../src/oracle/ODMarketHours.sol";
import {SessionWindow} from "../../src/interfaces/IODMarketHours.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";

/// Live Robinhood Chain (4663) feeds, Stock Tokens, v3 pools and Pyth Core, on a fork of the latest block. Skips
/// without RHC_RPC_URL. Addresses and per-feed age bounds come from the 2026-11-13 chain survey: the in-session bound
/// is 1.25 x the largest observed in-session gap (at least 26 h), the closed bound 1.25 x the largest closed gap
/// (5 to 14 days), because quiet feeds (SPY, QQQ, AAPL, MSFT, AMZN) go about 1 day in session and 3.8 days over a
/// weekend without a round. The fixture forces an OPEN session around the fork block, so the in-session age limit is
/// the one in force on any day. That limit is never loosened here: a feed whose latest round is older than it (a
/// 26 h feed late on a weekend, any feed after a long holiday) must read HALTED, and the tests assert exactly that for
/// such a market (`_assertLiveOrHalted`) and run the live checks for every market inside its limit. The expected side
/// comes from the feed's own latestRoundData, read here and not through the guard.
contract OracleForkTest is ODTest {
    address internal constant PYTH_CORE = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    uint32 internal constant REF_MAX_AGE = 120;

    struct Mkt {
        bytes32 id;
        string sym;
        address token;
        address feed;
        address pool;
        bytes32 pythId;
        uint32 maxAgeInSession;
        uint32 maxAgeClosed;
        bool twapUsable;
    }

    Mkt[] internal mkts;
    ODOracleGuard internal guard;
    ODMarketHours internal mh;
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal guardian = makeAddr("guardian");

    function _add(
        string memory sym,
        address token,
        address feed,
        address pool,
        bytes32 pythId,
        uint32 inSession,
        uint32 closed,
        bool usable
    ) internal {
        mkts.push(Mkt(bytes32(bytes(sym)), sym, token, feed, pool, pythId, inSession, closed, usable));
    }

    function _setUpFork() internal {
        forkOrSkip();
        _add(
            "ETH",
            address(0),
            0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9,
            address(0),
            0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace, // not-a-key: Pyth price id
            284400,
            432000,
            false
        );
        _add(
            "BTC",
            address(0),
            0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251,
            address(0),
            0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43, // not-a-key: Pyth price id
            111600,
            432000,
            false
        );
        _add(
            "TSLA",
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
            0x4A1166a659A55625345e9515b32adECea5547C38,
            0xf4ACdAEEB7022862A763C9B1B885e11191c889E3,
            0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1, // not-a-key: Pyth price id
            93600,
            432000,
            true
        );
        _add(
            "NVDA",
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
            0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
            0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3,
            0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593, // not-a-key: Pyth price id
            93600,
            432000,
            true
        );
        _add(
            "SPY",
            0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,
            0x319724394D3A0e3669269846abE664Cd621f9f6A,
            0xa7Bb1AC63BBaB0C44316E6c8C455213441689167,
            0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5, // not-a-key: Pyth price id
            367200,
            432000,
            true
        );
        _add(
            "QQQ",
            0xD5f3879160bc7c32ebb4dC785F8a4F505888de68,
            0x80901d846d5D7B030F26B480776EE3b29374C2ae,
            0xD60A5d14dB690B7Afad71F76B108071D7175597d,
            0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d, // not-a-key: Pyth price id
            414000,
            432000,
            true
        );
        _add(
            "AAPL",
            0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,
            0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,
            0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D,
            0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688, // not-a-key: Pyth price id
            345600,
            432000,
            true
        );
        _add(
            "MSFT",
            0xe93237C50D904957Cf27E7B1133b510C669c2e74,
            0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E,
            0xeb60bCD1D920ad6E102690CCFC6fB488899E1510,
            0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1, // not-a-key: Pyth price id
            363600,
            432000,
            true
        );
        _add(
            "META",
            0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35,
            0x7C38C00C30BEe9378381E7B6135d7283356D71b1,
            0x107a7Cb40d8665360ba10E59471Af06150A50922,
            0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe, // not-a-key: Pyth price id
            108000,
            432000,
            true
        );
        _add(
            "AMZN",
            0x12f190a9F9d7D37a250758b26824B97CE941bF54,
            0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C,
            0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef,
            0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a, // not-a-key: Pyth price id
            345600,
            432000,
            true
        );
        _add(
            "COIN",
            0x6330D8C3178a418788dF01a47479c0ce7CCF450b,
            0xA3a468A452940B7D6b69991207B508c609a98Ef2,
            0x3a6eC0aa6C702323414d449B5F60f4B742A82dED,
            0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245, // not-a-key: Pyth price id
            93600,
            432000,
            false
        );
        _add(
            "MSTR",
            0xec262a75e413fAfD0dF80480274532C79D42da09,
            0x396118bdFB181e6240E74D243F266B061c0edc3D,
            0x17578C0e0D15da44f31677263114F71aE76653EA,
            0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09, // not-a-key: Pyth price id
            93600,
            432000,
            true
        );
        _add(
            "PLTR",
            0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A,
            0x820ABedFF239034956B7A9d2F0a331f9F075eB4c,
            0x851680416A4f4E1c463d45171d61ACDdBc8554c0,
            0x11a70634863ddffb71f2b11f2cff29f73f3db8f6d0b78c49f2b5f4ad36e885f0, // not-a-key: Pyth price id
            93600,
            432000,
            true
        );
        _add(
            "AMD",
            0x86923f96303D656E4aa86D9d42D1e57ad2023fdC,
            0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72,
            0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f,
            0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e, // not-a-key: Pyth price id
            104400,
            432000,
            true
        );
        mh = new ODMarketHours(admin, keeper);
        // One OPEN window around the fork block. Since L-9 the keeper cannot push a window over calendar-closed time
        // (a weekend fork block), so the fixture writes it into storage (as ForkSystem does). ODMarketHours layout:
        // slot 0 AccessControl._roles, slot 1 _sessions, slot 2 _kinds (Session.OPEN is 0).
        uint256 open = block.timestamp - 1 hours;
        uint256 close = block.timestamp + 1 hours;
        vm.store(address(mh), bytes32(uint256(1)), bytes32(uint256(1)));
        vm.store(address(mh), keccak256(abi.encode(uint256(1))), bytes32(open | (close << 64)));
        vm.store(address(mh), bytes32(uint256(2)), bytes32(uint256(1)));
        SessionWindow[] memory w = mh.sessions();
        require(w.length == 1 && w[0].open == open && w[0].close == close, "OracleFork: ODMarketHours layout moved");
        require(mh.kindAt(block.timestamp) == Session.OPEN, "OracleFork: forced window not read");
        guard = new ODOracleGuard(admin, guardian, address(mh), PYTH_CORE, address(0));
        vm.startPrank(admin);
        for (uint256 i; i < mkts.length; ++i) {
            guard.setMarket(mkts[i].id, _cfg(mkts[i]));
        }
        vm.stopPrank();
    }

    function _cfg(Mkt memory m) internal pure returns (MarketConfig memory c) {
        c.feed = m.feed;
        c.stockToken = m.token;
        c.multiplierEmbedded = true; // Robinhood docs: feed = share price x multiplier
        c.pythMultiplierEmbedded = false; // Pyth equity prices one share
        c.alwaysOpen = m.token == address(0);
        c.pythId = m.pythId;
        c.twapPool = m.pool;
        c.maxAgeOpen = _limit(m);
        c.maxAgeExtended = _limit(m);
        c.maxAgeClosed = m.maxAgeClosed;
        c.refMaxAge = REF_MAX_AGE;
        c.twapWindow = 30 minutes;
        c.refBandBps = 200;
        c.continuityBps = 1500;
        c.enabled = true;
    }

    /// The in-session age limit in force: the surveyed bound, held to the guard's hard cap (I4-3).
    function _limit(Mkt memory m) internal pure returns (uint32) {
        return m.maxAgeInSession > 3 days ? uint32(3 days) : m.maxAgeInSession;
    }

    /// Age of the feed's latest round, read from the feed itself (not through the guard).
    function _feedAge(Mkt memory m) internal view returns (uint256) {
        (, bytes memory d) = m.feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        (,,, uint256 updatedAt,) = abi.decode(d, (uint80, int256, uint256, uint256, uint80));
        return block.timestamp - updatedAt;
    }

    /// Deterministic on any day: a round inside the limit with no long close since its print must read live in the
    /// forced OPEN session; a round past the limit, or printed before the last long close (I7-2), must read HALTED (not fresh, buys paused with reason HALTED, never a live price). Returns true when live.
    function _assertLiveOrHalted(Mkt memory m, PriceReading memory r) internal returns (bool live) {
        uint256 age = _feedAge(m);
        live = age <= _limit(m);
        // I7-2: a stock round with a close of 24 hours or more since its print (a fork block on a Sunday evening or
        // a Monday before the first round) is not live either, whatever its age.
        if (live && m.token != address(0)) {
            live = !mh.closedBetween(block.timestamp - age, block.timestamp, guard.LONG_CLOSE());
        }
        if (live) {
            assertEq(uint256(r.session), uint256(Session.OPEN), m.sym);
            assertTrue(r.fresh, m.sym);
            assertEq(block.timestamp - r.updatedAt, age, m.sym);
        } else {
            assertEq(uint256(r.session), uint256(Session.HALTED), m.sym);
            assertFalse(r.fresh, m.sym);
            assertTrue(r.buysPaused, m.sym);
            assertEq(r.reason, guard.REASON_HALTED(), m.sym);
            assertEq(r.p, 0, m.sym); // nothing poked yet: no last good price to fall back on
            guard.poke(m.id);
            (uint256 lg,) = guard.lastGood(m.id);
            assertEq(lg, 0, "a stale round must never become the last good price");
            assertGt(guard.haltedSince(m.id), 0, "the halt is latched");
            console2.log(m.sym, "feed round past the limit or the last long close: HALTED, age", age);
        }
    }

    function _find(string memory sym) internal view returns (Mkt memory) {
        for (uint256 i; i < mkts.length; ++i) {
            if (mkts[i].id == bytes32(bytes(sym))) return mkts[i];
        }
        revert("unknown");
    }

    /// The real US equity calendar, not the OPEN fixture window pushed in setUp: Monday to Friday, inside the regular session in
    /// both DST regimes (14:30 UTC when New York is on EST, to 20:00 UTC when it is on EDT). Conservative on purpose: a false
    /// "closed" only skips the TWAP comparison on that run. Holidays are not modelled.
    function _realMarketOpen() internal view returns (bool) {
        uint256 dow = ((block.timestamp / 1 days) + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
        if (dow == 0 || dow == 6) return false;
        uint256 secs = block.timestamp % 1 days;
        return secs >= 14 hours + 30 minutes && secs < 20 hours;
    }

    function _within2pct(uint256 a, uint256 b) internal pure returns (bool) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * 10_000 <= b * 200;
    }

    /// TSLA, NVDA, SPY, ETH read live; p within 2% of refP when both exist; the stocks have a TWAP reference.
    function test_ForkLiveReads() public {
        _setUpFork();
        assertEq(guard.MAX_MAX_AGE_OPEN(), 3 days, "_limit mirrors the guard's cap");
        string[4] memory syms = ["TSLA", "NVDA", "SPY", "ETH"];
        for (uint256 i; i < syms.length; ++i) {
            Mkt memory m = _find(syms[i]);
            PriceReading memory r = guard.read(m.id);
            (uint256 refP, bool fromPyth) = guard.refPrice(m.id);
            console2.log(syms[i], r.p, r.refP);
            console2.log("  session/fromPyth/age", uint256(r.session), fromPyth, block.timestamp - r.updatedAt);
            if (!_assertLiveOrHalted(m, r)) continue;
            assertGt(r.p, 0);
            assertEq(refP, r.refP);
            if (r.refP != 0) assertTrue(_within2pct(r.p, r.refP), "p within 2% of refP");
            else assertEq(r.reason, guard.REASON_REF_UNAVAILABLE(), "no reference: buys paused");
            if (m.twapUsable) assertGt(r.refP, 0, "stock TWAP reference present");
            guard.poke(m.id);
            (uint256 lg,) = guard.lastGood(m.id);
            assertEq(lg, r.p);
        }
    }

    /// Every stock with a Pyth id: when Pyth Core is fresh, p (feed, multiplier embedded) must match Pyth x multiplier
    /// within 2%; when it is stale or missing (the 2026-11-13 state: 7 days old or PriceFeedNotFound), the guard must
    /// not use it, and p is checked against the TWAP instead. COIN has no usable pool, so its buys pause.
    function test_ForkMultiplierOnceAgainstPyth() public {
        _setUpFork();
        for (uint256 i; i < mkts.length; ++i) {
            Mkt memory m = mkts[i];
            if (m.token == address(0) || m.pythId == bytes32(0)) continue;
            PriceReading memory r = guard.read(m.id);
            (uint256 refP, bool fromPyth) = guard.refPrice(m.id);
            if (!_assertLiveOrHalted(m, r)) continue;
            (bool fresh, uint256 pythP) = _pythPerToken(m);
            assertEq(fromPyth, fresh, m.sym);
            if (fresh) {
                assertTrue(_within2pct(r.p, pythP), "feed vs Pyth x multiplier");
            } else if (m.twapUsable) {
                assertFalse(fromPyth);
                assertGt(refP, 0, m.sym);
                // The TWAP is a live-market number: with the real US calendar closed (weekend, overnight) the feed holds the last
                // close while the pool keeps trading, so the two legitimately differ. The 2% bound is not widened; the check is skipped.
                if (_realMarketOpen()) assertTrue(_within2pct(r.p, refP), "feed vs TWAP");
            } else {
                assertEq(refP, 0, m.sym);
                assertEq(r.reason, guard.REASON_REF_UNAVAILABLE(), m.sym);
            }
            console2.log(m.sym, r.p, refP, fresh);
        }
    }

    /// Pyth Core read done independently of the guard: getPriceUnsafe, fresh within REF_MAX_AGE, conf <= 2%.
    function _pythPerToken(Mkt memory m) internal view returns (bool fresh, uint256 v) {
        (bool ok, bytes memory data) =
            PYTH_CORE.staticcall(abi.encodeWithSignature("getPriceUnsafe(bytes32)", m.pythId));
        if (!ok || data.length < 128) return (false, 0);
        (int64 price, uint64 conf, int32 expo, uint256 publishTime) = abi.decode(data, (int64, uint64, int32, uint256));
        if (price <= 0 || expo > 0 || publishTime > block.timestamp || block.timestamp - publishTime > REF_MAX_AGE) {
            return (false, 0);
        }
        if (uint256(conf) * 50 > uint256(int256(price))) return (false, 0);
        (, bytes memory u) = m.token.staticcall(abi.encodeWithSignature("uiMultiplier()"));
        uint256 mult = abi.decode(u, (uint256));
        v = uint256(int256(price)) * 10 ** uint256(int256(18 + expo)) * mult / 1e18;
        fresh = true;
    }

    /// Real proxies pass setMarket's proxy check; the aggregator behind one does not.
    function test_ForkSetMarketRejectsAggregator() public {
        _setUpFork();
        Mkt memory m = _find("TSLA");
        (, bytes memory a) = m.feed.staticcall(abi.encodeWithSignature("aggregator()"));
        address agg = abi.decode(a, (address));
        MarketConfig memory c = _cfg(m);
        c.feed = agg;
        vm.expectRevert();
        vm.prank(admin);
        guard.setMarket(m.id, c);
    }
}
