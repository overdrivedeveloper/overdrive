// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ForkSystem} from "./ForkSystem.sol";
import {Gear, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";

/// R7: a 4:1 split replayed on the REAL NVDA Stock Token and feed proxy (ERC-8056 fields mocked on the token). The
/// multiplier is applied once: value per token is unchanged across the switch, for a feed with the multiplier embedded
/// (Robinhood docs, the 00 finding) and for one without it (per-share feed). A feed moving before the multiplier halts.
contract SplitReplayForkTest is ForkSystem {
    bytes32 internal id;
    uint256 internal cur;
    uint256 internal eff;

    function _arm(bool embedded) internal returns (uint256 tokens, uint256 v0) {
        id = gearOf[NVDA][Gear.SPORT];
        if (!embedded) {
            feedNotEmbedded[NVDA] = true;
            vm.prank(admin);
            guard.setMarket(NVDA, _cfg(NVDA));
            _refresh();
        }
        tokens = _hookBuy(alice, id, 1_000e6);
        cur = multOf[NVDA];
        eff = vm.getBlockTimestamp() + 2 days;
        _mockSplit(NVDA, cur, cur * 4, eff);
        v0 = _valueExToll(id);
    }

    function _buyReverts() internal {
        _fundUsdg(bob, 100e6);
        vm.startPrank(bob);
        usdg.approve(address(minter), 100e6);
        vm.expectRevert();
        minter.buy(id, 100e6, 0, bob, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();
    }

    function _replay(bool embedded) internal {
        (uint256 tokens, uint256 v0) = _arm(embedded);
        // before the lead window: buys open
        vm.warp(eff - 24 hours - 60);
        _refresh();
        assertGt(_hookBuy(bob, id, 100e6), 0, "buys open before effectiveAt - 24 h");
        // inside the window: SPLIT_PENDING
        vm.warp(eff - 24 hours + 60);
        _refresh();
        assertEq(guard.read(NVDA).reason, guard.REASON_SPLIT());
        _buyReverts();
        // at effectiveAt the multiplier and the feed move together (per-share feed / 4, embedded feed unchanged)
        vm.warp(eff);
        multOf[NVDA] = cur * 4;
        _mockSplit(NVDA, cur * 4, cur * 4, eff); // the token's uiMultiplier switches too
        _refresh();
        PriceReading memory r = guard.read(NVDA);
        assertEq(uint256(r.session), uint256(Session.OPEN), "not halted");
        uint256 v1 = _valueExToll(id);
        assertApproxEqRel(v1, v0, 1e14, "value per token unchanged within 1 bp");
        _buyReverts(); // still inside the 1 h tail
        // sells at the right price
        Quote memory q = minter.quote(id, false, true, tokens);
        assertApproxEqRel(q.valuePerTokenWad * WAD / minter.normState(id).nf, v0, 1e14);
        // after the window: buys resume
        vm.warp(eff + 1 hours + 60);
        _refresh();
        assertEq(guard.read(NVDA).reason, bytes32(0), "window over");
        assertGt(_hookBuy(bob, id, 100e6), 0, "buys resume");
        assertApproxEqRel(_valueExToll(id), v0, 1e14, "still the same value net of the toll");
    }

    function test_SplitEmbeddedFeed() public {
        _replay(true);
    }

    function test_SplitNotEmbeddedFeed() public {
        _replay(false);
    }

    /// Per-share feed (and Pyth) drop 4x two hours BEFORE effectiveAt: HALTED, no buy, and no sell at the wrong price;
    /// once the multiplier switches they agree again; after the window buys resume.
    function test_FeedFirstHalts() public {
        (uint256 tokens, uint256 v0) = _arm(false);
        vm.warp(eff - 2 hours);
        _refresh();
        uint256 perShare = px[NVDA] * 1e18 / cur;
        _mockFeed(NVDA, perShare / 4 / 1e10, vm.getBlockTimestamp());
        _mockPyth(NVDA, int64(int256(perShare / 4 / 1e10)), vm.getBlockTimestamp());
        guard.poke(NVDA);
        PriceReading memory r = guard.read(NVDA);
        assertEq(uint256(r.session), uint256(Session.HALTED), "feed ahead of the multiplier halts");
        _buyReverts();
        // no sell at the wrong price: the sell queues
        Quote memory q = minter.quote(id, false, true, tokens);
        assertEq(guard.read(NVDA).refP, 0, "a reference moved by the pending ratio is dropped");
        assertTrue(q.queued, "no sell at the /4 price: queued");
        // multiplier switches: feed and multiplier agree
        vm.warp(eff);
        multOf[NVDA] = cur * 4;
        _mockSplit(NVDA, cur * 4, cur * 4, eff);
        _refresh();
        r = guard.read(NVDA);
        assertEq(uint256(r.session), uint256(Session.OPEN), "agree again");
        uint256 v1 = _valueExToll(id);
        assertApproxEqRel(v1, v0, 1e14);
        vm.warp(eff + 1 hours + 60);
        _refresh();
        assertGt(_hookBuy(bob, id, 100e6), 0, "buys resume");
    }

    /// Pyth (per share) splits two hours early while the feed has not: the reference is dropped (buys pause, a sell is
    /// never priced off the /4 reference); the live feed keeps sells at the right price only when a reference exists.
    function test_PythFirstNoWrongSell() public {
        (uint256 tokens,) = _arm(true);
        vm.warp(eff - 2 hours);
        _refresh();
        uint256 perShare = px[NVDA] * 1e18 / cur;
        _mockPyth(NVDA, int64(int256(perShare / 4 / 1e10)), vm.getBlockTimestamp());
        guard.poke(NVDA);
        PriceReading memory r = guard.read(NVDA);
        assertEq(r.refP, 0, "split-skewed reference dropped");
        assertTrue(r.buysPaused);
        Quote memory q = minter.quote(id, false, true, tokens);
        assertTrue(q.queued, "queued, never paid at 1/16 of value");
    }
}
