// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {ODHook} from "overdrive/hook/ODHook.sol";
import {ODHookMiner} from "overdrive/hook/ODHookMiner.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";

/// A minimal v4 router (the vendored v4-core ships no test utils): swaps and pays from the caller, and a quote mode that
/// reverts with the deltas the way V4Quoter does (simulate, revert, decode).
contract HookRouter is IUnlockCallback {
    IPoolManager public immutable pm;

    error QuoteResult(int128 amount0, int128 amount1);

    enum Op {
        SWAP,
        QUOTE,
        ADD,
        DEPOSIT
    }

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function swap(PoolKey memory key, IPoolManager.SwapParams memory p) external returns (BalanceDelta d) {
        d = abi.decode(pm.unlock(abi.encode(Op.SWAP, msg.sender, key, abi.encode(p))), (BalanceDelta));
    }

    /// Swapper's deltas without executing (negative = paid, positive = received).
    function quote(PoolKey memory key, IPoolManager.SwapParams memory p) external returns (int128 a0, int128 a1) {
        try pm.unlock(abi.encode(Op.QUOTE, msg.sender, key, abi.encode(p))) {
            revert("quote did not revert");
        } catch (bytes memory r) {
            if (r.length != 68 || bytes4(r) != QuoteResult.selector) {
                assembly {
                    revert(add(r, 32), mload(r))
                }
            }
            assembly {
                a0 := mload(add(r, 36))
                a1 := mload(add(r, 68))
            }
        }
    }

    function addLiquidity(PoolKey memory key, IPoolManager.ModifyLiquidityParams memory p) external {
        pm.unlock(abi.encode(Op.ADD, msg.sender, key, abi.encode(p)));
    }

    /// Deposits `amount` of `c` into the PoolManager as the caller's ERC-6909 claims (physical balance in the PM).
    function deposit(Currency c, uint256 amount) external {
        PoolKey memory key;
        key.currency0 = c;
        pm.unlock(abi.encode(Op.DEPOSIT, msg.sender, key, abi.encode(amount)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (Op op, address payer, PoolKey memory key, bytes memory inner) = abi.decode(data, (Op, address, PoolKey, bytes));
        if (op == Op.DEPOSIT) {
            uint256 amount = abi.decode(inner, (uint256));
            _resolve(key.currency0, -int128(uint128(amount)), payer);
            pm.mint(payer, key.currency0.toId(), amount);
            return "";
        }
        if (op == Op.ADD) {
            pm.modifyLiquidity(key, abi.decode(inner, (IPoolManager.ModifyLiquidityParams)), "");
            return "";
        }
        BalanceDelta d = pm.swap(key, abi.decode(inner, (IPoolManager.SwapParams)), "");
        if (op == Op.QUOTE) revert QuoteResult(d.amount0(), d.amount1());
        _resolve(key.currency0, d.amount0(), payer);
        _resolve(key.currency1, d.amount1(), payer);
        return abi.encode(d);
    }

    function _resolve(Currency c, int128 a, address who) private {
        if (a < 0) {
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transferFrom(who, address(pm), uint256(uint128(-a)));
            pm.settle();
        } else if (a > 0) {
            pm.take(c, who, uint256(uint128(a)));
        }
    }
}

/// SystemFixture plus a real local v4 PoolManager, ODHook at a mined CREATE2 address (deployer = this test), wired
/// into the minter, and a pool for every listed single-name gear and the pair.
abstract contract HookFixture is SystemFixture {
    using StateLibrary for IPoolManager;

    PoolManager internal pm;
    ODHook internal hook;
    HookRouter internal router;
    bytes32 internal hookSalt;

    function setUp() public virtual override {
        super.setUp();
        pm = _newPoolManager();
        router = new HookRouter(IPoolManager(address(pm)));
        bytes memory code = _hookCode(address(pm));
        address predicted;
        (predicted, hookSalt) = ODHookMiner.find(address(this), code);
        hook = new ODHook{salt: hookSalt}(
            IPoolManager(address(pm)), IODMinter(address(minter)), IODGearRegistry(address(reg)), usdg, admin
        );
        assertEq(address(hook), predicted, "mined address");
        vm.startPrank(admin);
        minter.setHook(address(hook));
        hook.initializeGearPool(cruise);
        hook.initializeGearPool(sport);
        hook.initializeGearPool(race);
        hook.initializeGearPool(eco);
        hook.initializeGearPool(reverse);
        hook.initializeGearPool(ethSport);
        hook.initializeGearPool(pair);
        vm.stopPrank();
        if (_seedPoolManager()) _seed();
    }

    /// The PoolManager the hook binds to: a fresh local one here; the fork suite returns the deployed singleton.
    function _newPoolManager() internal virtual returns (PoolManager) {
        return new PoolManager(admin);
    }

    /// See docs: the hook moves the input currency out of the PoolManager before the swapper settles, so the PM must
    /// physically hold it. Seeding stands in for other users' ERC-6909 balances in the singleton.
    function _seedPoolManager() internal view virtual returns (bool) {
        return true;
    }

    function _seed() internal {
        address seeder = makeAddr("pmSeeder");
        usdg.mint(seeder, 3_000_000e6);
        vm.startPrank(seeder);
        usdg.approve(address(router), type(uint256).max);
        router.deposit(Currency.wrap(address(usdg)), 2_000_000e6);
        vm.stopPrank();
        _seedGear(seeder, sport, 80_000e6);
        _seedGear(seeder, reverse, 20_000e6);
        _seedGear(seeder, cruise, 20_000e6);
        _seedGear(seeder, race, 20_000e6);
        _seedGear(seeder, pair, 20_000e6);
    }

    function _seedGear(address seeder, bytes32 id, uint256 usdgIn) internal {
        vm.startPrank(seeder);
        usdg.approve(address(minter), usdgIn);
        uint256 t = minter.buy(id, usdgIn, 0, seeder, uint64(vm.getBlockTimestamp()));
        _token(id).approve(address(router), t);
        router.deposit(Currency.wrap(address(_token(id))), t);
        vm.stopPrank();
    }

    function _hookCode(address pm_) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(ODHook).creationCode, abi.encode(pm_, address(minter), address(reg), address(usdg), admin)
        );
    }

    // ------------------------------------------------------------------------------------------ swaps

    function _params(bytes32 id, bool isBuy, bool exactIn, uint256 amount)
        internal
        view
        returns (PoolKey memory key, IPoolManager.SwapParams memory p)
    {
        key = hook.poolKeyOf(id);
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        p.zeroForOne = isBuy == usdgIs0; // input is currency0
        p.amountSpecified = exactIn ? -int256(amount) : int256(amount);
        p.sqrtPriceLimitX96 = p.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// Swaps through the pool as `who`; returns what `who` paid and received (balance deltas).
    function _swap(address who, bytes32 id, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (uint256 paid, uint256 got)
    {
        (PoolKey memory key, IPoolManager.SwapParams memory p) = _params(id, isBuy, exactIn, amount);
        IERC20 tin = isBuy ? IERC20(address(usdg)) : _token(id);
        IERC20 tout = isBuy ? _token(id) : IERC20(address(usdg));
        vm.startPrank(who);
        tin.approve(address(router), type(uint256).max);
        uint256 in0 = tin.balanceOf(who);
        uint256 out0 = tout.balanceOf(who);
        router.swap(key, p);
        vm.stopPrank();
        paid = in0 - tin.balanceOf(who);
        got = tout.balanceOf(who) - out0;
    }

    /// Buys through the pool with fresh USDG.
    function _hookBuy(address who, bytes32 id, uint256 usdgIn) internal returns (uint256 tokens) {
        usdg.mint(who, usdgIn);
        (, tokens) = _swap(who, id, true, true, usdgIn);
    }

    function _sqrtPrice(bytes32 id) internal view returns (uint160 s) {
        (s,,,) = IPoolManager(address(pm)).getSlot0(PoolId.wrap(hook.poolIdOf(id)));
    }
}
