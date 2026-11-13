// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODHook {
    event GearPoolInitialized(bytes32 indexed gearId, bytes32 indexed poolId);
    error NotGearPool();
    error LiquidityNotAllowed();
    error ExactOutputUnsupported(); // only if 06a proves exact output unsafe; default: both supported
    function initializeGearPool(bytes32 gearId) external returns (bytes32 poolId); // admin
    function gearOfPool(bytes32 poolId) external view returns (bytes32 gearId);
    function poolIdOf(bytes32 gearId) external view returns (bytes32);
}
