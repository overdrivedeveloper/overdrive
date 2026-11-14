// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// TWAP source for the $OVRD/USDG route used by the stake slash and the buy-burn.
/// Prices are WAD USD per whole 18-decimal token; 0 or a revert means unavailable (callers fail closed).
interface IODPriceSource {
    function referencePrice(address token, uint24 fee) external view returns (uint256 priceWad);
    function spotPrice(address token, uint24 fee) external view returns (uint256 priceWad);
}

/// Swap adapter on a fixed pool route; must deliver at least `minOut` of `tokenOut` to `recipient` or revert.
interface IODSwapAdapter {
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}
