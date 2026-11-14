// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {HookFixture} from "./HookFixture.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {Quote} from "overdrive/interfaces/ODTypes.sol";

/// R10 (QUOTE-1): the minter's quote equals the swapper's actual balance deltas through the pool, and the V4Quoter
/// mechanism (simulate the swap, revert with the deltas) returns the same numbers, for all four modes, with toll due
/// and the exit reserve drawn.
contract HookQuoteTest is HookFixture {
    uint256 internal held;

    function setUp() public override {
        super.setUp();
        held = _hookBuy(alice, sport, 100_000e6);
        _warpFresh(3 days); // toll due: the next trade accrues it
        // move all but a little cash to the exit reserve so sells draw it
        uint256 cash = gov.trackedCash();
        vm.prank(admin);
        gov.moveToExitReserve(cash - 1_000e6);
    }

    function _case(bool isBuy, bool exactIn, uint256 amount) internal {
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(sport, isBuy, exactIn, amount);
        Quote memory q;
        try minter.quote(sport, isBuy, exactIn, amount) returns (Quote memory q0) {
            q = q0;
        } catch {
            // the minter refuses (caps, stress, minimum): the pool refuses too
            vm.expectRevert();
            router.quote(key, p);
            return;
        }
        // V4Quoter-style simulation through the pool
        (int128 a0, int128 a1) = router.quote(key, p);
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        (int128 dIn, int128 dOut) = (isBuy == usdgIs0) ? (a0, a1) : (a1, a0);
        assertEq(uint256(uint128(-dIn)), q.amountIn, "simulated in");
        assertEq(uint256(uint128(dOut)), q.amountOut, "simulated out");
        // execution: the swapper's balance deltas, at the exact limit (a router demanding exactly the quote passes)
        if (isBuy) usdg.mint(alice, q.amountIn);
        uint256 resBefore = gov.exitReserve();
        (uint256 paid, uint256 got) = _swap(alice, sport, isBuy, exactIn, amount);
        assertEq(paid, q.amountIn, "paid");
        assertEq(got, q.amountOut, "got");
        if (!isBuy && q.amountOut > 1_000e6) assertLt(gov.exitReserve(), resBefore, "reserve drawn");
    }

    function test_QuoteEqualsSwapDeltas() public {
        _case(false, true, held / 4); // sell exact in, draws the reserve
        _case(false, false, 20_000e6); // sell exact out
        _case(true, true, 12_345e6); // buy exact in
        _case(true, false, 17e18); // buy exact out
    }

    function testFuzz_QuoteEqualsSwapDeltas(uint8 mode, uint256 amount, uint32 dt) public {
        _warpFresh(bound(dt, 0, 2 days));
        bool isBuy = mode & 1 == 0;
        bool exactIn = mode & 2 == 0;
        if (isBuy) amount = exactIn ? bound(amount, 1e6, 100_000e6) : bound(amount, 1e16, 100e18);
        else amount = exactIn ? bound(amount, 1, held / 4) : bound(amount, 1, 20_000e6);
        _case(isBuy, exactIn, amount);
    }
}
