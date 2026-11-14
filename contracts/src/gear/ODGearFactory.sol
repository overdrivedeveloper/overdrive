// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ODGear} from "./ODGear.sol";

/// @title ODGearFactory
/// @notice Deploys one EIP-1167 clone of ODGear per gear at a deterministic address (salt = gear id).
/// @dev Only its owner (the ODGearRegistry that created it) may deploy, and the registry lists only through the
/// timelock, so nobody can squat a gear's address first.
contract ODGearFactory {
    /// @notice Reverts when the caller is not the factory owner.
    error NotOwner();

    address public immutable implementation;
    address public immutable owner;

    constructor() {
        implementation = address(new ODGear());
        owner = msg.sender;
    }

    /// @notice Deploys and initialises the clone of `gearId` in one call.
    function deploy(bytes32 gearId, address minter, string calldata name, string calldata symbol)
        external
        returns (address token)
    {
        if (msg.sender != owner) revert NotOwner();
        token = Clones.cloneDeterministic(implementation, gearId);
        ODGear(token).initialize(minter, gearId, name, symbol);
    }

    /// @notice The address the clone of `gearId` has (or will have).
    function predict(bytes32 gearId) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, gearId);
    }
}
