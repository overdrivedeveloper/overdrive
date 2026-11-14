// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Pool} from "v4-core/libraries/Pool.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {IODHook} from "../interfaces/IODHook.sol";
import {IODMinter} from "../interfaces/IODMinter.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {Quote} from "../interfaces/ODTypes.sol";

interface IODMinterGovernor {
    /// @notice Returns the Governor the minter uses.
    /// @return  The Governor address.
    function governor() external view returns (address);
}

/// @title ODHook
/// @notice Uniswap v4 hook on each gear/USDG pool. The pool holds no liquidity: `beforeSwap` takes the whole swap and
/// prices it with the minter (Governor value plus or minus the inventory-aware spread), so a wallet or router reaches
/// the minter like any pool. Buys revert exactly when the minter refuses them; sells pay exactly when the minter can.
/// The hook holds no funds between calls and reads none of its own balances.
/// @dev Implements IHooks directly (the vendored periphery has no BaseHook). The deployed address must have exactly
/// the permission bits below: mine the CREATE2 salt with ODHookMiner against the real deployer.
contract ODHook is IHooks, AccessControl, IODHook {
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint24 public constant POOL_FEE = 0; // all pricing is the minter's spread
    int24 public constant TICK_SPACING = 60; // unused by pricing; fixed so the PoolKey is predictable
    uint160 public constant INIT_SQRT_PRICE_X96 = 79228162514264337593543950336; // 1:1, never moves

    IPoolManager public immutable poolManager;
    IODMinter public immutable minter;
    IODGearRegistry public immutable registry;
    IERC20 public immutable usdg;
    address public immutable governor;

    mapping(bytes32 poolId => bytes32 gearId) private _gearOfPool;
    mapping(bytes32 gearId => bytes32 poolId) private _poolOf;

    /// @notice Reverts when the caller is not the pool manager.
    error NotPoolManager();
    /// @notice Reverts when a hook callback that this hook does not use is called.
    error HookNotImplemented();
    /// @notice Reverts when the swap does not match the minter quote.
    /// @param quotedIn Input amount quoted by the minter.
    /// @param quotedOut Output amount quoted by the minter.
    /// @param gotIn Input amount in the pool swap.
    /// @param gotOut Output amount in the pool swap.
    error QuoteMismatch(uint256 quotedIn, uint256 quotedOut, uint256 gotIn, uint256 gotOut);
    /// @notice Reverts when an address argument is zero.
    error ZeroAddress();
    /// The PoolManager does not physically hold enough of the input currency to front this swap (see `beforeSwap`).
    error PoolManagerShort(address currency, uint256 have, uint256 need);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager pm, IODMinter minter_, IODGearRegistry registry_, IERC20 usdg_, address admin) {
        if (
            address(pm) == address(0) || address(minter_) == address(0) || address(registry_) == address(0)
                || address(usdg_) == address(0) || admin == address(0)
        ) revert ZeroAddress();
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
        poolManager = pm;
        minter = minter_;
        registry = registry_;
        usdg = usdg_;
        address g = IODMinterGovernor(address(minter_)).governor();
        if (g == address(0)) revert ZeroAddress();
        governor = g;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ================================================================================================ pools

    /// @notice Returns the hook callbacks this contract implements.
    /// @return p  p=The permission flags.
    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    /// @inheritdoc IODHook
    /// @dev The PoolManager skips the hook's own callbacks when the hook is the caller, so `beforeInitialize` refusing
    /// every key means only this function can create a pool with this hook.
    function initializeGearPool(bytes32 gearId) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes32 poolId) {
        PoolKey memory key = poolKeyOf(gearId);
        poolId = PoolId.unwrap(_id(key));
        _gearOfPool[poolId] = gearId;
        _poolOf[gearId] = poolId;
        poolManager.initialize(key, INIT_SQRT_PRICE_X96);
        emit GearPoolInitialized(gearId, poolId);
    }

    /// The PoolKey of a gear's pool: currencies sorted (gear token and USDG), fee 0, tick spacing 60, hooks = this.
    function poolKeyOf(bytes32 gearId) public view returns (PoolKey memory key) {
        address token = registry.gear(gearId).token;
        if (token == address(0)) revert NotGearPool();
        (address a, address b) = token < address(usdg) ? (token, address(usdg)) : (address(usdg), token);
        key = PoolKey({
            currency0: Currency.wrap(a),
            currency1: Currency.wrap(b),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @inheritdoc IODHook
    function gearOfPool(bytes32 poolId) external view returns (bytes32) {
        return _gearOfPool[poolId];
    }

    /// @inheritdoc IODHook
    function poolIdOf(bytes32 gearId) external view returns (bytes32) {
        return _poolOf[gearId];
    }

    // ================================================================================================ callbacks

    /// @dev Reached only for a stranger's initialize (the hook's own call skips it).
    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        revert NotGearPool();
    }

    /// @notice Rejects any liquidity addition.
    /// @dev Pool manager only. Always reverts with LiquidityNotAllowed.
    /// @return  The returned bytes4 value.
    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert LiquidityNotAllowed();
    }

    /// @dev Takes the whole swap (custom curve): the returned delta cancels the specified amount and provides the
    /// unspecified one, so the pool's own curve moves nothing. Amounts are the minter's quote, asserted equal to what
    /// `hookSwap` executed.
    /// Flash accounting: the swapper settles its input only after `swap` returns, so the input currency the hook moves
    /// (USDG to the Governor, gear to be burned) is fronted from what the PoolManager singleton physically holds (any
    /// ERC-6909 balances, other pools' reserves) and refilled by the swapper's settlement in the same unlock. A swap
    /// larger than that balance reverts `PoolManagerShort`; the minter's own buy and sell are always available.
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = _id(key);
        bytes32 gearId = _gearOfPool[PoolId.unwrap(id)];
        if (gearId == bytes32(0)) revert NotGearPool();
        _checkPriceLimit(id, params);

        bool exactIn = params.amountSpecified < 0;
        uint256 amount = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        Currency input = params.zeroForOne ? key.currency0 : key.currency1;
        Currency output = params.zeroForOne ? key.currency1 : key.currency0;
        bool isBuy = Currency.unwrap(input) == address(usdg);

        Quote memory q = minter.quote(gearId, isBuy, exactIn, amount);
        uint256 have = input.balanceOf(address(poolManager));
        if (have < q.amountIn) revert PoolManagerShort(Currency.unwrap(input), have, q.amountIn);
        uint256 gotIn;
        uint256 gotOut;
        if (isBuy) {
            // USDG straight to the Governor, then the minter mints the gear to the PoolManager
            poolManager.take(input, governor, q.amountIn);
            poolManager.sync(output);
            (gotIn, gotOut) = minter.hookSwap(gearId, true, exactIn, amount, address(poolManager));
        } else {
            // gear to the hook (the minter burns it here), then the Governor pays the PoolManager
            poolManager.take(input, address(this), q.amountIn);
            poolManager.sync(output);
            (gotIn, gotOut) = minter.hookSwap(gearId, false, exactIn, amount, address(this));
        }
        if (gotIn != q.amountIn || gotOut != q.amountOut || (exactIn ? gotIn : gotOut) != amount) {
            revert QuoteMismatch(q.amountIn, q.amountOut, gotIn, gotOut);
        }
        poolManager.settle();

        int128 specified = -params.amountSpecified.toInt128(); // cancels the swapper's specified amount
        int128 unspecified = exactIn ? -gotOut.toInt256().toInt128() : gotIn.toInt256().toInt128();
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(specified, unspecified), 0);
    }

    // ================================================================================================ unused

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    /// @return  The returned BalanceDelta value.
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    /// @return  The returned BalanceDelta value.
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    /// @return  The returned int128 value.
    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @notice Unused callback.
    /// @dev Always reverts with HookNotImplemented.
    /// @return  The returned bytes4 value.
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    // ================================================================================================ internals

    function _id(PoolKey memory key) private pure returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(key)));
    }

    /// The pool's price never moves, so v4's own limit check (skipped for a zero swap) is repeated here: a limit already
    /// crossed or out of bounds reverts as it would in v4. The limit plays no part in pricing.
    function _checkPriceLimit(PoolId id, IPoolManager.SwapParams calldata params) private view {
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        uint160 lim = params.sqrtPriceLimitX96;
        if (params.zeroForOne) {
            if (lim >= sqrtP) revert Pool.PriceLimitAlreadyExceeded(sqrtP, lim);
            if (lim <= TickMath.MIN_SQRT_PRICE) revert Pool.PriceLimitOutOfBounds(lim);
        } else {
            if (lim <= sqrtP) revert Pool.PriceLimitAlreadyExceeded(sqrtP, lim);
            if (lim >= TickMath.MAX_SQRT_PRICE) revert Pool.PriceLimitOutOfBounds(lim);
        }
    }
}
