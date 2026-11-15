// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

interface IODOracleGuard {
    /// @notice Emitted when a market configuration is set.
    /// @param market Market id (bytes32 symbol key).
    /// @param cfg The market configuration.
    event MarketSet(bytes32 indexed market, MarketConfig cfg);
    /// @notice Emitted when buys on a market are paused or unpaused.
    /// @param market Market id (bytes32 symbol key).
    /// @param paused True to pause, false to unpause.
    /// @param reason Reason code (bytes32 tag).
    event BuysPausedSet(bytes32 indexed market, bool paused, bytes32 reason);
    /// @notice Emitted when the last good price of a market is recorded.
    /// @param market Market id (bytes32 symbol key).
    /// @param p The parameter struct.
    /// @param at Timestamp.
    event LastGoodSet(bytes32 indexed market, uint256 p, uint64 at);
    /// @notice Emitted when a halt is latched for a market.
    /// @param market Market id (bytes32 symbol key).
    /// @param since Timestamp since which the condition holds.
    event HaltLatched(bytes32 indexed market, uint64 since);
    /// @notice Emitted when a price continuity confirmation is recorded.
    /// @param market Market id (bytes32 symbol key).
    /// @param confirmations Number of continuity confirmations.
    /// @param p The parameter struct.
    event ContinuityConfirmed(bytes32 indexed market, uint8 confirmations, uint256 p);
    /// @notice Reverts when the market is not configured.
    /// @param market Market id (bytes32 symbol key).
    error MarketUnknown(bytes32 market);
    /// @notice Reverts when a market configuration is invalid.
    error InvalidConfig();
    /// @notice Reverts when an address argument is zero.
    error ZeroAddress();
    /// @notice Sets the configuration of a market.
    /// @dev Admin (timelock) only. Reverts with InvalidConfig.
    /// @param market Market id (bytes32 symbol key).
    /// @param cfg The market configuration.
    function setMarket(bytes32 market, MarketConfig calldata cfg) external; // admin (timelock)
    /// @notice Pauses or unpauses buys on a market.
    /// @dev The guardian may pause; only the admin unpauses.
    /// @param market Market id (bytes32 symbol key).
    /// @param paused True to pause, false to unpause.
    function setBuysPaused(bytes32 market, bool paused) external; // guardian may pause; only admin unpauses
    /// @notice Says why a liquidation must not be priced on a market right now, or zero when it may.
    /// @dev Fail closed for liquidation: "NOT_LIVE" (halted, closed or unknown session), "CONTINUITY", "SPLIT_PENDING",
    /// "REF_UNAVAILABLE" (no reference) or "REF_BAND" (the reference is outside refBandBps of the feed). Reverts only
    /// with MarketUnknown.
    /// @param market Market id (bytes32 symbol key).
    /// @return reason  Zero when a liquidation may be priced, else the reason.
    function liquidationBlock(bytes32 market) external view returns (bytes32 reason);
    /// @notice Reads the price of a market.
    /// @dev Reverts only with MarketUnknown.
    /// @param market Market id (bytes32 symbol key).
    /// @return  The price reading.
    function read(bytes32 market) external view returns (PriceReading memory); // reverts only MarketUnknown
    /// @notice Reads the ratio of two markets for pair gears.
    /// @param a The a.
    /// @param b The b.
    /// @return  The reading, with p = pA / pB.
    function readRatio(bytes32 a, bytes32 b) external view returns (PriceReading memory); // pair: p = pA/pB
    /// @notice Updates the oracle state for a market and returns the reading.
    /// @dev Permissionless.
    /// @param market Market id (bytes32 symbol key).
    /// @return  The price reading.
    function poke(bytes32 market) external returns (PriceReading memory); // permissionless state update
    /// @notice Returns the last good price of a market and when it was set.
    /// @param market Market id (bytes32 symbol key).
    /// @return p  The parameter struct.
    /// @return at  Timestamp.
    function lastGood(bytes32 market) external view returns (uint256 p, uint64 at);
    /// @notice Returns the configuration of a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return  The market configuration.
    function config(bytes32 market) external view returns (MarketConfig memory);
    /// @notice Returns the market hours contract.
    /// @return  The market hours address.
    function marketHours() external view returns (address);
    /// @notice Returns when a market halted.
    /// @param market Market id (bytes32 symbol key).
    /// @return  Timestamp, or zero if not halted.
    function haltedSince(bytes32 market) external view returns (uint64); // 0 = not halted
    /// @notice Returns the reference price of a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return refP  refP=The reference price, zero if unavailable.
    /// @return fromPyth  fromPyth=True when it comes from Pyth.
    function refPrice(bytes32 market) external view returns (uint256 refP, bool fromPyth); // 0 = unavailable
    /// @notice Returns why buys are paused on a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return  Reason code, zero when buys are allowed.
    function buysPausedReason(bytes32 market) external view returns (bytes32); // 0 = buys allowed
}
