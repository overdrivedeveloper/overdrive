// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

interface IODGearRegistry {
    event GearListed(
        bytes32 indexed id,
        bytes32 indexed marketA,
        bytes32 marketB,
        Gear gear,
        address token,
        uint256 p0,
        uint128 unitWad
    );
    event GearStatusSet(bytes32 indexed id, GearStatus status);
    event GearParamsSet(bytes32 indexed id, uint128 capUsdWad, uint16 spreadBps);
    error GearExists(bytes32 id);
    error GearUnknown(bytes32 id);
    error NotAllowed(); // e.g. RACE on a market whose vol ceiling is above 40%, or a guardian raising risk
    error InvalidParams();
    function listGear(
        bytes32 marketA,
        bytes32 marketB,
        Gear gear,
        uint128 unitWad,
        uint128 capUsdWad,
        uint16 spreadBps,
        string calldata symbol
    ) external returns (bytes32 id); // admin; p0 read from the oracle guard (fresh only)
    function setStatus(bytes32 id, GearStatus status) external; // guardian: only toward less risk; admin: any
    function setParams(bytes32 id, uint128 capUsdWad, uint16 spreadBps) external; // guardian: lower only; admin: any
    function gear(bytes32 id) external view returns (GearConfig memory);
    function idOf(bytes32 marketA, bytes32 marketB, Gear gear) external pure returns (bytes32);
    function gearsOfMarket(bytes32 market) external view returns (bytes32[] memory); // includes pairs touching it
    function gearCount() external view returns (uint256);
    function gearIdAt(uint256 i) external view returns (bytes32);
    function predictToken(bytes32 id) external view returns (address);
    function powerWad(Gear gear) external pure returns (int256); // 1.5e18, 2e18, 3e18, 0.5e18, -1e18
}
