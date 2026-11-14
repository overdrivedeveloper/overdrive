// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IProtocolFees} from "v4-core/interfaces/IProtocolFees.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {console2} from "forge-std/console2.sol";
import {ForkBase, IDeployedV4Quoter, IDeployedUniversalRouter, IDeployedPermit2} from "./ForkBase.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {Quote, Session} from "overdrive/interfaces/ODTypes.sol";

/// Universal Router v4 single-hop params (v4-periphery IV4Router.ExactInputSingleParams as deployed).
struct URExactInputSingle {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// 06b: ODHook on the DEPLOYED PoolManager, quoted by the DEPLOYED V4Quoter, routed by the DEPLOYED Universal Router.
/// The singleton is seeded exactly as HookFixture._seed() does (backlog D26 default A).
contract HookForkTest is ForkBase {
    using StateLibrary for IPoolManager;

    uint8 internal constant UR_V4_SWAP = 0x10;
    uint8 internal constant A_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant A_SETTLE = 0x0b;
    uint8 internal constant A_SETTLE_ALL = 0x0c;
    uint8 internal constant A_TAKE_ALL = 0x0f;

    // ------------------------------------------------------------------------------------------ R1 parity

    /// One mode: real V4Quoter == minter.quote == the swapper's executed balance deltas through the real PoolManager.
    function _mode(bytes32 id, bool isBuy, bool exactIn, uint256 amount) internal {
        Quote memory q = minter.quote(id, isBuy, exactIn, amount);
        (uint256 vIn, uint256 vOut) = _v4Quote(id, isBuy, exactIn, amount);
        assertEq(vIn, q.amountIn, "V4Quoter in == minter.quote");
        assertEq(vOut, q.amountOut, "V4Quoter out == minter.quote");
        if (isBuy) usdg.mint(alice, vIn);
        (uint256 paid, uint256 got) = _swap(alice, id, isBuy, exactIn, amount);
        assertEq(paid, vIn, "executed in == V4Quoter");
        assertEq(got, vOut, "executed out == V4Quoter");
    }

    function _parity(bytes32 id, uint256 buyIn, uint256 buyOutTokens, uint256 sellOutUsdg) internal {
        _mode(id, true, true, buyIn); // buy exact in
        _mode(id, true, false, buyOutTokens); // buy exact out
        uint256 held = _gearToken(id).balanceOf(alice);
        _mode(id, false, true, held / 3); // sell exact in
        _mode(id, false, false, sellOutUsdg); // sell exact out
    }

    function test_V4QuoterParity_TSLA_SPORT() public {
        _parity(sport, 10_000e6, 3e18, 1_000e6);
    }

    function test_V4QuoterParity_NVDA_CRUISE() public {
        _parity(nvdaCruise, 10_000e6, 5e18, 1_000e6);
    }

    function test_V4QuoterParity_SPY_SPORT() public {
        _parity(spySport, 10_000e6, 2e18, 1_000e6);
    }

    function test_V4QuoterParity_ETH_SPORT() public {
        _parity(ethSport, 10_000e6, 1e18, 1_000e6);
    }

    // ------------------------------------------------------------------------------------------ R2 closed market

    /// Stocks CLOSED (next Saturday 12:00 UTC; the fixture's calendar is a mock, so the session is set with it).
    function _weekend() internal {
        uint256 t = vm.getBlockTimestamp();
        uint256 day = (t / 1 days + 4) % 7; // 0 = Sunday
        uint256 next = (t / 1 days + (6 + 7 - day) % 7) * 1 days + 12 hours;
        if (next <= t) next += 7 days;
        _warpFresh(next - t);
        _price(SPY, _p(SPY));
        _postVol(SPY, 2000);
        _session(Session.CLOSED);
    }

    function test_WeekendBuysBlockedStocks() public {
        _weekend();
        bytes32[2] memory ids = [sport, spySport];
        for (uint256 i; i < ids.length; ++i) {
            IDeployedV4Quoter.QuoteExactSingleParams memory qp = _qp(ids[i], true, 1_000e6);
            vm.expectRevert();
            quoter.quoteExactInputSingle(qp);
            usdg.mint(alice, 1_000e6);
            (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(ids[i], true, true, 1_000e6);
            vm.startPrank(alice);
            usdg.approve(address(router), type(uint256).max);
            vm.expectRevert();
            router.swap(key, p);
            vm.stopPrank();
        }
    }

    function test_WeekendCryptoOpen() public {
        _weekend();
        _mode(ethSport, true, true, 5_000e6);
        _mode(ethSport, false, true, _gearToken(ethSport).balanceOf(alice) / 2);
    }

    function test_WeekendSellAtMin() public {
        uint256 t = _hookBuy(alice, sport, 20_000e6);
        _weekend();
        uint256 last = _p(TSLA);
        uint256 amt = t / 4;
        // reference above the last value: min picks the last value
        _ref(TSLA, last * 104 / 100);
        (, uint256 atLast) = _v4Quote(sport, false, true, amt);
        // reference below the last value: min picks the reference, so the holder gets less
        _ref(TSLA, last * 98 / 100);
        (, uint256 atRef) = _v4Quote(sport, false, true, amt);
        assertLt(atRef, atLast, "sell priced at min(last, ref)");
        _mode(sport, false, true, amt);
        // no reference: the hook path refuses (the holder queues through the minter)
        _dropRef(TSLA);
        IDeployedV4Quoter.QuoteExactSingleParams memory qp = _qp(sport, false, amt);
        vm.expectRevert();
        quoter.quoteExactInputSingle(qp);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(sport, false, true, amt);
        vm.startPrank(alice);
        _token(sport).approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(key, p);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------ R3 protocol fee

    function test_NoProtocolFeeTaken() public {
        IProtocolFees fees_ = IProtocolFees(address(pm));
        Currency cu = Currency.wrap(address(usdg));
        Currency cg = Currency.wrap(address(_token(sport)));
        uint256 u0 = fees_.protocolFeesAccrued(cu);
        uint256 g0 = fees_.protocolFeesAccrued(cg);
        (,, uint24 protocolFee,) = IPoolManager(address(pm)).getSlot0(PoolId.wrap(hook.poolIdOf(sport)));
        assertEq(protocolFee, 0, "pool protocol fee");
        uint256 t = _hookBuy(alice, sport, 10_000e6);
        _swap(alice, sport, false, true, t / 2);
        // even at the maximum protocol fee the controller can set, the hook takes the whole swap (zero curve amount)
        address controller = address(fees_.protocolFeeController());
        console2.log("protocolFeeController", controller);
        PoolKey memory key = hook.poolKeyOf(sport);
        vm.prank(controller);
        fees_.setProtocolFee(key, uint24(1000 | (1000 << 12)));
        (,, protocolFee,) = IPoolManager(address(pm)).getSlot0(PoolId.wrap(hook.poolIdOf(sport)));
        assertEq(protocolFee, uint24(1000 | (1000 << 12)), "max protocol fee set");
        _hookBuy(alice, sport, 10_000e6);
        _swap(alice, sport, false, true, _gearToken(sport).balanceOf(alice) / 2);
        assertEq(fees_.protocolFeesAccrued(cu), u0, "no USDG protocol fee");
        assertEq(fees_.protocolFeesAccrued(cg), g0, "no gear protocol fee");
    }

    // ------------------------------------------------------------------------------------------ R5 router

    function _permit(address who, IERC20 token) internal {
        vm.startPrank(who);
        token.approve(RHC_PERMIT2, type(uint256).max);
        IDeployedPermit2(RHC_PERMIT2).approve(address(token), RHC_UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    /// Wallet order: SWAP, SETTLE_ALL (pay after the swap), TAKE_ALL. Needs the seeded singleton.
    function _urBuy(address who, bytes32 id, uint256 usdgIn, bool settleFirst_) internal returns (uint256 got) {
        PoolKey memory key = hook.poolKeyOf(id);
        URExactInputSingle memory s;
        s.poolKey = key;
        s.zeroForOne = _usdgIs0(key);
        s.amountIn = uint128(usdgIn);
        bytes memory actions;
        bytes[] memory params = new bytes[](3);
        if (settleFirst_) {
            actions = abi.encodePacked(A_SETTLE, A_SWAP_EXACT_IN_SINGLE, A_TAKE_ALL);
            params[0] = abi.encode(address(usdg), usdgIn, true);
            params[1] = abi.encode(s);
        } else {
            actions = abi.encodePacked(A_SWAP_EXACT_IN_SINGLE, A_SETTLE_ALL, A_TAKE_ALL);
            params[0] = abi.encode(s);
            params[1] = abi.encode(address(usdg), usdgIn);
        }
        params[2] = abi.encode(address(_token(id)), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        usdg.mint(who, usdgIn);
        _permit(who, IERC20(address(usdg)));
        uint256 b0 = _token(id).balanceOf(who);
        vm.prank(who);
        IDeployedUniversalRouter(RHC_UNIVERSAL_ROUTER).execute(abi.encodePacked(UR_V4_SWAP), inputs, block.timestamp);
        got = _token(id).balanceOf(who) - b0;
    }

    function test_UniversalRouterRoutes() public {
        Quote memory q = minter.quote(sport, true, true, 7_000e6);
        (, uint256 vOut) = _v4Quote(sport, true, true, 7_000e6);
        uint256 got = _urBuy(bob, sport, 7_000e6, false);
        assertEq(got, q.amountOut, "Universal Router out == minter.quote");
        assertEq(got, vOut, "Universal Router out == V4Quoter");
    }

    // ------------------------------------------------------------------------------------------ gas

    /// Measured gas per hook swap through the real PoolManager (router call, warm system, exact in).
    function test_GasPerHookSwap() public {
        _hookBuy(alice, sport, 1_000e6); // warm the gear and the Governor
        usdg.mint(bob, 5_000e6);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(sport, true, true, 5_000e6);
        vm.startPrank(bob);
        usdg.approve(address(router), type(uint256).max);
        uint256 g = gasleft();
        router.swap(key, p);
        uint256 buyGas = g - gasleft();
        usdg.mint(bob, 5_000e6);
        g = gasleft();
        router.swap(key, p);
        uint256 buyGas2 = g - gasleft();
        console2.log("hook buy gas, second buy same block", buyGas2);
        uint256 t = _token(sport).balanceOf(bob);
        _token(sport).approve(address(router), type(uint256).max);
        (key, p) = _params(sport, false, true, t / 2);
        g = gasleft();
        router.swap(key, p);
        uint256 sellGas = g - gasleft();
        vm.stopPrank();
        console2.log("hook buy gas (exact in)", buyGas);
        console2.log("hook sell gas (exact in)", sellGas);
        assertLt(buyGas, 5_000_000);
        assertLt(sellGas, 5_000_000);
    }
}

/// D26: with no seed in the singleton, a swap-then-settle buy (the V4Quoter, the wallet order through the Universal
/// Router, HookRouter) reverts PoolManagerShort; a settle-first buy pays in before the hook takes and works.
contract HookForkUnseededTest is ForkBase {
    function _seedPoolManager() internal pure override returns (bool) {
        return false;
    }

    function test_UnseededSwapThenSettleShort_SettleFirstWorks() public {
        uint256 amt = 1_000e6;
        Quote memory q = minter.quote(sport, true, true, amt);
        bytes memory short = abi.encodeWithSelector(ODHook.PoolManagerShort.selector, address(usdg), 0, amt);
        // the real V4Quoter (swap then revert) cannot quote
        try quoter.quoteExactInputSingle(_qp(sport, true, amt)) {
            revert("quoter should fail unseeded");
        } catch (bytes memory r) {
            assertTrue(_contains(r, short), "quoter revert carries PoolManagerShort");
        }
        // swap-then-settle router
        usdg.mint(alice, amt);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(sport, true, true, amt);
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        try router.swap(key, p) {
            revert("swap-then-settle should fail unseeded");
        } catch (bytes memory r) {
            assertTrue(_contains(r, short), "router revert carries PoolManagerShort");
        }
        // settle first: works, at the minter's quote
        usdg.approve(address(settleFirst), type(uint256).max);
        uint256 b0 = _token(sport).balanceOf(alice);
        uint256 g = gasleft();
        settleFirst.swapExactIn(key, p);
        console2.log("settle-first hook buy gas", g - gasleft());
        vm.stopPrank();
        assertEq(_token(sport).balanceOf(alice) - b0, q.amountOut, "settle-first out == minter.quote");
        assertEq(usdg.balanceOf(alice), 0, "paid exactly");
    }

    /// ABI-encoded `needle` appears inside `hay` (revert data is wrapped by the PoolManager's hook-call error).
    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool ok = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
