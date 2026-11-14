// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ODRoles} from "../interfaces/ODRoles.sol";
import {IODPriceSource, IODSwapAdapter} from "./IODSwapRoute.sol";

/// @title ODBuyBurn
/// @notice Recipient of ODFees' BURN bucket. A keeper spends the USDG held here on $OVRD through one admin-set route
/// and sends the tokens to the dead address. $OVRD comes from a launchpad; this contract never issues it.
/// @dev Keeper only. The output is floored at max(minTokensOut, TWAP less the route's slippage allowance), the spot price
/// must sit within SPOT_BAND_BPS of the TWAP, and a missing TWAP refuses the buy (fail closed). There is no withdrawal
/// path for the USDG: it can only buy $OVRD.
contract ODBuyBurn is AccessControl, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant BPS = 10_000;
    /// @dev WAD USD per whole 18-dp token to USDG 6 dp: value = amount x price / 1e30.
    uint256 private constant PRICE_TO_USDG = 1e30;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint256 public constant SPOT_BAND_BPS = 50;

    IERC20 public immutable usdg;

    IERC20 public token;
    IODSwapAdapter public swapAdapter;
    uint24 public poolFee;
    uint16 public maxSlippageBps;
    IODPriceSource public priceSource;
    uint256 public maxUsdgPerCall = 1_000e6;
    uint256 public totalUsdgSpent;
    uint256 public totalBurned;

    event Burned(uint256 usdgIn, uint256 tokensBurned);
    event RouteSet(address token, address swapAdapter, uint24 fee, uint16 maxSlippageBps);
    event PriceSourceSet(address priceSource);
    event MaxPerCallSet(uint256 maxUsdgPerCall);

    error InvalidParams();
    error NoRoute();
    error TwapUnavailable();
    error SpotOffTwap();
    error OutputTooLow(uint256 got, uint256 minOut);

    constructor(IERC20 usdg_, address admin) {
        if (address(usdg_) == address(0) || admin == address(0)) revert InvalidParams();
        usdg = usdg_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Buys $OVRD with `usdgIn` of the held USDG and burns it. Reverts (spends nothing) when the route is unset,
    /// the TWAP is unavailable, spot is off the TWAP, or the output is under the floor.
    function execute(uint256 usdgIn, uint256 minTokensOut)
        external
        nonReentrant
        onlyRole(ODRoles.KEEPER_ROLE)
        returns (uint256 burned)
    {
        IERC20 t = token;
        IODSwapAdapter adapter = swapAdapter;
        if (address(t) == address(0) || address(adapter) == address(0)) revert NoRoute();
        if (usdgIn == 0 || usdgIn > maxUsdgPerCall || usdgIn > usdg.balanceOf(address(this))) revert InvalidParams();
        uint256 price = _price(t);
        if (price == 0) revert TwapUnavailable();
        if (!_spotNearTwap(t, price)) revert SpotOffTwap();
        uint256 floor = Math.mulDiv(usdgIn, PRICE_TO_USDG * (BPS - maxSlippageBps), price * BPS);
        uint256 minOut = floor > minTokensOut ? floor : minTokensOut;
        if (minOut == 0) revert TwapUnavailable();

        uint256 deadBefore = t.balanceOf(DEAD);
        usdg.forceApprove(address(adapter), usdgIn);
        adapter.swapExactIn(address(usdg), address(t), poolFee, usdgIn, minOut, DEAD);
        usdg.forceApprove(address(adapter), 0);
        burned = t.balanceOf(DEAD) - deadBefore;
        if (burned < minOut) revert OutputTooLow(burned, minOut);
        totalUsdgSpent += usdgIn;
        totalBurned += burned;
        emit Burned(usdgIn, burned);
    }

    // ------------------------------------------------------------------------------------------------ admin (timelock)

    function setRoute(address token_, address swapAdapter_, uint24 fee, uint16 maxSlippageBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (maxSlippageBps_ > MAX_SLIPPAGE_BPS || token_ == address(usdg)) revert InvalidParams();
        if (swapAdapter_ != address(0) && (swapAdapter_.code.length == 0 || fee == 0 || token_ == address(0))) {
            revert InvalidParams();
        }
        token = IERC20(token_);
        swapAdapter = IODSwapAdapter(swapAdapter_);
        poolFee = fee;
        maxSlippageBps = maxSlippageBps_;
        emit RouteSet(token_, swapAdapter_, fee, maxSlippageBps_);
    }

    /// @notice The TWAP source for the route. Zero refuses every buy.
    function setPriceSource(address source) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (source != address(0) && source.code.length == 0) revert InvalidParams();
        priceSource = IODPriceSource(source);
        emit PriceSourceSet(source);
    }

    function setMaxUsdgPerCall(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (cap == 0) revert InvalidParams();
        maxUsdgPerCall = cap;
        emit MaxPerCallSet(cap);
    }

    // ------------------------------------------------------------------------------------------------ internals

    function _price(IERC20 t) private view returns (uint256) {
        IODPriceSource src = priceSource;
        if (address(src) == address(0)) return 0;
        return _read(abi.encodeCall(IODPriceSource.referencePrice, (address(t), poolFee)));
    }

    /// @dev Static call to the price source; a revert, short return or missing source reads as 0 (fail closed).
    function _read(bytes memory data) private view returns (uint256 v) {
        address src = address(priceSource);
        if (src.code.length == 0) return 0;
        (bool ok, bytes memory ret) = src.staticcall(data);
        if (!ok || ret.length < 32) return 0;
        v = abi.decode(ret, (uint256));
    }

    function _spotNearTwap(IERC20 t, uint256 twap) private view returns (bool) {
        uint256 spot = _read(abi.encodeCall(IODPriceSource.spotPrice, (address(t), poolFee)));
        if (spot == 0) return false;
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        return diff * BPS <= twap * SPOT_BAND_BPS;
    }
}
