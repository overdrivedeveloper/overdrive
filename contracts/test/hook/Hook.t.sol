// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Pool} from "v4-core/libraries/Pool.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {HookFixture} from "./HookFixture.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {IODHook} from "overdrive/interfaces/IODHook.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {GearStatus, Quote, Session} from "overdrive/interfaces/ODTypes.sol";

/// Shared helpers for the hook tests.
abstract contract HookTestBase is HookFixture {
    function _wrapped(bytes4 callback, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            callback,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _swapWrapped(bytes memory reason) internal view returns (bytes memory) {
        return _wrapped(IHooks.beforeSwap.selector, reason);
    }

    /// Low-level pool swap as `who`; returns success and revert data.
    function _trySwap(address who, bytes32 id, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (bool ok, bytes memory ret)
    {
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(id, isBuy, exactIn, amount);
        IERC20 tin = isBuy ? IERC20(address(usdg)) : _token(id);
        vm.startPrank(who);
        tin.approve(address(router), type(uint256).max);
        (ok, ret) = address(router).call(abi.encodeCall(router.swap, (key, p)));
        vm.stopPrank();
    }

    function _assertHookEmpty() internal view {
        assertEq(usdg.balanceOf(address(hook)), 0, "hook usdg");
        assertEq(_token(sport).balanceOf(address(hook)), 0, "hook gear");
        assertEq(_token(reverse).balanceOf(address(hook)), 0, "hook reverse");
    }
}

contract HookTest is HookTestBase {
    using StateLibrary for IPoolManager;

    // ------------------------------------------------------------------------------------------ R1

    function test_PermissionsBits() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeAddLiquidity && p.beforeSwap && p.beforeSwapReturnDelta);
        assertFalse(
            p.afterInitialize || p.afterAddLiquidity || p.beforeRemoveLiquidity || p.afterRemoveLiquidity || p.afterSwap
                || p.beforeDonate || p.afterDonate || p.afterSwapReturnDelta || p.afterAddLiquidityReturnDelta
                || p.afterRemoveLiquidityReturnDelta
        );
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, ODHookMiner.FLAGS, "exactly the four bits");
        assertEq(hook.POOL_FEE(), 0);
        assertEq(hook.TICK_SPACING(), 60);
    }

    function test_MinedAddressMatchesFlags() public {
        assertEq(
            address(hook),
            ODHookMiner.computeAddress(address(this), hookSalt, keccak256(_hookCode(address(pm)))),
            "CREATE2 from this deployer"
        );
        // an unmined address is refused by the constructor
        bytes32 bad = hookSalt == bytes32(0) ? bytes32(uint256(1)) : bytes32(0);
        address at = ODHookMiner.computeAddress(address(this), bad, keccak256(_hookCode(address(pm))));
        if (uint160(at) & Hooks.ALL_HOOK_MASK != ODHookMiner.FLAGS) {
            vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, at));
            new ODHook{salt: bad}(
                IPoolManager(address(pm)), IODMinter(address(minter)), IODGearRegistry(address(reg)), usdg, admin
            );
        }
    }

    function test_OtherDeployerDifferentAddress() public {
        address other = makeAddr("otherDeployer");
        (address a, bytes32 s) = ODHookMiner.find(other, _hookCode(address(pm)));
        assertTrue(a != address(hook), "different deployer, different address");
        assertEq(uint160(a) & Hooks.ALL_HOOK_MASK, ODHookMiner.FLAGS);
        // this deployer's salt used by the other deployer lands on an address without the right bits (or elsewhere)
        address reuse = ODHookMiner.computeAddress(other, hookSalt, keccak256(_hookCode(address(pm))));
        assertTrue(reuse != address(hook));
        s; // silence
    }

    // ------------------------------------------------------------------------------------------ R2

    function test_StrangerCannotInitialize() public {
        bytes32 role = hook.DEFAULT_ADMIN_ROLE();
        uint160 px = hook.INIT_SQRT_PRICE_X96();
        bytes memory notGear =
            _wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(IODHook.NotGearPool.selector));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        hook.initializeGearPool(sport);
        // a stranger building the same pair with this hook but another fee is refused by beforeInitialize
        PoolKey memory key = hook.poolKeyOf(sport);
        key.fee = 3000;
        vm.prank(stranger);
        vm.expectRevert(notGear);
        pm.initialize(key, px);
        // re-initializing the real pool fails in the PoolManager
        vm.prank(admin);
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        hook.initializeGearPool(sport);
    }

    function test_WrongPairRefused() public {
        MockUSDG other = new MockUSDG();
        (address a, address b) =
            address(other) < address(usdg) ? (address(other), address(usdg)) : (address(usdg), address(other));
        PoolKey memory key = PoolKey(Currency.wrap(a), Currency.wrap(b), 0, 60, IHooks(address(hook)));
        uint160 px = hook.INIT_SQRT_PRICE_X96();
        bytes memory notGear =
            _wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(IODHook.NotGearPool.selector));
        vm.prank(stranger);
        vm.expectRevert(notGear);
        pm.initialize(key, px);
        // the admin cannot open a pool for an unknown gear either
        vm.prank(admin);
        vm.expectRevert();
        hook.initializeGearPool(keccak256("nope"));
        // the pool records its gear both ways
        PoolKey memory k = hook.poolKeyOf(sport);
        bytes32 pid = PoolId.unwrap(PoolId.wrap(keccak256(abi.encode(k))));
        assertEq(hook.poolIdOf(sport), pid);
        assertEq(hook.gearOfPool(pid), sport);
        assertTrue(Currency.unwrap(k.currency0) < Currency.unwrap(k.currency1), "sorted");
    }

    // ------------------------------------------------------------------------------------------ R3, R4

    function test_AddLiquidityReverts() public {
        IPoolManager.ModifyLiquidityParams memory p =
            IPoolManager.ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e18, salt: 0});
        PoolKey memory key = hook.poolKeyOf(sport);
        vm.expectRevert(
            _wrapped(IHooks.beforeAddLiquidity.selector, abi.encodeWithSelector(IODHook.LiquidityNotAllowed.selector))
        );
        router.addLiquidity(key, p);
        assertEq(IPoolManager(address(pm)).getLiquidity(PoolId.wrap(hook.poolIdOf(sport))), 0);
    }

    function test_PoolCurveNeverMoves() public {
        uint160 s0 = _sqrtPrice(sport);
        assertEq(s0, hook.INIT_SQRT_PRICE_X96());
        uint256 t = _hookBuy(alice, sport, 50_000e6);
        usdg.mint(alice, 10_000e6);
        _swap(alice, sport, true, false, 1e18);
        _swap(alice, sport, false, true, t / 2);
        _swap(alice, sport, false, false, 1_000e6);
        assertEq(_sqrtPrice(sport), s0, "price never moves");
        assertEq(IPoolManager(address(pm)).getLiquidity(PoolId.wrap(hook.poolIdOf(sport))), 0, "no liquidity");
    }

    // ------------------------------------------------------------------------------------------ R5

    function test_BuyExactIn() public {
        Quote memory q = _quote(sport, true, true, 10_000e6);
        uint256 before = usdg.balanceOf(address(gov)) + usdg.balanceOf(address(fees));
        usdg.mint(alice, 10_000e6);
        (uint256 paid, uint256 got) = _swap(alice, sport, true, true, 10_000e6);
        assertEq(paid, 10_000e6);
        assertEq(got, q.amountOut);
        assertEq(
            usdg.balanceOf(address(gov)) + usdg.balanceOf(address(fees)) - before,
            10_000e6,
            "USDG went to the Governor (protocol share forwarded to fees)"
        );
        _assertHookEmpty();
    }

    function test_BuyExactOut() public {
        Quote memory q = _quote(sport, true, false, 3e18);
        usdg.mint(alice, q.amountIn);
        (uint256 paid, uint256 got) = _swap(alice, sport, true, false, 3e18);
        assertEq(got, 3e18);
        assertEq(paid, q.amountIn);
        _assertHookEmpty();
    }

    function test_HookSwapEqualsPreview() public {
        bytes32[4] memory ids = [cruise, race, reverse, pair];
        for (uint256 i; i < ids.length; ++i) {
            Quote memory q = _quote(ids[i], true, true, 7_777e6);
            usdg.mint(bob, 7_777e6);
            (uint256 paid, uint256 got) = _swap(bob, ids[i], true, true, 7_777e6);
            assertEq(paid, q.amountIn);
            assertEq(got, q.amountOut);
            q = _quote(ids[i], false, true, got / 3);
            (paid, got) = _swap(bob, ids[i], false, true, got / 3);
            assertEq(paid, q.amountIn);
            assertEq(got, q.amountOut);
        }
    }

    // ------------------------------------------------------------------------------------------ R6

    function test_SellExactIn() public {
        uint256 t = _hookBuy(alice, sport, 20_000e6);
        Quote memory q = _quote(sport, false, true, t);
        (uint256 paid, uint256 got) = _swap(alice, sport, false, true, t);
        assertEq(paid, t);
        assertEq(got, q.amountOut);
        assertEq(_token(sport).balanceOf(alice), 0);
        _assertHookEmpty();
    }

    function test_SellExactOut() public {
        _hookBuy(alice, sport, 20_000e6);
        Quote memory q = _quote(sport, false, false, 5_000e6);
        (uint256 paid, uint256 got) = _swap(alice, sport, false, false, 5_000e6);
        assertEq(got, 5_000e6);
        assertEq(paid, q.amountIn);
        _assertHookEmpty();
    }

    function test_SellUseQueueRevertsWholeSwap() public {
        uint256 t = _hookBuy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        _dropRef(TSLA);
        uint256 supply = _token(sport).totalSupply();
        (bool ok, bytes memory ret) = _trySwap(alice, sport, false, true, t);
        assertFalse(ok);
        assertEq(ret, _swapWrapped(abi.encodeWithSelector(IODMinter.UseQueue.selector)));
        assertEq(_token(sport).balanceOf(alice), t, "nothing moved");
        assertEq(_token(sport).totalSupply(), supply, "nothing burned");
        // the exit is the minter's queue, directly
        vm.prank(alice);
        uint256 ticket = minter.queueSell(sport, t, 0, alice);
        assertGt(ticket, 0);
    }

    // ------------------------------------------------------------------------------------------ R7

    function test_HookBalanceZeroAfterSwaps() public {
        uint256 t = _hookBuy(alice, sport, 30_000e6);
        _assertHookEmpty();
        uint256 r = _hookBuy(bob, reverse, 15_000e6);
        _assertHookEmpty();
        _swap(alice, sport, false, false, 2_000e6);
        _assertHookEmpty();
        _swap(bob, reverse, false, true, r);
        _assertHookEmpty();
        _swap(alice, sport, false, true, _token(sport).balanceOf(alice));
        _assertHookEmpty();
        t;
    }

    function test_DonationToHookIgnored() public {
        uint256 t = _hookBuy(alice, sport, 30_000e6);
        Quote memory qb = _quote(sport, true, true, 1_000e6);
        Quote memory qs = _quote(sport, false, true, t / 4);
        usdg.mint(address(hook), 5_000e6);
        IERC20 tok = _token(sport);
        vm.prank(alice);
        tok.transfer(address(hook), t / 4);
        assertEq(_quote(sport, true, true, 1_000e6).amountOut, qb.amountOut, "price unchanged");
        usdg.mint(bob, 1_000e6);
        (, uint256 got) = _swap(bob, sport, true, true, 1_000e6);
        assertEq(got, qb.amountOut);
        qs = _quote(sport, false, true, t / 4);
        (, got) = _swap(alice, sport, false, true, t / 4);
        assertEq(got, qs.amountOut);
        assertEq(usdg.balanceOf(address(hook)), 5_000e6, "donation untouched");
        assertEq(_token(sport).balanceOf(address(hook)), t / 4, "donation untouched");
    }

    // ------------------------------------------------------------------------------------------ R8

    function test_BuyBlockedWhenClosed() public {
        _session(Session.CLOSED);
        usdg.mint(alice, 1_000e6);
        (bool ok, bytes memory ret) = _trySwap(alice, sport, true, true, 1_000e6);
        assertFalse(ok);
        assertEq(ret, _swapWrapped(abi.encodeWithSelector(IODMinter.BuysClosed.selector, sport, bytes32("CLOSED"))));
        vm.prank(guardian);
        gov.setBuysPaused(true);
        _session(Session.OPEN);
        (ok, ret) = _trySwap(alice, sport, true, true, 1_000e6);
        assertEq(ret, _swapWrapped(abi.encodeWithSelector(IODMinter.BuysClosed.selector, sport, bytes32("PAUSED"))));
    }

    function test_SellAllowedWhenClosedWithRef() public {
        uint256 t = _hookBuy(alice, sport, 10_000e6);
        _session(Session.CLOSED);
        Quote memory q = _quote(sport, false, true, t);
        assertFalse(q.queued);
        (, uint256 got) = _swap(alice, sport, false, true, t);
        assertEq(got, q.amountOut);
        assertGt(got, 9_000e6);
    }

    /// Fuzzed state: the hook's outcome (and revert reason, unwrapped) equals a direct minter call's.
    function testFuzz_HookMatchesMinterGating(uint8 session, uint8 flags, uint32 dt, uint64 amt) public {
        uint256 held = _buy(alice, sport, 50_000e6);
        uint256 amount = bound(amt, 1, 200_000e6);
        _session(Session(bound(session, 0, 4)));
        if (flags & 1 != 0) _dropRef(TSLA);
        if (flags & 2 != 0) {
            vm.prank(guardian);
            reg.setStatus(sport, GearStatus.BUYS_PAUSED);
        }
        if (flags & 4 != 0) {
            vm.prank(guardian);
            gov.setBuysPaused(true);
        }
        if (flags & 8 != 0) vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 6 days)); // stale inputs
        if (flags & 16 != 0) usdg.setBlocked(address(pm), true); // payout to the PoolManager fails

        usdg.mint(alice, amount);
        // buy
        uint256 snap = vm.snapshotState();
        vm.startPrank(alice);
        usdg.approve(address(minter), amount);
        (bool okD, bytes memory retD) =
            address(minter).call(abi.encodeCall(minter.buy, (sport, amount, 0, alice, uint64(vm.getBlockTimestamp()))));
        vm.stopPrank();
        vm.revertToState(snap);
        (bool okH, bytes memory retH) = _trySwap(alice, sport, true, true, amount);
        vm.revertToState(snap);
        if (flags & 16 == 0) {
            assertEq(okH, okD, "buy outcome");
            if (!okD) assertEq(retH, _swapWrapped(retD), "buy reason");
        } else if (okH) {
            assertTrue(okD);
        }
        // sell (the PoolManager blocklist only affects the hook's payout, so skip comparing that case)
        uint256 tokens = bound(amt, 1, held);
        vm.startPrank(alice);
        (okD, retD) = address(minter)
            .call(abi.encodeCall(minter.sell, (sport, tokens, 0, alice, uint64(vm.getBlockTimestamp()))));
        vm.stopPrank();
        vm.revertToState(snap);
        (okH, retH) = _trySwap(alice, sport, false, true, tokens);
        if (flags & 16 == 0) {
            assertEq(okH, okD, "sell outcome");
            if (!okD) assertEq(retH, _swapWrapped(retD), "sell reason");
        }
    }

    // ------------------------------------------------------------------------------------------ R9

    function test_PriceLimitHandling() public {
        usdg.mint(alice, 10_000e6);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(sport, true, true, 1_000e6);
        uint160 s = _sqrtPrice(sport);
        // a limit already crossed reverts as in v4
        p.sqrtPriceLimitX96 = s;
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        bytes memory err = p.zeroForOne
            ? abi.encodeWithSelector(Pool.PriceLimitAlreadyExceeded.selector, s, s)
            : abi.encodeWithSelector(Pool.PriceLimitAlreadyExceeded.selector, s, s);
        vm.expectRevert(_swapWrapped(err));
        router.swap(key, p);
        // out of bounds
        p.sqrtPriceLimitX96 = p.zeroForOne ? TickMath.MIN_SQRT_PRICE : TickMath.MAX_SQRT_PRICE;
        vm.expectRevert(_swapWrapped(abi.encodeWithSelector(Pool.PriceLimitOutOfBounds.selector, p.sqrtPriceLimitX96)));
        router.swap(key, p);
        // any limit on the right side prices the same (the limit is not a price)
        Quote memory q = _quote(sport, true, true, 1_000e6);
        p.sqrtPriceLimitX96 = p.zeroForOne ? s - 1 : s + 1;
        uint256 before = _token(sport).balanceOf(alice);
        router.swap(key, p);
        vm.stopPrank();
        assertEq(_token(sport).balanceOf(alice) - before, q.amountOut, "no LP fee, same amount");
        (,, uint24 protocolFee, uint24 lpFee) = IPoolManager(address(pm)).getSlot0(PoolId.wrap(hook.poolIdOf(sport)));
        assertEq(protocolFee, 0);
        assertEq(lpFee, 0);
    }

    // ------------------------------------------------------------------------------------------ R11

    function test_OnlyPoolManagerCallbacks() public {
        PoolKey memory key = hook.poolKeyOf(sport);
        (, IPoolManager.SwapParams memory p) = _params(sport, true, true, 1_000e6);
        vm.startPrank(stranger);
        vm.expectRevert(ODHook.NotPoolManager.selector);
        hook.beforeSwap(stranger, key, p, "");
        vm.expectRevert(ODHook.NotPoolManager.selector);
        hook.beforeInitialize(stranger, key, 1);
        vm.expectRevert(ODHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(stranger, key, IPoolManager.ModifyLiquidityParams(-60, 60, 1, 0), "");
        vm.expectRevert(IODMinter.NotHook.selector);
        minter.hookSwap(sport, true, true, 1_000e6, stranger);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------ R12

    function test_EventsOncePerSwap() public {
        bytes32 boughtSig = IODMinter.Bought.selector;
        bytes32 soldSig = IODMinter.Sold.selector;
        usdg.mint(alice, 10_000e6);
        vm.recordLogs();
        (, uint256 t) = _swap(alice, sport, true, true, 10_000e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 nb, bool via) = _count(logs, boughtSig);
        assertEq(nb, 1, "one Bought");
        assertTrue(via, "viaHook");
        vm.recordLogs();
        _swap(alice, sport, false, true, t);
        logs = vm.getRecordedLogs();
        uint256 ns;
        (ns, via) = _count(logs, soldSig);
        assertEq(ns, 1, "one Sold");
        assertTrue(via, "viaHook");
        (nb,) = _count(logs, boughtSig);
        assertEq(nb, 0);
    }

    function _count(Vm.Log[] memory logs, bytes32 sig) private view returns (uint256 n, bool viaHook) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(minter) && logs[i].topics[0] == sig) {
                ++n;
                // viaHook is the 5th data word in both events
                bytes memory d = logs[i].data;
                uint256 w;
                assembly {
                    w := mload(add(d, 160))
                }
                viaHook = w == 1;
            }
        }
    }
}

/// USDG that calls back into the protocol on every transfer while armed.
contract ReentrantUSDG is MockUSDG {
    address public target;
    bytes public payload;
    uint256 public attempts;
    uint256 public successes;
    bool private _in;

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && !_in) {
            _in = true;
            ++attempts;
            (bool ok,) = target.call(payload);
            if (ok) ++successes;
            _in = false;
        }
    }
}

/// R11: a token callback cannot re-enter the hook or the minter's hook path.
contract HookReentrancyTest is HookTestBase {
    function _newUsdg() internal override returns (MockUSDG) {
        return new ReentrantUSDG();
    }

    function test_ReentrantTokenCannotReenter() public {
        ReentrantUSDG r = ReentrantUSDG(address(usdg));
        uint256 t = _hookBuy(alice, sport, 10_000e6);
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(sport, true, true, 1_000e6);
        bytes[3] memory payloads = [
            abi.encodeCall(minter.hookSwap, (sport, true, true, 1_000e6, address(r))),
            abi.encodeCall(hook.beforeSwap, (address(r), key, p, bytes(""))),
            abi.encodeCall(hook.initializeGearPool, (sport))
        ];
        address[3] memory targets = [address(minter), address(hook), address(hook)];
        for (uint256 i; i < 3; ++i) {
            r.arm(targets[i], payloads[i]);
            Quote memory q = _quote(sport, true, true, 1_000e6);
            usdg.mint(bob, 1_000e6);
            (, uint256 got) = _swap(bob, sport, true, true, 1_000e6);
            assertEq(got, q.amountOut, "swap unaffected");
            q = _quote(sport, false, true, t / 10);
            (, got) = _swap(alice, sport, false, true, t / 10);
            assertEq(got, q.amountOut, "sell unaffected");
        }
        assertGt(r.attempts(), 0, "callbacks fired");
        assertEq(r.successes(), 0, "no re-entry succeeded");
        _assertHookEmpty();
    }
}

/// Without a physical balance of the input currency in the PoolManager the hook cannot front the swap: it refuses with
/// a clear error, holds nothing, and the minter's own path still works.
contract HookUnseededTest is HookTestBase {
    function _seedPoolManager() internal pure override returns (bool) {
        return false;
    }

    function test_UnseededPoolManagerRefusesClearly() public {
        Quote memory q = _quote(sport, true, true, 1_000e6);
        usdg.mint(alice, 1_000e6);
        (bool ok, bytes memory ret) = _trySwap(alice, sport, true, true, 1_000e6);
        assertFalse(ok);
        assertEq(ret, _swapWrapped(abi.encodeWithSelector(ODHook.PoolManagerShort.selector, address(usdg), 0, 1_000e6)));
        uint256 t = _buy(alice, sport, 1_000e6);
        assertEq(t, q.amountOut, "minter path unaffected");
        (ok, ret) = _trySwap(alice, sport, false, true, t);
        assertEq(
            ret, _swapWrapped(abi.encodeWithSelector(ODHook.PoolManagerShort.selector, address(_token(sport)), 0, t))
        );
        assertGt(_sell(alice, sport, t), 0, "exit through the minter");
        _assertHookEmpty();
    }
}
