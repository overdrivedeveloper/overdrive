// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OracleFixture} from "./OracleFixture.t.sol";
import {ODOracleGuard} from "../../src/oracle/ODOracleGuard.sol";
import {ODMarketHours} from "../../src/oracle/ODMarketHours.sol";
import {Holiday} from "../../src/interfaces/IODMarketHours.sol";
import {MarketConfig, PriceReading, Session} from "../../src/interfaces/ODTypes.sol";

/// ORACLE-SRC: every external price source of TSLA replayed from LIVE responses recorded on Robinhood Chain mainnet
/// with the market OPEN (Mon 2026-11-16) and CLOSED (Sat 2026-11-14), test/fixtures/oracle-sources/TSLA.json, written
/// by .github/scripts/record-oracle-fixtures.sh. Sources: the Chainlink proxy round, Pyth (the Hermes answer the crank would
/// push, and the on-chain Pyth price as it stood), and the v3 pool TWAP (the recorded tick cumulatives). The session
/// comes from the real ODMarketHours calendar (built-in weekly schedule) with the mainnet holidays at the recorded block timestamps, and the
/// market uses the mainnet config's ages and bands.
contract SourceFixturesTest is OracleFixture {
    ODMarketHours internal mh;
    ODOracleGuard internal g;
    string internal fx;
    bytes32 internal pythId;

    function setUp() public override {
        super.setUp();
        fx = vm.readFile("test/fixtures/oracle-sources/TSLA.json");
        pythId = vm.parseJsonBytes32(fx, ".pythId");
        mh = new ODMarketHours(admin, makeAddr("keeper"));
        g = new ODOracleGuard(admin, guardian, address(mh), address(pyth), address(0));
        vm.startPrank(admin);
        mh.setHolidays(_holidays());
        mh.setFallbackEnabled(true); // the built-in weekly schedule (no crank-pushed windows in this test)
        g.setMarket(M, _mainnetCfg());
        vm.stopPrank();
        assertEq(vm.parseJsonUint(fx, ".open.chainlink.decimals"), 8, "feed decimals");
        assertEq(vm.parseJsonUint(fx, ".open.uiMultiplier"), 1e18, "multiplier");
    }

    // ------------------------------------------------------------------------------------------------ OPEN

    /// Open: the live Chainlink round is the price, the Hermes update (once pushed) is the reference, buys open.
    function test_Open_ChainlinkLive_HermesPythIsReference() public {
        assertEq(vm.parseJsonUint(fx, ".open.hermes.status"), 200, "Hermes answers an open market");
        uint256 pub = vm.parseJsonUint(fx, ".open.hermes.body.parsed[0].price.publish_time");
        _replay("open", pub > _ts("open") ? pub + 1 : _ts("open"));
        pyth.setPrice(
            pythId,
            int64(vm.parseJsonInt(fx, ".open.hermes.body.parsed[0].price.price")),
            uint64(vm.parseJsonUint(fx, ".open.hermes.body.parsed[0].price.conf")),
            int32(vm.parseJsonInt(fx, ".open.hermes.body.parsed[0].price.expo")),
            pub
        );
        PriceReading memory r = g.read(M);
        _assertInSession(r, "Monday 10:59 New York is a session");
        assertTrue(r.fresh, "live");
        assertEq(r.p, _answer("open") * 1e10, "the Chainlink round is the price");
        (uint256 refP, bool fromPyth) = g.refPrice(M);
        assertTrue(fromPyth, "a fresh Pyth print is the reference");
        assertEq(refP, vm.parseJsonUint(fx, ".open.hermes.body.parsed[0].price.price") * 1e13, "expo -5 to WAD");
        assertFalse(r.buysPaused, "reference inside the band");
        assertEq(g.liquidationBlock(M), bytes32(0), "liquidations open");
    }

    /// Open, Pyth not pushed: the on-chain Pyth price as recorded is days old, so the reference falls to the TWAP.
    function test_Open_StaleOnchainPyth_FallsBackToTwap() public {
        _replay("open", _ts("open"));
        PriceReading memory r = g.read(M);
        _assertInSession(r, "Monday session");
        (uint256 refP, bool fromPyth) = g.refPrice(M);
        assertFalse(fromPyth, "stale Pyth is never the reference");
        assertGt(refP, 0, "the pool TWAP answers");
        assertApproxEqRel(refP, r.p, 0.02e18, "TWAP within the 200 bps band of the round");
        assertFalse(r.buysPaused);
    }

    /// Open, but the only Chainlink round is the one printed before the weekend: the guard halts, never prices it.
    function test_Open_FridayRoundAtReopen_Halts() public {
        _replay("closed", _ts("open"));
        _setPoolTick(int24(vm.parseJsonInt(fx, ".open.twap.meanTick")));
        PriceReading memory r = g.read(M);
        assertEq(uint256(r.session), uint256(Session.HALTED), "a pre-close round is not a live price");
        assertTrue(r.buysPaused);
        assertEq(r.reason, g.REASON_HALTED());
        assertEq(g.liquidationBlock(M), "NOT_LIVE");
    }

    // ------------------------------------------------------------------------------------------------ CLOSED

    /// Closed: Hermes has no update for the weekend (404), the round is Friday's; the guard serves the last good
    /// price as CLOSED and blocks liquidations.
    function test_Closed_LastGoodOnly_NoLiveReading() public {
        assertEq(vm.parseJsonUint(fx, ".closed.hermes.status"), 404, "Hermes has nothing at a closed timestamp");
        uint256 updatedAt = vm.parseJsonUint(fx, ".closed.chainlink.updatedAt");
        // Friday's last round, read in session (the extended session runs to 20:00 New York): the last good price.
        _replay("closed", updatedAt + 60);
        g.poke(M);
        (uint256 lastP,) = g.lastGood(M);
        assertEq(lastP, _answer("closed") * 1e10);
        vm.warp(_ts("closed"));
        PriceReading memory r = g.read(M);
        assertEq(uint256(r.session), uint256(Session.CLOSED), "Saturday is closed");
        assertEq(r.p, lastP, "only the last good price");
        assertEq(r.updatedAt, updatedAt, "stamped with Friday's round time");
        assertEq(g.liquidationBlock(M), "NOT_LIVE", "no liquidation on a closed price");
        (, bool fromPyth) = g.refPrice(M);
        assertFalse(fromPyth, "on-chain Pyth is stale and Hermes has no weekend update");
    }

    /// Closed with no last good price at all: nothing to serve, reading not fresh.
    function test_Closed_NoHistory_NotFresh() public {
        _replay("closed", _ts("closed"));
        PriceReading memory r = g.read(M);
        assertEq(uint256(r.session), uint256(Session.CLOSED));
        assertEq(r.p, 0);
        assertFalse(r.fresh);
        assertEq(g.liquidationBlock(M), "NOT_LIVE");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _assertInSession(PriceReading memory r, string memory what) internal pure {
        assertTrue(r.session == Session.OPEN || r.session == Session.EXTENDED, what);
        assertTrue(r.fresh, what);
    }

    function _ts(string memory s) internal view returns (uint256) {
        return vm.parseJsonUint(fx, string.concat(".", s, ".timestamp"));
    }

    function _answer(string memory s) internal view returns (uint256) {
        return vm.parseJsonUint(fx, string.concat(".", s, ".chainlink.answer"));
    }

    /// Feed, on-chain Pyth and pool as recorded in state `s`, read at `at`. The pool holds the recorded mean tick
    /// for the whole TWAP window, which gives the same observe() difference as the recorded cumulatives.
    function _replay(string memory s, uint256 at) internal {
        string memory k = string.concat(".", s);
        int256 window = int256(vm.parseJsonUint(fx, string.concat(k, ".twap.window")));
        int256[] memory cum = vm.parseJsonIntArray(fx, string.concat(k, ".twap.tickCumulatives"));
        int256 mean = (cum[1] - cum[0]) / window;
        if ((cum[1] - cum[0]) % window != 0 && cum[1] < cum[0]) --mean; // v3 OracleLibrary rounds to negative infinity
        assertEq(mean, vm.parseJsonInt(fx, string.concat(k, ".twap.meanTick")), "mean tick");
        vm.warp(at - uint256(window) - 1);
        _setPoolTick(int24(mean));
        vm.warp(at);
        feed.setRound(int256(_answer(s)), vm.parseJsonUint(fx, string.concat(k, ".chainlink.updatedAt")));
        pyth.setPrice(
            pythId,
            int64(vm.parseJsonInt(fx, string.concat(k, ".pythOnchain.price"))),
            uint64(vm.parseJsonUint(fx, string.concat(k, ".pythOnchain.conf"))),
            int32(vm.parseJsonInt(fx, string.concat(k, ".pythOnchain.expo"))),
            vm.parseJsonUint(fx, string.concat(k, ".pythOnchain.publishTime"))
        );
    }

    /// TSLA's ages and bands from script/config/mainnet.json; the fixture's own feed, Stock Token and pool mocks.
    function _mainnetCfg() internal view returns (MarketConfig memory c) {
        string memory j = vm.readFile("script/config/mainnet.json");
        uint256 i;
        while (
            keccak256(bytes(vm.parseJsonString(j, string.concat(".markets[", vm.toString(i), "].symbol"))))
                != keccak256("TSLA")
        ) {
            ++i;
        }
        string memory k = string.concat(".markets[", vm.toString(i), "]");
        c = _cfg();
        c.pythId = pythId;
        c.maxAgeOpen = uint32(vm.parseJsonUint(j, string.concat(k, ".maxAgeInSession")));
        c.maxAgeExtended = c.maxAgeOpen;
        c.maxAgeClosed = uint32(vm.parseJsonUint(j, string.concat(k, ".maxAgeClosed")));
        c.refMaxAge = uint32(vm.parseJsonUint(j, string.concat(k, ".refMaxAge")));
        c.twapWindow = uint32(vm.parseJsonUint(j, string.concat(k, ".twapWindow")));
        c.refBandBps = uint16(vm.parseJsonUint(j, string.concat(k, ".refBandBps")));
        c.continuityBps = uint16(vm.parseJsonUint(j, string.concat(k, ".continuityBps")));
        assertEq(vm.parseJsonBytes32(fx, ".pythId"), vm.parseJsonBytes32(j, string.concat(k, ".pythId")), "same id");
    }

    function _holidays() internal view returns (Holiday[] memory hs) {
        string memory j = vm.readFile("script/config/mainnet.json");
        uint256 n;
        while (vm.keyExistsJson(j, string.concat(".holidays[", vm.toString(n), "]"))) ++n;
        hs = new Holiday[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".holidays[", vm.toString(i), "]");
            hs[i] = Holiday({
                day: uint32(vm.parseJsonUint(j, string.concat(k, ".day"))),
                closeMinute: uint16(vm.parseJsonUint(j, string.concat(k, ".closeMinute")))
            });
        }
    }
}
