// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

interface IODOracleGuard {
    event MarketSet(bytes32 indexed market, MarketConfig cfg);
    event BuysPausedSet(bytes32 indexed market, bool paused, bytes32 reason);
    event LastGoodSet(bytes32 indexed market, uint256 p, uint64 at);
    event HaltLatched(bytes32 indexed market, uint64 since);
    error MarketUnknown(bytes32 market);
    error InvalidConfig();
    function setMarket(bytes32 market, MarketConfig calldata cfg) external; // admin (timelock)
    function setBuysPaused(bytes32 market, bool paused) external; // guardian may pause; only admin unpauses
    function read(bytes32 market) external view returns (PriceReading memory); // reverts only MarketUnknown
    function readRatio(bytes32 a, bytes32 b) external view returns (PriceReading memory); // pair: p = pA/pB
    function poke(bytes32 market) external returns (PriceReading memory); // permissionless state update
    function lastGood(bytes32 market) external view returns (uint256 p, uint64 at);
    function config(bytes32 market) external view returns (MarketConfig memory);
    function marketHours() external view returns (address);
}
