// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SystemFixture} from "../system/SystemFixture.sol";

/// R14 (PERP-3): buying just before a feed update of the deviation threshold (0.5%), with a fresh reference already
/// showing the move, and selling right after loses at least both spreads, for every gear and both directions.
/// Buys price at the worse of p and refP for the buyer, sells at the worse for the seller, so the trader never gets
/// the stale side of the move.
contract OracleArbitrageTest is SystemFixture {
    function _roundTrip(bytes32 id, bool up) internal {
        uint256 snap = vm.snapshotState();
        uint256 p0 = _p(TSLA);
        uint256 p1 = up ? p0 * 10_050 / 10_000 : p0 * 9_950 / 10_000;
        _ref(TSLA, p1); // the reference already shows the move
        uint256 usdgIn = 10_000e6;
        uint16 s = _quote(id, true, true, usdgIn).spreadBps;
        uint256 tokens = _buy(alice, id, usdgIn);
        _price(TSLA, p1); // the feed catches up
        uint256 out = _sell(alice, id, tokens);
        assertLe(out + Math.mulDiv(usdgIn, 2 * uint256(s), 10_000 + s), usdgIn, "loses at least both spreads");
        vm.revertToState(snap);
    }

    function test_FrontRunFeedUpdateLoses() public {
        bytes32[6] memory ids = [cruise, sport, race, eco, reverse, pair];
        for (uint256 i; i < ids.length; ++i) {
            _roundTrip(ids[i], true);
            _roundTrip(ids[i], false);
        }
    }
}
