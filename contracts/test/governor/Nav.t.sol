// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GovernorFixture} from "./GovernorFixture.sol";
import {Gear, Session} from "overdrive/interfaces/ODTypes.sol";

/// R2: NAV = cash + exit reserve + hedge equity - liability - fees owed; the band uses the worse / better of p and refP.
contract NavTest is GovernorFixture {
    bytes32 sport;
    bytes32 cruise;
    bytes32 rev;
    bytes32 pair;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 100_000e6);
        sport = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        cruise = _list(TSLA, NONE, Gear.CRUISE, 1_000_000e18);
        rev = _list(NVDA, NONE, Gear.REVERSE, 1_000_000e18);
        pair = _list(TSLA, NVDA, Gear.SPORT, 1_000_000e18);
        _buy(sport, 1_000e18, 1_000e6);
        _buy(cruise, 2_000e18, 2_000e6);
        _buy(rev, 4_000e18, 4_000e6);
        _buy(pair, 500e18, 500e6);
        vm.prank(backerC);
        gov.onBackerMint(rev, 5_000e18, false, 0); // net REVERSE = -1,000: a Governor long
        minter.setNf(sport, 0.9e18);
    }

    function test_NavMatchesHandComputed() public {
        guard.set(TSLA, 360e18, 360e18); // r = 1.44: SPORT 2.0736, CRUISE 1.728
        guard.set(NVDA, 100e18, 100e18); // r = 0.8: REVERSE 1.25; pair ratio 3.6 / 2 = 1.8: SPORT 3.24
        // liability = 1,000 x 2.0736 x 0.9 + 2,000 x 1.728 - 1,000 x 1.25 + 500 x 3.24 = 5,692.24
        int256 expected = 107_500e18 - 5_692.24e18;
        assertEq(gov.equity(), expected);
        assertEq(gov.totalAssets(), uint256(expected) / 1e12);
        assertEq(gov.netTokens(rev), -1_000e18);
        // CLOSED: the guard's p is its last good price; NAV uses it as is.
        guard.setSession(TSLA, Session.CLOSED);
        assertEq(gov.equity(), expected);
        // Exit reserve and hedge equity count; fees owed do not.
        _fundReserve(1_000e6);
        vm.prank(hedger);
        gov.postHedge(TSLA, 0, 300e6, uint64(vm.getBlockTimestamp()));
        minter.toll(sport, 10_000e18); // 1,000 USDG fee, paid from free cash: NAV -1,000
        assertEq(gov.equity(), expected + 1_000e18 + 300e18 - 1_000e18);
    }

    function test_NavBandBrackets() public {
        (int256 lo, int256 hi) = gov.navBand();
        assertEq(lo, gov.equity(), "refP == p: no band");
        assertEq(hi, gov.equity());
        guard.set(TSLA, 360e18, 340e18);
        guard.set(NVDA, 100e18, 105e18);
        (lo, hi) = gov.navBand();
        int256 mid = gov.equity();
        assertLt(lo, mid);
        assertGt(hi, mid);
        // Per gear the worse of p and refP: lo equals NAV with each gear at its own worse price.
        // TSLA single shorts: worse at 360 (p). REVERSE long on NVDA: worse at 105 (lower value). Pair short: worse at
        // the larger ratio, p (3.6 > 340/105).
        int256 hand = 107_500e18 - (1_000e18 * 20736 / 10000 * 9 / 10 + 2_000e18 * 1728 / 1000 + 500e18 * 324 / 100);
        hand += int256(1_000 * (uint256(1e36) / 0.84e18)); // 1,000 x 1/(105/125), index rounded down (an asset)
        assertEq(lo, hand);
        // refP unavailable (0): the band collapses to p.
        guard.set(TSLA, 360e18, 0);
        guard.set(NVDA, 100e18, 0);
        (lo, hi) = gov.navBand();
        assertEq(lo, gov.equity());
        assertEq(hi, gov.equity());
    }

    function testFuzz_NavBandBrackets(uint256 pT, uint256 rT, uint256 pN, uint256 rN) public {
        pT = bound(pT, 100e18, 600e18);
        rT = bound(rT, 100e18, 600e18);
        pN = bound(pN, 50e18, 300e18);
        rN = bound(rN, 50e18, 300e18);
        guard.set(TSLA, pT, rT);
        guard.set(NVDA, pN, rN);
        (int256 lo, int256 hi) = gov.navBand();
        int256 mid = gov.equity();
        assertLe(lo, mid);
        assertGe(hi, mid);
    }
}
