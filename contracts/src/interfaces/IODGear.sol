// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

interface IODGear is IERC20Metadata, IERC20Permit {
    error NotMinter();
    function initialize(address minter, bytes32 gearId, string calldata name, string calldata symbol) external;
    function mint(address to, uint256 amount) external; // minter only
    function burn(address from, uint256 amount) external; // minter only
    function gearId() external view returns (bytes32);
    function minter() external view returns (address);
}
