// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// TWAP source for the $OVRD/USDG route used by the stake slash and the buy-burn.
/// Prices are WAD USD per whole 18-decimal token; 0 or a revert means unavailable (callers fail closed).
interface IODPriceSource {
    /// @notice Returns the TWAP reference price of `token`.
    /// @dev Zero or a revert means unavailable and callers fail closed.
    /// @param token Address of the token.
    /// @param fee Pool fee tier.
    /// @return priceWad  Price in USD, WAD (18 decimals).
    function referencePrice(address token, uint24 fee) external view returns (uint256 priceWad);
    /// @notice Returns the spot price of `token`.
    /// @dev Zero or a revert means unavailable and callers fail closed.
    /// @param token Address of the token.
    /// @param fee Pool fee tier.
    /// @return priceWad  Price in USD, WAD (18 decimals).
    function spotPrice(address token, uint24 fee) external view returns (uint256 priceWad);
}

/// Swap adapter on a fixed pool route; must deliver at least `minOut` of `tokenOut` to `recipient` or revert.
interface IODSwapAdapter {
    /// @notice Swaps an exact input amount along the fixed route.
    /// @dev Must deliver at least `minOut` of `tokenOut` to `recipient` or revert.
    /// @param tokenIn The token in.
    /// @param tokenOut The token out.
    /// @param fee Pool fee tier.
    /// @param amountIn Amount of the input token.
    /// @param minOut The min out.
    /// @param recipient The address that receives the output.
    /// @return amountOut  Amount of the output token received.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}
