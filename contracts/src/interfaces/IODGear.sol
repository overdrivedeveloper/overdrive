// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

interface IODGear is IERC20Metadata, IERC20Permit {
    /// @notice Reverts when the caller is not the minter.
    error NotMinter();
    /// @notice Initializes a freshly deployed gear token clone.
    /// @dev Callable once; sets the minter, gear id, name and symbol.
    /// @param minter Address of the minter.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param name Token name.
    /// @param symbol Token symbol.
    function initialize(address minter, bytes32 gearId, string calldata name, string calldata symbol) external;
    /// @notice Mints gear tokens.
    /// @dev Minter only (NotMinter otherwise).
    /// @param to The recipient address.
    /// @param amount The amount, in the units of the asset concerned.
    function mint(address to, uint256 amount) external; // minter only
    /// @notice Burns gear tokens from an account.
    /// @dev Minter only (NotMinter otherwise).
    /// @param from The source address.
    /// @param amount The amount, in the units of the asset concerned.
    function burn(address from, uint256 amount) external; // minter only
    /// @notice Returns the id of the gear this token represents.
    /// @return  The gear id.
    function gearId() external view returns (bytes32);
    /// @notice Returns the minter allowed to mint and burn.
    /// @return  The minter address.
    function minter() external view returns (address);
}
