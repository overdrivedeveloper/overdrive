// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODHook {
    /// @notice Emitted when the pool for a gear is initialized.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param poolId Id of the pool.
    event GearPoolInitialized(bytes32 indexed gearId, bytes32 indexed poolId);
    /// @notice Reverts when the pool is not a registered gear pool.
    error NotGearPool();
    /// @notice Reverts on any attempt to add liquidity, since gear pools take swaps only.
    error LiquidityNotAllowed();
    /// @notice Reverts if exact-output swaps are found unsafe and disabled; by default both modes are supported.
    error ExactOutputUnsupported(); // only if 06a proves exact output unsafe; default: both supported
    /// @notice Initializes the pool for a gear and returns its pool id.
    /// @dev Admin only.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return poolId  Id of the pool.
    function initializeGearPool(bytes32 gearId) external returns (bytes32 poolId); // admin
    /// @notice Returns the gear id of a pool.
    /// @param poolId Id of the pool.
    /// @return gearId  Id of the gear (the registry key derived from its market pair and kind).
    function gearOfPool(bytes32 poolId) external view returns (bytes32 gearId);
    /// @notice Returns the pool id of a gear.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @return  The resulting identifier or tag.
    function poolIdOf(bytes32 gearId) external view returns (bytes32);
}
