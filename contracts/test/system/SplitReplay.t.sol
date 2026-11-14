// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SystemFixture} from "./SystemFixture.sol";
import {MarketConfig, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";

/// R7 twin on mocks (always runs): a 4:1 split on TSLA with the multiplier embedded in the feed and with a per-share
/// feed; value per token unchanged across the switch; a feed (or reference) moving first never prices a trade.
contract SplitReplayTest is SystemFixture {
    uint256 internal constant WAD = 1e18;
    uint256 internal mult = WAD;
    uint256 internal pTok = 250e18; // per-token price the market means
    bool internal perShare;
    uint256 internal eff;

    function _setTsla(uint256 perToken) internal {
        pTok = perToken;
        uint256 v = perShare ? perToken * WAD / mult : perToken;
        feedOf[TSLA].push(int256(v / 1e10));
        _ref(TSLA, v);
        guard.poke(TSLA);
    }

    function _fresh(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        _setTsla(pTok);
        _price(NVDA, _p(NVDA));
        _price(ETH, _p(ETH));
        _repost(TSLA);
        _repost(NVDA);
        _repost(ETH);
        _repost(vol.pairKey(TSLA, NVDA));
        _poke();
    }

    function _arm(bool embedded) internal returns (uint256 tokens, uint256 v0) {
        if (!embedded) {
            perShare = true;
            MarketConfig memory c = guard.config(TSLA);
            c.multiplierEmbedded = false;
            c.pythMultiplierEmbedded = false;
            vm.prank(admin);
            guard.setMarket(TSLA, c);
            _setTsla(pTok);
        }
        tokens = _buy(alice, sport, 1_000e6);
        eff = vm.getBlockTimestamp() + 2 days;
        stockOf[TSLA].setMultipliers(WAD, 4 * WAD, eff);
        v0 = _exToll();
    }

    function _exToll() internal view returns (uint256) {
        (uint256 v,) = minter.valuePerToken(sport);
        return v * WAD / minter.normState(sport).nf;
    }

    function _buyReverts() internal {
        _fund(bob, 100e6);
        vm.prank(bob);
        vm.expectRevert();
        minter.buy(sport, 100e6, 0, bob, uint64(vm.getBlockTimestamp()));
    }

    function _switch() internal {
        vm.warp(eff);
        mult = 4 * WAD;
        stockOf[TSLA].setMultipliers(4 * WAD, 4 * WAD, eff);
        _fresh(0);
    }

    function _replay(bool embedded) internal {
        (uint256 tokens, uint256 v0) = _arm(embedded);
        _fresh(1 days - 60);
        assertGt(_buy(bob, sport, 100e6), 0, "open before the lead window");
        _fresh(120);
        assertEq(guard.read(TSLA).reason, guard.REASON_SPLIT());
        _buyReverts();
        _switch();
        assertEq(uint256(guard.read(TSLA).session), uint256(Session.OPEN));
        assertApproxEqRel(_exToll(), v0, 1e14, "value unchanged within 1 bp");
        Quote memory q = _quote(sport, false, true, tokens);
        assertApproxEqRel(q.valuePerTokenWad * WAD / minter.normState(sport).nf, v0, 1e14, "sell at the right value");
        _buyReverts();
        _fresh(1 hours + 60);
        assertEq(guard.read(TSLA).reason, bytes32(0));
        assertGt(_buy(bob, sport, 100e6), 0, "buys resume");
        assertApproxEqRel(_exToll(), v0, 1e14);
    }

    function test_SplitEmbeddedFeed() public {
        _replay(true);
    }

    function test_SplitNotEmbeddedFeed() public {
        _replay(false);
    }

    function test_FeedFirstHalts() public {
        (uint256 tokens, uint256 v0) = _arm(false);
        _fresh(2 days - 2 hours);
        // the per-share feed and reference split before the multiplier switches
        uint256 ps = pTok * WAD / mult / 4;
        feedOf[TSLA].push(int256(ps / 1e10));
        _ref(TSLA, ps);
        guard.poke(TSLA);
        PriceReading memory r = guard.read(TSLA);
        assertEq(uint256(r.session), uint256(Session.HALTED));
        assertEq(r.refP, 0, "split-skewed reference dropped");
        _buyReverts();
        assertTrue(_quote(sport, false, true, tokens).queued, "no sell at the wrong price");
        _switch();
        assertEq(uint256(guard.read(TSLA).session), uint256(Session.OPEN), "agree again");
        assertApproxEqRel(_exToll(), v0, 1e14);
        _fresh(1 hours + 60);
        assertGt(_buy(bob, sport, 100e6), 0, "buys resume");
    }

    function test_ReferenceFirstNeverPricesASell() public {
        (uint256 tokens,) = _arm(false);
        _fresh(2 days - 2 hours);
        _ref(TSLA, pTok * WAD / mult / 4); // reference (per share) moved, feed not
        PriceReading memory r = guard.read(TSLA);
        assertEq(r.refP, 0);
        assertTrue(r.buysPaused);
        assertTrue(_quote(sport, false, true, tokens).queued);
    }
}
