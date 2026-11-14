// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./ODTypes.sol";

interface IODGearRegistry {
    /// @notice Emitted when a gear is listed and its token deployed.
    /// @param id Identifier.
    /// @param marketA First market id of the gear.
    /// @param marketB Second market id of the gear (zero for a single-market gear).
    /// @param gear The gear kind.
    /// @param token Address of the token.
    /// @param p0 Initial price of the gear at listing, WAD.
    /// @param unitWad Unit size of the gear, WAD (18 decimals).
    event GearListed(
        bytes32 indexed id,
        bytes32 indexed marketA,
        bytes32 marketB,
        Gear gear,
        address token,
        uint256 p0,
        uint128 unitWad
    );
    /// @notice Emitted when the status of a gear changes.
    /// @param id Identifier.
    /// @param status The new status.
    event GearStatusSet(bytes32 indexed id, GearStatus status);
    /// @notice Emitted when the cap or spread of a gear changes.
    /// @param id Identifier.
    /// @param capUsdWad Open-value cap in USD, WAD (18 decimals).
    /// @param spreadBps Spread in basis points.
    event GearParamsSet(bytes32 indexed id, uint128 capUsdWad, uint16 spreadBps);
    /// @notice Reverts when the gear is already listed.
    /// @param id Identifier.
    error GearExists(bytes32 id);
    /// @notice Reverts when the gear is not listed.
    /// @param id Identifier.
    error GearUnknown(bytes32 id);
    /// @notice Reverts when the action is not allowed, for example a RACE gear on a market with a vol ceiling above 40%, or a
    /// guardian raising risk.
    error NotAllowed(); // e.g. RACE on a market whose vol ceiling is above 40%, or a guardian raising risk
    /// @notice Reverts when parameters are invalid.
    error InvalidParams();
    /// @notice Lists a new gear and deploys its token.
    /// @dev Admin only. The initial price is read from the oracle guard and must be fresh. Reverts with GearExists,
    /// NotAllowed or InvalidParams.
    /// @param marketA First market id of the gear.
    /// @param marketB Second market id of the gear (zero for a single-market gear).
    /// @param gear The gear kind.
    /// @param unitWad Unit size of the gear, WAD (18 decimals).
    /// @param capUsdWad Open-value cap in USD, WAD (18 decimals).
    /// @param spreadBps Spread in basis points.
    /// @param symbol Token symbol.
    /// @return id  Identifier.
    function listGear(
        bytes32 marketA,
        bytes32 marketB,
        Gear gear,
        uint128 unitWad,
        uint128 capUsdWad,
        uint16 spreadBps,
        string calldata symbol
    ) external returns (bytes32 id); // admin; p0 read from the oracle guard (fresh only)
    /// @notice Sets the status of a gear.
    /// @dev The guardian may only move toward less risk; the admin may set any status.
    /// @param id Identifier.
    /// @param status The new status.
    function setStatus(bytes32 id, GearStatus status) external; // guardian: only toward less risk; admin: any
    /// @notice Sets the cap and spread of a gear.
    /// @dev The guardian may only lower; the admin may set any value.
    /// @param id Identifier.
    /// @param capUsdWad Open-value cap in USD, WAD (18 decimals).
    /// @param spreadBps Spread in basis points.
    function setParams(bytes32 id, uint128 capUsdWad, uint16 spreadBps) external; // guardian: lower only; admin: any
    /// @notice Returns the configuration of a gear.
    /// @param id Identifier.
    /// @return  The gear configuration.
    function gear(bytes32 id) external view returns (GearConfig memory);
    /// @notice Returns the id of a gear from its markets and kind.
    /// @param marketA First market id of the gear.
    /// @param marketB Second market id of the gear (zero for a single-market gear).
    /// @param gear The gear kind.
    /// @return  The gear id.
    function idOf(bytes32 marketA, bytes32 marketB, Gear gear) external pure returns (bytes32);
    /// @notice Returns the ids of the gears on a market, including pairs that touch it.
    /// @param market Market id (bytes32 symbol key).
    /// @return  The gear ids.
    function gearsOfMarket(bytes32 market) external view returns (bytes32[] memory); // includes pairs touching it
    /// @notice Returns the number of listed gears.
    /// @return  The gear count.
    function gearCount() external view returns (uint256);
    /// @notice Returns the gear id at an index.
    /// @param i Index into the list.
    /// @return  The gear id.
    function gearIdAt(uint256 i) external view returns (bytes32);
    /// @notice Returns the address the token of a gear has or will have.
    /// @param id Identifier.
    /// @return  The token address.
    function predictToken(bytes32 id) external view returns (address);
    /// @notice Returns the power exponent of a gear kind.
    /// @param gear The gear kind.
    /// @return  The exponent, WAD: 1.5, 2, 3, 0.5 or -1.
    function powerWad(Gear gear) external pure returns (int256); // 1.5e18, 2e18, 3e18, 0.5e18, -1e18
}
