// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackerFixture} from "../backer/BackerFixture.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";

/// Independent 6, I6-2: the per-owner lock share (L-12 fix) is keyed on the vault owner address, so one actor with
/// four addresses takes the whole lock ceiling and closes own mints for every other backer, exactly as before fix 8.
contract Ind6SybilLockQuotaTest is BackerFixture {
    uint256 internal constant COLL = 2_500_000e6;

    function test_I6_FourAddressesTakeTheWholeCeiling() public {
        _buy(alice, sport, 10_000e6);
        _poke();
        uint256 total = gov.freeCash();
        uint256 honest = minter.quote(race, false, false, total / 25).amountIn;
        uint256 all = minter.quote(cruise, false, false, total / 5).amountIn * 99 / 100;
        for (uint256 i; i < 4; ++i) {
            address sybil = makeAddr(string.concat("bob", vm.toString(i)));
            uint256 v = _open(sybil, cruise, COLL);
            _mint(sybil, v, all / 4, false);
        }
        // control: one owner alone is refused above his quarter (the L-12 fix works for one address)
        address solo = makeAddr("bob0");
        uint256 vs = _open(solo, cruise, COLL);
        vm.prank(solo);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(vs, all / 100, false, 0);
        // the honest backer's own mint (4% of free cash) is now refused, and stays refused a week on
        uint256 w = _open(carol, race, COLL);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(w, honest, false, 0);
        _warpFresh(7 days);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.MintingClosed.selector, bytes32("GOVERNOR_CASH")));
        backer.mint(w, honest, false, 0);
    }
}
