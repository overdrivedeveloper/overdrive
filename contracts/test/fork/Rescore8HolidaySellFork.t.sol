// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ForkSystem} from "./ForkSystem.sol";
import {IV3Pool, PoolPusher} from "./Ind7WeekendSellFork.t.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {SessionWindow, Holiday} from "overdrive/interfaces/IODMarketHours.sol";
import {Gear, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Rescore 8, R8-1, regression on the fork (real SPY pool, real ODMarketHours, guard, minter and Governor).
/// The I7-1 steps on a holiday: Wednesday 19:00 round, the keeper drops past windows during Thanksgiving, the
/// holder lifts the SPY pool for one TWAP window and sells at the reopen. With the holiday list the deploy now
/// writes (script/config, SystemDeployer), Wednesday's round is HALTED at the reopen and the sell goes to the queue;
/// so does a round stamped 13 s into the close (I8-1). Before fix round 11 the deploy wrote no list and the lifted
/// sell was paid Wednesday's value (7,476 USDG over the market on a 100,000 USDG position).
contract Rescore8HolidaySellForkTest is ForkSystem {
    uint256 internal constant WED_2000 = 1795654800; // Wed 2026-11-25 20:00 EST
    uint256 internal constant TG_2000 = 1795741200; // Thu 2026-11-26 (Thanksgiving) 20:00 EST
    uint256 internal constant GAP_BPS = 400; // the holiday move: the pool is 4% under Wednesday's print
    uint256 internal constant POSITION = 100_000e6;
    address internal constant SPY_POOL = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;
    address internal constant SPY_STOCK = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    address internal attacker = makeAddr("attacker");
    bytes32 internal id;
    uint256 internal tokens;

    function _poolSpot() internal view returns (uint256 p) {
        (uint160 sq,,,,,,) = IV3Pool(SPY_POOL).slot0();
        p = uint256(sq) * uint256(sq) / (1 << 96) * 1e30 / (1 << 96);
    }

    function _pushFrom(uint256 firstWindow) internal {
        // the crank's list: Wednesday regular, Wednesday post-market, [holiday gap], Thursday 20:00 overnight
        uint256[3] memory o = [WED_2000 - 10 hours - 30 minutes, WED_2000 - 4 hours, TG_2000];
        uint256[3] memory c = [WED_2000 - 4 hours, WED_2000, TG_2000 + 13 hours];
        Session[3] memory kk = [Session.OPEN, Session.EXTENDED, Session.EXTENDED];
        uint256 n = 3 - firstWindow;
        SessionWindow[] memory s = new SessionWindow[](n);
        Session[] memory k = new Session[](n);
        for (uint256 i; i < n; ++i) {
            s[i] = SessionWindow({open: uint64(o[firstWindow + i]), close: uint64(c[firstWindow + i])});
            k[i] = kk[firstWindow + i];
        }
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }

    /// Wednesday: buy at 11:00, last round of the day at 19:00. Then the holiday.
    function _wednesday(bool listHoliday) internal {
        id = gearOf[SPY][Gear.SPORT];
        if (listHoliday) {
            // what SystemDeployer does: the config's list, written at deploy
            string memory j = vm.readFile("script/config/fork.json");
            uint256 n;
            while (vm.keyExistsJson(j, string.concat(".holidays[", vm.toString(n), "]"))) ++n;
            Holiday[] memory h = new Holiday[](n);
            for (uint256 i; i < n; ++i) {
                string memory k = string.concat(".holidays[", vm.toString(i), "]");
                h[i] = Holiday({
                    day: uint32(vm.parseJsonUint(j, string.concat(k, ".day"))),
                    closeMinute: uint16(vm.parseJsonUint(j, string.concat(k, ".closeMinute")))
                });
            }
            vm.prank(admin);
            mh.setHolidays(h);
        }
        vm.warp(WED_2000 - 9 hours);
        _pushFrom(0);
        px[SPY] = _poolSpot() * (10_000 + GAP_BPS) / 10_000;
        _refresh();
        assertEq(uint256(guard.read(SPY).session), uint256(Session.OPEN), "Wednesday 11:00 ET is open");
        tokens = _buy(attacker, id, POSITION);
        vm.warp(WED_2000 - 1 hours);
        _refresh(); // the last round before the holiday, Wednesday 19:00 ET, same price
    }

    function _lift() internal {
        PoolPusher pusher = new PoolPusher(IV3Pool(SPY_POOL), IERC20(SPY_STOCK), usdg);
        uint256 bankroll = 2_000_000e6;
        _fundUsdg(address(pusher), bankroll);
        (uint160 sq0,,,,,,) = IV3Pool(SPY_POOL).slot0();
        pusher.swap(false, int256(bankroll), uint160(uint256(sq0) * 102_274 / 100_000));
    }

    function _holidayThenReopen(bool lift) internal {
        vm.warp(TG_2000 - 31 minutes);
        assertEq(uint256(mh.kindAt(vm.getBlockTimestamp())), uint256(Session.CLOSED), "Thanksgiving is closed");
        if (lift) _lift();
        _pushFrom(2); // the crank's push during the holiday: past windows dropped
        vm.warp(TG_2000 + 30);
    }

    function _assertHaltedAndQueued() internal {
        PriceReading memory r = guard.read(SPY);
        assertEq(uint256(r.session), uint256(Session.HALTED), "HALTED at the holiday reopen");
        assertFalse(r.fresh);
        (, bool fromPyth) = guard.refPrice(SPY);
        assertFalse(fromPyth, "the reference is the v3 TWAP");
        Quote memory q = minter.quote(id, false, true, tokens);
        assertTrue(q.queued, "the sell is queued, not paid");
        vm.expectRevert(IODMinter.UseQueue.selector);
        vm.prank(attacker);
        minter.sell(id, tokens, 0, attacker, uint64(vm.getBlockTimestamp()));
    }

    /// The deployed list, the keeper's real push sequence, the pool lifted: no sell at Wednesday's price.
    function test_R8_1_HolidayReopen_LiftedTwap_Halted_SellQueues() public {
        if (address(gov) == address(0)) return;
        _wednesday(true);
        assertGt(mh.holidays().length, 20, "the deploy list");
        _holidayThenReopen(true);
        assertEq(vm.getBlockTimestamp() - guard.read(SPY).updatedAt, 25 hours + 30, "the round is 25 h old");
        _assertHaltedAndQueued();
        // the exit: the queue, with a minimum; it cannot fill until the feed prints after the reopen
        vm.startPrank(attacker);
        IERC20(reg.gear(id).token).approve(address(minter), tokens);
        uint256 ticket = minter.queueSell(id, tokens, POSITION * 9_700 / 10_000, attacker);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);
    }

    /// I8-1 on the fork: the session's last round lands 60 s after the 20:00 close. Under 24 hours old at the
    /// reopen, and still HALTED.
    function test_I8_1_LateRound_Halted_SellQueues() public {
        if (address(gov) == address(0)) return;
        _wednesday(true);
        vm.warp(WED_2000 + 60);
        uint256 ans = feedNotEmbedded[SPY] ? px[SPY] * 1e18 / multOf[SPY] / 1e10 : px[SPY] / 1e10;
        _mockFeed(SPY, ans, WED_2000 + 60);
        _holidayThenReopen(true);
        assertLt(vm.getBlockTimestamp() - (WED_2000 + 60), 24 hours, "under 24 hours old");
        _assertHaltedAndQueued();
    }
}
