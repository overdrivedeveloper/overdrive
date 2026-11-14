// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackerFixture} from "./BackerFixture.sol";
import {ODBackerMath} from "overdrive/backer/ODBackerMath.sol";
import {PriceReading, Session} from "overdrive/interfaces/ODTypes.sol";

/// R3 debt valued on the protocol's side, R4 required ratios.
contract BackerHealthTest is BackerFixture {
    function test_DebtValuedHighSide() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 300e18, false);
        uint256 r = _open(alice, reverse, 1_000e6);
        _mint(alice, r, 300e18, false);
        // reference 4% above the feed: SPORT is valued at the reference, REVERSE at the feed
        _ref(TSLA, 260e18);
        (, uint256 dv,,,) = backer.health(id);
        assertEq(dv, Math.mulDiv(300e18, _valueAt(sport, 260e18, Math.Rounding.Ceil), 1e18, Math.Rounding.Ceil));
        (, uint256 rv,,,) = backer.health(r);
        assertEq(rv, Math.mulDiv(300e18, _valueAt(reverse, 250e18, Math.Rounding.Ceil), 1e18, Math.Rounding.Ceil));
        // reference 4% below: REVERSE now at the reference
        _ref(TSLA, 240e18);
        (, rv,,,) = backer.health(r);
        assertEq(rv, Math.mulDiv(300e18, _valueAt(reverse, 240e18, Math.Rounding.Ceil), 1e18, Math.Rounding.Ceil));
        (, dv,,,) = backer.health(id);
        assertEq(dv, Math.mulDiv(300e18, _valueAt(sport, 250e18, Math.Rounding.Ceil), 1e18, Math.Rounding.Ceil));
    }

    function test_ClosedDebtValuedHighSide() public {
        uint256 id = _open(alice, sport, 1_000e6);
        _mint(alice, id, 300e18, false);
        _session(Session.CLOSED);
        // the feed drifts down while closed, the reference rises: debt is valued at the reference
        feedOf[TSLA].push(int256(200e18 / 1e10));
        _ref(TSLA, 262e18);
        PriceReading memory rd = _reading(sport);
        assertFalse(rd.session == Session.OPEN);
        assertEq(rd.p, 250e18, "last good while closed");
        (, uint256 dv,,,) = backer.health(id);
        assertEq(dv, Math.mulDiv(300e18, _valueAt(sport, 262e18, Math.Rounding.Ceil), 1e18, Math.Rounding.Ceil));
        // reference unavailable: the last good price, never the lower drifting feed
        _dropRef(TSLA);
        (, dv,,,) = backer.health(id);
        assertEq(dv, Math.mulDiv(300e18, _valueAt(sport, 250e18, Math.Rounding.Ceil), 1e18, Math.Rounding.Ceil));
    }

    function testFuzz_RatioMaths(uint256 coll, uint256 debtWad) public pure {
        coll = bound(coll, 0, 1e15 * 1e6);
        debtWad = bound(debtWad, 1, 1e15 * 1e18);
        uint256 r = ODBackerMath.ratioBps(coll, debtWad);
        // r = floor(coll x 1e12 x 1e4 / debt)
        assertLe(r * debtWad, coll * 1e16);
        assertGt((r + 1) * debtWad, coll * 1e16);
        assertEq(ODBackerMath.ratioBps(coll, 0), type(uint256).max);
    }

    function test_RaceRatios() public {
        uint256 id = _open(alice, race, 1_000e6);
        (,,, uint256 req, uint256 maint) = backer.health(id);
        assertEq(req, 25_000);
        assertEq(maint, 20_000);
        uint256 s = _open(alice, sport, 1_000e6);
        (,,, req, maint) = backer.health(s);
        assertEq(req, 20_000);
        assertEq(maint, 15_000);
    }

    function test_UpliftAddsToBoth() public {
        uint256 s = _open(alice, sport, 1_000e6);
        uint256 rc = _open(alice, race, 1_000e6);
        uint256 e = _open(alice, ethSport, 1_000e6);
        _uplift(true);
        (,,, uint256 req, uint256 maint) = backer.health(s);
        assertEq(req, 25_000);
        assertEq(maint, 20_000);
        (,,, req, maint) = backer.health(rc);
        assertEq(req, 30_000);
        assertEq(maint, 25_000);
        (,,, req, maint) = backer.health(e);
        assertEq(req, 20_000, "24/7 market never uplifted");
        assertEq(maint, 15_000);
        // a mint that clears 200% but not 250% is refused while the uplift is on
        vm.prank(alice);
        vm.expectRevert();
        backer.mint(s, 450e18, false, 0);
        _uplift(false);
        _mint(alice, s, 450e18, false);
    }

    function test_SetUpliftGuardianOnlyRaises() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("NotAllowed()"));
        backer.setUplift(4000, 2 hours);
        vm.prank(guardian);
        backer.setUplift(6000, 3 hours);
        vm.prank(admin);
        backer.setUplift(4000, 1 hours);
        (uint16 bps, uint32 lead) = backer.uplift();
        assertEq(bps, 4000);
        assertEq(lead, 1 hours);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSignature("InvalidParams()"));
        backer.setUplift(20_001, 1 hours);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotAllowed()"));
        backer.setUplift(9000, 3 hours);
    }
}
