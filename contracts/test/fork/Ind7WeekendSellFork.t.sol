// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ForkSystem} from "./ForkSystem.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {SessionWindow} from "overdrive/interfaces/IODMarketHours.sol";
import {Gear, PriceReading, Quote, Session} from "overdrive/interfaces/ODTypes.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata)
        external
        returns (int256, int256);
}

/// Pushes a real v3 pool and pays the swap callback. Holds the attacker's pool inventory.
contract PoolPusher {
    IV3Pool public immutable pool;
    IERC20 public immutable t0;
    IERC20 public immutable t1;

    constructor(IV3Pool p, IERC20 a, IERC20 b) {
        pool = p;
        t0 = a;
        t1 = b;
    }

    function swap(bool zeroForOne, int256 amount, uint160 limit) external returns (int256 a0, int256 a1) {
        return pool.swap(address(this), zeroForOne, amount, limit, "");
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == address(pool), "pool only");
        if (d0 > 0) t0.transfer(msg.sender, uint256(d0));
        if (d1 > 0) t1.transfer(msg.sender, uint256(d1));
    }
}

/// I7-1 regression (independent grade 7). On a weekend the feed price is frozen at Friday's last good price and the
/// only second source is the v3 TWAP of a thin pool. Before the fix a sell paid min(value at Friday's price, value at
/// the TWAP), so a holder who lifted the pool back to Friday's level for one window sold at Friday's price after the
/// market had fallen. Now a sell off a live reading needs a fresh Pyth print on every leg; with the pool alone it goes
/// to the queue and fills at the first live round.
/// Real state: the Robinhood Chain SPY Stock Token / USDG v3 pool (the `twapPool` of mainnet.json), the real calendar.
contract Ind7WeekendSellForkTest is ForkSystem {
    uint256 internal constant EST = 5 hours;
    uint256 internal constant GAP_BPS = 400; // the weekend move: the pool (the only open market) is 4% under Friday
    uint256 internal constant POSITION = 100_000e6;
    address internal constant SPY_POOL = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;
    address internal constant SPY_STOCK = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    address internal attacker = makeAddr("attacker");
    bytes32 internal id;
    uint256 internal tokens;
    uint256 internal friday;
    uint256 internal poolP;

    function setUp() public override {
        super.setUp();
        if (address(gov) == address(0)) return;
        vm.prank(keeper);
        mh.setSessionsWithKinds(new SessionWindow[](0), new Session[](0));
        vm.prank(admin);
        mh.setFallbackEnabled(true);
        id = gearOf[SPY][Gear.SPORT];

        // Friday 11:00 ET, regular hours. Feed and Pyth print Friday's price: GAP_BPS above where the real pool sits.
        uint256 day = (vm.getBlockTimestamp() - EST) / 1 days + 1;
        while ((day + 4) % 7 != 5) ++day;
        friday = day * 1 days + 11 hours + EST;
        vm.warp(friday);
        poolP = _poolSpot();
        px[SPY] = poolP * (10_000 + GAP_BPS) / 10_000;
        _refresh();
        assertEq(uint256(guard.read(SPY).session), uint256(Session.OPEN), "Friday 11:00 ET is open");
        tokens = _buy(attacker, id, POSITION);

        // Saturday noon ET. Nothing is refreshed: the feed round and the Pyth print are Friday's, as on the real chain.
        vm.warp(friday + 1 days + 1 hours);
    }

    function _poolSpot() internal view returns (uint256 p) {
        (uint160 sq,,,,,,) = IV3Pool(SPY_POOL).slot0();
        // token0 = Stock Token (18 dp), token1 = USDG (6 dp): price WAD = sq^2 / 2^192 x 1e12 x 1e18
        p = uint256(sq) * uint256(sq) / (1 << 96) * 1e30 / (1 << 96);
    }

    function _expectUseQueue() internal {
        Quote memory q = minter.quote(id, false, true, tokens);
        assertTrue(q.queued, "the quote says: queue");
        assertEq(q.amountOut, 0, "no price is quoted");
        vm.expectRevert(IODMinter.UseQueue.selector);
        vm.prank(attacker);
        minter.sell(id, tokens, 0, attacker, uint64(vm.getBlockTimestamp()));
    }

    /// Sunday 20:00:30 ET, then the first feed round and Pyth print of the new week at the weekend's price.
    function _reopenAtMarketPrice() internal {
        vm.warp(friday + 2 days + 9 hours + 30);
        walkPrice(SPY, -int256(GAP_BPS * 10_000 / (10_000 + GAP_BPS)));
        _refresh();
    }

    /// Control: the pool left alone. The TWAP is the honest weekend price, and it still is not a reference for a
    /// closed sell: the sell queues. A fresh Pyth print is one, and then the sell pays the lower (weekend) value.
    function test_Control_HonestPool_QueuesWithoutPyth_PaysWithPyth() public {
        if (address(gov) == address(0)) return;
        PriceReading memory r = guard.read(SPY);
        assertEq(uint256(r.session), uint256(Session.CLOSED), "Saturday is closed");
        (uint256 last,) = guard.lastGood(SPY);
        assertEq(r.p, last, "p is Friday's last good price");
        assertGt(r.refP, 0, "the guard still reports the v3 TWAP (Pyth is a day old)");
        (, bool fromPyth) = guard.refPrice(SPY);
        assertFalse(fromPyth, "not Pyth");
        _expectUseQueue();

        // a Pyth print inside refMaxAge at the weekend price: the sell is paid, at the lower value
        _mockPyth(SPY, int64(int256(poolP * 1e18 / multOf[SPY] / 1e10)), vm.getBlockTimestamp());
        (, fromPyth) = guard.refPrice(SPY);
        assertTrue(fromPyth, "Pyth");
        Quote memory q = minter.quote(id, false, true, tokens);
        assertFalse(q.queued, "payable");
        uint256 out = _sell(attacker, id, tokens);
        assertEq(out, q.amountOut, "quote equals execution");
        assertLt(out, POSITION * 9_300 / 10_000, "SPORT lost about 8% on a 4% move, plus spread");
    }

    /// The attack, now refused: lift the pool to Friday's price, hold it one TWAP window, try to sell at Friday's
    /// value. The sell queues, the queue cannot fill on the closed market or on Friday's round at the reopen, and
    /// the ticket fills at the first live round, at the market's price.
    function test_I7_1_LiftedTwapSellIsQueuedAndFillsAtTheLivePrice() public {
        if (address(gov) == address(0)) return;
        (uint256 last,) = guard.lastGood(SPY);

        PoolPusher pusher = new PoolPusher(IV3Pool(SPY_POOL), IERC20(SPY_STOCK), usdg);
        uint256 bankroll = 2_000_000e6;
        _fundUsdg(address(pusher), bankroll);
        (uint160 sq0,,,,,,) = IV3Pool(SPY_POOL).slot0();
        // target: 4.6% above the pool's price now (just over Friday), sqrt price up by sqrt(1.046)
        uint160 limit = uint160(uint256(sq0) * 102_274 / 100_000);
        pusher.swap(false, int256(bankroll), limit);

        // one TWAP window later (no other trade in the pool) the guard's reference reads Friday's level or more
        vm.warp(vm.getBlockTimestamp() + 30 minutes + 1);
        PriceReading memory r = guard.read(SPY);
        assertEq(uint256(r.session), uint256(Session.CLOSED));
        assertGe(r.refP, last, "the reference is back at Friday's price");

        // direct sell and hook sell are both refused; nothing leaves the Governor
        uint256 govBefore = usdg.balanceOf(address(gov));
        _expectUseQueue();
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _keyParams(id, false, tokens);
        vm.startPrank(attacker);
        _token(id).approve(address(router), tokens);
        vm.expectRevert();
        router.swapExactIn(key, p);

        // the deferred exit: queue now
        _token(id).approve(address(minter), tokens);
        uint256 ticket = minter.queueSell(id, tokens, 0, attacker);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);
        assertEq(usdg.balanceOf(address(gov)), govBefore, "nothing paid on the closed market");

        // Sunday 20:00:30 ET: the calendar reopens but Friday's round is not a live price (I7-2), so no fill yet
        vm.warp(friday + 2 days + 9 hours + 30);
        assertEq(uint256(guard.read(SPY).session), uint256(Session.HALTED), "Friday's round is not live");
        vm.expectRevert(abi.encodeWithSelector(IODMinter.NotFillable.selector, ticket));
        minter.fillQueued(ticket);

        // the first round of the week prints the weekend's price: the ticket fills there
        _reopenAtMarketPrice();
        uint256 before = usdg.balanceOf(attacker);
        uint256 quoted = minter.quote(id, false, true, tokens).amountOut;
        uint256 out = minter.fillQueued(ticket);
        assertEq(usdg.balanceOf(attacker) - before, out);
        assertEq(quoted, out, "quote equals the fill");
        assertGt(out, 0, "the exit is paid");
        assertLt(out, POSITION * 9_300 / 10_000, "paid at the market's price, not Friday's");
    }
}

/// I7-2 regression: with mainnet.json's 72 hour in-session age for SPY, Friday's feed round used to be a LIVE price
/// when the calendar reopened on Sunday 20:00 ET. A round printed before a close of 24 hours or more is now HALTED
/// until the feed prints again, the same as NVDA (26 hours).
contract Ind7ReopenStaleRoundForkTest is ForkSystem {
    uint256 internal constant EST = 5 hours;
    address internal constant SPY_POOL = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;

    function test_I7_2_SundayReopenFridayRoundIsNotLive() public {
        if (address(gov) == address(0)) return;
        vm.prank(keeper);
        mh.setSessionsWithKinds(new SessionWindow[](0), new Session[](0));
        vm.prank(admin);
        mh.setFallbackEnabled(true);
        uint256 day = (vm.getBlockTimestamp() - EST) / 1 days + 1;
        while ((day + 4) % 7 != 5) ++day;
        uint256 friday = day * 1 days + 11 hours + EST;
        vm.warp(friday);
        (uint160 sq,,,,,,) = IV3Pool(SPY_POOL).slot0();
        px[SPY] = uint256(sq) * uint256(sq) / (1 << 96) * 1e30 / (1 << 96); // Friday's price = the pool's price
        _refresh();
        uint256 fridayRound = guard.read(SPY).updatedAt;

        // Friday 19:59 ET, still in session: the same round is live (8 hours old, no long close since)
        vm.warp(friday + 9 hours - 60);
        assertTrue(guard.read(SPY).fresh, "live before the close");

        // Sunday 20:00:30 ET: the calendar reopens. No feed round and no Pyth print since Friday.
        vm.warp(friday + 2 days + 9 hours + 30);
        assertEq(uint256(mh.kindAt(vm.getBlockTimestamp())), uint256(Session.EXTENDED), "reopened");
        assertLt(vm.getBlockTimestamp() - fridayRound, guard.config(SPY).maxAgeExtended, "inside the age limit");
        PriceReading memory r = guard.read(SPY);
        assertEq(uint256(r.session), uint256(Session.HALTED), "Friday's round is not a live price");
        assertFalse(r.fresh);
        assertEq(r.reason, bytes32("HALTED"));
        assertEq(uint256(guard.read(NVDA).session), uint256(Session.HALTED), "NVDA (26 h) is halted too");

        _repost(SPY);
        bytes32 id = gearOf[SPY][Gear.SPORT];
        _fundUsdg(alice, 50_000e6);
        vm.startPrank(alice);
        usdg.approve(address(minter), 50_000e6);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.BuysClosed.selector, id, bytes32("CLOSED")));
        minter.buy(id, 50_000e6, 0, alice, uint64(vm.getBlockTimestamp()));
        vm.stopPrank();

        // the first round after the reopen is live again
        _refresh();
        assertEq(uint256(guard.read(SPY).session), uint256(Session.EXTENDED), "live on the new round");
        assertGt(_buy(alice, id, 50_000e6), 0, "buys reopen with the feed");
    }
}
